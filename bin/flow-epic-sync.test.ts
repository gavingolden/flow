import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, deriveBoard } from "./flow-epic-sync";
import { writeState, type PipelineState } from "./lib/state";
import { writeEpicRunState, type EpicRunState } from "./lib/epic-run-state";
import {
  readCommittedStatus,
  serializeEpicStatus,
} from "./lib/epic-status-schema";
import type { EpicManifest } from "./lib/epic-manifest-schema";
import type { GhRunner } from "./lib/resume-probes";
import { slugify } from "./lib/slug";

/**
 * Coverage for the `flow-epic-sync` PATH helper: `deriveBoard` (pure,
 * stubbed `GhRunner`, no network) plus the CLI-level epic resolution,
 * write/no-write disposition, and `--check` drift detection.
 */

const ISO = "2026-08-01T00:00:00Z";

const MANIFEST: EpicManifest = {
  epicId: "watchlist",
  prompt: "build the watchlist",
  createdAt: ISO,
  features: [
    { id: "feature-a", title: "A", description: "a", dependsOn: [] },
    { id: "feature-b", title: "B", description: "b", dependsOn: [] },
    { id: "feature-c", title: "C", description: "c", dependsOn: [] },
  ],
};

/** gh stub keyed by feature id (matched against the slugified PR head). */
function ghForHeads(
  merged: Record<string, number>,
  open: Record<string, number> = {},
): GhRunner {
  const mergedByHead: Record<string, number> = {};
  for (const [id, num] of Object.entries(merged))
    mergedByHead[slugify(id)] = num;
  const openByHead: Record<string, number> = {};
  for (const [id, num] of Object.entries(open)) openByHead[slugify(id)] = num;

  return (argv) => {
    const headIdx = argv.indexOf("--head");
    const head = argv[headIdx + 1];
    const stateFiltered = argv.includes("--state");
    const num = stateFiltered
      ? mergedByHead[head]
      : (mergedByHead[head] ?? openByHead[head]);
    return {
      stdout: JSON.stringify(num !== undefined ? [{ number: num }] : []),
      stderr: "",
      exitCode: 0,
    };
  };
}

const ghFailing: GhRunner = () => ({ stdout: "", stderr: "boom", exitCode: 1 });

