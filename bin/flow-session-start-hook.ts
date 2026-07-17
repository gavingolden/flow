#!/usr/bin/env bun
/**
 * Claude Code SessionStart hook (matcher `clear`) for the /flow-pipeline
 * supervisor's checkpoint → /clear → auto-resume flow.
 *
 * After the user types `/clear` inside a flow pipeline window in which they
 * ran `/flow-checkpoint` (or hit the step-4 auto-checkpoint), this hook makes the
 * freshly-cleared session auto-enter resume mode — the pipeline continues
 * instead of leaving a blank session.
 *
 * Delivery mechanism, per launcher backend. TMUX: an earlier version emitted
 * the resume seed as SessionStart `additionalContext`, but that is injected
 * PASSIVELY — it never triggers an autonomous assistant turn, so with no user
 * message after `/clear` the supervisor never entered resume mode and the
 * pane sat blank; the tmux path therefore delivers the seed as a REAL user
 * turn via `tmux send-keys` — the exact mechanism the initial launch and
 * `flow feature resume` already use (`bin/lib/tmux.ts`). PLAIN (slug resolved
 * via `FLOW_SLUG` with no tmux pane): there is no send-keys surface, so the
 * hook DELIBERATELY falls back to emitting the seed as `additionalContext` —
 * passive delivery is ACCEPTED here because the user is present at a
 * foreground terminal and their next message carries the resume context in.
 * The seed text is the SAME string `flow feature resume` sends, reused (not
 * re-authored) from `flowPipelineResumeSeed`.
 *
 * The hook is synchronous and BLOCKS session start, so it must return promptly:
 * `run()` fires the delivery as a DETACHED, unref'd child (`dispatchResume`)
 * and returns immediately without awaiting it. The child owns a CLEAR-AWARE
 * readiness gate — it waits for the pane to settle into its post-`/clear` state
 * before sending, so it never fires into the stale pre-clear prompt (whose
 * keystrokes `/clear` would then wipe — the False-Positive-Poll race).
 *
 * Correctness constraint: the hook is global (`~/.claude/settings.json`) and
 * fires on EVERY `/clear` on the machine, so it MUST do nothing — no delivery,
 * exit 0 — unless ALL of: the tmux window resolves to a non-terminal flow
 * pipeline AND a `<worktree>/.flow-tmp/checkpoint.pending` marker is present
 * (written by `flow-checkpoint` on a ready verdict). A plain `/clear` with no
 * prior checkpoint leaves no marker → the hook no-ops and the session clears
 * normally. Modeled on `flow-stop-guard`'s "no-op when state.json
 * missing/terminal" discipline.
 */

import * as fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { readState, TERMINAL_PHASE_SET, type PipelineState } from "./lib/state";
import { resolveSlugFromEnv } from "./lib/session-identity";
import { flowPipelineResumeSeed } from "./lib/feature";
import { capturePaneBySlug, sendKeysBySlug } from "./lib/tmux";
import { deliverSeed } from "./lib/seed-delivery";
import { sleepSync } from "./lib/sleep";
import { markerPath } from "./flow-checkpoint";

export type Deps = {
  readStdin: () => Promise<string>;
  /** FLOW_SLUG env value (env-first ambient slug; both launcher backends set it). */
  flowSlugEnv?: string | undefined;
  tmuxPane: string | undefined;
  showFlowSlug: (pane: string) => string;
  /**
   * Plain-mode delivery: emit the SessionStart hookSpecificOutput JSON
   * carrying the resume seed as additionalContext. Default writes to stdout
   * (the SessionStart hook contract); injected in tests.
   */
  emitContext: (context: string) => void;
  loadState: (slug: string) => PipelineState | null;
  markerExists: (worktree: string) => boolean;
  /**
   * Fire-and-forget resume-seed delivery. On the emit path `run()` calls this
   * and returns immediately — it MUST NOT block session start, so the default
   * implementation spawns a detached child and returns synchronously. Injected
   * in tests to record the dispatch without spawning anything.
   */
  dispatchResume: (slug: string) => void;
};

