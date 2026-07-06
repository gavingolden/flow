import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  run,
  parseArgs,
  tailBound,
  fetchCiFailure,
  fetchPrReview,
  CI_LOG_TAIL_LINES,
  CI_LOG_TAIL_BYTES,
} from "./flow-epic-judge-context";
import { writeState, type PipelineState } from "./lib/state";
import { writeEpicRunState, type EpicRunState } from "./lib/epic-run-state";
import type { GhRunner } from "./lib/resume-probes";

// ---------------------------------------------------------------------------
// Temp dirs + fixtures
// ---------------------------------------------------------------------------

const ISO = "2026-06-30T00:00:00Z";

let stateDir!: string;
let epicsDir!: string;
let manifestPath!: string;

const MANIFEST = {
  epicId: "epic-x",
  prompt: "overhaul everything",
  createdAt: ISO,
  features: [
    {
      id: "foundation",
      title: "Foundation",
      description: "the base layer",
      dependsOn: [],
    },
    {
      id: "shell",
      title: "Shell",
      description: "the app shell",
      dependsOn: ["foundation"],
    },
  ],
};

function baseRunState(overrides: Partial<EpicRunState> = {}): EpicRunState {
  return {
    epicSlug: "epic-x",
    repo: "/tmp/repo",
    manifestPath,
    manifestSha: "deadbeef",
    maxParallel: 3,
    createdAt: ISO,
    updatedAt: ISO,
    features: {
      foundation: { slug: "foundation-slug", launchedAt: ISO, pr: 42 },
      shell: { slug: "shell-slug", launchedAt: ISO },
    },
    ...overrides,
  };
}

function seedFeatureState(slug: string, phase: string, pr?: number): void {
  const s: PipelineState = {
    slug,
    phase,
    repo: "/tmp/repo",
    updatedAt: ISO,
  };
  if (pr !== undefined) s.pr = pr;
  writeState(s, stateDir);
}

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    writes.push(s.toString());
    return true;
  });
  return { writes, restore: () => spy.mockRestore() };
}

/** Default gh stub: no checks, no PR review (exitCode 1 on every call). */
const ghNone: GhRunner = () => ({ stdout: "", stderr: "", exitCode: 1 });