describe("deriveBoard — pure whole-epic reconcile", () => {
  it("classifies merged/open/never-launched features from a stubbed gh", () => {
    const gh = ghForHeads({ "feature-a": 101 }, { "feature-b": 55 });
    const { file, derived } = deriveBoard({
      manifest: MANIFEST,
      existing: null,
      gh,
    });
    expect(derived).toBe(true);
    expect(file.features).toEqual({
      "feature-a": { status: "merged", pr: 101 },
      "feature-b": { status: "not-started" },
      "feature-c": { status: "not-started" },
    });
  });

  it("does not record an open PR — only what landed", () => {
    const gh = ghForHeads({}, { "feature-b": 55 });
    const { file } = deriveBoard({ manifest: MANIFEST, existing: null, gh });
    expect(file.features["feature-b"]).toEqual({ status: "not-started" });
  });

  it("keeps an existing merged row merged when gh returns nothing for it", () => {
    const gh = ghForHeads({});
    const existing = {
      version: 1 as const,
      epicId: "watchlist",
      features: { "feature-a": { status: "merged" as const, pr: 101 } },
    };
    const { file } = deriveBoard({ manifest: MANIFEST, existing, gh });
    expect(file.features["feature-a"]).toEqual({ status: "merged", pr: 101 });
  });

  it("optimistically marks the self row merged even when GitHub reports it OPEN, without touching siblings", () => {
    const gh = ghForHeads({}, { "feature-b": 77 });
    const { file, derived } = deriveBoard({
      manifest: MANIFEST,
      existing: null,
      gh,
      selfFeatureId: "feature-b",
    });
    expect(derived).toBe(true);
    expect(file.features["feature-b"]).toEqual({ status: "merged", pr: 77 });
    expect(file.features["feature-a"]).toEqual({ status: "not-started" });
    expect(file.features["feature-c"]).toEqual({ status: "not-started" });
  });

  it("quiet-diff: open, closed-unmerged, and no-PR-at-all all derive the same board", () => {
    // A closed-unmerged PR: gh returns it for the unfiltered (open) query
    // shape used to probe the self row, but never for the `--state merged`
    // filtered query siblings use — model that explicitly rather than
    // reusing the same stub as the "no PR at all" case, which could never
    // distinguish a real bug in the merged-state filter.
    const closedUnmergedGh: GhRunner = (argv) => {
      const stateFiltered = argv.includes("--state");
      return {
        stdout: stateFiltered ? "[]" : JSON.stringify([{ number: 55 }]),
        stderr: "",
        exitCode: 0,
      };
    };
    const ghOpen = ghForHeads({}, { "feature-b": 55 });
    const ghNone = ghForHeads({}, {});
    const a = deriveBoard({ manifest: MANIFEST, existing: null, gh: ghOpen });
    const b = deriveBoard({
      manifest: MANIFEST,
      existing: null,
      gh: closedUnmergedGh,
    });
    const c = deriveBoard({ manifest: MANIFEST, existing: null, gh: ghNone });
    expect(serializeEpicStatus(a.file)).toBe(serializeEpicStatus(b.file));
    expect(serializeEpicStatus(b.file)).toBe(serializeEpicStatus(c.file));
  });

  it("marks derived:false when gh fails, without writing", () => {
    const { derived } = deriveBoard({
      manifest: MANIFEST,
      existing: null,
      gh: ghFailing,
    });
    expect(derived).toBe(false);
  });

  it("skips the gh query for a row already committed merged+pr (latch would discard it anyway), but still queries not-started rows and the self row", () => {
    let queriedHeads: string[] = [];
    const gh: GhRunner = (argv) => {
      const headIdx = argv.indexOf("--head");
      queriedHeads.push(argv[headIdx + 1]);
      return { stdout: "[]", stderr: "", exitCode: 0 };
    };
    const existing = {
      version: 1 as const,
      epicId: "watchlist",
      features: { "feature-a": { status: "merged" as const, pr: 101 } },
    };
    const { file, derived } = deriveBoard({
      manifest: MANIFEST,
      existing,
      gh,
      selfFeatureId: "feature-c",
    });
    expect(derived).toBe(true);
    expect(queriedHeads).not.toContain(slugify("feature-a"));
    expect(queriedHeads).toContain(slugify("feature-b"));
    expect(queriedHeads).toContain(slugify("feature-c"));
    expect(file.features["feature-a"]).toEqual({ status: "merged", pr: 101 });
  });

  it("--rederive rebuilds a wrong committed merged+pr row from gh instead of latching it", () => {
    const gh = ghForHeads({}); // gh reports nothing merged for any feature
    const existing = {
      version: 1 as const,
      epicId: "watchlist",
      features: {
        "feature-a": { status: "merged" as const, pr: 9999 },
      },
    };
    const { file, regressed } = deriveBoard({
      manifest: MANIFEST,
      existing,
      gh,
      rederive: true,
    });
    expect(file.features["feature-a"]).toEqual({ status: "not-started" });
    expect(regressed).toEqual(["feature-a"]);
  });

  it("without --rederive the same planted row stays latched merged/9999", () => {
    const gh = ghForHeads({});
    const existing = {
      version: 1 as const,
      epicId: "watchlist",
      features: {
        "feature-a": { status: "merged" as const, pr: 9999 },
      },
    };
    const { file, regressed } = deriveBoard({
      manifest: MANIFEST,
      existing,
      gh,
    });
    expect(file.features["feature-a"]).toEqual({ status: "merged", pr: 9999 });
    expect(regressed).toEqual([]);
  });

  it("--rederive still applies the optimistic self-mark", () => {
    const gh = ghForHeads({}, {});
    const existing = {
      version: 1 as const,
      epicId: "watchlist",
      features: {
        "feature-b": { status: "merged" as const, pr: 9999 },
      },
    };
    const { file } = deriveBoard({
      manifest: MANIFEST,
      existing,
      gh,
      selfFeatureId: "feature-b",
      rederive: true,
    });
    expect(file.features["feature-b"]).toEqual({
      status: "merged",
      pr: undefined,
    });
  });

  it("--rederive still marks derived:false when gh fails, without writing", () => {
    const existing = {
      version: 1 as const,
      epicId: "watchlist",
      features: {
        "feature-a": { status: "merged" as const, pr: 9999 },
      },
    };
    const { derived } = deriveBoard({
      manifest: MANIFEST,
      existing,
      gh: ghFailing,
      rederive: true,
    });
    expect(derived).toBe(false);
  });
});