export async function run(deps: Deps): Promise<number> {
  // Drain stdin so the harness's pipe closes cleanly. The SessionStart payload
  // carries no field this hook needs — the decision is entirely disk-derived —
  // so a malformed / empty read is harmless.
  try {
    await deps.readStdin();
  } catch {
    // A stdin read hiccup must never break session start; fall through.
  }

  // Env-first slug resolution: FLOW_SLUG (shape-validated) wins; the tmux
  // pane option is the fallback for tmux-launched sessions.
  const pane = deps.tmuxPane;
  let slug =
    resolveSlugFromEnv({ FLOW_SLUG: deps.flowSlugEnv } as NodeJS.ProcessEnv) ??
    "";
  if (slug.length === 0) {
    if (!pane) return 0;
    slug = deps.showFlowSlug(pane).trim();
  }
  if (slug.length === 0) return 0;

  const state = deps.loadState(slug);
  if (!state) return 0;

  // A terminal pipeline has nothing to resume — never deliver a stray seed.
  // EXCEPT `gated`: a gated pipeline carrying a checkpoint marker is a
  // feedback-mode resume point (flow-resume-decide resolves it to
  // `gated-feedback`), so it falls through to the marker check below —
  // marker present → deliver the seed, marker absent → no-op like any terminal.
  if (TERMINAL_PHASE_SET.has(state.phase) && state.phase !== "gated") return 0;

  // The one-shot marker is the deliberate opt-in: no /flow-checkpoint → no marker →
  // no auto-resume, so the user keeps the choice to /clear without a checkpoint.
  const worktree = state.worktree;
  if (!worktree || !deps.markerExists(worktree)) return 0;

  // Emit path. TMUX: deliver the resume seed as a real user turn (send-keys),
  // fire-and-forget — dispatchResume returns at once (detached child), so the
  // hook does not block session start. PLAIN (env-resolved slug, no pane):
  // no send-keys surface exists, so degrade to passive additionalContext —
  // the deliberate plain-mode fallback (see the header comment).
  if (!pane || state.launcher === "plain") {
    deps.emitContext(flowPipelineResumeSeed(slug));
    return 0;
  }
  deps.dispatchResume(slug);
  return 0;
}

/** SessionStart hookSpecificOutput JSON for the plain-mode context emit. */
export function sessionStartOutput(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  });
}

/** Seams for the clear-aware resume-seed delivery, injected in unit tests. */
export type DeliverSeams = {
  capturePane: () => string;
  sendKeys: (
    keysOrText: string,
    literal: boolean,
  ) => { ok: boolean; stderr: string };
  sleep: (ms: number) => void;
  /** Per-poll-pass attempt budget (injectable so tests run instantly). */
  attempts?: number;
};

const DELIVER_POLL_ATTEMPTS = 40; // ~40 × 150ms ≈ 6s budget per pass
const DELIVER_POLL_INTERVAL_MS = 150;
const DELIVER_STABLE_PROBES = 2; // consecutive identical non-empty captures ⇒ settled
const DELIVER_FALLBACK_EXTRA_PROBES = 4; // extra settle when no transition is observable

/**
 * Clear-aware readiness: `/clear` wipes the pane then redraws a fresh prompt.
 * Snapshot the initial (possibly pre-clear) content, then poll until the pane
 * is non-empty AND stable across DELIVER_STABLE_PROBES consecutive captures.
 * Prefer a settle that ALSO transitioned away from the pre-clear snapshot (so
 * we never fire into the stale prompt `/clear` is about to wipe — the
 * False-Positive-Poll race). When the clear completed before our first capture
 * (no transition observable), fall back to a longer stable settle so a
 * genuinely-ready pane still delivers. Always sleeps BEFORE the first capture,
 * skipping the immediate post-`/clear` redraw transient.
 */
function paneClearedAndSettled(seams: DeliverSeams, attempts: number): boolean {
  const initial = seams.capturePane().trim();
  let prev: string | null = null;
  let stable = 0;
  let sawChange = false;
  for (let i = 0; i < attempts; i++) {
    seams.sleep(DELIVER_POLL_INTERVAL_MS);
    const cur = seams.capturePane().trim();
    if (cur !== initial) sawChange = true;
    if (cur.length > 0 && cur === prev) {
      stable++;
      if (sawChange && stable >= DELIVER_STABLE_PROBES) return true;
      if (stable >= DELIVER_STABLE_PROBES + DELIVER_FALLBACK_EXTRA_PROBES) {
        return true;
      }
    } else {
      stable = 0;
    }
    prev = cur;
  }
  return false;
}

