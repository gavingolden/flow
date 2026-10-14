import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONFLICT_STDERR_PATTERNS,
  evaluateMergeGuard,
  evaluateMergePreconditions,
  OVERRIDE_FRESHNESS_MS,
  parseArgs,
  run,
  type Deps,
  type GuardResult,
  type MergeOutcome,
} from "./flow-merge-guard";
import { FLOW_MERGE_ALLOW_RULE } from "./lib/merge-allow-rule";
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
  fs.writeFileSync(
    path.join(stateDir, `${slug}.json`),
    JSON.stringify(state) + "\n",
  );
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
    expect(evaluateMergeGuard(HAS_UNCHECKED, state, 7, NOW).decision).toBe(
      "blocked",
    );
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
    expect(evaluateMergeGuard(HAS_UNCHECKED, state, 42, NOW).decision).toBe(
      "blocked",
    );
  });

  it("blocks when the override token is stale (outside the freshness window)", () => {
    const state: PipelineState = {
      slug: "x",
      phase: "gating",
      repo: "/r",
      updatedAt: "2026-05-22T11:00:00Z",
      gateOverride: freshOverride(42, OVERRIDE_FRESHNESS_MS + 60_000),
    };
    expect(evaluateMergeGuard(HAS_UNCHECKED, state, 42, NOW).decision).toBe(
      "blocked",
    );
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
    expect(evaluateMergeGuard(HAS_UNCHECKED, state, 42, NOW).decision).toBe(
      "blocked",
    );
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
    expect(parseArgs(["100"])).toEqual({
      pr: 100,
      slug: undefined,
      recordOverride: false,
    });
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
    expect(parseArgs(["100", "--bogus"])).toEqual({
      error: "unknown flag: --bogus",
    });
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
    seedState("alpha", { pr: 5 });
    const cap = captureStdout();
    const exit = run(["5", "--slug", "alpha"], {
      gh: ghBody(NO_UNCHECKED),
      stateDir,
      now: () => NOW,
    });
    cap.restore();
    expect(exit).toBe(0);
    expect((JSON.parse(cap.writes.join("")) as GuardResult).decision).toBe(
      "clear",
    );
  });

  it("exits 1 with decision blocked when unchecked items remain and no token", () => {
    seedState("beta", { pr: 5 });
    const cap = captureStdout();
    const exit = run(["5", "--slug", "beta"], {
      gh: ghBody(HAS_UNCHECKED),
      stateDir,
      now: () => NOW,
    });
    cap.restore();
    expect(exit).toBe(1);
    expect((JSON.parse(cap.writes.join("")) as GuardResult).decision).toBe(
      "blocked",
    );
  });

  it("exits 0 when unchecked items remain but a fresh override token clears them", () => {
    seedState("gamma", { gateOverride: freshOverride(5), pr: 5 });
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
    const exit = run(["5", "--slug", "delta"], {
      gh,
      stateDir,
      now: () => NOW,
    });
    cap.restore();
    expect(exit).toBe(2);
    const result = JSON.parse(cap.writes.join("")) as {
      decision: string;
      reason: string;
    };
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
    expect((JSON.parse(cap.writes.join("")) as GuardResult).decision).toBe(
      "clear",
    );
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
    seedState("eta", { pr: 9 });
    const recCap = captureStdout();
    run(["9", "--slug", "eta", "--record-override"], {
      stateDir,
      now: () => NOW,
    });
    recCap.restore();

    const gh = vi.fn(() => ({
      stdout: JSON.stringify({
        body: HAS_UNCHECKED,
        state: "OPEN",
        url: "https://x/y/pull/9",
      }),
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

// --- phase advance -----------------------------------------------------

describe("run() — phase advance", () => {
  function readWritten(slug: string): Record<string, unknown> {
    return JSON.parse(
      fs.readFileSync(path.join(stateDir, `${slug}.json`), "utf8"),
    );
  }

  function ghBody(body: string, state = "OPEN") {
    return vi.fn(() => ({
      stdout: JSON.stringify({ body, state, url: "https://x/y/pull/5" }),
      stderr: "",
      exitCode: 0,
    }));
  }

  it("checkGuard advances a reviewing pipeline to merging as part of the guard check", () => {
    seedState("iota", { phase: "gating", pr: 5 });
    const exit = run(["5", "--slug", "iota"], {
      gh: ghBody(NO_UNCHECKED),
      stateDir,
      now: () => NOW,
    });
    expect(exit).toBe(0);
    const written = readWritten("iota");
    expect(written.phase).toBe("merging");
    expect((written.phaseLog as unknown[]) ?? []).toHaveLength(1);
  });

  it("advances gated -> merging when the guard clears (the gate-override merge path records its merging row)", () => {
    seedState("kappa", { phase: "gated", pr: 5 });
    const exit = run(["5", "--slug", "kappa"], {
      gh: ghBody(NO_UNCHECKED),
      stateDir,
      now: () => NOW,
    });
    expect(exit).toBe(0);
    expect(readWritten("kappa").phase).toBe("merging");
  });

  it("leaves a gated pipeline at gated when the guard blocks (no override, unchecked items)", () => {
    seedState("kappa2", { phase: "gated", pr: 5 });
    const exit = run(["5", "--slug", "kappa2"], {
      gh: ghBody(HAS_UNCHECKED),
      stateDir,
      now: () => NOW,
    });
    expect(exit).toBe(1);
    expect(readWritten("kappa2").phase).toBe("gated");
  });

  it("advances phase to merging even when the decision is blocked (unchecked items present)", () => {
    seedState("lambda", { phase: "gating", pr: 5 });
    const exit = run(["5", "--slug", "lambda"], {
      gh: ghBody(HAS_UNCHECKED),
      stateDir,
      now: () => NOW,
    });
    expect(exit).toBe(1);
    expect(readWritten("lambda").phase).toBe("merging");
  });

  it("does not advance the phase on a gh fetch error (exit 2)", () => {
    seedState("mu", { phase: "gating", pr: 5 });
    const gh = vi.fn(() => ({ stdout: "", stderr: "boom", exitCode: 1 }));
    const cap = captureStdout();
    const exit = run(["5", "--slug", "mu"], { gh, stateDir, now: () => NOW });
    cap.restore();
    expect(exit).toBe(2);
    expect(readWritten("mu").phase).toBe("gating");
  });

  it("does not advance the phase when the PR is non-OPEN (defer-clear)", () => {
    seedState("nu", { phase: "gating", pr: 5 });
    const gh = ghBody(NO_UNCHECKED, "MERGED");
    const cap = captureStdout();
    const exit = run(["5", "--slug", "nu"], { gh, stateDir, now: () => NOW });
    cap.restore();
    expect(exit).toBe(0);
    expect(readWritten("nu").phase).toBe("gating");
  });

  it("recordOverrideToken does NOT advance the phase, and the recorded token round-trips unchanged", () => {
    seedState("lambda", { phase: "gating", pr: 5 });
    const cap = captureStdout();
    const exit = run(["5", "--slug", "lambda", "--record-override"], {
      stateDir,
      now: () => NOW,
    });
    cap.restore();
    expect(exit).toBe(0);
    const written = readWritten("lambda");
    // The override path leaves phase untouched — it is a fresh-confirmation
    // recording, not a pipeline transition (plan.md Contract adjustment #1).
    expect(written.phase).toBe("gating");
    expect(written.gateOverride).toEqual({
      pr: 5,
      confirmedAt: new Date(NOW).toISOString(),
    });
  });
});

// --- merge mode ------------------------------------------------------------

describe("run() — merge mode", () => {
  const PASSING = JSON.stringify([{ name: "verify", state: "SUCCESS" }]);

  function ghFor(opts: {
    body?: string;
    prState?: string;
    checks?: { stdout: string; stderr?: string; exitCode?: number };
  }) {
    return vi.fn((argv: string[]) => {
      if (argv[1] === "view") {
        return {
          stdout: JSON.stringify({
            body: opts.body ?? NO_UNCHECKED,
            state: opts.prState ?? "OPEN",
            url: "https://x/y/pull/5",
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      const c = opts.checks ?? { stdout: PASSING };
      return {
        stdout: c.stdout,
        stderr: c.stderr ?? "",
        exitCode: c.exitCode ?? 0,
      };
    });
  }

  function seedMerge(slug: string, extra: Partial<PipelineState> = {}): string {
    const worktree = path.join(stateDir, `wt-${slug}`);
    fs.mkdirSync(worktree, { recursive: true });
    seedState(slug, { pr: 5, repo: "/base/checkout", worktree, ...extra });
    return worktree;
  }

  const phaseOf = (slug: string) =>
    JSON.parse(fs.readFileSync(path.join(stateDir, `${slug}.json`), "utf8"))
      .phase as string;

  function runMerge(
    argv: string[],
    deps: Partial<Deps>,
  ): { exit: number; out: MergeOutcome } {
    const cap = captureStdout();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let exit: number;
    try {
      exit = run(argv, {
        stateDir,
        now: () => NOW,
        resolveSlug: () => null,
        ...deps,
      });
    } finally {
      cap.restore();
      errSpy.mockRestore();
    }
    const line = cap.writes.join("").trim();
    return { exit, out: (line ? JSON.parse(line) : {}) as MergeOutcome };
  }

  const okMerge = () => ({ exitCode: 0, stderr: "" });

  it("merges with a bare --squash <pr> from state.repo, writes merging and merge-result.json", () => {
    const wt = seedMerge("m1");
    const runMergeSpy = vi.fn(okMerge);
    const gh = ghFor({});
    const { exit, out } = runMerge(["merge", "5", "--slug", "m1"], {
      gh,
      runMerge: runMergeSpy,
    });
    expect(exit).toBe(0);
    expect(out).toEqual({ decision: "merged", reason: "merged" });
    expect(runMergeSpy.mock.calls).toEqual([[5, "/base/checkout"]]);
    expect(phaseOf("m1")).toBe("merging");
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(wt, ".flow-tmp", "merge-result.json"),
          "utf8",
        ),
      ),
    ).toEqual(out);
    expect(gh).toHaveBeenCalledWith([
      "pr",
      "checks",
      "5",
      "--json",
      "name,state",
    ]);
  });

  it("the default runner invokes bare `gh pr merge --squash <pr>` (no --body/--subject/--delete-branch)", () => {
    seedMerge("m1b");
    const calls: Array<{ pr: number; cwd: string }> = [];
    runMerge(["merge", "5", "--slug", "m1b"], {
      gh: ghFor({}),
      runMerge: (pr, cwd) => {
        calls.push({ pr, cwd });
        return okMerge();
      },
    });
    expect(calls).toEqual([{ pr: 5, cwd: "/base/checkout" }]);
    const src = fs.readFileSync(
      path.join(__dirname, "flow-merge-guard.ts"),
      "utf8",
    );
    expect(src).toContain('["pr", "merge", "--squash", String(pr)]');
    expect(src).not.toMatch(/--body|--subject|--delete-branch|--admin/);
  });

  it("refuses unchecked Test Steps without an override token (exit 1, no merge, phase untouched)", () => {
    seedMerge("m2");
    const spy = vi.fn(okMerge);
    const { exit, out } = runMerge(["merge", "5", "--slug", "m2"], {
      gh: ghFor({ body: HAS_UNCHECKED }),
      runMerge: spy,
    });
    expect(exit).toBe(1);
    expect(out.decision).toBe("refused");
    expect(out.reason).toContain("gate-blocked");
    expect(out.uncheckedItems).toHaveLength(2);
    expect(spy).not.toHaveBeenCalled();
    expect(phaseOf("m2")).toBe("gating");
  });

  it("merges unchecked items when a fresh override token exists", () => {
    seedMerge("m3", { gateOverride: freshOverride(5, 1000) });
    const { exit } = runMerge(["merge", "5", "--slug", "m3"], {
      gh: ghFor({ body: HAS_UNCHECKED }),
      runMerge: okMerge,
    });
    expect(exit).toBe(0);
  });

  it("refuses a pending check and a failed check", () => {
    seedMerge("m4");
    const spy = vi.fn(okMerge);
    const pending = runMerge(["merge", "5", "--slug", "m4"], {
      gh: ghFor({
        checks: {
          stdout: JSON.stringify([{ name: "v", state: "IN_PROGRESS" }]),
        },
      }),
      runMerge: spy,
    });
    expect(pending.exit).toBe(1);
    expect(pending.out.reason).toBe("checks-pending");
    const failed = runMerge(["merge", "5", "--slug", "m4"], {
      gh: ghFor({
        checks: {
          stdout: JSON.stringify([{ name: "lint", state: "FAILURE" }]),
          exitCode: 1,
        },
      }),
      runMerge: spy,
    });
    expect(failed.exit).toBe(1);
    expect(failed.out.reason).toBe("checks-failed: lint");
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses when the checks read fails (fail-closed), but treats gh's 'no checks reported' as an empty CI", () => {
    seedMerge("m5");
    const spy = vi.fn(okMerge);
    const unreadable = runMerge(["merge", "5", "--slug", "m5"], {
      gh: ghFor({
        checks: { stdout: "", stderr: "HTTP 502: bad gateway", exitCode: 1 },
      }),
      runMerge: spy,
    });
    expect(unreadable.exit).toBe(1);
    expect(unreadable.out.reason).toContain("checks-unreadable");
    expect(spy).not.toHaveBeenCalled();
    const none = runMerge(["merge", "5", "--slug", "m5"], {
      gh: ghFor({
        checks: {
          stdout: "",
          stderr: "no checks reported on the 'x' branch",
          exitCode: 1,
        },
      }),
      runMerge: spy,
    });
    expect(none.exit).toBe(0);
  });

  it("refuses when autoMerge is false and no fresh token exists", () => {
    seedMerge("m6", { autoMerge: false });
    const { exit, out } = runMerge(["merge", "5", "--slug", "m6"], {
      gh: ghFor({}),
      runMerge: okMerge,
    });
    expect(exit).toBe(1);
    expect(out.reason).toContain("auto-merge-disabled");
  });

  it("refuses another pipeline's PR and a closed PR", () => {
    seedMerge("m7", { pr: 99 });
    const other = runMerge(["merge", "5", "--slug", "m7"], {
      gh: ghFor({}),
      runMerge: okMerge,
    });
    expect(other.exit).toBe(1);
    expect(other.out.reason).toContain("pr-not-owned");
    seedMerge("m7b");
    const closed = runMerge(["merge", "5", "--slug", "m7b"], {
      gh: ghFor({ prState: "CLOSED" }),
      runMerge: okMerge,
    });
    expect(closed.exit).toBe(1);
    expect(closed.out.reason).toBe("pr-not-open: CLOSED");
  });

  it("refuses with phase-not-advanceable from needs-human and does not merge", () => {
    seedMerge("m8", { phase: "needs-human" });
    const spy = vi.fn(okMerge);
    const { exit, out } = runMerge(["merge", "5", "--slug", "m8"], {
      gh: ghFor({}),
      runMerge: spy,
    });
    expect(exit).toBe(1);
    expect(out.reason).toBe("phase-not-advanceable: terminal");
    expect(spy).not.toHaveBeenCalled();
    expect(phaseOf("m8")).toBe("needs-human");
  });

  it("re-entry at merging (a retry after a resolver) proceeds", () => {
    seedMerge("m9", { phase: "merging" });
    const { exit } = runMerge(["merge", "5", "--slug", "m9"], {
      gh: ghFor({}),
      runMerge: okMerge,
    });
    expect(exit).toBe(0);
  });

  it("an already-MERGED PR is idempotent success: exit 0, no gh merge, no phase write", () => {
    seedMerge("m10");
    const spy = vi.fn(okMerge);
    const { exit, out } = runMerge(["merge", "5", "--slug", "m10"], {
      gh: ghFor({ prState: "MERGED" }),
      runMerge: spy,
    });
    expect(exit).toBe(0);
    expect(out).toEqual({ decision: "merged", reason: "already-merged" });
    expect(spy).not.toHaveBeenCalled();
    expect(phaseOf("m10")).toBe("gating");
  });

  it("classifies each conflict stderr pattern as conflict and anything else as other (exit 3)", () => {
    seedMerge("m11");
    for (const pattern of CONFLICT_STDERR_PATTERNS) {
      const { exit, out } = runMerge(["merge", "5", "--slug", "m11"], {
        gh: ghFor({}),
        runMerge: () => ({ exitCode: 1, stderr: `GraphQL: ${pattern} (x)` }),
      });
      expect(exit).toBe(3);
      expect(out).toMatchObject({
        decision: "merge-failed",
        failureClass: "conflict",
      });
      expect(out.stderr).toContain(pattern);
    }
    const other = runMerge(["merge", "5", "--slug", "m11"], {
      gh: ghFor({}),
      runMerge: () => ({ exitCode: 1, stderr: "HTTP 401" }),
    });
    expect(other.exit).toBe(3);
    expect(other.out.failureClass).toBe("other");
  });

  it("exits 2 on a gh error reading the PR, and on usage errors including --record-override", () => {
    seedMerge("m12");
    const boom = vi.fn(() => ({ stdout: "", stderr: "boom", exitCode: 1 }));
    expect(runMerge(["merge", "5", "--slug", "m12"], { gh: boom }).exit).toBe(
      2,
    );
    const spy = vi.fn(okMerge);
    for (const argv of [
      ["merge"],
      ["merge", "abc"],
      ["merge", "5", "--record-override", "--slug", "m12"],
      ["merge", "5", "--bogus"],
      ["merge", "5", "--slug"],
    ]) {
      expect(runMerge(argv, { gh: ghFor({}), runMerge: spy }).exit).toBe(2);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(phaseOf("m12")).toBe("gating");
  });

  it("a missing state file is an error (exit 2), not a merge", () => {
    const spy = vi.fn(okMerge);
    const { exit, out } = runMerge(["merge", "5", "--slug", "no-such-slug"], {
      gh: ghFor({}),
      runMerge: spy,
    });
    expect(exit).toBe(2);
    expect(out.decision).toBe("error");
    expect(spy).not.toHaveBeenCalled();
  });

  it("merges with autoMerge:false when a fresh override token exists", () => {
    seedMerge("m6b", {
      autoMerge: false,
      gateOverride: freshOverride(5, 1000),
    });
    const spy = vi.fn(okMerge);
    const { exit, out } = runMerge(["merge", "5", "--slug", "m6b"], {
      gh: ghFor({}),
      runMerge: spy,
    });
    expect(exit).toBe(0);
    expect(out.decision).toBe("merged");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refuses a check state outside the pending/failed/passing sets (fail-closed)", () => {
    seedMerge("m13");
    const spy = vi.fn(okMerge);
    for (const state of [
      "ERROR",
      "ACTION_REQUIRED",
      "WAITING",
      "REQUESTED",
      "EXPECTED",
      "SOMETHING_NEW",
    ]) {
      const { exit, out } = runMerge(["merge", "5", "--slug", "m13"], {
        gh: ghFor({
          checks: {
            stdout: JSON.stringify([
              { name: "ok", state: "SUCCESS" },
              { name: "odd", state },
            ]),
          },
        }),
        runMerge: spy,
      });
      expect(exit).toBe(1);
      expect(out.reason).toBe(`checks-unrecognised: odd=${state}`);
    }
    const malformed = runMerge(["merge", "5", "--slug", "m13"], {
      gh: ghFor({
        checks: { stdout: JSON.stringify([{ name: "no-state" }]) },
      }),
      runMerge: spy,
    });
    expect(malformed.exit).toBe(1);
    expect(malformed.out.reason).toContain("checks-unrecognised");
    expect(spy).not.toHaveBeenCalled();
    expect(phaseOf("m13")).toBe("gating");
  });

  it("passes SUCCESS, NEUTRAL and SKIPPED checks", () => {
    seedMerge("m14");
    const { exit } = runMerge(["merge", "5", "--slug", "m14"], {
      gh: ghFor({
        checks: {
          stdout: JSON.stringify([
            { name: "a", state: "SUCCESS" },
            { name: "b", state: "NEUTRAL" },
            { name: "c", state: "SKIPPED" },
          ]),
        },
      }),
      runMerge: okMerge,
    });
    expect(exit).toBe(0);
  });

  it("reads gate inputs with cwd = state.repo, the same repo the merge targets", () => {
    seedMerge("m15");
    const gh = ghFor({});
    const ghInRepo = vi.fn((_cwd: string) => gh);
    const { exit } = runMerge(["merge", "5", "--slug", "m15"], {
      ghInRepo,
      runMerge: okMerge,
    });
    expect(exit).toBe(0);
    expect(ghInRepo).toHaveBeenCalledWith("/base/checkout");
  });

  it("refuses a forged --slug (path traversal or wrong shape) before reading any state", () => {
    const forged = path.join(stateDir, "forged.json");
    fs.writeFileSync(
      forged,
      JSON.stringify({
        slug: "x",
        phase: "gating",
        repo: "/base/checkout",
        updatedAt: "2026-05-22T11:00:00Z",
        pr: 5,
        gateOverride: freshOverride(5),
      }),
    );
    const spy = vi.fn(okMerge);
    const gh = ghFor({ body: HAS_UNCHECKED });
    for (const slug of [
      `../${path.basename(stateDir)}/forged`,
      "../forged",
      "/abs/forged",
      "A_B",
      "a/b",
    ]) {
      const { exit } = runMerge(["merge", "5", "--slug", slug], {
        gh,
        runMerge: spy,
      });
      expect(exit).toBe(2);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(gh).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(forged, "utf8")).phase).toBe("gating");
  });

  it("refuses a malformed ambient slug and a --slug that differs from the pipeline's own FLOW_SLUG", () => {
    seedMerge("own");
    seedMerge("other");
    const spy = vi.fn(okMerge);
    const bad = runMerge(["merge", "5"], {
      gh: ghFor({}),
      resolveSlug: () => "../own",
      runMerge: spy,
    });
    expect(bad.exit).toBe(2);
    const mismatch = runMerge(["merge", "5", "--slug", "other"], {
      gh: ghFor({}),
      resolveSlug: () => "own",
      runMerge: spy,
    });
    expect(mismatch.exit).toBe(2);
    expect(spy).not.toHaveBeenCalled();
    const same = runMerge(["merge", "5", "--slug", "own"], {
      gh: ghFor({}),
      resolveSlug: () => "own",
      runMerge: spy,
    });
    expect(same.exit).toBe(0);
  });

  it("existing parseArgs shape is untouched by merge mode", () => {
    expect(parseArgs(["100"])).toEqual({
      pr: 100,
      slug: undefined,
      recordOverride: false,
    });
    expect(parseArgs(["merge", "5"])).toHaveProperty("error");
  });

  it("an invocation of merge mode starts with the owner's allow-rule prefix", () => {
    const prefix = FLOW_MERGE_ALLOW_RULE.slice("Bash(".length, -" *)".length);
    expect("flow-merge-guard merge 1 --slug x".startsWith(`${prefix} `)).toBe(
      true,
    );
  });
});

describe(evaluateMergePreconditions, () => {
  const base = {
    body: NO_UNCHECKED,
    prState: "OPEN",
    state: {
      slug: "s",
      phase: "gating",
      repo: "/r",
      updatedAt: "x",
      pr: 5,
    } as PipelineState,
    pr: 5,
    checks: { kind: "all-passed" } as const,
    nowMs: NOW,
  };

  it("passes when everything holds, including no-checks-reported", () => {
    expect(evaluateMergePreconditions(base)).toEqual({ ok: true });
    expect(
      evaluateMergePreconditions({
        ...base,
        checks: { kind: "no-checks-reported" },
      }),
    ).toEqual({ ok: true });
  });

  it("refuses a missing state file", () => {
    expect(evaluateMergePreconditions({ ...base, state: null })).toEqual({
      ok: false,
      reason: "no-state",
    });
  });
});
