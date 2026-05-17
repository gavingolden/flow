import { describe, expect, it, vi } from "vitest";
import {
  buildReminder,
  buildStagnationReminder,
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
import {
  TURN_BLOCK_LIMIT,
  type TurnTracking,
} from "./lib/stop-turn-tracking";

const FROZEN_NOW = "2026-05-17T00:00:00.000Z";

type Stub = {
  deps: Deps;
  errLines: string[];
  loadCalls: string[];
  writeTurn: ReturnType<typeof vi.fn>;
  readTurn: ReturnType<typeof vi.fn>;
};

function makeDeps(opts: {
  stdin?: string;
  pane?: string;
  slug?: string;
  state?: PipelineState | null;
  turnTracking?: TurnTracking | null;
  nowIso?: string;
}): Stub {
  const errLines: string[] = [];
  const loadCalls: string[] = [];
  const writeTurn = vi.fn();
  const readTurn = vi.fn(() => opts.turnTracking ?? null);
  const deps: Deps = {
    readStdin: async () => opts.stdin ?? "",
    tmuxPane: opts.pane,
    showFlowSlug: () => opts.slug ?? "",
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
  };
  return { deps, errLines, loadCalls, writeTurn, readTurn };
}

function fakeState(phase: string): PipelineState {
  return {
    slug: "demo",
    phase,
    repo: "/tmp/repo",
    updatedAt: "2026-05-03T00:00:00Z",
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
      pane: "%1",
      slug: "demo",
      state: fakeState("verifying"),
      turnTracking: fakeTracking({ blockCount: TURN_BLOCK_LIMIT, lastPhase: "implementing" }),
    });
    expect(await run(deps)).toBe(0);
    expect(errLines.join("")).toContain("loop-break consumed");
    expect(writeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ lastPhase: "verifying" }),
    );
  });

  it("exits 0 when TMUX_PANE is undefined (not in tmux)", async () => {
    const { deps, loadCalls, errLines, writeTurn } = makeDeps({
      stdin: JSON.stringify({}),
      pane: undefined,
      state: fakeState("implementing"),
    });
    expect(await run(deps)).toBe(0);
    expect(loadCalls).toEqual([]);
    expect(writeTurn).not.toHaveBeenCalled();
    expect(errLines).toEqual([]);
  });

  it("exits 0 when @flow-slug is empty (not a flow window)", async () => {
    const { deps, loadCalls, errLines, writeTurn } = makeDeps({
      stdin: JSON.stringify({}),
      pane: "%1",
      slug: "",
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
      pane: "%1",
      slug: "ghost",
      state: null,
    });
    expect(await run(deps)).toBe(0);
    expect(errLines).toEqual([]);
  });

  it("exits 0 when stdin is empty (no hook payload)", async () => {
    const { deps } = makeDeps({
      stdin: "",
      pane: "%1",
      slug: "demo",
      state: fakeState("merged"),
    });
    expect(await run(deps)).toBe(0);
  });

  it("exits 0 when stdin is malformed JSON (treats as no input)", async () => {
    const { deps } = makeDeps({
      stdin: "{not json",
      pane: "%1",
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
      pane: "%1",
      slug: "demo",
      state: fakeState("implementing"),
    });
    expect(await run(deps)).toBe(2);
    expect(errLines.join("")).toContain("DO NOT END THE TURN");
  });
});

describe("flow-stop-guard allows legitimate end phases", () => {
  it.each([...TERMINAL_PHASES])("exits 0 at terminal phase %s", async (phase) => {
    const { deps, errLines } = makeDeps({
      stdin: "{}",
      pane: "%1",
      slug: "demo",
      state: fakeState(phase),
    });
    expect(await run(deps)).toBe(0);
    expect(errLines).toEqual([]);
  });

  it.each([...PENDING_PHASES])("exits 0 at pending phase %s", async (phase) => {
    const { deps, errLines } = makeDeps({
      stdin: "{}",
      pane: "%1",
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
      pane: "%1",
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
      pane: "%1",
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
      ["merging", "step 10 → step 11 (finalize merge, run local follow-ups, then MERGED)"],
    ];
    for (const [phase, label] of expected) {
      const { deps, errLines } = makeDeps({
        stdin: "{}",
        pane: "%1",
        slug: "demo",
        state: fakeState(phase),
      });
      expect(await run(deps)).toBe(2);
      expect(errLines.join(""), `phase=${phase}`).toContain(label);
    }
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
      pane: "%1",
      slug: "demo",
      state: fakeState("plan-pending-review"),
      turnTracking: null,
    });
    expect(await run(deps)).toBe(0);
    expect(writeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ blockCount: 0, lastPhase: "plan-pending-review" }),
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
      pane: "%1",
      slug: "demo",
      state: fakeState("plan-pending-review"),
      turnTracking: fakeTracking({ blockCount: TURN_BLOCK_LIMIT, lastPhase: "verifying" }),
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
      pane: "%1",
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
      pane: "%1",
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
      pane: "%1",
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
      pane: "%1",
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

  it("(6) out-of-tmux skips tracking I/O entirely", async () => {
    const { deps, errLines, writeTurn } = makeDeps({
      stdin: JSON.stringify({}),
      pane: "",
      slug: "demo",
      state: fakeState("implementing"),
    });
    expect(await run(deps)).toBe(0);
    expect(writeTurn).not.toHaveBeenCalled();
    expect(errLines).toEqual([]);
  });

  it("(7) non-flow window skips tracking I/O entirely", async () => {
    const { deps, errLines, writeTurn } = makeDeps({
      stdin: JSON.stringify({}),
      pane: "%1",
      slug: "",
      state: fakeState("implementing"),
    });
    expect(await run(deps)).toBe(0);
    expect(writeTurn).not.toHaveBeenCalled();
    expect(errLines).toEqual([]);
  });
});
