#!/usr/bin/env bun
/**
 * Computes the resume-from-disk decision for a crashed `/flow-epic-create`
 * (epic-designer) session — the epic analogue of `flow-resume-decide.ts`.
 * Walks the SHORT epic-phase table and returns a single JSON object the
 * `/flow-epic-create` supervisor branches on in its `# Resume mode` section.
 *
 * Why: an epic session that crashes at any epic phase (epic-designing /
 * epic-validating / epic-pr-open / epic-design-pending-review) must resume at
 * the correct step from disk state alone, with the same crash-safety as
 * `flow feature resume`: never replay an approval given to a dead session, never
 * re-open an already-open design PR (lean on flow-open-pr's up-front probe),
 * never re-merge (F5 never merges anyway). The supervisor reinventing the walk
 * on every `flow epic create --resume` is the failure mode this helper closes.
 *
 * Per the Q7 middle ground, the skill-agnostic probes (worktree / PR / branch)
 * are imported from ./lib/resume-probes — the SAME module flow-resume-decide.ts
 * uses; only the epic phase table + the epic-artifact probe are local. This
 * helper is flow's INSTALLED code (a bare-name PATH command after `flow install`,
 * exactly like flow-resume-decide), so its ./lib import is fine — R1 forbids
 * `bin/lib` imports only inside the spawned consumer-worktree window.
 *
 * NOT read-only: the CLI entry retires the one-shot checkpoint (archives the
 * note, removes the resume marker) on every verdict except `awaiting-human`
 * (the pause defers retirement until the confirming `done`) and `abort`, and
 * publishes `context.checkpointPath` — the archived note to read. Running it
 * by hand to inspect an epic therefore consumes its saved notes.
 *
 * Usage:
 *   flow-epic-resume-decide [<slug>]   (slug auto-resolves from $FLOW_SLUG)
 *
 * Output: a single JSON object on stdout.
 *   {
 *     "epicResumeAt": "design"|"validate"|"open-pr"|"read-back-pr"
 *                   | "checkpoint"|"worktree"|"awaiting-human"
 *                   | "terminal"|"escalate"|"abort",
 *     "reason": "<one-line summary>",
 *     "context": {
 *       "slug": string, "phase": string,
 *       "worktree"?: string, "pr"?: number,
 *       "prState"?: "OPEN"|"MERGED"|"CLOSED",
 *       "checkpointExists"?: boolean,
 *       "continueAt"?: <a step verdict>, "continuePhase"?: string
 *     }
 *   }
 *
 * Exit codes:
 *   0 — decision computed (any kind incl. abort/escalate/terminal). Same
 *       exit-0-for-every-decision contract as flow-resume-decide: the
 *       supervisor captures stdout via RESULT=$(flow-epic-resume-decide) and
 *       branches on .epicResumeAt, so abort (state.json missing) also exits 0.
 *   2 — bad CLI args
 */

import {
  pausedPhase,
  readState,
  type PipelineState,
  TERMINAL_PHASES,
} from "./lib/state";
import { FLOW_STATE_DIR } from "./lib/paths";
import { resolveSlugAmbient } from "./lib/session-identity";
import {
  probeWorktree,
  probePr,
  probeBranch,
  defaultGh,
  defaultGit,
  type WorktreeInfo,
  type PrInfo,
  type GhRunner,
  type GitRunner,
} from "./lib/resume-probes";
import {
  consumeCheckpoint,
  probeCheckpointBody,
  type ConsumeResult,
} from "./flow-checkpoint";
import { checkpointBodyPath } from "./lib/checkpoint-freshness";

// --- Types -----------------------------------------------------------------

export type EpicResumeAt =
  | "design"
  | "validate"
  | "open-pr"
  | "read-back-pr"
  | "checkpoint"
  | "worktree"
  | "awaiting-human"
  | "terminal"
  | "escalate"
  | "abort";

/**
 * Maps each `decide()` step verdict to the epic phase a needs-human
 * continuation writes on the way out of its pause — the epic analogue of
 * `CONTINUE_PHASE_BY_STEP` in `bin/flow-resume-decide.ts`. Every value must
 * be in `TERMINAL_EXIT_TRANSITIONS["needs-human"]` (`bin/lib/state.ts`); the
 * union of both continue maps equals that allowlist exactly (parity-tested).
 * There is no merge target: F5 never merges.
 */
export const CONTINUE_PHASE_BY_EPIC_STEP: Readonly<Record<string, string>> = {
  design: "epic-designing",
  validate: "epic-validating",
  "open-pr": "epic-pr-open",
  "read-back-pr": "epic-pr-open",
  checkpoint: "epic-design-pending-review",
};

