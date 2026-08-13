import { describe, expect, it } from "vitest";
import {
  deliverResumeSeed,
  parseResumeKind,
  resumeSeedFor,
  run,
  sessionStartOutput,
  terminalAdvisory,
  terminalCarryOver,
  type DeliverSeams,
  type Deps,
  type ResumeKind,
} from "./flow-session-start-hook";
import { flowPipelineResumeSeed } from "./lib/feature";
import { TERMINAL_PHASES, type PipelineState } from "./lib/state";

type Stub = {
  deps: Deps;
  dispatched: string[];
  dispatchedKinds: ResumeKind[];
  emitted: string[];
  loadCalls: string[];
  retiredSlugs: string[];
};

function makeDeps(opts: {
  stdin?: string;
  pane?: string;
  slug?: string;
  flowSlugEnv?: string;
  state?: PipelineState | null;
  markerExists?: boolean;
  /** Terminal-carry-over body: `null`/omitted falls back to `terminalAdvisory`. */
  checkpointBody?: string | null;
  /** Makes `readCheckpointBody` throw — must still return 0 and emit nothing. */
  readCheckpointBodyThrows?: boolean;
  /** Makes `retireCheckpoint` throw — must still return 0. */
  retireCheckpointThrows?: boolean;
  /**
   * Stubs the `@flow-kind` seam. Defaults to `() => null` — NOT omitted —
   * so tests never fall through to the real `resolveKindAmbient()` (which
   * would read the live tmux pane this suite happens to run inside) unless
   * a test explicitly wants that fallback exercised.
   */
  resolveKind?: () => ResumeKind | null;
}): Stub {
  const dispatched: string[] = [];
  const dispatchedKinds: ResumeKind[] = [];
  const emitted: string[] = [];
  const loadCalls: string[] = [];
  const retiredSlugs: string[] = [];
  const deps: Deps = {
    readStdin: async () => opts.stdin ?? "",
    flowSlugEnv: opts.flowSlugEnv,
    tmuxPane: opts.pane,
    showFlowSlug: () => opts.slug ?? "",
    loadState: (slug) => {
      loadCalls.push(slug);
      return opts.state ?? null;
    },
    markerExists: () => opts.markerExists ?? false,
    readCheckpointBody: () => {
      if (opts.readCheckpointBodyThrows) throw new Error("boom");
      return opts.checkpointBody ?? null;
    },
    retireCheckpoint: (slug) => {
      if (opts.retireCheckpointThrows) throw new Error("boom");
      retiredSlugs.push(slug);
    },
    resolveKind: opts.resolveKind ?? (() => null),
    dispatchResume: (slug, kind) => {
      dispatched.push(slug);
      dispatchedKinds.push(kind);
    },
    emitContext: (context) => {
      emitted.push(context);
    },
  };
  return {
    deps,
    dispatched,
    dispatchedKinds,
    emitted,
    loadCalls,
    retiredSlugs,
  };
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
      readCheckpointBody: () => null,
      retireCheckpoint: () => undefined,
      resolveKind: () => null,
      dispatchResume: (slug) => {
        // Simulate the real detached-child dispatch: returns immediately,
        // delivery happens out-of-band and is NOT awaited by run().
        dispatchedSlug = slug;
      },
      emitContext: () => undefined,
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

  it("dispatches for a non-terminal slug even when state carries no worktree — the marker gate is worktree-independent now", async () => {
    // Before the state-dir move, `!worktree` alone short-circuited to a
    // no-op regardless of the marker. The checkpoint marker is now slug-
    // keyed, not worktree-keyed, so a worktree-less non-terminal state (e.g.
    // `starting`, before step 2 creates the worktree) with an armed marker
    // reaches the normal dispatch path.
    const { deps, dispatched } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: { ...fakeState("checkpoint-pending-clear"), worktree: undefined },
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual(["demo"]);
  });
});

