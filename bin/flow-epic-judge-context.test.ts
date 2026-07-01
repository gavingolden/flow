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
import {
  writeEpicRunState,
  readEpicRunState,
  type EpicRunState,
} from "./lib/epic-run-state";
import type { GhRunner } from "./lib/resume-probes";

// ---------------------------------------------------------------------------
// Temp dirs + fixtures
// ---------------------------------------------------------------------------

const ISO = "2026-06-30T00:00:00Z";
const FIXED_NOW = "2026-06-30T12:00:00Z";

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
// context mode — feature
// ---------------------------------------------------------------------------

describe("context mode — feature flags", () => {
  it("marks a gated feature overridable:false", () => {
    writeEpicRunState(baseRunState(), epicsDir);
    seedFeatureState("foundation-slug", "gated");
    const { exit, out } = runJson(
      ["context", "--slug", "epic-x", "--feature", "foundation"],
      { stateDir, epicsDir, gh: ghNone, maxRetries: 2, maxRedirects: 1 },
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
      { stateDir, epicsDir, gh: ghNone, maxRetries: 2, maxRedirects: 1 },
    );
    expect(out.status).toBe("needs-human");
    expect((out.flags as Record<string, unknown>).overridable).toBe(true);
  });

  it("budgetExhausted:true when retryCount >= maxRetries", () => {
    const rs = baseRunState();
    rs.features.foundation.retryCount = 2;
    writeEpicRunState(rs, epicsDir);
    seedFeatureState("foundation-slug", "needs-human");
    const { out } = runJson(
      ["context", "--slug", "epic-x", "--feature", "foundation"],
      { stateDir, epicsDir, gh: ghNone, maxRetries: 2, maxRedirects: 1 },
    );
    expect(out.retryCount).toBe(2);
    expect((out.flags as Record<string, unknown>).budgetExhausted).toBe(true);
  });

  it("budgetExhausted:false when retryCount < maxRetries", () => {
    const rs = baseRunState();
    rs.features.foundation.retryCount = 1;
    writeEpicRunState(rs, epicsDir);
    seedFeatureState("foundation-slug", "needs-human");
    const { out } = runJson(
      ["context", "--slug", "epic-x", "--feature", "foundation"],
      { stateDir, epicsDir, gh: ghNone, maxRetries: 2, maxRedirects: 1 },
    );
    expect((out.flags as Record<string, unknown>).budgetExhausted).toBe(false);
  });

  it("redirectExhausted:false when redirectCount < maxRedirects", () => {
    const rs = baseRunState();
    rs.features.foundation.redirectCount = 0;
    writeEpicRunState(rs, epicsDir);
    seedFeatureState("foundation-slug", "needs-human");
    const { out } = runJson(
      ["context", "--slug", "epic-x", "--feature", "foundation"],
      { stateDir, epicsDir, gh: ghNone, maxRetries: 2, maxRedirects: 1 },
    );
    expect(out.redirectCount).toBe(0);
    expect((out.flags as Record<string, unknown>).redirectExhausted).toBe(
      false,
    );
  });

  it("redirectExhausted:true when redirectCount >= maxRedirects", () => {
    const rs = baseRunState();
    rs.features.foundation.redirectCount = 1;
    writeEpicRunState(rs, epicsDir);
    seedFeatureState("foundation-slug", "needs-human");
    const { out } = runJson(
      ["context", "--slug", "epic-x", "--feature", "foundation"],
      { stateDir, epicsDir, gh: ghNone, maxRetries: 2, maxRedirects: 1 },
    );
    expect(out.redirectCount).toBe(1);
    expect((out.flags as Record<string, unknown>).redirectExhausted).toBe(true);
  });

  it("includes the manifest neighbourhood (node + direct dependents)", () => {
    writeEpicRunState(baseRunState(), epicsDir);
    seedFeatureState("foundation-slug", "needs-human");
    const { out } = runJson(
      ["context", "--slug", "epic-x", "--feature", "foundation"],
      { stateDir, epicsDir, gh: ghNone, maxRetries: 2, maxRedirects: 1 },
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
      { stateDir, epicsDir, gh, maxRetries: 2, maxRedirects: 1 },
    );
    expect(out.pr).toBe(42);
    const ci = out.ciFailure as Record<string, unknown>;
    expect(ci.failingChecks).toEqual(["verify"]);
    expect(ci.truncated).toBe(true);
  });

  it("tolerantly reports run-state-missing without throwing", () => {
    const { exit, out } = runJson(
      ["context", "--slug", "no-such-epic", "--feature", "foundation"],
      { stateDir, epicsDir, gh: ghNone, maxRetries: 2, maxRedirects: 1 },
    );
    expect(exit).toBe(0);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("run-state-missing");
  });
});

// ---------------------------------------------------------------------------
// context mode — deadlock
// ---------------------------------------------------------------------------

