import { describe, expect, it, vi } from "vitest";
import {
  buildEpicMetadataReminder,
  buildReminder,
  buildStagnationReminder,
  epicMetadataBlockIsSatisfiable,
  nextStepLabel,
  run,
  type Deps,
} from "./flow-stop-guard";
import {
  PENDING_PHASES,
  STEP_PHASES,
  TERMINAL_PHASES,
  type PipelineState,
} from "./lib/state";
import { TURN_BLOCK_LIMIT, type TurnTracking } from "./lib/stop-turn-tracking";
import type { RepoState } from "./lib/epic-metadata-commit";
import type { GuardCapability } from "./lib/base-branch-guard";

const FROZEN_NOW = "2026-05-17T00:00:00.000Z";

/** Default test capability: always allows the status.json route, matching
 * pre-Task-3 behaviour, so existing tests that name the sync route don't
 * each need to opt in individually. */
const ALWAYS_ALLOWS_CAPABILITY: GuardCapability = {
  allowsStatusBoard: true,
  selfHealable: false,
  classification: "own-current",
  version: 4,
  hookPath: "/fake/.git/hooks/pre-commit",
};

type Stub = {
  deps: Deps;
  errLines: string[];
  loadCalls: string[];
  writeTurn: ReturnType<typeof vi.fn>;
  readTurn: ReturnType<typeof vi.fn>;
  repoCommitStateSpy: ReturnType<typeof vi.fn>;
};

function makeDeps(opts: {
  stdin?: string;
  /** Convenience alias for flowSlugEnv, kept for call-site brevity across the suite. */
  slug?: string;
  flowSlugEnv?: string;
  state?: PipelineState | null;
  turnTracking?: TurnTracking | null;
  nowIso?: string;
  dirtyEpicPaths?: (repoRoot: string) => string[];
  repoCommitState?: (repoRoot: string) => RepoState;
  guardCapability?: (repoRoot: string) => GuardCapability;
}): Stub {
  const errLines: string[] = [];
  const loadCalls: string[] = [];
  const writeTurn = vi.fn();
  const readTurn = vi.fn(() => opts.turnTracking ?? null);
  const repoCommitStateSpy = vi.fn(
    opts.repoCommitState ?? (() => "clean" as RepoState),
  );
  const deps: Deps = {
    readStdin: async () => opts.stdin ?? "",
    flowSlugEnv: opts.flowSlugEnv ?? opts.slug,
    loadState: (slug) => {
      loadCalls.push(slug);
      return opts.state ?? null;
    },
    writeErr: (s) => {
      errLines.push(s);
    },
    readTurn,
    writeTurn,
    nowIso: () => opts.nowIso ?? FROZEN_NOW,
    dirtyEpicPaths: opts.dirtyEpicPaths ?? (() => []),
    repoCommitState: repoCommitStateSpy,
    guardCapability: opts.guardCapability ?? (() => ALWAYS_ALLOWS_CAPABILITY),
  };
  return { deps, errLines, loadCalls, writeTurn, readTurn, repoCommitStateSpy };
}

function fakeState(
  phase: string,
  overrides: Partial<PipelineState> = {},
): PipelineState {
  return {
    slug: "demo",
    phase,
    repo: "/tmp/repo",
    updatedAt: "2026-05-03T00:00:00Z",
    ...overrides,
  };
}

