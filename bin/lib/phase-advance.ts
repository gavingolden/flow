/**
 * Phase-advance primitive: `advancePhase` (non-terminal, monotonic) and
 * `finalizePhase` (terminal, permits the one legal `gated`/`needs-human`
 * -> `merged` backward-looking transition).
 *
 * `flow-open-pr` / `flow-ci-check` / `flow-fetch-pr-review` /
 * `flow-gate-decide` / `flow-merge-guard` each call `advancePhase` as a
 * side effect of returning the value the supervisor cannot proceed
 * without — a PR URL, a CI decision, a review payload, a gate verdict, or
 * a guard exit code. `flow-gate-summary` calls `finalizePhase` as a side
 * effect of a successful terminal-status render (`merged` / `gated` /
 * `needs-human` / `cancelled` — see `TERMINAL_PHASE_EMITTERS` below). Both
 * writes can no longer be a skippable prompt instruction: PR #676's
 * baseline re-record measured the supervisor partially executing a
 * mandatory fenced block (running its third statement, never its first),
 * so each write is moved into code the supervisor has no way to bypass
 * and still obtain the value it needs.
 *
 * `advancePhase`'s monotonicity (never moving `phase` backwards, no-oping
 * on terminal / epic-* phases) is `bin/lib/state.ts`'s `STEP_PHASES`
 * ordering applied as a guard — the one idea kept from the rejected
 * "derive phase from artifacts" alternative (see plan.md Decision D1,
 * Branch C). `finalizePhase` is the sanctioned exception: it permits the
 * `gated` / `needs-human` -> `merged` edge (AWAITING_HUMAN_PHASES) that
 * `advancePhase`'s STEP_PHASES ordering alone cannot express, while still
 * refusing out of `FINISHED_PHASE_SET`.
 */

import {
  readState,
  writeState,
  appendPhaseLog,
  STEP_PHASES,
  TERMINAL_PHASE_SET,
  FINISHED_PHASE_SET,
  nowIso,
  type PipelinePhase,
  type PipelineState,
} from "./state";
import { resolveSlugAmbient } from "./session-identity";
import { FLOW_STATE_DIR } from "./paths";
import { checkWorktreeBranch } from "./worktree-marker";
import { publishStateBadges } from "./tmux";
import { recordEvent } from "./telemetry";

export type PhaseAdvanceReason =
  | "advanced"
  | "reentered"
  | "finalized"
  | "no-slug"
  | "no-state"
  | "already-at-or-past"
  | "already-terminal"
  | "terminal"
  | "finished"
  | "epic-phase"
  | "pr-mismatch"
  | "branch-mismatch";

export type PhaseAdvanceResult = {
  advanced: boolean;
  reason: PhaseAdvanceReason;
  from?: string;
  to: string;
};

export type AdvancePhaseOpts = {
  slug?: string | null;
  expectPr?: number | null;
  dir?: string;
  resolveSlug?: () => string | null;
  /**
   * Best-effort tmux badge publisher, fired once per successful write with
   * the freshly-written state (never the pre-write state — that would leave
   * every badge one transition behind). Defaults to the real
   * `publishStateBadges`. Void-discarded: a throwing publisher can never
   * alter `advanced`/`reason`/the exit code. Tests inject a stub.
   */
  publishBadges?: (state: PipelineState) => void;
};

/**
 * Maps every `PENDING_PHASES` entry a helper can legitimately observe to
 * the `STEP_PHASES` index it anchors at, so a repeated poll while the
 * pipeline sits in that pending phase is a safe equal-phase no-op rather
 * than a backward move.
 *
 * Deliberately anchors `ci-wait-pending` ONLY, not all nine
 * `PENDING_PHASES` entries — the cut-list form (plan.md "## Cut list" +
 * the cross-model review's accepted point) wins over Task 1's original
 * nine-entry enumeration: helper emissions only ever advance from forward
 * step phases, and `ci-wait-pending` (the Step-7 yield) is the only
 * pending phase one of the six helpers can observe live.
 */