/**
 * Delivers the resume seed to the pipeline window as a real user turn. Waits for
 * the clear-aware readiness gate (with ONE bounded retry — the plan's mitigation
 * for the timing race), then delegates to the shared `deliverSeed`: it sends the
 * seed's leading line, verifies it echoed intact (re-sending on a dropped
 * prefix), chunks below tmux's send-keys byte cap, and checks every literal
 * send. The SEPARATE submit `Enter` fires ONLY when delivery verified —
 * preserving this path's discipline of never submitting after a failed literal
 * send (which could submit stale/partial pane content on a live pane). Returns
 * false (never fires blind) when the pane never becomes ready or delivery fails.
 * Exported for unit testing.
 */
export function deliverResumeSeed(slug: string, seams: DeliverSeams): boolean {
  const attempts = seams.attempts ?? DELIVER_POLL_ATTEMPTS;
  // paneClearedAndSettled owns the CLEAR-aware gate (its transitioned-away-from-
  // the-pre-clear-snapshot semantics are distinct from deliverSeed's generic
  // content-settle), so it stays here rather than folding into deliverSeed.
  let ready = paneClearedAndSettled(seams, attempts);
  if (!ready) ready = paneClearedAndSettled(seams, attempts); // one bounded retry
  if (!ready) return false;
  // settleAttempts: 0 skips deliverSeed's generic settle poll — paneClearedAndSettled
  // above already waited for the pane to clear and stabilise, so the redundant
  // gate would only cost one wasted sleep interval.
  const result = deliverSeed(
    flowPipelineResumeSeed(slug),
    {
      capture: seams.capturePane,
      send: seams.sendKeys,
      sleep: seams.sleep,
    },
    { settleAttempts: 0 },
  );
  if (!result.delivered) return false;
  const submitted = seams.sendKeys("Enter", false);
  return submitted.ok;
}

/** Reads the window's `@flow-slug` user option — mirrors flow-stop-guard. */
export function defaultShowFlowSlug(pane: string): string {
  const r = spawnSync(
    "tmux",
    ["show-options", "-w", "-t", pane, "-q", "-v", "@flow-slug"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return "";
  return r.stdout ?? "";
}

/**
 * Default fire-and-forget dispatch: re-exec THIS script as `deliver <slug>` in
 * a detached, unref'd child so the foreground hook returns without awaiting the
 * clear-aware readiness poll (which must run AFTER the hook returns and the
 * session finishes clearing). Best-effort: a spawn failure must never break
 * session start.
 */
function defaultDispatchResume(slug: string): void {
  try {
    const child = spawn(process.execPath, [import.meta.path, "deliver", slug], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Never let a spawn hiccup break session start.
  }
}

async function defaultReadStdin(): Promise<string> {
  // Bun.stdin reads to EOF; on a TTY (no piped input) this can hang, so the
  // helper bails after a short wait. Claude Code always pipes JSON when
  // invoking a SessionStart hook, so the hang case is only hit when a developer
  // runs the helper by hand. Copied from flow-stop-guard.
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    process.stdin.on("data", (c) => chunks.push(c as Uint8Array));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    setTimeout(finish, 250);
  });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "deliver" && argv[1]) {
    // Detached-child entry: run the clear-aware send-keys delivery against the
    // live tmux window resolved by slug, then exit.
    const slug = argv[1];
    const ok = deliverResumeSeed(slug, {
      capturePane: () => capturePaneBySlug(slug),
      sendKeys: (keysOrText, literal) =>
        sendKeysBySlug(slug, keysOrText, literal),
      sleep: (ms) => sleepSync(ms),
    });
    process.exit(ok ? 0 : 1);
  }
  run({
    readStdin: defaultReadStdin,
    flowSlugEnv: process.env.FLOW_SLUG,
    tmuxPane: process.env.TMUX_PANE,
    emitContext: (context) => {
      process.stdout.write(sessionStartOutput(context) + "\n");
    },
    showFlowSlug: defaultShowFlowSlug,
    loadState: (slug) => readState(slug),
    markerExists: (worktree) => {
      try {
        return fs.existsSync(markerPath(worktree));
      } catch {
        return false;
      }
    },
    dispatchResume: defaultDispatchResume,
  }).then((code) => process.exit(code));
}
