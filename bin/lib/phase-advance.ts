/**
 * Monotonic phase-advance primitive.
 *
 * `flow-open-pr` / `flow-ci-check` / `flow-fetch-pr-review` /
 * `flow-gate-decide` / `flow-merge-guard` each call `advancePhase` as a
 * side effect of returning the value the supervisor cannot proceed
 * without — a PR URL, a CI decision, a review payload, a gate verdict, or
 * a guard exit code. The write can no longer be a skippable prompt
 * instruction: PR #676's baseline re-record measured the supervisor
 * partially executing a mandatory fenced block (running its third
 * statement, never its first), so the write is moved into code the
 * supervisor has no way to bypass and still obtain the value it needs.
 *
 * Monotonicity (never moving `phase` backwards, no-oping on terminal /
 * epic-* phases) is `bin/lib/state.ts`'s `STEP_PHASES` ordering applied as
 * a guard — the one idea kept from the rejected "derive phase from
 * artifacts" alternative (see plan.md Decision D1, Branch C).
 */

import {
  readState,
  writeState,
  appendPhaseLog,
  STEP_PHASES,
  TERMINAL_PHASE_SET,
  nowIso,
  type PipelinePhase,
} from "./state";
import { resolveSlugAmbient } from "./session-identity";
import { FLOW_STATE_DIR } from "./paths";
import { checkWorktreeBranch } from "./worktree-marker";

export type PhaseAdvanceReason =
  | "advanced"
  | "no-slug"
  | "no-state"
  | "already-at-or-past"
  | "terminal"
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
 * Phase → emitting-helper map. Consumed by `bin/skill-md-lint.test.ts` to
 * assert SKILL.md names the right helper at each site and carries no
 * standalone `flow-state-update --phase <phase>` fence for these six
 * (was five; `verifying` was missing here despite being emitted below).
 * Must not contradict `bin/flow-stop-guard.ts`'s `NEXT_STEP_BY_PHASE`.
 */
export const PHASE_EMITTERS: Readonly<
  Record<
    | "implementing"
    | "verifying"
    | "ci-wait"
    | "reviewing"
    | "gating"
    | "merging",
    string
  >
> = {
  implementing: "flow-open-pr",
  verifying: "flow-verify-prep",
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
  if (currentIndex >= 0 && currentIndex >= targetIndex) {
    return {
      advanced: false,
      reason: "already-at-or-past",
      from: state.phase,
      to: target,
    };
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

  writeState(
    {
      ...state,
      phase: target,
      phaseLog: appendPhaseLog(state, target),
      updatedAt: nowIso(),
    },
    dir,
  );
  return { advanced: true, reason: "advanced", from: state.phase, to: target };
}