export type DecisionContext = {
  slug: string;
  phase: string;
  worktree?: string;
  pr?: number;
  prState?: "OPEN" | "MERGED" | "CLOSED";
  /**
   * Additive/optional (parity with `bin/flow-resume-decide.ts:117`): whether
   * the slug-keyed checkpoint body under `~/.flow/state/checkpoints/<slug>/`
   * is present and non-empty, so `/flow-epic-create` Resume mode can branch
   * on it without a bespoke shell probe. Worktree-independent, so a removed
   * or broken checkout does not zero it. Never omitted.
   */
  checkpointExists?: boolean;
  /**
   * The mechanical continue step for a `needs-human` pause — `decide()`'s own
   * verdict for the last non-terminal `phaseLog` phase before the pause
   * (`pausedPhase`, `./lib/state`). Set only on the `awaiting-human` verdict,
   * and only when that inner verdict is a key of `CONTINUE_PHASE_BY_EPIC_STEP`.
   */
  continueAt?: EpicResumeAt;
  /**
   * `CONTINUE_PHASE_BY_EPIC_STEP[continueAt]` — the phase a confirming "done"
   * reply writes via `flow-state-update --phase` (allowlisted, no `--force`)
   * before re-entering `continueAt`. Always set together with `continueAt`.
   */
  continuePhase?: string;
  /**
   * Set by the CLI entry (`run`) only, never by the pure `decide()`. The
   * absolute path of the one-shot notes to read: the ARCHIVED note when this
   * run retired it (every verdict except `awaiting-human` and `abort`), else
   * the live note (at the pause, where retirement is deferred until the
   * confirming `done`). Absent when no note existed.
   */
  checkpointPath?: string;
  /**
   * Set by the CLI entry only: whether this run retired the one-shot
   * checkpoint (archived a note and/or removed the resume marker).
   */
  checkpointConsumed?: boolean;
};

export type DecisionResult = {
  epicResumeAt: EpicResumeAt;
  reason: string;
  context: DecisionContext;
};

export type Inputs = {
  slug: string;
  state: PipelineState;
  worktree: WorktreeInfo;
  pr: PrInfo;
  checkpointExists: boolean;
};

// --- Phase sets ------------------------------------------------------------
//
// Sourced from the canonical lib/state taxonomy so this reader can't drift from
// the supervisor's phase set — mirroring flow-resume-decide.ts's TERMINAL_PHASE_SET
// anti-drift guard. `needs-human` is in TERMINAL_PHASES but `decide()` handles it
// BEFORE the terminal check (awaiting-human / escalate / terminal).
export const TERMINAL_PHASE_SET = new Set<string>(TERMINAL_PHASES);

// --- Pure decision function -----------------------------------------------

/**
 * Walks the short epic-phase table. The supervisor writes phase BEFORE each
 * step's work, so a phase value implies all earlier epic steps completed.
 * Pre-tree edge cases (terminal, PR-closed) short-circuit first.
 */
