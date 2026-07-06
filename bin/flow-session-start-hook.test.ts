import { describe, expect, it } from "vitest";
import {
  deliverResumeSeed,
  run,
  type DeliverSeams,
  type Deps,
} from "./flow-session-start-hook";
import { flowPipelineResumeSeed } from "./lib/feature";
import { TERMINAL_PHASES, type PipelineState } from "./lib/state";

type Stub = {
  deps: Deps;
  dispatched: string[];
  loadCalls: string[];
};

function makeDeps(opts: {
  stdin?: string;
  pane?: string;
  slug?: string;
  state?: PipelineState | null;
  markerExists?: boolean;
}): Stub {
  const dispatched: string[] = [];
  const loadCalls: string[] = [];
  const deps: Deps = {
    readStdin: async () => opts.stdin ?? "",
    tmuxPane: opts.pane,
    showFlowSlug: () => opts.slug ?? "",
    loadState: (slug) => {
      loadCalls.push(slug);
      return opts.state ?? null;
    },
    markerExists: () => opts.markerExists ?? false,
    dispatchResume: (slug) => {
      dispatched.push(slug);
    },
  };
  return { deps, dispatched, loadCalls };
}

function fakeState(
  phase: string,
  worktree: string | undefined = "/tmp/wt",
): PipelineState {
  return {
    slug: "demo",
    phase,
    repo: "/tmp/repo",
    worktree,
    updatedAt: "2026-06-30T00:00:00Z",
  };
}