function fakeTracking(overrides: Partial<TurnTracking> = {}): TurnTracking {
  return {
    slug: "demo",
    turnId: "2026-05-17T00:00:00.000Z",
    blockCount: 0,
    lastPhase: "starting",
    lastStopAt: "2026-05-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("flow-stop-guard short-circuits", () => {
  it("exits 0 when stop_hook_active is true and phase has advanced (loop-break consumed)", async () => {
    const { deps, errLines, writeTurn } = makeDeps({
      stdin: JSON.stringify({ stop_hook_active: true }),
      slug: "demo",
      state: fakeState("verifying"),
      turnTracking: fakeTracking({
        blockCount: TURN_BLOCK_LIMIT,
        lastPhase: "implementing",
      }),
    });
    expect(await run(deps)).toBe(0);
    expect(errLines.join("")).toContain("loop-break consumed");
    expect(writeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ lastPhase: "verifying" }),
    );
  });

  it("exits 0 when NO slug resolves (no FLOW_SLUG — not a flow session)", async () => {
    const { deps, loadCalls, errLines, writeTurn } = makeDeps({
      stdin: JSON.stringify({}),
      flowSlugEnv: undefined,
      state: fakeState("implementing"),
    });
    expect(await run(deps)).toBe(0);
    expect(loadCalls).toEqual([]);
    expect(writeTurn).not.toHaveBeenCalled();
    expect(errLines).toEqual([]);
  });

  it("blocks (exit 2) when FLOW_SLUG resolves — the plain-launcher guard", async () => {
    const { deps, loadCalls } = makeDeps({
      stdin: JSON.stringify({}),
      flowSlugEnv: "demo",
      state: fakeState("implementing"),
    });
    expect(await run(deps)).toBe(2);
    expect(loadCalls).toEqual(["demo"]);
  });

  it("permits (exit 0) at a terminal phase when the slug resolved via FLOW_SLUG", async () => {
    const { deps } = makeDeps({
      stdin: JSON.stringify({}),
      flowSlugEnv: "demo",
      state: fakeState("merged"),
    });
    expect(await run(deps)).toBe(0);
  });

  it("exits 0 when FLOW_SLUG is shape-invalid — env-only, no fallback", async () => {
    const { deps, loadCalls, errLines, writeTurn } = makeDeps({
      stdin: JSON.stringify({}),
      flowSlugEnv: "NOT A SLUG",
      state: fakeState("implementing"),
    });
    expect(await run(deps)).toBe(0);
    expect(loadCalls).toEqual([]);
    expect(writeTurn).not.toHaveBeenCalled();
    expect(errLines).toEqual([]);
  });

  it("exits 0 when state.json is missing for the slug", async () => {
    const { deps, errLines } = makeDeps({
      stdin: JSON.stringify({}),
      slug: "ghost",
      state: null,
    });
    expect(await run(deps)).toBe(0);
    expect(errLines).toEqual([]);
  });

  it("exits 0 when stdin is empty (no hook payload)", async () => {
    const { deps } = makeDeps({
      stdin: "",
      slug: "demo",
      state: fakeState("merged"),
    });
    expect(await run(deps)).toBe(0);
  });

  it("exits 0 when stdin is malformed JSON (treats as no input)", async () => {
    const { deps } = makeDeps({
      stdin: "{not json",
      slug: "demo",
      state: fakeState("merged"),
    });
    expect(await run(deps)).toBe(0);
  });

  it("malformed JSON does not bypass the phase check (still blocks mid-pipeline)", async () => {
    // Regression guard: the malformed-JSON branch falls through to the rest
    // of the checks rather than short-circuiting like `stop_hook_active`.
    // If a future refactor accidentally collapses the two, mid-pipeline
    // turn-ends would silently exit 0 whenever the harness sent garbage.
    const { deps, errLines } = makeDeps({
      stdin: "{not json",
      slug: "demo",
      state: fakeState("implementing"),
    });
    expect(await run(deps)).toBe(2);
    expect(errLines.join("")).toContain("DO NOT END THE TURN");
  });
});

describe("flow-stop-guard allows legitimate end phases", () => {
  it.each([...TERMINAL_PHASES])(
    "exits 0 at terminal phase %s",
    async (phase) => {
      const { deps, errLines } = makeDeps({
        stdin: "{}",
        slug: "demo",
        state: fakeState(phase),
      });
      expect(await run(deps)).toBe(0);
      expect(errLines).toEqual([]);
    },
  );

  it.each([...PENDING_PHASES])("exits 0 at pending phase %s", async (phase) => {
    const { deps, errLines } = makeDeps({
      stdin: "{}",
      slug: "demo",
      state: fakeState(phase),
    });
    expect(await run(deps)).toBe(0);
    expect(errLines).toEqual([]);
  });
});

