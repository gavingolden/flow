import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateMergeGuard,
  OVERRIDE_FRESHNESS_MS,
  parseArgs,
  run,
  type GuardResult,
} from "./flow-merge-guard";
import type { PipelineState } from "./lib/state";

let stateDir!: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-merge-guard-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-05-22T12:00:00Z");

function seedState(slug: string, extra: Partial<PipelineState> = {}): void {
  const state: Record<string, unknown> = {
    slug,
    phase: "gating",
    repo: "/tmp/repo",
    updatedAt: "2026-05-22T11:00:00Z",
    ...extra,
  };
  fs.writeFileSync(path.join(stateDir, `${slug}.json`), JSON.stringify(state) + "\n");
}

function freshOverride(pr: number, ageMs = 0): PipelineState["gateOverride"] {
  return { pr, confirmedAt: new Date(NOW - ageMs).toISOString() };
}

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    writes.push(s.toString());
    return true;
  });
  return { writes, restore: () => spy.mockRestore() };
}

const HAS_UNCHECKED =
  "## Test Steps\n\n- [ ] Hover the legend entry — the popover opens\n- [ ] Run `npm run verify`\n";
const NO_UNCHECKED = "## Test Steps\n\n- [x] Run `npm run verify` — pass\n";
const MISSING_HEADING = "## Why\n\nbecause.\n";

// --- evaluateMergeGuard ----------------------------------------------------

describe(evaluateMergeGuard, () => {
  it("clears when the section has zero unchecked items", () => {
    const r = evaluateMergeGuard(NO_UNCHECKED, null, 1, NOW);
    expect(r.decision).toBe("clear");
    expect(r.uncheckedItems).toEqual([]);
    expect(r.overrideApplied).toBe(false);
  });

  it("blocks when unchecked items remain and no override token is present", () => {
    const r = evaluateMergeGuard(HAS_UNCHECKED, null, 1, NOW);
    expect(r.decision).toBe("blocked");
    expect(r.uncheckedItems).toEqual([
      "Hover the legend entry — the popover opens",
      "Run `npm run verify`",
    ]);
    expect(r.overrideApplied).toBe(false);
  });

  it("blocks when the state carries no gateOverride at all", () => {
    const state: PipelineState = {
      slug: "x",
      phase: "gating",
      repo: "/r",
      updatedAt: "2026-05-22T11:00:00Z",
    };
    expect(evaluateMergeGuard(HAS_UNCHECKED, state, 7, NOW).decision).toBe("blocked");
  });

  it("clears unchecked items when a fresh matching override token is present", () => {
    const state: PipelineState = {
      slug: "x",
      phase: "gating",
      repo: "/r",
      updatedAt: "2026-05-22T11:00:00Z",
      gateOverride: freshOverride(42),
    };
    const r = evaluateMergeGuard(HAS_UNCHECKED, state, 42, NOW);
    expect(r.decision).toBe("clear");
    expect(r.overrideApplied).toBe(true);
    // The unchecked items are still surfaced so the override is auditable.
    expect(r.uncheckedItems.length).toBe(2);
  });

  it("blocks when the override token is for a different PR", () => {
    const state: PipelineState = {
      slug: "x",
      phase: "gating",
      repo: "/r",
      updatedAt: "2026-05-22T11:00:00Z",
      gateOverride: freshOverride(99),
    };
    expect(evaluateMergeGuard(HAS_UNCHECKED, state, 42, NOW).decision).toBe("blocked");
  });

  it("blocks when the override token is stale (outside the freshness window)", () => {
    const state: PipelineState = {
      slug: "x",
      phase: "gating",
      repo: "/r",
      updatedAt: "2026-05-22T11:00:00Z",
      gateOverride: freshOverride(42, OVERRIDE_FRESHNESS_MS + 60_000),
    };
    expect(evaluateMergeGuard(HAS_UNCHECKED, state, 42, NOW).decision).toBe("blocked");
  });

  it("blocks when the override token has an unparseable confirmedAt", () => {
    // isGateOverride only typechecks confirmedAt as a string, so a
    // string-but-unparseable timestamp survives readState and reaches
    // tokenIsFresh — the malformed value must not clear the merge.
    const state: PipelineState = {
      slug: "x",
      phase: "gating",
      repo: "/r",
      updatedAt: "2026-05-22T11:00:00Z",
      gateOverride: { pr: 42, confirmedAt: "not-a-date" },
    };
    expect(evaluateMergeGuard(HAS_UNCHECKED, state, 42, NOW).decision).toBe("blocked");
  });

  it("blocks a missing heading even when a fresh override token is present", () => {
    // A missing heading is an upstream regression, not a user-skipped step —
    // the token must not clear it.
    const state: PipelineState = {
      slug: "x",
      phase: "gating",
      repo: "/r",
      updatedAt: "2026-05-22T11:00:00Z",
      gateOverride: freshOverride(42),
    };
    const r = evaluateMergeGuard(MISSING_HEADING, state, 42, NOW);
    expect(r.decision).toBe("blocked");
    expect(r.overrideApplied).toBe(false);
    expect(r.reason).toMatch(/heading missing/);
  });
});

// --- parseArgs -------------------------------------------------------------