export function decide(inputs: Inputs): DecisionResult {
  const ctx: DecisionContext = {
    slug: inputs.slug,
    phase: inputs.state.phase,
    checkpointExists: inputs.checkpointExists,
  };
  if (inputs.worktree.kind !== "absent-from-state") {
    ctx.worktree = inputs.worktree.path;
  }
  if (inputs.pr.kind === "found") {
    ctx.pr = inputs.pr.number;
    ctx.prState = inputs.pr.state;
  }

  // needs-human awaiting-human mode: mirrors flow-resume-decide's needs-human
  // branch. A paused escalation with a live worktree resolves to
  // `awaiting-human` carrying a continue step computed by re-running decide()
  // with the phase swapped for the last non-terminal `phaseLog` entry before
  // the pause. MUST precede the terminal short-circuit (needs-human is a
  // terminal phase). A closed design PR or a vanished worktree escalates
  // (surfaced, never dead-ended); a merged PR or no recorded worktree is
  // terminal — there is nothing live to continue.
  if (inputs.state.phase === "needs-human") {
    if (inputs.pr.kind === "found" && inputs.pr.state === "CLOSED") {
      return {
        epicResumeAt: "escalate",
        reason: "pr-closed-without-merge",
        context: ctx,
      };
    }
    if (inputs.pr.kind === "found" && inputs.pr.state === "MERGED") {
      return {
        epicResumeAt: "terminal",
        reason: "pr-merged-while-paused",
        context: ctx,
      };
    }
    if (inputs.worktree.kind === "missing-on-disk") {
      return {
        epicResumeAt: "escalate",
        reason: "worktree-missing-on-resume",
        context: ctx,
      };
    }
    if (inputs.worktree.kind === "absent-from-state") {
      return {
        epicResumeAt: "terminal",
        reason: `phase: ${inputs.state.phase}`,
        context: ctx,
      };
    }
    const paused = pausedPhase(inputs.state.phaseLog);
    if (paused !== undefined) {
      const inner = decide({
        ...inputs,
        state: { ...inputs.state, phase: paused },
      });
      if (Object.hasOwn(CONTINUE_PHASE_BY_EPIC_STEP, inner.epicResumeAt)) {
        ctx.continueAt = inner.epicResumeAt;
        ctx.continuePhase = CONTINUE_PHASE_BY_EPIC_STEP[inner.epicResumeAt];
      }
    }
    return {
      epicResumeAt: "awaiting-human",
      reason: "needs-human-awaiting-human-step",
      context: ctx,
    };
  }

  // Terminal phases — the epic already ended (approve/cancel/escalation). Wins
  // over every disk-state branch, exactly like flow-resume-decide's pre-tree
  // terminal check. Never replay an approval given to a now-dead session: an
  // epic-approved resume just re-renders the terminal note.
  if (TERMINAL_PHASE_SET.has(inputs.state.phase)) {
    return {
      epicResumeAt: "terminal",
      reason: `phase: ${inputs.state.phase}`,
      context: ctx,
    };
  }

  // PR CLOSED without merge — escalate rather than guess (mirror
  // flow-resume-decide's pr-closed-without-merge edge case). F5 never merges,
  // so a MERGED epic PR is not an expected state; only CLOSED is special-cased.
  if (inputs.pr.kind === "found" && inputs.pr.state === "CLOSED") {
    return {
      epicResumeAt: "escalate",
      reason: "pr-closed-without-merge",
      context: ctx,
    };
  }

  // Worktree recorded but the directory is gone — escalate (the user may have
  // removed it deliberately; don't auto-recreate mid-flight).
  if (inputs.worktree.kind === "missing-on-disk") {
    return {
      epicResumeAt: "escalate",
      reason: "worktree-missing-on-resume",
      context: ctx,
    };
  }

  // Worktree not yet created — re-enter step 1 (worktree). The epic crashed
  // before flow-new-worktree ran.
  if (inputs.worktree.kind !== "present") {
    return {
      epicResumeAt: "worktree",
      reason: "worktree not yet created",
      context: ctx,
    };
  }

  // epic-design-pending-review: the design PR is open and we are AT the human
  // review checkpoint. Re-render the checkpoint WITHOUT re-designing and wait —
  // never auto-approve.
  if (inputs.state.phase === "epic-design-pending-review") {
    return {
      epicResumeAt: "checkpoint",
      reason: "at-design-review-checkpoint",
      context: ctx,
    };
  }

  // epic-pr-open: a crash mid-PR-open. If a PR already exists for the branch
  // (flow-open-pr wrote state.pr, or the branch was pushed + PR'd before the
  // crash), read it back and advance to the checkpoint — do NOT create a second
  // PR (idempotent; flow-open-pr's own up-front `gh pr view` probe enforces the
  // same). Otherwise open the PR.
  if (inputs.state.phase === "epic-pr-open") {
    if (inputs.pr.kind === "found") {
      return {
        epicResumeAt: "read-back-pr",
        reason: "pr-already-open-read-back",
        context: ctx,
      };
    }
    return {
      epicResumeAt: "open-pr",
      reason: "pr-not-yet-open",
      context: ctx,
    };
  }

  // epic-validating: re-run the cheap, idempotent validators.
  if (inputs.state.phase === "epic-validating") {
    return {
      epicResumeAt: "validate",
      reason: "re-run-validators",
      context: ctx,
    };
  }

  // epic-plan-review-pending: yielded while the async cross-model design
  // review was in flight — re-enter Step 4.5's --check, never re-run the
  // designer (which would overwrite design.md/manifest.json out from under
  // a still-running detached agy worker that may still be reading them).
  if (inputs.state.phase === "epic-plan-review-pending") {
    return {
      epicResumeAt: "validate",
      reason: "awaiting-plan-review-check",
      context: ctx,
    };
  }

  // epic-designing / starting (worktree present) — re-run the designer. The
  // designer is idempotent (it overwrites design.md + manifest.json), so a
  // re-spawn over the existing worktree is safe.
  return {
    epicResumeAt: "design",
    reason: `phase ${inputs.state.phase} — re-run designer`,
    context: ctx,
  };
}

// --- I/O wiring -----------------------------------------------------------