describe("flow-session-start-hook — epic-kind seed selection (Task 4)", () => {
  it("(a) epic-design-pending-review + marker + no @flow-kind dispatches with kind epic-design", async () => {
    const { deps, dispatched, dispatchedKinds } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("epic-design-pending-review"),
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual(["demo"]);
    expect(dispatchedKinds).toEqual(["epic-design"]);
  });

  it("(b) every epic-design STEP phase + marker dispatches with kind epic-design", async () => {
    for (const phase of ["epic-designing", "epic-validating", "epic-pr-open"]) {
      const { deps, dispatched, dispatchedKinds } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState(phase),
        markerExists: true,
      });
      expect(await run(deps), phase).toBe(0);
      expect(dispatched, phase).toEqual(["demo"]);
      expect(dispatchedKinds, phase).toEqual(["epic-design"]);
    }
  });

  it("(c) a feature phase dispatches with kind feature and a byte-identical seed (regression)", async () => {
    const { deps, dispatched, dispatchedKinds } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("implementing"),
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual(["demo"]);
    expect(dispatchedKinds).toEqual(["feature"]);
    expect(resumeSeedFor("demo", "feature")).toBe(
      flowPipelineResumeSeed("demo"),
    );
  });

  it("(d) deliverResumeSeed(slug, seams, 'epic-design') sends the epic-create resume seed then a separate Enter", () => {
    const capture = frames(["old pre-clear prompt", "fresh", "fresh", "fresh"]);
    const seed = resumeSeedFor("demo", "epic-design");
    const lead = seed.split("\n")[0]!;
    const remainder = seed.slice(lead.length);
    const sends: SendCall[] = [];
    let leadingSent = false;
    const seams: DeliverSeams = {
      capturePane: () => {
        if (!leadingSent) return capture();
        return `❯ ${lead}`;
      },
      sendKeys: (text, literal) => {
        sends.push({ text, literal });
        if (literal) leadingSent = true;
        return { ok: true, stderr: "" };
      },
      sleep: () => {},
      attempts: 20,
    };
    expect(deliverResumeSeed("demo", seams, "epic-design")).toBe(true);
    expect(sends).toEqual([
      { text: lead, literal: true },
      { text: remainder, literal: true },
      { text: "Enter", literal: false },
    ]);
    expect(lead).toBe(
      "Use the /flow-epic-create skill in --resume mode for: demo",
    );
    expect(seed).toContain("EPIC_DIR: .flow/epics/demo");
    expect(seed).toContain("SKILL_DIR: ");
  });

  it("(e) plain path (FLOW_SLUG, no pane) at an epic phase emits the epic-design seed as additionalContext", async () => {
    const { deps, dispatched, emitted } = makeDeps({
      pane: undefined,
      flowSlugEnv: "demo",
      state: fakeState("epic-design-pending-review"),
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(emitted).toEqual([resumeSeedFor("demo", "epic-design")]);
  });

  it("(f)/(j) epic-approved + marker + no @flow-kind: no dispatch, but an advisory is emitted naming the phase + epic recovery command", async () => {
    const { deps, dispatched, emitted } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("epic-approved"),
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(emitted).toEqual([
      terminalAdvisory("demo", "epic-approved", "epic-design"),
    ]);
    expect(emitted[0]).toContain("epic-approved");
    expect(emitted[0]).toContain("flow epic create --resume demo");
  });

  it("(f2) cancelled (a SHARED terminal phase, not in EPIC_PHASES) + marker + resolveKind() === 'epic-design': advisory names the epic-design recovery command, not flow feature resume", async () => {
    const { deps, dispatched, emitted } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("cancelled"),
      markerExists: true,
      resolveKind: () => "epic-design",
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(emitted).toEqual([
      terminalAdvisory("demo", "cancelled", "epic-design"),
    ]);
    expect(emitted[0]).toContain("flow epic create --resume demo");
    expect(emitted[0]).not.toContain("flow feature resume");
  });

  it("(f3) needs-human (a SHARED terminal phase) + marker + resolveKind() === 'epic-design': isEpicPhase('needs-human') would wrongly say false — the fix must use the resolved kind, not re-derive from phase", async () => {
    const { deps, dispatched, emitted } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("needs-human"),
      markerExists: true,
      resolveKind: () => "epic-design",
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(emitted).toEqual([
      terminalAdvisory("demo", "needs-human", "epic-design"),
    ]);
    expect(emitted[0]).toContain("flow epic create --resume demo");
  });

  it("(g) epic-approved + marker + resolveKind() === 'epic-run' dispatches with kind epic-run (D3 bypasses the terminal guard)", async () => {
    const { deps, dispatched, dispatchedKinds, emitted } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("epic-approved"),
      markerExists: true,
      resolveKind: () => "epic-run",
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual(["demo"]);
    expect(dispatchedKinds).toEqual(["epic-run"]);
    expect(emitted).toEqual([]); // resumed, not declined — no advisory
  });

  it("(h) deliverResumeSeed(slug, seams, 'epic-run') sends the epic-run seed with NO SKILL_DIR line", () => {
    const capture = frames(["old pre-clear prompt", "fresh", "fresh", "fresh"]);
    const seed = resumeSeedFor("demo", "epic-run");
    const lead = seed.split("\n")[0]!;
    const remainder = seed.slice(lead.length);
    const sends: SendCall[] = [];
    let leadingSent = false;
    const seams: DeliverSeams = {
      capturePane: () => {
        if (!leadingSent) return capture();
        return `❯ ${lead}`;
      },
      sendKeys: (text, literal) => {
        sends.push({ text, literal });
        if (literal) leadingSent = true;
        return { ok: true, stderr: "" };
      },
      sleep: () => {},
      attempts: 20,
    };
    expect(deliverResumeSeed("demo", seams, "epic-run")).toBe(true);
    expect(sends).toEqual([
      { text: lead, literal: true },
      { text: remainder, literal: true },
      { text: "Enter", literal: false },
    ]);
    expect(lead).toBe("Use the /flow-epic-run skill for: demo");
    expect(seed).toContain("EPIC_DIR: .flow/epics/demo");
    expect(seed).not.toContain("SKILL_DIR:");
  });

  it("(i) resolveKind() === 'feature' on a feature pipeline does not change today's behavior", async () => {
    const { deps, dispatched, dispatchedKinds } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("implementing"),
      markerExists: true,
      resolveKind: () => "feature",
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual(["demo"]);
    expect(dispatchedKinds).toEqual(["feature"]);
  });

  it("(k) epic-approved with NO marker: no dispatch and no emit (an ordinary /clear with no checkpoint stays silent)", async () => {
    const { deps, dispatched, emitted } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("epic-approved"),
      markerExists: false,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("(l) merged + marker on a feature pipeline: advisory names the flow feature resume recovery command", async () => {
    const { deps, dispatched, emitted } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("merged"),
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(emitted).toEqual([terminalAdvisory("demo", "merged", "feature")]);
    expect(emitted[0]).toContain("flow feature resume demo");
  });
});

describe("flow-session-start-hook — terminal-phase checkpoint carry-over (Task 2)", () => {
  it("a terminal phase with a non-empty body emits it under '## Checkpoint (carried over)' plus the terminal note, and retires the checkpoint exactly once", async () => {
    const { deps, dispatched, emitted, retiredSlugs } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("merged"),
      markerExists: true,
      checkpointBody: "approved with condition X\n",
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual([]); // no resume seed dispatched at a terminal phase
    expect(emitted).toEqual([
      terminalCarryOver(
        "demo",
        "merged",
        "feature",
        "approved with condition X\n",
      ),
    ]);
    expect(emitted[0]).toContain("## Checkpoint (carried over)");
    expect(emitted[0]).toContain("approved with condition X");
    expect(emitted[0]).toContain("flow feature resume demo");
    expect(retiredSlugs).toEqual(["demo"]);
  });

  it("a terminal phase with NO readable body falls back to the plain terminalAdvisory and does not retire anything", async () => {
    const { deps, emitted, retiredSlugs } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("needs-human"),
      markerExists: true,
      checkpointBody: null,
    });
    expect(await run(deps)).toBe(0);
    expect(emitted).toEqual([
      terminalAdvisory("demo", "needs-human", "feature"),
    ]);
    expect(retiredSlugs).toEqual([]);
  });

  it("a throwing readCheckpointBody still returns 0 and emits nothing — session start is never blocked", async () => {
    const { deps, emitted, retiredSlugs, dispatched } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("merged"),
      markerExists: true,
      readCheckpointBodyThrows: true,
    });
    expect(await run(deps)).toBe(0);
    expect(emitted).toEqual([]);
    expect(retiredSlugs).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it("a throwing retireCheckpoint still returns 0 — the carry-over context was already emitted before the throw, but the hook never propagates the failure", async () => {
    const { deps } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("merged"),
      markerExists: true,
      checkpointBody: "note\n",
      retireCheckpointThrows: true,
    });
    await expect(run(deps)).resolves.toBe(0);
  });

  it("a second run() after retirement (readCheckpointBody now returns null) falls back to the plain advisory", async () => {
    const { deps, emitted } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("cancelled"),
      markerExists: true,
      checkpointBody: null, // simulates the post-retirement state
    });
    expect(await run(deps)).toBe(0);
    expect(emitted).toEqual([terminalAdvisory("demo", "cancelled", "feature")]);
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
    expect(deliverResumeSeed("demo", seams, "feature")).toBe(true);
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
    expect(deliverResumeSeed("demo", seams, "feature")).toBe(false);
    expect(sends).toEqual([]);
  });

  it("returns false without sending when the pane never becomes ready", () => {
    // Alternating content never stabilises → never ready within budget.
    const capture = frames(["a", "b", "a", "b", "a", "b"]);
    const { seams, sends } = makeSeams(capture, 6);
    expect(deliverResumeSeed("demo", seams, "feature")).toBe(false);
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
    expect(deliverResumeSeed("demo", seams, "feature")).toBe(false);
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
    expect(deliverResumeSeed("demo", seams, "feature")).toBe(true);
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
    expect(deliverResumeSeed("demo", seams, "feature")).toBe(true);
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
    expect(deliverResumeSeed("demo", seams, "feature")).toBe(true);
    expect(sends).toEqual([
      { text: RESUME_LEAD, literal: true },
      { text: "C-u", literal: false },
      { text: RESUME_LEAD, literal: true },
      { text: RESUME_REMAINDER, literal: true },
      { text: "Enter", literal: false },
    ]);
  });
});