describe("flow-stop-guard blocks mid-pipeline", () => {
  const blockable = STEP_PHASES.filter((p) => p !== "starting"); // tested separately

  it.each([...blockable])("exits 2 at step phase %s", async (phase) => {
    const { deps, errLines } = makeDeps({
      stdin: "{}",
      slug: "demo",
      state: fakeState(phase),
    });
    expect(await run(deps)).toBe(2);
    const joined = errLines.join("");
    expect(joined).toContain(`phase=${phase}`);
    expect(joined).toContain("DO NOT END THE TURN");
  });

  it("blocks at phase=starting and points back to step 1", async () => {
    const { deps, errLines } = makeDeps({
      stdin: "{}",
      slug: "demo",
      state: fakeState("starting"),
    });
    expect(await run(deps)).toBe(2);
    expect(errLines.join("")).toContain("step 1 (triage)");
  });

  it("reminder names the documented next step for each phase", async () => {
    const expected: Array<[string, string]> = [
      ["triaging", "step 2 (worktree-create)"],
      ["worktree-create", "step 3 (plan)"],
      ["planning", "step 4 (approval)"],
      ["implementing", "step 5.5 (installing-skills)"],
      ["installing-skills", "step 6 (verify)"],
      ["verifying", "step 7 (ci-wait)"],
      ["ci-wait", "step 8 (review)"],
      ["reviewing", "step 9 (gate)"],
      ["gating", "step 10 (merge)"],
      [
        "merging",
        "step 10 → step 11 (finalize merge, run local follow-ups, then MERGED)",
      ],
    ];
    for (const [phase, label] of expected) {
      const { deps, errLines } = makeDeps({
        stdin: "{}",
        slug: "demo",
        state: fakeState(phase),
      });
      expect(await run(deps)).toBe(2);
      expect(errLines.join(""), `phase=${phase}`).toContain(label);
    }
  });

  it("NEXT_STEP_BY_PHASE points ci-wait-pending back at step 7 (the yielded CI-wait phase)", () => {
    // ci-wait-pending is a pending phase, so run() exits 0 before building a
    // reminder — assert the breadcrumb directly via nextStepLabel rather than
    // via the exit-2 reminder loop above.
    expect(nextStepLabel("ci-wait-pending")).toBe(
      "step 7 (ci-wait) — run flow-ci-check and branch on .status/.decision",
    );
  });

  it("exits 0 at the yielded ci-wait-pending phase but still exits 2 at the active ci-wait phase", async () => {
    // Regression guard: the active poll phase (`ci-wait`) and the yielded
    // phase (`ci-wait-pending`) must not be conflated — ci-wait blocks the
    // stop, ci-wait-pending is a legitimate end-state.
    const pending = makeDeps({
      stdin: "{}",
      slug: "demo",
      state: fakeState("ci-wait-pending"),
    });
    expect(await run(pending.deps)).toBe(0);
    expect(pending.errLines).toEqual([]);

    const active = makeDeps({
      stdin: "{}",
      slug: "demo",
      state: fakeState("ci-wait"),
    });
    expect(await run(active.deps)).toBe(2);
    expect(active.errLines.join("")).toContain("DO NOT END THE TURN");
  });

  it("NEXT_STEP_BY_PHASE points plan-review-pending back at step 3 (the async plan review wake ladder)", () => {
    expect(nextStepLabel("plan-review-pending")).toBe(
      "step 3 (plan) — run flow-plan-review --check and branch on .status",
    );
  });

  it("NEXT_STEP_BY_PHASE points epic-plan-review-pending back at /flow-epic-create step 4.5", () => {
    expect(nextStepLabel("epic-plan-review-pending")).toBe(
      "/flow-epic-create step 4.5 — run flow-plan-review --check and branch on .status",
    );
  });

  it("exits 0 at the yielded plan-review-pending phase but still exits 2 at the active planning phase", async () => {
    const pending = makeDeps({
      stdin: "{}",
      slug: "demo",
      state: fakeState("plan-review-pending"),
    });
    expect(await run(pending.deps)).toBe(0);
    expect(pending.errLines).toEqual([]);

    const active = makeDeps({
      stdin: "{}",
      slug: "demo",
      state: fakeState("planning"),
    });
    expect(await run(active.deps)).toBe(2);
    expect(active.errLines.join("")).toContain("DO NOT END THE TURN");
  });

  it("exits 0 at the yielded epic-plan-review-pending phase but still exits 2 at the active epic-validating phase", async () => {
    const pending = makeDeps({
      stdin: "{}",
      slug: "demo",
      state: fakeState("epic-plan-review-pending"),
    });
    expect(await run(pending.deps)).toBe(0);
    expect(pending.errLines).toEqual([]);

    const active = makeDeps({
      stdin: "{}",
      slug: "demo",
      state: fakeState("epic-validating"),
    });
    expect(await run(active.deps)).toBe(2);
    expect(active.errLines.join("")).toContain("DO NOT END THE TURN");
  });
});