function runJson(
  argv: string[],
  deps: Parameters<typeof run>[1],
): {
  exit: number;
  out: Record<string, unknown>;
} {
  const { writes, restore } = captureStdout();
  const exit = run(argv, deps);
  restore();
  return { exit, out: JSON.parse(writes.join("")) as Record<string, unknown> };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-judge-state-"));
  epicsDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-judge-epics-"));
  manifestPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "flow-judge-manifest-")),
    "manifest.json",
  );
  fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(epicsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// tailBound (pure)
// ---------------------------------------------------------------------------

describe(tailBound, () => {
  it("returns short text unchanged and untruncated", () => {
    const r = tailBound("line1\nline2\nline3");
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("line1\nline2\nline3");
  });

  it("clamps to the last CI_LOG_TAIL_LINES lines", () => {
    const text = Array.from({ length: CI_LOG_TAIL_LINES + 50 }, (_, i) =>
      String(i),
    ).join("\n");
    const r = tailBound(text);
    expect(r.truncated).toBe(true);
    expect(r.text.split("\n").length).toBe(CI_LOG_TAIL_LINES);
    // The tail must contain the LAST line, never the first.
    expect(r.text.endsWith(String(CI_LOG_TAIL_LINES + 49))).toBe(true);
    expect(r.text.startsWith("0\n")).toBe(false);
  });

  it("clamps to the last CI_LOG_TAIL_BYTES bytes for a single huge line", () => {
    const text = "x".repeat(CI_LOG_TAIL_BYTES * 3);
    const r = tailBound(text);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(
      CI_LOG_TAIL_BYTES,
    );
  });
});

// ---------------------------------------------------------------------------
// fetchCiFailure (stubbed gh)
// ---------------------------------------------------------------------------

describe(fetchCiFailure, () => {
  it("collects failing check names and tail-bounds the failed-run log", () => {
    const bigLog = Array.from(
      { length: CI_LOG_TAIL_LINES + 200 },
      (_, i) => `log line ${i}`,
    ).join("\n");
    const gh: GhRunner = (argv) => {
      if (argv[0] === "pr" && argv[1] === "checks") {
        return {
          stdout: JSON.stringify([
            {
              name: "verify",
              state: "FAILURE",
              link: "https://gh/o/r/actions/runs/777/job/1",
            },
            { name: "lint", state: "SUCCESS", link: "" },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      if (argv[0] === "run" && argv[1] === "view") {
        return { stdout: bigLog, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const ev = fetchCiFailure(42, gh);
    expect(ev.failingChecks).toEqual(["verify"]);
    expect(ev.truncated).toBe(true);
    expect(ev.logTail.split("\n").length).toBe(CI_LOG_TAIL_LINES);
    expect(ev.logTail).toContain(`log line ${CI_LOG_TAIL_LINES + 199}`);
  });

  it("degrades to empty evidence when gh fails", () => {
    const ev = fetchCiFailure(42, ghNone);
    expect(ev.failingChecks).toEqual([]);
    expect(ev.logTail).toBe("");
    expect(ev.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchPrReview (stubbed gh)
// ---------------------------------------------------------------------------

describe(fetchPrReview, () => {
  it("parses the populated success path (state + reviewDecision)", () => {
    const gh: GhRunner = (argv) => {
      if (argv[0] === "pr" && argv[1] === "view") {
        return {
          stdout: JSON.stringify({
            state: "OPEN",
            reviewDecision: "CHANGES_REQUESTED",
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    expect(fetchPrReview(42, gh)).toEqual({
      state: "OPEN",
      reviewDecision: "CHANGES_REQUESTED",
    });
  });

  it("degrades to null when gh exits non-zero", () => {
    expect(fetchPrReview(42, ghNone)).toBe(null);
  });

  it("degrades to null when the JSON payload fails to parse", () => {
    const gh: GhRunner = () => ({
      stdout: "not json {",
      stderr: "",
      exitCode: 0,
    });
    expect(fetchPrReview(42, gh)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// context mode — feature evidence
// ---------------------------------------------------------------------------

describe("context mode — feature evidence", () => {
  it("marks a gated feature overridable:false (escalate-only)", () => {
    writeEpicRunState(baseRunState(), epicsDir);
    seedFeatureState("foundation-slug", "gated");
    const { exit, out } = runJson(
      ["context", "--slug", "epic-x", "--feature", "foundation"],
      { stateDir, epicsDir, gh: ghNone },
    );
    expect(exit).toBe(0);
    expect(out.mode).toBe("feature");
    expect(out.status).toBe("gated");
    expect((out.flags as Record<string, unknown>).overridable).toBe(false);
  });

  it("marks a non-gated feature overridable:true", () => {
    writeEpicRunState(baseRunState(), epicsDir);
    seedFeatureState("foundation-slug", "needs-human");
    const { out } = runJson(
      ["context", "--slug", "epic-x", "--feature", "foundation"],
      { stateDir, epicsDir, gh: ghNone },
    );
    expect(out.status).toBe("needs-human");
    expect((out.flags as Record<string, unknown>).overridable).toBe(true);
  });

  it("includes the manifest neighbourhood (node + direct dependents)", () => {
    writeEpicRunState(baseRunState(), epicsDir);
    seedFeatureState("foundation-slug", "needs-human");
    const { out } = runJson(
      ["context", "--slug", "epic-x", "--feature", "foundation"],
      { stateDir, epicsDir, gh: ghNone },
    );
    const nb = out.neighbourhood as Record<string, unknown>;
    expect(nb.dependents).toEqual(["shell"]);
    expect((nb.feature as Record<string, unknown>).id).toBe("foundation");
  });

  it("attaches tail-bounded CI evidence keyed off the feature PR", () => {
    writeEpicRunState(baseRunState(), epicsDir);
    seedFeatureState("foundation-slug", "needs-human");
    const bigLog = Array.from(
      { length: CI_LOG_TAIL_LINES + 80 },
      (_, i) => `L${i}`,
    ).join("\n");
    const gh: GhRunner = (argv) => {
      if (argv[1] === "checks") {
        return {
          stdout: JSON.stringify([
            {
              name: "verify",
              state: "FAILURE",
              link: "https://gh/o/r/actions/runs/9/job/1",
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      if (argv[0] === "run") {
        return { stdout: bigLog, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const { out } = runJson(
      ["context", "--slug", "epic-x", "--feature", "foundation"],
      { stateDir, epicsDir, gh },
    );
    expect(out.pr).toBe(42);
    const ci = out.ciFailure as Record<string, unknown>;
    expect(ci.failingChecks).toEqual(["verify"]);
    expect(ci.truncated).toBe(true);
  });

  it("tolerates an external-completion record (no live slug) without throwing", () => {
    const rs = baseRunState();
    rs.features.foundation = { external: "PR #99", completedAt: ISO };
    writeEpicRunState(rs, epicsDir);
    const { exit, out } = runJson(
      ["context", "--slug", "epic-x", "--feature", "foundation"],
      { stateDir, epicsDir, gh: ghNone },
    );
    expect(exit).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.status).toBe("merged");
    // No live slug ⇒ no pipeline state read.
    expect(out.featureState).toBe(null);
  });

  it("tolerantly reports run-state-missing without throwing", () => {
    const { exit, out } = runJson(
      ["context", "--slug", "no-such-epic", "--feature", "foundation"],
      { stateDir, epicsDir, gh: ghNone },
    );
    expect(exit).toBe(0);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("run-state-missing");
  });
});

// ---------------------------------------------------------------------------
// parseArgs / CLI errors
// ---------------------------------------------------------------------------

describe(parseArgs, () => {
  it("defaults to the context subcommand", () => {
    expect(parseArgs(["--slug", "e", "--feature", "f"])).toEqual({
      mode: "context",
      slug: "e",
      feature: "f",
    });
  });

  it("parses an explicit context subcommand", () => {
    expect(parseArgs(["context", "--slug", "e", "--feature", "f"])).toEqual({
      mode: "context",
      slug: "e",
      feature: "f",
    });
  });

  it("errors when --slug is missing", () => {
    expect(parseArgs(["--feature", "f"])).toEqual({
      error: "--slug <epic-slug> is required",
    });
  });

  it("errors when --feature is missing", () => {
    const r = parseArgs(["--slug", "e"]);
    expect("error" in r && r.error).toMatch(/--feature/);
  });

  it("run() exits 2 on a CLI usage error", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--feature", "f"], { stateDir, epicsDir });
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });
});