describe(parseArgs, () => {
  it("requires a PR number", () => {
    expect(parseArgs([])).toEqual({ error: "PR number is required" });
  });

  it("rejects a non-positive PR", () => {
    expect(parseArgs(["0"])).toEqual({
      error: "PR must be a positive integer, got '0'",
    });
  });

  it("parses a PR-only invocation (check mode, slug auto-resolved)", () => {
    expect(parseArgs(["100"])).toEqual({ pr: 100, slug: undefined, recordOverride: false });
  });

  it("parses --record-override", () => {
    expect(parseArgs(["100", "--record-override"])).toEqual({
      pr: 100,
      slug: undefined,
      recordOverride: true,
    });
  });

  it("parses --slug with --record-override", () => {
    expect(parseArgs(["100", "--slug", "x", "--record-override"])).toEqual({
      pr: 100,
      slug: "x",
      recordOverride: true,
    });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["100", "--bogus"])).toEqual({ error: "unknown flag: --bogus" });
  });
});

// --- run() check mode ------------------------------------------------------

describe("run() check mode", () => {
  function ghBody(body: string, state = "OPEN") {
    return vi.fn(() => ({
      stdout: JSON.stringify({ body, state, url: "https://x/y/pull/5" }),
      stderr: "",
      exitCode: 0,
    }));
  }

  it("exits 0 with decision clear when the section has no unchecked items", () => {
    seedState("alpha");
    const cap = captureStdout();
    const exit = run(["5", "--slug", "alpha"], {
      gh: ghBody(NO_UNCHECKED),
      stateDir,
      now: () => NOW,
    });
    cap.restore();
    expect(exit).toBe(0);
    expect((JSON.parse(cap.writes.join("")) as GuardResult).decision).toBe("clear");
  });

  it("exits 1 with decision blocked when unchecked items remain and no token", () => {
    seedState("beta");
    const cap = captureStdout();
    const exit = run(["5", "--slug", "beta"], {
      gh: ghBody(HAS_UNCHECKED),
      stateDir,
      now: () => NOW,
    });
    cap.restore();
    expect(exit).toBe(1);
    expect((JSON.parse(cap.writes.join("")) as GuardResult).decision).toBe("blocked");
  });

  it("exits 0 when unchecked items remain but a fresh override token clears them", () => {
    seedState("gamma", { gateOverride: freshOverride(5) });
    const cap = captureStdout();
    const exit = run(["5", "--slug", "gamma"], {
      gh: ghBody(HAS_UNCHECKED),
      stateDir,
      now: () => NOW,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.writes.join("")) as GuardResult;
    expect(result.decision).toBe("clear");
    expect(result.overrideApplied).toBe(true);
  });

  it("exits 2 with decision error on a gh failure", () => {
    seedState("delta");
    const gh = vi.fn(() => ({ stdout: "", stderr: "no such PR", exitCode: 1 }));
    const cap = captureStdout();
    const exit = run(["5", "--slug", "delta"], { gh, stateDir, now: () => NOW });
    cap.restore();
    expect(exit).toBe(2);
    const result = JSON.parse(cap.writes.join("")) as { decision: string; reason: string };
    expect(result.decision).toBe("error");
    expect(result.reason).toContain("no such PR");
  });

  it("defers (clear, exit 0) when the PR is already MERGED", () => {
    seedState("epsilon");
    const cap = captureStdout();
    const exit = run(["5", "--slug", "epsilon"], {
      gh: ghBody(HAS_UNCHECKED, "MERGED"),
      stateDir,
      now: () => NOW,
    });
    cap.restore();
    expect(exit).toBe(0);
    expect((JSON.parse(cap.writes.join("")) as GuardResult).decision).toBe("clear");
  });

  it("exits 2 on bad args", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run([], { gh: vi.fn(), stateDir, now: () => NOW });
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });

  it("exits 2 when no slug is given and the pane has none either", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["5"], {
      gh: vi.fn(),
      stateDir,
      resolveSlug: () => null,
      now: () => NOW,
    });
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });
});

// --- run() record mode -----------------------------------------------------

describe("run() record mode", () => {
  it("writes a gateOverride token to state.json and exits 0", () => {
    seedState("zeta");
    const cap = captureStdout();
    const exit = run(["5", "--slug", "zeta", "--record-override"], {
      stateDir,
      now: () => NOW,
    });
    cap.restore();
    expect(exit).toBe(0);
    const written = JSON.parse(
      fs.readFileSync(path.join(stateDir, "zeta.json"), "utf8"),
    ) as PipelineState;
    expect(written.gateOverride).toEqual({
      pr: 5,
      confirmedAt: new Date(NOW).toISOString(),
    });
  });

  it("exits 2 when there is no state file to record the token into", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["5", "--slug", "missing", "--record-override"], {
      stateDir,
      now: () => NOW,
    });
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });

  it("a recorded token then clears the same PR in a subsequent check", () => {
    // End-to-end: record-override writes the token, check mode reads it back
    // and clears the merge for that PR.
    seedState("eta");
    const recCap = captureStdout();
    run(["9", "--slug", "eta", "--record-override"], { stateDir, now: () => NOW });
    recCap.restore();

    const gh = vi.fn(() => ({
      stdout: JSON.stringify({ body: HAS_UNCHECKED, state: "OPEN", url: "https://x/y/pull/9" }),
      stderr: "",
      exitCode: 0,
    }));
    const chkCap = captureStdout();
    const exit = run(["9", "--slug", "eta"], { gh, stateDir, now: () => NOW });
    chkCap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(chkCap.writes.join("")) as GuardResult;
    expect(result.decision).toBe("clear");
    expect(result.overrideApplied).toBe(true);
  });
});
