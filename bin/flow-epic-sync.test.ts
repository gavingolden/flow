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
import type { GitRunner } from "./lib/epic-metadata-commit";
import { slugify } from "./lib/slug";

type GitResp = { stdout?: string; stderr?: string; exitCode?: number };

/** Recording git fake — same shape as bin/lib/epic-metadata-commit.test.ts. */
function makeGit(respond: (argv: string[]) => GitResp | undefined) {
  const calls: string[][] = [];
  const git: GitRunner = (argv) => {
    calls.push(argv);
    const r = respond(argv) ?? {};
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.exitCode ?? 0,
    };
  };
  return { git, calls };
}

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
        committed: false,
        pushed: false,
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("--commit on a drifted board: writes AND emits a path-scoped commit argv, envelope committed:true", () => {
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    const { git, calls } = makeGit((argv) => {
      if (argv[0] === "status")
        return { stdout: " M .flow/epics/watchlist/status.json\n" };
      return { exitCode: 0 };
    });
    const exit = main(["--epic-slug", "watchlist", "--commit"], {
      gh,
      epicsDir,
      cwd: repoDir,
      git,
    });
    expect(exit).toBe(0);
    expect(
      fs.existsSync(path.join(path.dirname(manifestPath), "status.json")),
    ).toBe(true);
    const commitCall = calls.find((c) => c[0] === "commit");
    expect(commitCall).toBeDefined();
    expect(commitCall).toContain("--");
    expect(commitCall).toContain(".flow/epics/watchlist/status.json");
  });

  it("--commit when the commit runner exits non-zero: exit 0, committed:false + commitSkipReason, stderr warns", () => {
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    const { git } = makeGit((argv) => {
      if (argv[0] === "status")
        return { stdout: " M .flow/epics/watchlist/status.json\n" };
      if (argv[0] === "add") return { exitCode: 0 };
      if (argv[0] === "commit")
        return { exitCode: 1, stderr: "refusing to commit\n" };
      return { exitCode: 0 };
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exit = main(["--epic-slug", "watchlist", "--commit", "--json"], {
        gh,
        epicsDir,
        cwd: repoDir,
        git,
      });
      expect(exit).toBe(0);
      const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(printed.committed).toBe(false);
      expect(printed.commitSkipReason).toBe("commit-refused");
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes("--commit")),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("--commit when the board is byte-identical on disk but UNCOMMITTED: the rescue path still runs, not a silent no-op", () => {
    // Regression lock: `written` only means "differs from what's on disk";
    // a board that is already correct on disk but still uncommitted must
    // NOT skip the commit block, or the exact stranded-board incident this
    // command exists to fix would recur silently.
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    main(["--epic-slug", "watchlist"], { gh, epicsDir, cwd: repoDir });
    const { git, calls } = makeGit((argv) => {
      if (argv[0] === "status")
        return { stdout: " M .flow/epics/watchlist/status.json\n" };
      if (argv[0] === "add") return { exitCode: 0 };
      if (argv[0] === "commit") return { exitCode: 0 };
      return { exitCode: 0 };
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exit = main(["--epic-slug", "watchlist", "--commit", "--json"], {
        gh,
        epicsDir,
        cwd: repoDir,
        git,
      });
      expect(exit).toBe(0);
      expect(calls.some((c) => c[0] === "commit")).toBe(true);
      const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(printed.committed).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("--commit when nothing is dirty at all: nothing-staged, committed:false", () => {
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    main(["--epic-slug", "watchlist"], { gh, epicsDir, cwd: repoDir });
    const { git, calls } = makeGit(() => ({ exitCode: 0, stdout: "" }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exit = main(["--epic-slug", "watchlist", "--commit", "--json"], {
        gh,
        epicsDir,
        cwd: repoDir,
        git,
      });
      expect(exit).toBe(0);
      expect(calls.some((c) => c[0] === "commit")).toBe(false);
      const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(printed.committed).toBe(false);
      expect(printed.commitSkipReason).toBe("nothing-staged");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("--push implies --commit: passing ONLY --push still emits the commit argv, then the push argv, committed:true pushed:true", () => {
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    const { git, calls } = makeGit((argv) => {
      if (argv[0] === "status")
        return { stdout: " M .flow/epics/watchlist/status.json\n" };
      if (argv[0] === "rev-parse") return { stdout: "main\n" };
      if (argv[0] === "symbolic-ref") return { stdout: "origin/main\n" };
      return { exitCode: 0 };
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exit = main(["--epic-slug", "watchlist", "--push", "--json"], {
        gh,
        epicsDir,
        cwd: repoDir,
        git,
      });
      expect(exit).toBe(0);
      expect(calls.some((c) => c[0] === "commit")).toBe(true);
      const pushCall = calls.find((c) => c.includes("push"));
      expect(pushCall).toEqual([
        "-c",
        "core.askPass=",
        "push",
        "origin",
        "HEAD:main",
      ]);
      const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(printed.committed).toBe(true);
      expect(printed.pushed).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("one case per PushSkipReason reachable from this level", () => {
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });

    const runPush = (respond: (argv: string[]) => GitResp | undefined) => {
      // Each sub-case must re-see the board as freshly written (`written:
      // true`) so the commit/push block actually runs — remove any status.json
      // left by a prior sub-case in this same test.
      fs.rmSync(path.join(path.dirname(manifestPath), "status.json"), {
        force: true,
      });
      const { git, calls } = makeGit(respond);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const exit = main(["--epic-slug", "watchlist", "--push", "--json"], {
          gh,
          epicsDir,
          cwd: repoDir,
          git,
        });
        const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
        return { exit, printed, calls };
      } finally {
        logSpy.mockRestore();
      }
    };

    // detached-head
    {
      const { exit, printed, calls } = runPush((argv) => {
        if (argv[0] === "status") return { stdout: " M x\n" };
        if (argv[0] === "rev-parse") return { stdout: "HEAD\n" };
        return { exitCode: 0 };
      });
      expect(exit).toBe(0);
      expect(printed.pushed).toBe(false);
      expect(printed.pushSkipReason).toBe("detached-head");
      expect(calls.some((c) => c.includes("push"))).toBe(false);
    }

    // not-base-branch
    {
      const { exit, printed, calls } = runPush((argv) => {
        if (argv[0] === "status") return { stdout: " M x\n" };
        if (argv[0] === "rev-parse") return { stdout: "feat/x\n" };
        if (argv[0] === "symbolic-ref") return { stdout: "origin/main\n" };
        return { exitCode: 0 };
      });
      expect(exit).toBe(0);
      expect(printed.pushed).toBe(false);
      expect(printed.pushSkipReason).toBe("not-base-branch");
      expect(calls.some((c) => c.includes("push"))).toBe(false);
    }

    // no-remote
    {
      const { exit, printed, calls } = runPush((argv) => {
        if (argv[0] === "status") return { stdout: " M x\n" };
        if (argv[0] === "rev-parse") return { stdout: "main\n" };
        if (argv[0] === "symbolic-ref") return { stdout: "origin/main\n" };
        if (argv[0] === "remote") return { exitCode: 1 };
        return { exitCode: 0 };
      });
      expect(exit).toBe(0);
      expect(printed.pushed).toBe(false);
      expect(printed.pushSkipReason).toBe("no-remote");
      expect(calls.some((c) => c.includes("push"))).toBe(false);
    }

    // no-remote-branch
    {
      const { exit, printed, calls } = runPush((argv) => {
        if (argv[0] === "status") return { stdout: " M x\n" };
        if (argv[0] === "rev-parse") return { stdout: "main\n" };
        if (argv[0] === "symbolic-ref") return { stdout: "origin/main\n" };
        if (argv[0] === "remote") return { exitCode: 0 };
        if (argv.includes("ls-remote")) return { exitCode: 1 };
        return { exitCode: 0 };
      });
      expect(exit).toBe(0);
      expect(printed.pushed).toBe(false);
      expect(printed.pushSkipReason).toBe("no-remote-branch");
      expect(calls.some((c) => c.includes("push"))).toBe(false);
    }

    // non-fast-forward
    {
      const { exit, printed } = runPush((argv) => {
        if (argv[0] === "status") return { stdout: " M x\n" };
        if (argv[0] === "rev-parse") return { stdout: "main\n" };
        if (argv[0] === "symbolic-ref") return { stdout: "origin/main\n" };
        if (argv[0] === "remote") return { exitCode: 0 };
        if (argv.includes("ls-remote")) return { exitCode: 0 };
        if (argv.includes("push")) {
          return { exitCode: 1, stderr: "! [rejected] (non-fast-forward)\n" };
        }
        return { exitCode: 0 };
      });
      expect(exit).toBe(0);
      expect(printed.pushed).toBe(false);
      expect(printed.pushSkipReason).toBe("non-fast-forward");
    }

    // push-failed
    {
      const { exit, printed } = runPush((argv) => {
        if (argv[0] === "status") return { stdout: " M x\n" };
        if (argv[0] === "rev-parse") return { stdout: "main\n" };
        if (argv[0] === "symbolic-ref") return { stdout: "origin/main\n" };
        if (argv[0] === "remote") return { exitCode: 0 };
        if (argv.includes("ls-remote")) return { exitCode: 0 };
        if (argv.includes("push")) return { exitCode: 1, stderr: "fatal: x\n" };
        return { exitCode: 0 };
      });
      expect(exit).toBe(0);
      expect(printed.pushed).toBe(false);
      expect(printed.pushSkipReason).toBe("push-failed");
    }

    // not-committed: commit itself fails, so push is never attempted
    {
      fs.rmSync(path.join(path.dirname(manifestPath), "status.json"), {
        force: true,
      });
      const { git, calls } = makeGit((argv) => {
        if (argv[0] === "status") return { stdout: " M x\n" };
        if (argv[0] === "add") return { exitCode: 0 };
        if (argv[0] === "commit") return { exitCode: 1, stderr: "refused\n" };
        return { exitCode: 0 };
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const exit = main(["--epic-slug", "watchlist", "--push", "--json"], {
          gh,
          epicsDir,
          cwd: repoDir,
          git,
        });
        expect(exit).toBe(0);
        const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
        expect(printed.committed).toBe(false);
        expect(printed.pushed).toBe(false);
        expect(printed.pushSkipReason).toBe("not-committed");
        expect(calls.some((c) => c.includes("push"))).toBe(false);
      } finally {
        logSpy.mockRestore();
      }
    }
  });

  it("--check + --commit: no write, no commit argv, drift exit code preserved, no-op warning on stderr", () => {
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    const { git, calls } = makeGit(() => ({ exitCode: 0 }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const exit = main(["--epic-slug", "watchlist", "--check", "--commit"], {
        gh,
        epicsDir,
        cwd: repoDir,
        git,
      });
      expect(exit).toBe(1); // drift exit preserved
      expect(calls.some((c) => c[0] === "commit")).toBe(false);
      expect(
        fs.existsSync(path.join(path.dirname(manifestPath), "status.json")),
      ).toBe(false);
      expect(
        errSpy.mock.calls.some((c) =>
          String(c[0]).includes("no-ops under --check"),
        ),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("REGRESSION PIN: a bare invocation emits NO git argv and committed:false, pushed:false", () => {
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    const { git, calls } = makeGit(() => ({ exitCode: 0 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exit = main(["--epic-slug", "watchlist", "--json"], {
        gh,
        epicsDir,
        cwd: repoDir,
        git,
      });
      expect(exit).toBe(0);
      expect(calls.length).toBe(0);
      const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(printed.committed).toBe(false);
      expect(printed.pushed).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("REGRESSION PIN: a read invocation with NO cached run-state still derives via the unconditional cwd fallback", () => {
    // No seedRunState() call — this pins the cwd FALLBACK (unconditional,
    // every invocation type), not the cwd PREFERENCE (write-only). A prior
    // regression gated the fallback itself on isWriteInvocation, which
    // silently broke every read with no run.json (post-`flow epic done`
    // archive, a second machine, or a bare `flow-epic-sync` never preceded
    // by `flow epic run`).
    const gh = ghForHeads({ "feature-a": 101 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exit = main(["--epic-slug", "watchlist", "--json"], {
        gh,
        epicsDir,
        cwd: repoDir,
      });
      expect(exit).toBe(0);
      const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(printed.derived).toBe(true);
      expect(Object.keys(printed.features).length).toBeGreaterThan(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("REGRESSION PIN: --check with no cached run-state in a repo carrying the epic derives and diffs for real, instead of a blanket exit 1 from an unresolved manifest", () => {
    const gh = ghForHeads({ "feature-a": 101 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exit = main(["--epic-slug", "watchlist", "--check", "--json"], {
        gh,
        epicsDir,
        cwd: repoDir,
      });
      // No committed status.json yet, so this IS real drift (exit 1) — the
      // regression this pins is a manifest that can't even be resolved
      // (derived:false, features:{}), not a legitimate out-of-sync result.
      expect(exit).toBe(1);
      const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(printed.derived).toBe(true);
      expect(Object.keys(printed.features).length).toBeGreaterThan(0);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("main — foreign-repo containment", () => {
  let stateDir: string;
  let epicsDir: string;
  let repoA: string;
  let repoB: string;
  let manifestPath: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-sync-state-"));
    epicsDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-sync-epics-"));
    repoA = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-sync-repoA-"));
    repoB = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-sync-repoB-"));
    spawnSync("git", ["init", "-q"], { cwd: repoA });
    spawnSync("git", ["init", "-q"], { cwd: repoB });
    const epicDir = path.join(repoA, ".flow", "epics", "watchlist");
    fs.mkdirSync(epicDir, { recursive: true });
    manifestPath = path.join(epicDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(epicsDir, { recursive: true, force: true });
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
  });

  function seedRunState(overrides: Partial<EpicRunState> = {}): void {
    const rs: EpicRunState = {
      epicSlug: "watchlist",
      repo: repoA,
      manifestPath,
      manifestSha: "deadbeef",
      createdAt: ISO,
      updatedAt: ISO,
      features: {},
      ...overrides,
    };
    writeEpicRunState(rs, epicsDir);
  }

  it("(a) cwd outside the epic's repo: --commit --push both skip foreign-repo, no git mutation argv, and the foreign tree is never written to", () => {
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    const { git, calls } = makeGit(() => ({ exitCode: 0 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exit = main(
        ["--epic-slug", "watchlist", "--commit", "--push", "--json"],
        { gh, epicsDir, cwd: repoB, git },
      );
      expect(exit).toBe(0);
      const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(printed.committed).toBe(false);
      expect(printed.commitSkipReason).toBe("foreign-repo");
      expect(printed.pushed).toBe(false);
      expect(printed.pushSkipReason).toBe("foreign-repo");
      expect(
        calls.some(
          (c) => c[0] === "add" || c[0] === "commit" || c.includes("push"),
        ),
      ).toBe(false);
      // The containment gate must fire BEFORE the write, not just before
      // the commit/push: repoA (the cached, foreign path) must stay clean.
      expect(
        fs.existsSync(path.join(path.dirname(manifestPath), "status.json")),
      ).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("(b) repoB independently carries the same epic slug: cwd-local board wins, write lands in repoB, commit proceeds", () => {
    const epicDirB = path.join(repoB, ".flow", "epics", "watchlist");
    fs.mkdirSync(epicDirB, { recursive: true });
    fs.writeFileSync(
      path.join(epicDirB, "manifest.json"),
      JSON.stringify(MANIFEST),
    );
    seedRunState(); // cached manifestPath still points at repoA
    const gh = ghForHeads({ "feature-a": 101 });
    const { git, calls } = makeGit((argv) => {
      if (argv[0] === "status")
        return { stdout: " M .flow/epics/watchlist/status.json\n" };
      return { exitCode: 0 };
    });
    const exit = main(["--epic-slug", "watchlist", "--commit"], {
      gh,
      epicsDir,
      cwd: repoB,
      git,
    });
    expect(exit).toBe(0);
    expect(fs.existsSync(path.join(epicDirB, "status.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(path.dirname(manifestPath), "status.json")),
    ).toBe(false);
    expect(calls.some((c) => c[0] === "commit")).toBe(true);
  });

  it("(c) repoB carries a MALFORMED cwd-local manifest.json: the WRITE falls through to the cached (repoA) path rather than short-circuiting", () => {
    const epicDirB = path.join(repoB, ".flow", "epics", "watchlist");
    fs.mkdirSync(epicDirB, { recursive: true });
    fs.writeFileSync(path.join(epicDirB, "manifest.json"), "{ not valid json");
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    const { git } = makeGit(() => ({ exitCode: 0 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // --commit so the cwd-preference is actually consulted (it is gated on
      // a write invocation); the malformed repoB candidate must NOT win.
      const exit = main(["--epic-slug", "watchlist", "--commit", "--json"], {
        gh,
        epicsDir,
        cwd: repoB,
        git,
      });
      expect(exit).toBe(0);
      const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
      // Fell through to the cached (repoA) manifest -> real derivation,
      // NOT the empty envelope's derived:false / features:{}.
      expect(printed.derived).toBe(true);
      expect(Object.keys(printed.features).length).toBeGreaterThan(0);
      // And because it resolved to repoA while cwd is repoB, the containment
      // gate fires — proving the malformed repoB candidate did not win.
      expect(printed.commitSkipReason).toBe("foreign-repo");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("(d) READ-PATH PIN: --check/--json resolve cached-first even when the cwd repo carries the same epic slug", () => {
    // The cwd-preferred resolution is deliberately gated on a WRITE
    // invocation. Reads keep the documented "usable from any cwd" property:
    // they must report the CACHED board (repoA), never silently switch to a
    // same-slug board that happens to sit in the operator's own repo.
    // repoB's manifest is deliberately DISTINGUISHABLE from repoA's (an
    // extra feature) — if the read ever preferred cwd it would derive a
    // different feature set and this pin would catch it, instead of two
    // byte-identical manifests silently passing either way.
    const epicDirB = path.join(repoB, ".flow", "epics", "watchlist");
    fs.mkdirSync(epicDirB, { recursive: true });
    const manifestB: EpicManifest = {
      ...MANIFEST,
      features: [
        ...MANIFEST.features,
        {
          id: "feature-repob-only",
          title: "D",
          description: "d",
          dependsOn: [],
        },
      ],
    };
    fs.writeFileSync(
      path.join(epicDirB, "manifest.json"),
      JSON.stringify(manifestB),
    );
    seedRunState(); // cached manifestPath points at repoA
    const gh = ghForHeads({ "feature-a": 101 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exit = main(["--epic-slug", "watchlist", "--json"], {
        gh,
        epicsDir,
        cwd: repoB,
      });
      expect(exit).toBe(0);
      const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(printed.derived).toBe(true);
      // Reports the CACHED (repoA) board, not repoB's extra feature.
      expect(printed.features["feature-repob-only"]).toBeUndefined();
      // A read never writes, and never surfaces a containment reason.
      expect(printed.commitSkipReason).toBeUndefined();
      expect(printed.pushSkipReason).toBeUndefined();
      // The read did not touch repoB's board.
      expect(fs.existsSync(path.join(epicDirB, "status.json"))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("(e) --check --json from a cwd outside the epic's repo still derives and reports as before, and never surfaces a foreign-repo reason (the read-path guard)", () => {
    seedRunState();
    const gh = ghForHeads({ "feature-a": 101 });
    main(["--epic-slug", "watchlist"], { gh, epicsDir, cwd: repoA });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exit = main(["--epic-slug", "watchlist", "--check", "--json"], {
        gh,
        epicsDir,
        cwd: repoB,
      });
      expect(exit).toBe(0);
      const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(printed.derived).toBe(true);
      expect(printed.written).toBe(false);
      // A --check invocation from a foreign cwd never touches, warns about,
      // or errors on containment — the read-path guard applies before the
      // gate is ever consulted.
      expect(errorSpy.mock.calls.join("\n")).not.toMatch(/foreign-repo/);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
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