describe("nextStepLabel + buildReminder", () => {
  it("nextStepLabel falls back to a generic message for unknown phase", () => {
    expect(nextStepLabel("not-a-real-phase")).toContain("next step");
  });

  it("buildReminder includes the literal DO NOT END THE TURN", () => {
    const lines = buildReminder("implementing", "step 5.5 (installing-skills)");
    expect(lines.join("\n")).toContain("DO NOT END THE TURN");
  });

  it("buildReminder lists every pending phase so the model sees the full opt-out set", () => {
    const lines = buildReminder("triaging", "step 2 (worktree-create)");
    const joined = lines.join("\n");
    for (const p of PENDING_PHASES) expect(joined).toContain(p);
  });

  it("buildStagnationReminder includes 'DO NOT END THE TURN' and the 'phase has not advanced' substring", () => {
    const lines = buildStagnationReminder("verifying", 2);
    const joined = lines.join("\n");
    expect(joined).toContain("DO NOT END THE TURN");
    expect(joined).toContain("phase has not advanced");
    expect(joined).toContain("phase=verifying");
    expect(joined).toContain("2 consecutive stops");
  });
});

describe("per-turn tracking", () => {
  it("(1) legitimate pending exit does not consume budget", async () => {
    const { deps, writeTurn } = makeDeps({
      stdin: JSON.stringify({ stop_hook_active: false }),
      slug: "demo",
      state: fakeState("plan-pending-review"),
      turnTracking: null,
    });
    expect(await run(deps)).toBe(0);
    expect(writeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        blockCount: 0,
        lastPhase: "plan-pending-review",
      }),
    );
  });

  it("(1b) legitimate pending exit takes precedence when budget already exhausted", async () => {
    // Pins the dispatch precedence (legitimate-end > loop-break > stagnation).
    // If a future refactor reordered the checks, a real session that hit
    // stagnation then transitioned to plan-pending-review would now
    // incorrectly exit 2 with a stagnation reminder — this case forces the
    // legitimate-end branch to win even when blockCount === TURN_BLOCK_LIMIT.
    const { deps, errLines, writeTurn } = makeDeps({
      stdin: JSON.stringify({ stop_hook_active: true }),
      slug: "demo",
      state: fakeState("plan-pending-review"),
      turnTracking: fakeTracking({
        blockCount: TURN_BLOCK_LIMIT,
        lastPhase: "verifying",
      }),
    });
    expect(await run(deps)).toBe(0);
    expect(errLines).toEqual([]);
    expect(writeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ blockCount: TURN_BLOCK_LIMIT }),
    );
  });

  it("(2) non-legitimate phase + no prior tracking → exit 2 + increment", async () => {
    const { deps, writeTurn } = makeDeps({
      stdin: JSON.stringify({ stop_hook_active: false }),
      slug: "demo",
      state: fakeState("verifying"),
      turnTracking: null,
    });
    expect(await run(deps)).toBe(2);
    expect(writeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ blockCount: 1, lastPhase: "verifying" }),
    );
  });

  it("(3) second stop same turn, phase unchanged → stagnation reminder", async () => {
    const { deps, errLines, writeTurn } = makeDeps({
      stdin: JSON.stringify({ stop_hook_active: true }),
      slug: "demo",
      state: fakeState("verifying"),
      turnTracking: fakeTracking({
        blockCount: TURN_BLOCK_LIMIT,
        lastPhase: "verifying",
      }),
    });
    expect(await run(deps)).toBe(2);
    expect(errLines.join("")).toContain("phase has not advanced");
    expect(writeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ blockCount: TURN_BLOCK_LIMIT + 1 }),
    );
  });

  it("(4) second stop same turn, phase advanced → exit 0 + breadcrumb", async () => {
    const { deps, errLines, writeTurn } = makeDeps({
      stdin: JSON.stringify({ stop_hook_active: true }),
      slug: "demo",
      state: fakeState("verifying"),
      turnTracking: fakeTracking({
        blockCount: TURN_BLOCK_LIMIT,
        lastPhase: "implementing",
      }),
    });
    expect(await run(deps)).toBe(0);
    const joined = errLines.join("");
    expect(joined).toContain("loop-break consumed");
    expect(joined).toContain("phase=verifying");
    expect(writeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ lastPhase: "verifying" }),
    );
  });

  it("(5) new turn resets stale tracking (fresh turnId + lastPhase)", async () => {
    const FRESH = "2026-05-17T12:34:56.789Z";
    const { deps, writeTurn } = makeDeps({
      stdin: JSON.stringify({ stop_hook_active: false }),
      slug: "demo",
      state: fakeState("triaging"),
      turnTracking: fakeTracking({
        turnId: "2026-05-16T00:00:00.000Z",
        blockCount: TURN_BLOCK_LIMIT,
        lastPhase: "implementing",
      }),
      nowIso: FRESH,
    });
    await run(deps);
    expect(writeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        blockCount: 0,
        turnId: FRESH,
        lastPhase: "triaging",
      }),
    );
  });

  it("(6) no FLOW_SLUG in the environment skips tracking I/O entirely", async () => {
    const { deps, errLines, writeTurn } = makeDeps({
      stdin: JSON.stringify({}),
      state: fakeState("implementing"),
    });
    expect(await run(deps)).toBe(0);
    expect(writeTurn).not.toHaveBeenCalled();
    expect(errLines).toEqual([]);
  });

  it("ZERO COST: no dirty epic paths means repoCommitState is NEVER called, exit matches today's behaviour", async () => {
    const { deps, errLines, repoCommitStateSpy } = makeDeps({
      stdin: JSON.stringify({}),
      slug: "demo",
      state: fakeState("merged"),
      dirtyEpicPaths: () => [],
    });
    expect(await run(deps)).toBe(0);
    expect(repoCommitStateSpy).not.toHaveBeenCalled();
    expect(errLines).toEqual([]);
  });

  it("BLOCK: one dirty status.json on a non-terminal phase means exit 2 with the executable route", async () => {
    const { deps, errLines } = makeDeps({
      stdin: JSON.stringify({}),
      slug: "demo",
      state: fakeState("verifying"),
      dirtyEpicPaths: () => [".flow/epics/e1/status.json"],
    });
    expect(await run(deps)).toBe(2);
    const joined = errLines.join("");
    expect(joined).toContain(".flow/epics/e1/status.json");
    expect(joined).toContain("flow-epic-sync --epic-slug e1 --commit --push");
  });

  it("BLOCK AT A TERMINAL PHASE: the same dirty path still exits 2 (fires before isLegitimateEndPhase)", async () => {
    const { deps, errLines } = makeDeps({
      stdin: JSON.stringify({}),
      slug: "demo",
      state: fakeState("merged"),
      dirtyEpicPaths: () => [".flow/epics/e1/status.json"],
    });
    expect(await run(deps)).toBe(2);
    expect(errLines.join("")).toContain(
      "flow-epic-sync --epic-slug e1 --commit --push",
    );
  });

  it("MANIFEST ROUTE: a dirty manifest.json exits 2 with a switch-commit-switch-back sequence, not just 'open a PR'", async () => {
    const { deps, errLines } = makeDeps({
      stdin: JSON.stringify({}),
      slug: "demo",
      state: fakeState("verifying"),
      dirtyEpicPaths: () => [".flow/epics/e1/manifest.json"],
    });
    expect(await run(deps)).toBe(2);
    const joined = errLines.join("");
    expect(joined).toContain("git -C");
    expect(joined).toContain("switch -c flow-epic-amend/e1");
    expect(joined).toContain("switch -");
  });

  it("DUAL PROBE: distinct dirty paths in state.repo and state.worktree both appear, deduped when roots are equal", async () => {
    const { deps, errLines } = makeDeps({
      stdin: JSON.stringify({}),
      slug: "demo",
      state: fakeState("verifying", { worktree: "/tmp/worktree" }),
      dirtyEpicPaths: (root) =>
        root === "/tmp/repo"
          ? [".flow/epics/e1/status.json"]
          : [".flow/epics/e2/status.json"],
    });
    expect(await run(deps)).toBe(2);
    const joined = errLines.join("");
    expect(joined).toContain(".flow/epics/e1/status.json");
    expect(joined).toContain(".flow/epics/e2/status.json");
    // Root-anchored: the e1 command must target state.repo, the e2 command
    // must target state.worktree — never an ambient cwd.
    expect(joined).toContain(
      "(cd /tmp/repo && flow-epic-sync --epic-slug e1 --commit --push)",
    );
    expect(joined).toContain(
      "(cd /tmp/worktree && flow-epic-sync --epic-slug e2 --commit --push)",
    );
  });

  it("DUAL PROBE dedupes when state.repo === state.worktree (one dirtyEpicPaths call, not two)", async () => {
    const calls: string[] = [];
    const { deps } = makeDeps({
      stdin: JSON.stringify({}),
      slug: "demo",
      state: fakeState("verifying", { worktree: "/tmp/repo" }),
      dirtyEpicPaths: (root) => {
        calls.push(root);
        return [".flow/epics/e1/status.json"];
      },
    });
    await run(deps);
    expect(calls).toEqual(["/tmp/repo"]);
  });

  it("LOOP BREAK: blockCount already at the limit with the path still dirty means exit 0, no further increment", async () => {
    const { deps, errLines, writeTurn } = makeDeps({
      stdin: JSON.stringify({ stop_hook_active: true }),
      slug: "demo",
      state: fakeState("verifying"),
      turnTracking: fakeTracking({ blockCount: TURN_BLOCK_LIMIT }),
      dirtyEpicPaths: () => [".flow/epics/e1/status.json"],
    });
    expect(await run(deps)).toBe(0);
    expect(errLines.join("")).toContain("loop-break consumed");
    expect(writeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ blockCount: TURN_BLOCK_LIMIT }),
    );
  });

  it("NON-COMMITTABLE STATE (rebase): exit 0, diagnostic on stderr, blockCount NOT incremented", async () => {
    const { deps, errLines, writeTurn } = makeDeps({
      stdin: JSON.stringify({ stop_hook_active: true }),
      slug: "demo",
      state: fakeState("verifying"),
      turnTracking: fakeTracking({ blockCount: 0 }),
      dirtyEpicPaths: () => [".flow/epics/e1/status.json"],
      repoCommitState: () => "rebase",
    });
    expect(await run(deps)).toBe(0);
    expect(errLines.join("")).toContain("rebase");
    expect(writeTurn).not.toHaveBeenCalledWith(
      expect.objectContaining({ blockCount: 1 }),
    );
  });

  it("NON-COMMITTABLE STATE (detached): exit 0, diagnostic on stderr, blockCount NOT incremented", async () => {
    const { deps, errLines, writeTurn } = makeDeps({
      stdin: JSON.stringify({ stop_hook_active: true }),
      slug: "demo",
      state: fakeState("verifying"),
      turnTracking: fakeTracking({ blockCount: 0 }),
      dirtyEpicPaths: () => [".flow/epics/e1/status.json"],
      repoCommitState: () => "detached",
    });
    expect(await run(deps)).toBe(0);
    expect(errLines.join("")).toContain("detached");
    expect(writeTurn).not.toHaveBeenCalledWith(
      expect.objectContaining({ blockCount: 1 }),
    );
  });

  it("UNSATISFIABLE BLOCK (foreign hook): exit 0, diagnostic on stderr, no block slot consumed", async () => {
    const { deps, errLines, writeTurn } = makeDeps({
      stdin: JSON.stringify({ stop_hook_active: true }),
      slug: "demo",
      state: fakeState("verifying"),
      turnTracking: fakeTracking({ blockCount: 0 }),
      dirtyEpicPaths: () => [".flow/epics/e1/status.json"],
      guardCapability: () => ({
        allowsStatusBoard: false,
        selfHealable: false,
        classification: "foreign",
        version: null,
        hookPath: "/tmp/repo/.git/hooks/pre-commit",
      }),
    });
    expect(await run(deps)).toBe(0);
    expect(errLines.join("")).toContain("cannot be self-healed");
    expect(errLines.join("")).toContain("foreign");
    expect(errLines.join("")).toContain("flow install --upgrade");
    expect(writeTurn).not.toHaveBeenCalledWith(
      expect.objectContaining({ blockCount: 1 }),
    );
  });

  it("SELF-HEALABLE (own-outdated) still names the flow-epic-sync route and blocks (exit 2)", async () => {
    const { deps, errLines } = makeDeps({
      stdin: JSON.stringify({ stop_hook_active: true }),
      slug: "demo",
      state: fakeState("verifying"),
      turnTracking: fakeTracking({ blockCount: 0 }),
      dirtyEpicPaths: () => [".flow/epics/e1/status.json"],
      guardCapability: () => ({
        allowsStatusBoard: false,
        selfHealable: true,
        classification: "own-outdated",
        version: 3,
        hookPath: "/tmp/repo/.git/hooks/pre-commit",
      }),
    });
    expect(await run(deps)).toBe(2);
    expect(errLines.join("")).toContain(
      "flow-epic-sync --epic-slug e1 --commit --push",
    );
  });
});