export type Deps = {
  gh?: GhRunner;
  git?: GitRunner;
  stateDir?: string;
  resolveSlug?: () => string | null;
  consume?: (slug: string, dir: string) => ConsumeResult;
};

export function parseArgs(
  argv: string[],
): { slug?: string } | { error: string } {
  // Slug is optional: when omitted, the caller resolves from $FLOW_SLUG — the
  // same auto-resolve contract as flow-resume-decide / flow-state-update.
  if (argv.length === 0) return {};
  for (const a of argv) {
    if (a === "--help" || a === "-h") return { error: "help" };
  }
  const [first, ...rest] = argv;
  if (first.startsWith("--")) return { error: `unknown flag: ${first}` };
  for (const flag of rest) {
    return { error: `unknown flag: ${flag}` };
  }
  return { slug: first };
}

/**
 * Composes Inputs from disk + GitHub state. Tests bypass this and call decide()
 * directly; only the runner needs the full I/O dance.
 */
export function gatherInputs(
  slug: string,
  state: PipelineState,
  gh: GhRunner,
  git: GitRunner,
  stateDir = FLOW_STATE_DIR,
): Inputs {
  // Terminal phases short-circuit the gh/git I/O: decide() returns terminal
  // from the phase check alone, so probing a completed epic's remote state is
  // wasted work (and unsafe under a stub gh/git in tests). `needs-human` is
  // the exception — its awaiting-human branch reads the worktree and PR, so
  // it must be probed like a live phase. The checkpoint
  // probe is exempt from that short-circuit — it is a slug-keyed `statSync`,
  // not a subprocess, and zeroing it here would drop the design notes at
  // `epic-approved`, contradicting `/flow-epic-create`'s Resume-mode block.
  // Same rationale as the feature-side un-gating in `flow-resume-decide.ts`.
  if (state.phase !== "needs-human" && TERMINAL_PHASE_SET.has(state.phase)) {
    return {
      slug,
      state,
      worktree: { kind: "absent-from-state" },
      pr: { kind: "none" },
      checkpointExists: probeCheckpointBody(slug, stateDir),
    };
  }

  const worktree = probeWorktree(state.worktree, git);
  const branch =
    worktree.kind === "present" ? probeBranch(worktree.path, git) : null;
  const pr = branch ? probePr(branch, gh) : { kind: "none" as const };
  // Slug-keyed and worktree-independent: the body lives in the state dir, so
  // it is unaffected by a broken or removed git checkout.
  const checkpointExists = probeCheckpointBody(slug, stateDir);

  return { slug, state, worktree, pr, checkpointExists };
}

export function run(argv: string[], deps: Deps = {}): number {
  const gh = deps.gh ?? defaultGh;
  const git = deps.git ?? defaultGit;
  const stateDir = deps.stateDir ?? FLOW_STATE_DIR;
  const resolveSlug = deps.resolveSlug ?? (() => resolveSlugAmbient());

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      console.log("usage: flow-epic-resume-decide [<slug>]");
      return 0;
    }
    console.error(`flow-epic-resume-decide: ${parsed.error}`);
    console.error("usage: flow-epic-resume-decide [<slug>]");
    return 2;
  }

  const slug = parsed.slug ?? resolveSlug();
  if (!slug) {
    console.error(
      "flow-epic-resume-decide: no slug given and no FLOW_SLUG in the environment.\n" +
        "  pass <slug> explicitly, or run inside a pipeline launched by `flow epic create`.",
    );
    return 2;
  }

  const state = readState(slug, stateDir);
  if (!state) {
    const result: DecisionResult = {
      epicResumeAt: "abort",
      reason: "state-missing-on-resume",
      context: { slug, phase: "" },
    };
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  }

  const inputs = gatherInputs(slug, state, gh, git, stateDir);
  const decision = decide(inputs);

  // Retire the one-shot checkpoint here, in the CLI entry (never the pure
  // decide()): this helper is the resume entry, so the note is applied
  // exactly once without depending on a supervisor prose step. The pause
  // itself defers retirement — a second /clear before `done` must re-resume
  // into the same pause with its notes intact.
  if (decision.epicResumeAt === "awaiting-human") {
    decision.context.checkpointConsumed = false;
    if (inputs.checkpointExists) {
      decision.context.checkpointPath = checkpointBodyPath(slug, stateDir);
    }
  } else {
    const consume = deps.consume ?? consumeCheckpoint;
    const retired = consume(slug, stateDir);
    decision.context.checkpointConsumed =
      retired.markerRemoved || retired.archived !== null;
    if (retired.archived !== null) {
      decision.context.checkpointPath = retired.archived;
    }
  }
  process.stdout.write(JSON.stringify(decision) + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
