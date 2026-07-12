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
    let dispatchedSlug: string | null = null;
    const deps: Deps = {
      readStdin: async () => "",
      tmuxPane: "%1",
      showFlowSlug: () => "demo",
      loadState: () => fakeState("checkpoint-pending-clear"),
      markerExists: () => true,
      dispatchResume: (slug) => {
        // Simulate the real detached-child dispatch: returns immediately,
        // delivery happens out-of-band and is NOT awaited by run().
        dispatchedSlug = slug;
      },
    };
    await expect(run(deps)).resolves.toBe(0);
    // Dispatch was actually invoked (proves run() didn't skip it) AND run()
    // already resolved above without this test awaiting any delivery promise.
    expect(dispatchedSlug).toBe("demo");
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

// The resume seed's leading line (before the first newline) and remainder — the
// two chunks the shared deliverSeed handshake types before the submit Enter.
const RESUME_LEAD = "[pipeline-slug: demo]";
const RESUME_REMAINDER = flowPipelineResumeSeed("demo").slice(
  RESUME_LEAD.length,
);

/**
 * Wraps a `capturePane` frame generator with the delivery lifecycle deliverSeed
 * needs: the base `capture` drives the CLEAR-aware settle gate (pre-send), then
 * once a literal chunk lands the capture echoes the leading line so the
 * leading-line verify passes. `dropLeadingEchoes` makes the first N post-send
 * captures echo a TRUNCATED leading line (dropped prefix) → C-u + resend branch.
 */
function makeSeams(
  capture: () => string,
  attempts = 20,
  opts: { dropLeadingEchoes?: number } = {},
): {
  seams: DeliverSeams;
  sends: SendCall[];
} {
  const sends: SendCall[] = [];
  let leadingSent = false;
  let echoChecks = 0;
  const seams: DeliverSeams = {
    capturePane: () => {
      if (!leadingSent) return capture();
      echoChecks++;
      if (echoChecks <= (opts.dropLeadingEchoes ?? 0)) {
        return `❯ ${RESUME_LEAD.slice(3)}`; // dropped prefix ⇒ no full match
      }
      return `❯ ${RESUME_LEAD}`;
    },
    sendKeys: (text, literal) => {
      sends.push({ text, literal });
      if (literal) leadingSent = true;
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
    // Chunked delivery: leading line, then remainder, then a SEPARATE Enter.
    expect(sends).toEqual([
      { text: RESUME_LEAD, literal: true },
      { text: RESUME_REMAINDER, literal: true },
      { text: "Enter", literal: false },
    ]);
    // The remainder carries the reused resume-seed body, incl. its newline.
    expect(sends[1]?.text).toContain("--resume mode for: demo");
    expect(sends[1]?.text).toContain("\n");
    expect(RESUME_LEAD + RESUME_REMAINDER).toBe(flowPipelineResumeSeed("demo"));
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
    // The leading-line literal send failed, so delivery stops and the separate
    // Enter is guarded off — only the one (failed) send, never a partial submit.
    expect(sends).toEqual([{ text: RESUME_LEAD, literal: true }]);
  });

  it("uses the fallback-settle path (no observable transition) to still deliver", () => {
    // capturePane returns the SAME non-empty frame from the very first call —
    // the clear completed before our first capture, so `sawChange` never
    // flips true and the fast path (transition + STABLE_PROBES) can't fire.
    // With enough attempts, the longer fallback settle
    // (STABLE_PROBES + FALLBACK_EXTRA_PROBES consecutive identical captures)
    // must still return true and the seed must still be sent.
    const capture = () => "already-settled prompt";
    const { seams, sends } = makeSeams(capture, /* attempts */ 10);
    expect(deliverResumeSeed("demo", seams)).toBe(true);
    expect(sends).toEqual([
      { text: RESUME_LEAD, literal: true },
      { text: RESUME_REMAINDER, literal: true },
      { text: "Enter", literal: false },
    ]);
  });

  it("delivers on the one bounded retry when the first pass fails to settle", () => {
    // First pass (budget = attempts) sees alternating content that never
    // stabilises, so the first paneClearedAndSettled call returns false. The
    // retry pass's capture calls (continuing from the same stateful frames
    // generator) then settle into a stable, changed frame.
    const capture = frames([
      "old pre-clear prompt", // pass 1 initial snapshot
      "a",
      "b",
      "a",
      "b",
      "a",
      "b", // pass 1's 6 loop attempts: alternates forever, never settles
      "old pre-clear prompt", // pass 2 (retry) initial snapshot
      "fresh",
      "fresh",
      "fresh", // pass 2 settles: transitioned + 2 consecutive stable ⇒ ready
      "fresh",
      "fresh",
      "fresh",
    ]);
    const { seams, sends } = makeSeams(capture, /* attempts */ 6);
    expect(deliverResumeSeed("demo", seams)).toBe(true);
    expect(sends).toEqual([
      { text: RESUME_LEAD, literal: true },
      { text: RESUME_REMAINDER, literal: true },
      { text: "Enter", literal: false },
    ]);
  });

  it("dropped-leading-prefix: sends C-u and re-sends the leading line, then the remainder and Enter", () => {
    // The leading-line echo comes back truncated on the first check, so
    // deliverSeed clears the single-line box (C-u) and re-sends the leading line
    // before the remainder — the /clear-resume path inherits the same guarantee.
    const capture = frames(["old pre-clear prompt", "fresh", "fresh", "fresh"]);
    const { seams, sends } = makeSeams(capture, /* attempts */ 20, {
      dropLeadingEchoes: 1,
    });
    expect(deliverResumeSeed("demo", seams)).toBe(true);
    expect(sends).toEqual([
      { text: RESUME_LEAD, literal: true },
      { text: "C-u", literal: false },
      { text: RESUME_LEAD, literal: true },
      { text: RESUME_REMAINDER, literal: true },
      { text: "Enter", literal: false },
    ]);
  });
});