describe("buildEpicMetadataReminder", () => {
  it("names the executable flow-epic-sync route for a status.json path, root-anchored", () => {
    const lines = buildEpicMetadataReminder(
      [{ root: "/repo", path: ".flow/epics/e1/status.json" }],
      { onBaseBranch: true, statusRouteWorks: () => true },
    );
    expect(lines.join("\n")).toContain(
      "(cd /repo && flow-epic-sync --epic-slug e1 --commit --push)",
    );
  });

  it("names the full switch-commit-switch-back sequence for any other path, root-anchored, never just 'open a PR'", () => {
    const lines = buildEpicMetadataReminder(
      [{ root: "/repo", path: ".flow/epics/e1/design.md" }],
      { onBaseBranch: true, statusRouteWorks: () => true },
    );
    const joined = lines.join("\n");
    expect(joined).toContain("git -C /repo switch -c flow-epic-amend/e1");
    expect(joined).toContain("git -C /repo switch -");
    expect(joined).not.toMatch(/^open a PR$/m);
  });

  it("falls back to the generic route when the slug segment fails isValidSlug", () => {
    const lines = buildEpicMetadataReminder(
      [{ root: "/repo", path: ".flow/epics/../status.json" }],
      { onBaseBranch: true, statusRouteWorks: () => true },
    );
    const joined = lines.join("\n");
    expect(joined).not.toContain("--epic-slug ..");
  });

  it("names the upgrade path instead of the sync route when the installed hook cannot honor it", () => {
    const lines = buildEpicMetadataReminder(
      [{ root: "/repo", path: ".flow/epics/e1/status.json" }],
      { onBaseBranch: true, statusRouteWorks: () => false },
    );
    const joined = lines.join("\n");
    expect(joined).not.toContain("flow-epic-sync --epic-slug e1");
    expect(joined).toContain("flow install --upgrade");
    expect(joined).toContain("git -C /repo switch -c flow-epic-amend/e1");
  });

  it("omits the base-branch note when no entry actually took the sync route", () => {
    const lines = buildEpicMetadataReminder(
      [{ root: "/repo", path: ".flow/epics/e1/status.json" }],
      { onBaseBranch: true, statusRouteWorks: () => false },
    );
    expect(lines.join("\n")).not.toContain(
      "the status.json route above applies directly there",
    );
  });

  it("includes the base-branch note when at least one entry took the sync route", () => {
    const lines = buildEpicMetadataReminder(
      [{ root: "/repo", path: ".flow/epics/e1/status.json" }],
      { onBaseBranch: true, statusRouteWorks: () => true },
    );
    expect(lines.join("\n")).toContain(
      "the status.json route above applies directly there",
    );
  });
});

describe("epicMetadataBlockIsSatisfiable", () => {
  it("is false only when every entry is an allowlisted status.json whose root's route does not work", () => {
    expect(
      epicMetadataBlockIsSatisfiable(
        [{ root: "/repo", path: ".flow/epics/e1/status.json" }],
        () => false,
      ),
    ).toBe(false);
  });

  it("is true when the status.json route works", () => {
    expect(
      epicMetadataBlockIsSatisfiable(
        [{ root: "/repo", path: ".flow/epics/e1/status.json" }],
        () => true,
      ),
    ).toBe(true);
  });

  it("is true when any entry is a non-status.json path, regardless of route capability (the switch-branch route never depends on the hook)", () => {
    expect(
      epicMetadataBlockIsSatisfiable(
        [
          { root: "/repo", path: ".flow/epics/e1/status.json" },
          { root: "/repo", path: ".flow/epics/e1/design.md" },
        ],
        () => false,
      ),
    ).toBe(true);
  });
});