describe("main — CLI epic resolution + write disposition", () => {
  let stateDir: string;
  let epicsDir: string;
  let repoDir: string;
  let manifestPath: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-sync-state-"));
    epicsDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-sync-epics-"));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-sync-repo-"));
    spawnSync("git", ["init", "-q"], { cwd: repoDir });
    const epicDir = path.join(repoDir, ".flow", "epics", "watchlist");
    fs.mkdirSync(epicDir, { recursive: true });
    manifestPath = path.join(epicDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(epicsDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  function seedRunState(overrides: Partial<EpicRunState> = {}): void {
    const rs: EpicRunState = {
      epicSlug: "watchlist",
      repo: repoDir,
      manifestPath,
      manifestSha: "deadbeef",
      createdAt: ISO,
      updatedAt: ISO,
      features: {},
      ...overrides,
    };
    writeEpicRunState(rs, epicsDir);
  }

  it("creates status.json when none exists, and the result validates", () => {
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    const exit = main(["--epic-slug", "watchlist"], {
      gh,
      epicsDir,
      cwd: repoDir,
    });
    expect(exit).toBe(0);
    const status = readCommittedStatus(path.dirname(manifestPath));
    expect(status).not.toBeNull();
    expect(status?.features["feature-a"]).toEqual({
      status: "merged",
      pr: 101,
    });
  });

  it("--epic-feature overrides the self-mark id when paired with --epic-slug (optimistic self-mark even without an open PR)", () => {
    seedRunState();
    const gh = ghForHeads({}, {}); // no PR at all for feature-b
    const exit = main(
      ["--epic-slug", "watchlist", "--epic-feature", "feature-b"],
      { gh, epicsDir, cwd: repoDir },
    );
    expect(exit).toBe(0);
    const status = readCommittedStatus(path.dirname(manifestPath));
    expect(status?.features["feature-b"]).toEqual({
      status: "merged",
      pr: undefined,
    });
  });

  it("resolves the epic via --slug -> state.epic.slug -> selfFeatureId (the production /flow-pipeline invocation path, no --epic-slug)", () => {
    const s: PipelineState = {
      slug: "epic-feature-slug",
      phase: "review",
      repo: repoDir,
      updatedAt: ISO,
      epic: { slug: "watchlist", featureId: "feature-b" },
    };
    writeState(s, stateDir);
    seedRunState();
    const gh = ghForHeads({ "feature-b": 77 }, { "feature-b": 77 });
    const exit = main(["--slug", "epic-feature-slug"], {
      gh,
      epicsDir,
      cwd: repoDir,
      stateDir,
    });
    expect(exit).toBe(0);
    const status = readCommittedStatus(path.dirname(manifestPath));
    expect(status?.features["feature-b"]).toEqual({
      status: "merged",
      pr: 77,
    });
  });

  it("resolves the epic via FLOW_SLUG env -> state.epic.slug (no --slug, no --epic-slug)", () => {
    const s: PipelineState = {
      slug: "epic-feature-slug",
      phase: "review",
      repo: repoDir,
      updatedAt: ISO,
      epic: { slug: "watchlist", featureId: "feature-b" },
    };
    writeState(s, stateDir);
    seedRunState();
    const gh = ghForHeads({ "feature-b": 77 }, { "feature-b": 77 });
    const exit = main([], {
      gh,
      epicsDir,
      cwd: repoDir,
      stateDir,
      env: { FLOW_SLUG: "epic-feature-slug" } as NodeJS.ProcessEnv,
    });
    expect(exit).toBe(0);
    const status = readCommittedStatus(path.dirname(manifestPath));
    expect(status?.features["feature-b"]).toEqual({
      status: "merged",
      pr: 77,
    });
  });

  it("a slug whose state has no .epic exits 0, writes nothing, prints nothing", () => {
    const s: PipelineState = {
      slug: "plain-feature",
      phase: "merged",
      repo: repoDir,
      updatedAt: ISO,
    };
    writeState(s, stateDir);
    const exit = main(["--slug", "plain-feature"], {
      gh: ghForHeads({}),
      epicsDir,
      cwd: repoDir,
      stateDir,
    });
    expect(exit).toBe(0);
    expect(
      fs.existsSync(path.join(path.dirname(manifestPath), "status.json")),
    ).toBe(false);
  });

  it("gh failing: derived false, nothing written, exit 0", () => {
    seedRunState();
    const exit = main(["--epic-slug", "watchlist"], {
      gh: ghFailing,
      epicsDir,
      cwd: repoDir,
    });
    expect(exit).toBe(0);
    expect(
      fs.existsSync(path.join(path.dirname(manifestPath), "status.json")),
    ).toBe(false);
  });

  it("--check exits 1 on drift and 0 when in sync", () => {
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    const driftExit = main(["--epic-slug", "watchlist", "--check"], {
      gh,
      epicsDir,
      cwd: repoDir,
    });
    expect(driftExit).toBe(1);

    main(["--epic-slug", "watchlist"], { gh, epicsDir, cwd: repoDir });
    const inSyncExit = main(["--epic-slug", "watchlist", "--check"], {
      gh,
      epicsDir,
      cwd: repoDir,
    });
    expect(inSyncExit).toBe(0);
  });

  it("--rederive --check diagnoses drift on a wrong committed row and writes nothing", () => {
    seedRunState();
    // Plant a wrong committed merged+pr row directly (bypassing the latch)
    // that gh no longer backs — the exact scenario --rederive repairs.
    const epicDirAbs = path.dirname(manifestPath);
    fs.writeFileSync(
      path.join(epicDirAbs, "status.json"),
      JSON.stringify({
        version: 1,
        epicId: "watchlist",
        features: { "feature-a": { status: "merged", pr: 9999 } },
      }),
    );
    const gh = ghForHeads({}); // gh backs nothing
    const exit = main(["--epic-slug", "watchlist", "--rederive", "--check"], {
      gh,
      epicsDir,
      cwd: repoDir,
    });
    expect(exit).toBe(1);
    const status = readCommittedStatus(epicDirAbs);
    expect(status?.features["feature-a"]).toEqual({
      status: "merged",
      pr: 9999,
    });
  });

  it("--rederive rebuilds an epicId-mismatched committed file instead of early-returning", () => {
    seedRunState();
    const epicDirAbs = path.dirname(manifestPath);
    fs.writeFileSync(
      path.join(epicDirAbs, "status.json"),
      JSON.stringify({
        version: 1,
        epicId: "some-other-epic",
        features: { "feature-a": { status: "merged", pr: 9999 } },
      }),
    );
    const gh = ghForHeads({ "feature-a": 101 });
    const exit = main(["--epic-slug", "watchlist", "--rederive"], {
      gh,
      epicsDir,
      cwd: repoDir,
    });
    expect(exit).toBe(0);
    const status = readCommittedStatus(epicDirAbs);
    expect(status?.epicId).toBe("watchlist");
    expect(status?.features["feature-a"]).toEqual({
      status: "merged",
      pr: 101,
    });
  });

  it("--rederive repairs a wrong committed row by writing the rebuilt board and naming the regression", () => {
    seedRunState();
    const epicDirAbs = path.dirname(manifestPath);
    fs.writeFileSync(
      path.join(epicDirAbs, "status.json"),
      JSON.stringify({
        version: 1,
        epicId: "watchlist",
        features: { "feature-a": { status: "merged", pr: 9999 } },
      }),
    );
    const gh = ghForHeads({});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const exit = main(["--epic-slug", "watchlist", "--rederive"], {
        gh,
        epicsDir,
        cwd: repoDir,
      });
      expect(exit).toBe(0);
      expect(readCommittedStatus(epicDirAbs)?.features["feature-a"]).toEqual({
        status: "not-started",
      });
      expect(errSpy.mock.calls[0][0]).toContain("feature-a");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("--rederive still writes nothing when derived:false (gh unavailable)", () => {
    seedRunState();
    const epicDirAbs = path.dirname(manifestPath);
    fs.writeFileSync(
      path.join(epicDirAbs, "status.json"),
      JSON.stringify({
        version: 1,
        epicId: "watchlist",
        features: { "feature-a": { status: "merged", pr: 9999 } },
      }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const exit = main(["--epic-slug", "watchlist", "--rederive"], {
        gh: ghFailing,
        epicsDir,
        cwd: repoDir,
      });
      expect(exit).toBe(0);
      const status = readCommittedStatus(epicDirAbs);
      expect(status?.features["feature-a"]).toEqual({
        status: "merged",
        pr: 9999,
      });
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes("NOT rebuilt")),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("an unrecognized flag warns on stderr and exits 0 (no latch-preserving silent no-op)", () => {
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const exit = main(["--epic-slug", "watchlist", "--rederrive"], {
        gh,
        epicsDir,
        cwd: repoDir,
      });
      expect(exit).toBe(0);
      expect(errSpy).toHaveBeenCalled();
      expect(errSpy.mock.calls[0][0]).toContain("--rederrive");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a flag's consumed VALUE token is never itself warned about", () => {
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      main(["--slug", "some-slug", "--epic-slug", "watchlist"], {
        gh,
        epicsDir,
        cwd: repoDir,
      });
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("warns when a value-taking flag is followed by another flag instead of a value", () => {
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const exit = main(["--epic-slug", "--check"], {
        gh,
        epicsDir,
        cwd: repoDir,
      });
      expect(exit).toBe(0);
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes("--epic-slug")),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("warns when a value-taking flag is the last argv token", () => {
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      main(["--epic-slug"], {
        gh,
        epicsDir,
        cwd: repoDir,
      });
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes("--epic-slug")),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("--json prints the {epicSlug, derived, written, features} envelope shape", () => {
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exit = main(["--epic-slug", "watchlist", "--json"], {
        gh,
        epicsDir,
        cwd: repoDir,
      });
      expect(exit).toBe(0);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(printed).toEqual({
        epicSlug: "watchlist",
        derived: true,
        written: true,
        features: {
          "feature-a": { status: "merged", pr: 101 },
          "feature-b": { status: "not-started" },
          "feature-c": { status: "not-started" },
        },
        rederive: false,
        regressed: [],
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("flow-epic-sync.ts is executable", () => {
  it("has the exec bit set", () => {
    const scriptPath = path.resolve(__dirname, "flow-epic-sync.ts");
    const mode = fs.statSync(scriptPath).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});