export const PENDING_PHASE_ANCHOR: Readonly<Record<string, string>> = {
  "ci-wait-pending": "ci-wait",
};

/**
 * Named allowlist of the only two backward `advancePhase` writes
 * permitted — the documented fix-loop re-entries, both emitted by
 * `flow-ci-check`. Hand-listed, never derived, mirroring
 * `bin/lib/state.ts:542`'s `TERMINAL_EXIT_TRANSITIONS` — a derived rule
 * would silently auto-enroll a future phase. Each edge names the
 * SKILL.md site it recovers:
 *  - `ci-wait -> implementing`: step 7's `ci-failed` row loops back to
 *    step 5 (implement) to fix CI.
 *  - `reviewing -> ci-wait`: step 8's "return to step 7 (CI wait), not
 *    directly to step 9" after a review-fix commit + push.
 *
 * The backward branch in `advancePhase` additionally requires a matched
 * `expectPr` — this table alone is not sufficient to permit the write.
 */
export const FIX_LOOP_REENTRY_TRANSITIONS: Readonly<
  Record<string, readonly PipelinePhase[]>
> = {
  "ci-wait": ["implementing"],
  reviewing: ["ci-wait"],
};

export function isFixLoopReentry(from: string, to: string): boolean {
  return Object.hasOwn(FIX_LOOP_REENTRY_TRANSITIONS, from)
    ? (FIX_LOOP_REENTRY_TRANSITIONS[from] as readonly string[]).includes(to)
    : false;
}

/**
 * Phase → emitting-helper map. Consumed by `bin/skill-md-lint.test.ts` to
 * assert SKILL.md names the right helper at each site and carries no
 * standalone `flow-state-update --phase <phase>` fence for these five.
 * `verifying` is deliberately absent — step 6 now writes it via an
 * explicit `flow-state-update --phase verifying` call (no subagent
 * side-effect helper resolves it anymore).
 * Must not contradict `bin/flow-stop-guard.ts`'s `NEXT_STEP_BY_PHASE`.
 */
export const PHASE_EMITTERS: Readonly<
  Record<
    "implementing" | "ci-wait" | "reviewing" | "gating" | "merging",
    string
  >
> = {
  implementing: "flow-open-pr",
  "ci-wait": "flow-ci-check",
  reviewing: "flow-fetch-pr-review",
  gating: "flow-gate-decide",
  merging: "flow-merge-guard",
};

function resolveIndex(phase: string): number {
  const anchored = PENDING_PHASE_ANCHOR[phase] ?? phase;
  return (STEP_PHASES as readonly string[]).indexOf(anchored);
}