describe("plain-mode additionalContext fallback (FLOW_SLUG, no pane)", () => {
  it("emits the resume seed as additionalContext instead of send-keys", async () => {
    const { deps, dispatched, emitted } = makeDeps({
      pane: undefined,
      flowSlugEnv: "demo",
      state: fakeState("checkpoint-pending-clear"),
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(emitted).toEqual([flowPipelineResumeSeed("demo")]);
  });

  it("no-ops (no emit) when the checkpoint marker is absent", async () => {
    const { deps, dispatched, emitted } = makeDeps({
      pane: undefined,
      flowSlugEnv: "demo",
      state: fakeState("checkpoint-pending-clear"),
      markerExists: false,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("tmux path is unchanged: a pane-resolved slug still dispatches send-keys, never emits context", async () => {
    const { deps, dispatched, emitted } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("checkpoint-pending-clear"),
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual(["demo"]);
    expect(emitted).toEqual([]);
  });

  it("FLOW_SLUG with a live pane still uses send-keys (env resolves the slug, the pane owns delivery)", async () => {
    const { deps, dispatched, emitted, loadCalls } = makeDeps({
      pane: "%1",
      slug: "pane-slug",
      flowSlugEnv: "env-slug",
      state: fakeState("checkpoint-pending-clear"),
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(loadCalls).toEqual(["env-slug"]);
    expect(dispatched).toEqual(["env-slug"]);
    expect(emitted).toEqual([]);
  });

  it("a plain-launched pipeline resumed from inside a tmux pane emits context, never send-keys (regression: TMUX_PANE inherited from the user's terminal used to route to dispatchResume against a nonexistent window)", async () => {
    const { deps, dispatched, emitted } = makeDeps({
      pane: "%1",
      flowSlugEnv: "demo",
      state: { ...fakeState("checkpoint-pending-clear"), launcher: "plain" },
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(emitted).toEqual([flowPipelineResumeSeed("demo")]);
  });

  it("sessionStartOutput wraps the context in the SessionStart hookSpecificOutput shape", () => {
    expect(JSON.parse(sessionStartOutput("ctx"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "ctx",
      },
    });
  });
});

// The argv hop between `defaultDispatchResume` (parent) and the
// `import.meta.main` deliver branch (detached child) is the one link in the
// kind's journey the compiler cannot check: the parent writes the kind into
// `[import.meta.path, "deliver", slug, kind]` and the child re-reads
// `argv[2]`. Every `run()` test above stubs `dispatchResume`, so none of them
// crosses that boundary — a positional slip would degrade every epic window to
// the feature seed (the exact bug this hook exists to fix) with CI green.
describe("flow-session-start-hook — parseResumeKind argv round-trip", () => {
  const KINDS: ResumeKind[] = ["feature", "epic-design", "epic-run"];

  for (const kind of KINDS) {
    it(`survives the argv hop for '${kind}'`, () => {
      // Mirrors defaultDispatchResume's argv exactly, then reads back the slot
      // the import.meta.main branch reads (argv[2] after the leading two).
      const argv = ["deliver", "demo", kind];
      expect(parseResumeKind(argv[2])).toBe(kind);
    });
  }

  it("positions the kind at the slot the deliver branch actually reads", () => {
    // Pins the coupling itself: kind is the 3rd token, after "deliver" and the
    // slug. If either side ever reorders, this fails instead of silently
    // degrading to "feature".
    const argv = ["deliver", "demo", "epic-run"];
    expect(argv[0]).toBe("deliver");
    expect(argv[1]).toBe("demo");
    expect(parseResumeKind(argv[2])).toBe("epic-run");
  });

  it("falls back to 'feature' for undefined, empty, and unknown values", () => {
    expect(parseResumeKind(undefined)).toBe("feature");
    expect(parseResumeKind("")).toBe("feature");
    expect(parseResumeKind("bogus")).toBe("feature");
    expect(parseResumeKind("epic")).toBe("feature");
    expect(parseResumeKind("EPIC-RUN")).toBe("feature");
  });
});