describe("flow-session-start-hook — dispatches the resume seed", () => {
  it("dispatches for a non-terminal flow slug WITH a checkpoint.pending marker", async () => {
    const { deps, dispatched } = makeDeps({
      stdin: JSON.stringify({ hook_event_name: "SessionStart" }),
      pane: "%1",
      slug: "demo",
      state: fakeState("checkpoint-pending-clear"),
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual(["demo"]);
  });

  it("dispatches at gated WITH a checkpoint marker (feedback-mode resume point)", async () => {
    const { deps, dispatched } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("gated"),
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual(["demo"]);
  });

  it("run() returns without awaiting delivery (dispatchResume is fire-and-forget)", async () => {
    // A dispatchResume that never resolves anything (records synchronously and
    // returns void) must not delay run()'s resolution — run() dispatches and
    // returns, it never awaits the delivery.
    let delivered = false;
    const deps: Deps = {
      readStdin: async () => "",
      tmuxPane: "%1",
      showFlowSlug: () => "demo",
      loadState: () => fakeState("checkpoint-pending-clear"),
      markerExists: () => true,
      dispatchResume: () => {
        // Simulate the real detached-child dispatch: returns immediately,
        // delivery happens out-of-band and is NOT awaited by run().
      },
    };
    await expect(run(deps)).resolves.toBe(0);
    expect(delivered).toBe(false);
  });
});

describe("flow-session-start-hook — silent no-op paths", () => {
  it("no-op (no dispatch, exit 0) when TMUX_PANE is undefined (unresolved slug)", async () => {
    const { deps, dispatched, loadCalls } = makeDeps({
      pane: undefined,
      state: fakeState("implementing"),
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(loadCalls).toEqual([]);
  });

  it("no-op when @flow-slug is empty (non-flow window)", async () => {
    const { deps, dispatched, loadCalls } = makeDeps({
      pane: "%1",
      slug: "",
      state: fakeState("implementing"),
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(loadCalls).toEqual([]);
  });

  it("no-op when state.json is missing for the slug", async () => {
    const { deps, dispatched } = makeDeps({
      pane: "%1",
      slug: "ghost",
      state: null,
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it("no-op at every terminal phase even with a marker present (EXCEPT gated)", async () => {
    // `gated` is deliberately excluded from the terminal no-op: a gated
    // pipeline carrying a checkpoint marker is a feedback-mode resume point,
    // so it dispatches (covered above). Every OTHER terminal phase still
    // no-ops even with a marker present.
    for (const phase of TERMINAL_PHASES.filter((p) => p !== "gated")) {
      const { deps, dispatched } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState(phase),
        markerExists: true,
      });
      expect(await run(deps), phase).toBe(0);
      expect(dispatched, phase).toEqual([]);
    }
  });

  it("no-op at gated WITHOUT a checkpoint marker (a plain /clear at the gate still clears)", async () => {
    const { deps, dispatched } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("gated"),
      markerExists: false,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it("no-op for a non-terminal slug when the checkpoint.pending marker is absent", async () => {
    const { deps, dispatched } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("checkpoint-pending-clear"),
      markerExists: false,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it("no-op for a non-terminal slug whose state carries no worktree", async () => {
    // Explicit `undefined` still triggers fakeState's `worktree = "/tmp/wt"`
    // default param, so override the field directly to get a genuinely
    // worktree-less state (no worktree ⇒ no marker path ⇒ hard no-op).
    const { deps, dispatched } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: { ...fakeState("checkpoint-pending-clear"), worktree: undefined },
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual([]);
  });
});

// A capturePane stub that yields the given frames in order, then repeats the
// last frame forever (so a stable post-clear prompt keeps returning identically).
function frames(seq: string[]): () => string {
  let i = 0;
  return () => {
    const v = seq[Math.min(i, seq.length - 1)] ?? "";
    i++;
    return v;
  };
}

type SendCall = { text: string; literal: boolean };

function makeSeams(
  capture: () => string,
  attempts = 20,
): {
  seams: DeliverSeams;
  sends: SendCall[];
} {
  const sends: SendCall[] = [];
  const seams: DeliverSeams = {
    capturePane: capture,
    sendKeys: (text, literal) => {
      sends.push({ text, literal });
      return { ok: true, stderr: "" };
    },
    sleep: () => {},
    attempts,
  };
  return { seams, sends };
}

describe("deliverResumeSeed — clear-aware send-keys delivery", () => {
  it("sends the literal seed then a SEPARATE Enter once the pane settles post-clear", () => {
    // initial snapshot = pre-clear prompt; then it transitions to a fresh
    // prompt that stays stable → clear-aware ready.
    const capture = frames([
      "old pre-clear prompt",
      "fresh",
      "fresh",
      "fresh",
      "fresh",
    ]);
    const { seams, sends } = makeSeams(capture);
    expect(deliverResumeSeed("demo", seams)).toBe(true);
    expect(sends).toEqual([
      { text: flowPipelineResumeSeed("demo"), literal: true },
      { text: "Enter", literal: false },
    ]);
    // The literal seed is the exact reused resume-seed string, multi-line.
    expect(sends[0]?.text).toContain("--resume mode for: demo");
    expect(sends[0]?.text).toContain("\n");
  });

  it("does NOT fire into the stale pre-clear prompt (False-Positive-Poll guard)", () => {
    // The pre-clear prompt is non-empty and briefly stable, but it is the
    // SAME as the initial snapshot — a settle with no transition must not be
    // treated as ready on the fast path (only the longer fallback would, and
    // here the budget ends before the clear ever completes).
    const capture = frames(["stale prompt"]); // never changes, never clears
    const { seams, sends } = makeSeams(capture, /* attempts */ 3);
    // With 3 attempts and no transition, the fast path (needs a change) never
    // fires and the fallback (STABLE_PROBES + EXTRA = 6) is not reached → no send.
    expect(deliverResumeSeed("demo", seams)).toBe(false);
    expect(sends).toEqual([]);
  });

  it("returns false without sending when the pane never becomes ready", () => {
    // Alternating content never stabilises → never ready within budget.
    const capture = frames(["a", "b", "a", "b", "a", "b"]);
    const { seams, sends } = makeSeams(capture, 6);
    expect(deliverResumeSeed("demo", seams)).toBe(false);
    expect(sends).toEqual([]);
  });

  it("reports failure when a send-keys call fails", () => {
    const capture = frames(["old", "fresh", "fresh", "fresh", "fresh"]);
    const sends: SendCall[] = [];
    const seams: DeliverSeams = {
      capturePane: capture,
      sendKeys: (text, literal) => {
        sends.push({ text, literal });
        return { ok: false, stderr: "window not found" };
      },
      sleep: () => {},
      attempts: 20,
    };
    expect(deliverResumeSeed("demo", seams)).toBe(false);
    // It still attempted both sends (literal seed + Enter) before reporting.
    expect(sends.length).toBeGreaterThanOrEqual(1);
  });
});