export function advancePhase(
  target: PipelinePhase,
  opts: AdvancePhaseOpts = {},
): PhaseAdvanceResult {
  const dir = opts.dir ?? FLOW_STATE_DIR;
  const resolveSlug = opts.resolveSlug ?? (() => resolveSlugAmbient());
  const slug = opts.slug ?? resolveSlug();
  if (!slug) {
    return { advanced: false, reason: "no-slug", to: target };
  }

  const state = readState(slug, dir);
  if (!state) {
    return { advanced: false, reason: "no-state", to: target };
  }

  if (TERMINAL_PHASE_SET.has(state.phase)) {
    return {
      advanced: false,
      reason: "terminal",
      from: state.phase,
      to: target,
    };
  }

  if (state.phase.startsWith("epic-")) {
    return {
      advanced: false,
      reason: "epic-phase",
      from: state.phase,
      to: target,
    };
  }

  if (
    opts.expectPr !== undefined &&
    opts.expectPr !== null &&
    state.pr !== opts.expectPr
  ) {
    console.error(
      `NOTICE — phase-advance: slug ${slug} is pipeline for PR #${state.pr}, not #${opts.expectPr}; not advancing.`,
    );
    return {
      advanced: false,
      reason: "pr-mismatch",
      from: state.phase,
      to: target,
    };
  }

  const currentIndex = resolveIndex(state.phase);
  const targetIndex = resolveIndex(target);
  let isReentry = false;
  if (currentIndex >= 0 && currentIndex >= targetIndex) {
    // Equal phase is always refused. A strictly-backward move is refused
    // too, UNLESS the caller supplied a matching `expectPr` (already
    // verified above — the `pr-mismatch` check would have returned first
    // on a mismatch) AND the anchored `(from, to)` pair is one of the two
    // named fix-loop re-entries. Anchoring `state.phase` (not using it
    // raw) matters: the commonest real case is the Step-7 yield-and-resume
    // path, which leaves the live phase at `ci-wait-pending`, not
    // `ci-wait` — see PENDING_PHASE_ANCHOR.
    const isBackward = currentIndex > targetIndex;
    const anchoredFrom = PENDING_PHASE_ANCHOR[state.phase] ?? state.phase;
    const permitted =
      isBackward &&
      opts.expectPr !== undefined &&
      opts.expectPr !== null &&
      isFixLoopReentry(anchoredFrom, target);
    if (!permitted) {
      return {
        advanced: false,
        reason: "already-at-or-past",
        from: state.phase,
        to: target,
      };
    }
    isReentry = true;
  }

  // Mechanical defense against the 2026-05-01 worktree-contamination
  // failure mode: a peer pipeline renames this worktree's branch and the
  // next phase write would land commits on the wrong ref. Mirrors
  // `flow-state-update`'s guard (bin/lib/state.ts's "checkWorktreeBranch
  // still runs on every write" claim) — refuse the write and let the
  // caller escalate `NEEDS HUMAN: branch-mismatch` instead of continuing.
  const guard = checkWorktreeBranch(state.worktree);
  if (guard.kind === "mismatch") {
    console.error(
      `phase-advance: branch-mismatch in worktree '${state.worktree}'\n` +
        `  expected: ${guard.expected}\n` +
        `  actual (git branch --show-current): ${guard.actual}\n` +
        `  Refusing to advance phase to '${target}'.`,
    );
    return {
      advanced: false,
      reason: "branch-mismatch",
      from: state.phase,
      to: target,
    };
  }

  const written = {
    ...state,
    phase: target,
    phaseLog: appendPhaseLog(state, target),
    updatedAt: nowIso(),
  };
  writeState(written, dir);
  const publishBadges =
    opts.publishBadges ?? ((s) => void publishStateBadges(s));
  // Best-effort: a throwing publisher must never fail a successful phase
  // write. state.json is already durable at this point.
  try {
    publishBadges(written);
  } catch {
    // swallowed — see comment above.
  }
  // Durable phase-trace telemetry, same best-effort idiom as the
  // publishBadges block above — advancePhase bypasses flow-state-update
  // entirely for the six PHASE_EMITTERS phases, so this is the only place
  // those transitions would otherwise go unrecorded.
  try {
    const priorLog = state.phaseLog;
    const lastEntry =
      priorLog && priorLog.length > 0
        ? priorLog[priorLog.length - 1]
        : undefined;
    const sincePrevMs = lastEntry
      ? Date.now() - Date.parse(lastEntry.at)
      : null;
    recordEvent("phase.transition", {
      from: state.phase,
      to: target,
      outcome: null,
      since_prev_ms: sincePrevMs,
      forced: false,
    });
  } catch {
    // swallowed — see comment above.
  }
  return {
    advanced: true,
    reason: isReentry ? "reentered" : "advanced",
    from: state.phase,
    to: target,
  };
}

/**
 * Terminal-phase write primitive. `advancePhase` cannot express this: a
 * terminal phase is not in `STEP_PHASES`, so `resolveIndex` returns `-1`
 * and every `advancePhase` call short-circuits to `already-at-or-past`.
 * A sibling function keeps that guard chain untouched rather than
 * widening `resolveIndex` to rank terminals, which would let all six
 * existing forward `advancePhase` call sites terminalize a pipeline.
 *
 * Permits writes out of `gated` / `needs-human` (AWAITING_HUMAN_PHASES)
 * so the real `gated -> merged` transition works, but refuses out of
 * `FINISHED_PHASE_SET` (`merged`, `cancelled`, `epic-approved`) so
 * `merged -> gated` does not. No-ops when `state.phase === target`
 * (idempotent re-render), appending no second `phaseLog[]` entry.
 */