describe("context mode — deadlock", () => {
  it("assembles the board + run-state + neighbourhoods + drift flag", () => {
    writeEpicRunState(baseRunState(), epicsDir);
    seedFeatureState("foundation-slug", "needs-human");
    const { exit, out } = runJson(
      ["context", "--slug", "epic-x", "--deadlock"],
      {
        stateDir,
        epicsDir,
        gh: ghNone,
      },
    );
    expect(exit).toBe(0);
    expect(out.mode).toBe("deadlock");
    expect(Array.isArray(out.board)).toBe(true);
    expect((out.board as unknown[]).length).toBe(2);
    expect(Array.isArray(out.neighbourhoods)).toBe(true);
    // manifestSha "deadbeef" never matches the real file hash → drift true.
    expect(typeof out.manifestDrift).toBe("boolean");
    expect(out.manifestDrift).toBe(true);
    const rs = out.runState as Record<string, unknown>;
    expect(rs.features).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// record mode
// ---------------------------------------------------------------------------

describe("record mode", () => {
  it("increments retryCount and writes lastJudgment with the injected clock", () => {
    writeEpicRunState(baseRunState(), epicsDir);
    const { exit, out } = runJson(
      [
        "record",
        "--slug",
        "epic-x",
        "--feature",
        "foundation",
        "--action",
        "retry",
        "--reason",
        "transient flake",
        "--increment-retry",
      ],
      { stateDir, epicsDir, now: () => FIXED_NOW },
    );
    expect(exit).toBe(0);
    expect(out.ok).toBe(true);
    const record = out.record as Record<string, unknown>;
    expect(record.retryCount).toBe(1);
    const lj = record.lastJudgment as Record<string, unknown>;
    expect(lj.action).toBe("retry");
    expect(lj.reason).toBe("transient flake");
    expect(lj.at).toBe(FIXED_NOW);

    // Persisted back to disk.
    const persisted = readEpicRunState("epic-x", epicsDir);
    expect(persisted?.features.foundation.retryCount).toBe(1);
    expect(persisted?.features.foundation.lastJudgment?.at).toBe(FIXED_NOW);
    expect(persisted?.updatedAt).toBe(FIXED_NOW);
  });

  it("does NOT increment retryCount without --increment-retry", () => {
    writeEpicRunState(baseRunState(), epicsDir);
    const { out } = runJson(
      [
        "record",
        "--slug",
        "epic-x",
        "--feature",
        "foundation",
        "--action",
        "escalate",
        "--reason",
        "budget exhausted",
      ],
      { stateDir, epicsDir, now: () => FIXED_NOW },
    );
    const record = out.record as Record<string, unknown>;
    expect(record.retryCount).toBeUndefined();
    expect((record.lastJudgment as Record<string, unknown>).action).toBe(
      "escalate",
    );
  });

  it("sets runnerPhase when --runner-phase is passed", () => {
    writeEpicRunState(baseRunState(), epicsDir);
    const { out } = runJson(
      [
        "record",
        "--slug",
        "epic-x",
        "--feature",
        "foundation",
        "--action",
        "escalate",
        "--reason",
        "blocked",
        "--runner-phase",
        "blocked",
      ],
      { stateDir, epicsDir, now: () => FIXED_NOW },
    );
    expect(out.runnerPhase).toBe("blocked");
    expect(readEpicRunState("epic-x", epicsDir)?.runnerPhase).toBe("blocked");
  });

  it("runner-phase-only record stamps runnerPhase and touches no feature", () => {
    const rs = baseRunState();
    rs.features.foundation.retryCount = 1;
    rs.features.foundation.lastJudgment = {
      action: "retry",
      reason: "pre-seeded",
      at: ISO,
    };
    writeEpicRunState(rs, epicsDir);
    const { exit, out } = runJson(
      ["record", "--slug", "epic-x", "--runner-phase", "running"],
      { stateDir, epicsDir, now: () => FIXED_NOW },
    );
    expect(exit).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.runnerPhase).toBe("running");
    expect(out.featureId).toBe(null);
    expect(out.record).toBe(null);

    // Persisted runnerPhase, and the pre-seeded feature record is untouched.
    const persisted = readEpicRunState("epic-x", epicsDir);
    expect(persisted?.runnerPhase).toBe("running");
    expect(persisted?.features.foundation.retryCount).toBe(1);
    expect(persisted?.features.foundation.lastJudgment?.reason).toBe(
      "pre-seeded",
    );
    expect(persisted?.updatedAt).toBe(FIXED_NOW);
  });

  it("repoints the slug on --action redirect --relaunch-slug and appends the old slug to priorSlugs", () => {
    writeEpicRunState(baseRunState(), epicsDir);
    const { exit, out } = runJson(
      [
        "record",
        "--slug",
        "epic-x",
        "--feature",
        "foundation",
        "--action",
        "redirect",
        "--reason",
        "wrong approach; changed strategy",
        "--relaunch-slug",
        "foundation-slug-v2",
      ],
      { stateDir, epicsDir, now: () => FIXED_NOW },
    );
    expect(exit).toBe(0);
    expect(out.ok).toBe(true);
    const record = out.record as Record<string, unknown>;
    expect(record.slug).toBe("foundation-slug-v2");
    expect(record.priorSlugs).toEqual(["foundation-slug"]);
    expect(record.redirectCount).toBe(1);
    expect((record.lastJudgment as Record<string, unknown>).action).toBe(
      "redirect",
    );

    // Persisted back to disk: reconciler keys on the repointed slug.
    const persisted = readEpicRunState("epic-x", epicsDir);
    expect(persisted?.features.foundation.slug).toBe("foundation-slug-v2");
    expect(persisted?.features.foundation.priorSlugs).toEqual([
      "foundation-slug",
    ]);
    expect(persisted?.features.foundation.redirectCount).toBe(1);
  });

  it("exits 2 when --relaunch-slug is paired with --action retry (usage error)", () => {
    writeEpicRunState(baseRunState(), epicsDir);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(
      [
        "record",
        "--slug",
        "epic-x",
        "--feature",
        "foundation",
        "--action",
        "retry",
        "--reason",
        "x",
        "--relaunch-slug",
        "foundation-slug-v2",
      ],
      { stateDir, epicsDir, now: () => FIXED_NOW },
    );
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });

  it("tolerantly reports feature-not-in-run-state", () => {
    writeEpicRunState(baseRunState(), epicsDir);
    const { exit, out } = runJson(
      [
        "record",
        "--slug",
        "epic-x",
        "--feature",
        "ghost",
        "--action",
        "retry",
        "--reason",
        "x",
      ],
      { stateDir, epicsDir, now: () => FIXED_NOW },
    );
    expect(exit).toBe(0);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("feature-not-in-run-state");
  });

  it("treats a '__proto__' feature key as not-found and does not pollute Object.prototype", () => {
    writeEpicRunState(baseRunState(), epicsDir);
    const { exit, out } = runJson(
      [
        "record",
        "--slug",
        "epic-x",
        "--feature",
        "__proto__",
        "--action",
        "retry",
        "--reason",
        "x",
        "--increment-retry",
      ],
      { stateDir, epicsDir, now: () => FIXED_NOW },
    );
    expect(exit).toBe(0);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("feature-not-in-run-state");
    // The Object.hasOwn guard means the bracket lookup never resolved to
    // Object.prototype, so the record-write below never fired against it.
    expect(({} as Record<string, unknown>).lastJudgment).toBeUndefined();
    expect(({} as Record<string, unknown>).retryCount).toBeUndefined();
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
      deadlock: false,
    });
  });

  it("parses --deadlock as a context variant", () => {
    expect(parseArgs(["--slug", "e", "--deadlock"])).toEqual({
      mode: "context",
      slug: "e",
      deadlock: true,
    });
  });

  it("errors when --slug is missing", () => {
    expect(parseArgs(["--feature", "f"])).toEqual({
      error: "--slug <epic-slug> is required",
    });
  });

  it("errors on a bad record --action", () => {
    const r = parseArgs([
      "record",
      "--slug",
      "e",
      "--feature",
      "f",
      "--action",
      "merge",
      "--reason",
      "x",
    ]);
    expect("error" in r && r.error).toMatch(/--action/);
  });

  it("parses --relaunch-slug with --action redirect", () => {
    expect(
      parseArgs([
        "record",
        "--slug",
        "e",
        "--feature",
        "f",
        "--action",
        "redirect",
        "--reason",
        "x",
        "--relaunch-slug",
        "f-v2",
      ]),
    ).toEqual({
      mode: "record",
      args: {
        slug: "e",
        feature: "f",
        action: "redirect",
        reason: "x",
        incrementRetry: false,
        relaunchSlug: "f-v2",
        runnerPhase: undefined,
      },
    });
  });

  it("errors when --relaunch-slug is paired with a non-redirect action", () => {
    const r = parseArgs([
      "record",
      "--slug",
      "e",
      "--feature",
      "f",
      "--action",
      "escalate",
      "--reason",
      "x",
      "--relaunch-slug",
      "f-v2",
    ]);
    expect("error" in r && r.error).toMatch(/--relaunch-slug/);
  });

  it("parses a runner-phase-only record (no feature/action/reason)", () => {
    expect(
      parseArgs(["record", "--slug", "e", "--runner-phase", "running"]),
    ).toEqual({
      mode: "record",
      args: { slug: "e", incrementRetry: false, runnerPhase: "running" },
    });
  });

  it("errors on record with neither --feature nor --runner-phase", () => {
    const r = parseArgs(["record", "--slug", "e"]);
    expect("error" in r && r.error).toMatch(/--feature/);
    expect("error" in r && r.error).toMatch(/--runner-phase/);
  });

  it("run() exits 2 on a CLI usage error", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--feature", "f"], { stateDir, epicsDir });
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });
});