export function finalizePhase(
  target: PipelinePhase,
  opts: AdvancePhaseOpts = {},
): PhaseAdvanceResult {
  const dir = opts.dir ?? FLOW_STATE_DIR;
  const resolveSlug = opts.resolveSlug ?? (() => resolveSlugAmbient());
  const slug = opts.slug ?? resolveSlug();
  if (!slug) {
    return { advanced: false, reason: "no-slug", to: target };
  }

  const state = readState(slug, dir);
  if (!state) {
    return { advanced: false, reason: "no-state", to: target };
  }

  if (state.phase.startsWith("epic-")) {
    return {
      advanced: false,
      reason: "epic-phase",
      from: state.phase,
      to: target,
    };
  }

  if (state.phase === target) {
    return {
      advanced: false,
      reason: "already-terminal",
      from: state.phase,
      to: target,
    };
  }

  if (FINISHED_PHASE_SET.has(state.phase)) {
    return {
      advanced: false,
      reason: "finished",
      from: state.phase,
      to: target,
    };
  }

  if (
    opts.expectPr !== undefined &&
    opts.expectPr !== null &&
    state.pr !== opts.expectPr
  ) {
    console.error(
      `NOTICE — phase-advance: slug ${slug} is pipeline for PR #${state.pr}, not #${opts.expectPr}; not advancing.`,
    );
    return {
      advanced: false,
      reason: "pr-mismatch",
      from: state.phase,
      to: target,
    };
  }

  const guard = checkWorktreeBranch(state.worktree);
  if (guard.kind === "mismatch") {
    console.error(
      `phase-advance: branch-mismatch in worktree '${state.worktree}'\n` +
        `  expected: ${guard.expected}\n` +
        `  actual (git branch --show-current): ${guard.actual}\n` +
        `  Refusing to advance phase to '${target}'.`,
    );
    return {
      advanced: false,
      reason: "branch-mismatch",
      from: state.phase,
      to: target,
    };
  }

  const written = {
    ...state,
    phase: target,
    phaseLog: appendPhaseLog(state, target),
    updatedAt: nowIso(),
  };
  writeState(written, dir);
  const publishBadges =
    opts.publishBadges ?? ((s) => void publishStateBadges(s));
  // Best-effort: a throwing publisher must never fail a successful phase
  // write. state.json is already durable at this point.
  try {
    publishBadges(written);
  } catch {
    // swallowed — see comment above.
  }
  // Durable phase-trace telemetry, same best-effort idiom as the
  // publishBadges block above.
  try {
    const priorLog = state.phaseLog;
    const lastEntry =
      priorLog && priorLog.length > 0
        ? priorLog[priorLog.length - 1]
        : undefined;
    const sincePrevMs = lastEntry
      ? Date.now() - Date.parse(lastEntry.at)
      : null;
    recordEvent("phase.transition", {
      from: state.phase,
      to: target,
      outcome: null,
      since_prev_ms: sincePrevMs,
      forced: false,
    });
  } catch {
    // swallowed — see comment above.
  }
  return {
    advanced: true,
    reason: "finalized",
    from: state.phase,
    to: target,
  };
}

/**
 * Terminal phase -> emitting-helper map, the terminal sibling of
 * `PHASE_EMITTERS`. Kept separate rather than folded in:
 * `bin/skill-md-lint.test.ts`'s `PHASE_EMITTERS` parity test asserts
 * every key is a `STEP_PHASES` member, and no terminal phase is one.
 * Consumed by `bin/skill-md-lint.test.ts`'s terminal-emitter lint.
 */
export const TERMINAL_PHASE_EMITTERS: Readonly<
  Record<"merged" | "gated" | "needs-human" | "cancelled", string>
> = {
  merged: "flow-gate-summary",
  gated: "flow-gate-summary",
  "needs-human": "flow-gate-summary",
  cancelled: "flow-gate-summary",
};
