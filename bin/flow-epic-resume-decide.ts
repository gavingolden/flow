#!/usr/bin/env bun
/**
 * Computes the resume-from-disk decision for a crashed `/epic-create`
 * (epic-designer) session — the epic analogue of `flow-resume-decide.ts`.
 * Walks the SHORT epic-phase table and returns a single JSON object the
 * `/epic-create` supervisor branches on in its `# Resume mode` section.
 *
 * Why: an epic session that crashes at any epic phase (epic-designing /
 * epic-validating / epic-pr-open / epic-design-pending-review) must resume at
 * the correct step from disk state alone, with the same crash-safety as
 * `flow new --resume`: never replay an approval given to a dead session, never
 * re-open an already-open design PR (lean on flow-open-pr's up-front probe),
 * never re-merge (F5 never merges anyway). The supervisor reinventing the walk
 * on every `flow epic create --resume` is the failure mode this helper closes.
 *
 * Per the Q7 middle ground, the skill-agnostic probes (worktree / PR / branch)
 * are imported from ./lib/resume-probes — the SAME module flow-resume-decide.ts
 * uses; only the epic phase table + the epic-artifact probe are local. This
 * helper is flow's INSTALLED code (a bare-name PATH command after `flow setup`,
 * exactly like flow-resume-decide), so its ./lib import is fine — R1 forbids
 * `bin/lib` imports only inside the spawned consumer-worktree window.
 *
 * Usage:
 *   flow-epic-resume-decide [<slug>]   (slug auto-resolves from $TMUX_PANE)
 *
 * Output: a single JSON object on stdout.
 *   {
 *     "epicResumeAt": "design"|"validate"|"open-pr"|"read-back-pr"
 *                   | "checkpoint"|"worktree"
 *                   | "terminal"|"escalate"|"abort",
 *     "reason": "<one-line summary>",
 *     "context": {
 *       "slug": string, "phase": string,
 *       "worktree"?: string, "pr"?: number,
 *       "prState"?: "OPEN"|"MERGED"|"CLOSED"
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

import { readState, type PipelineState, TERMINAL_PHASES } from "./lib/state";
import { FLOW_STATE_DIR } from "./lib/paths";
import { resolveSlugFromPane } from "./lib/tmux";
import { epicDirRelative } from "./lib/epic-manifest-schema";
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
import * as fs from "node:fs";
import * as path from "node:path";

// --- Types -----------------------------------------------------------------

export type EpicResumeAt =
  | "design"
  | "validate"
  | "open-pr"
  | "read-back-pr"
  | "checkpoint"
  | "worktree"
  | "terminal"
  | "escalate"
  | "abort";

export type DecisionContext = {
  slug: string;
  phase: string;
  worktree?: string;
  pr?: number;
  prState?: "OPEN" | "MERGED" | "CLOSED";
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
};

// --- Phase sets ------------------------------------------------------------
//
// Sourced from the canonical lib/state taxonomy so this reader can't drift from
// the supervisor's phase set — mirroring flow-resume-decide.ts's TERMINAL_PHASE_SET
// anti-drift guard. `needs-human` is included (it lives in TERMINAL_PHASES), so a
// crashed epic escalation resolves `terminal` rather than falling through the walk.
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
  };
  if (inputs.worktree.kind !== "absent-from-state") {
    ctx.worktree = inputs.worktree.path;
  }
  if (inputs.pr.kind === "found") {
    ctx.pr = inputs.pr.number;
    ctx.prState = inputs.pr.state;
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
};

/**
 * Reads <worktree>/<EPIC_DIR>/{design.md,manifest.json} and returns true iff
 * BOTH exist and are non-empty. The epic analogue of probePlan — the design
 * artifacts are the epic's on-disk "is the decomposition written?" signal.
 * Currently informational (decide() routes on phase + worktree + PR), exported
 * so the supervisor / tests can assert artifact presence on resume.
 */
export function probeDesignArtifacts(
  worktreePath: string,
  slug: string,
): boolean {
  const epicDir = path.join(worktreePath, epicDirRelative(slug));
  for (const name of ["design.md", "manifest.json"]) {
    try {
      const stat = fs.statSync(path.join(epicDir, name));
      if (!stat.isFile() || stat.size === 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function parseArgs(
  argv: string[],
): { slug?: string } | { error: string } {
  // Slug is optional: when omitted, the caller resolves from $TMUX_PANE — the
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
): Inputs {
  // Terminal phases short-circuit all I/O: decide() returns terminal from the
  // phase check alone, so probing gh/git on a completed epic is wasted work
  // (and unsafe under a stub gh/git in tests).
  if (TERMINAL_PHASE_SET.has(state.phase)) {
    return {
      slug,
      state,
      worktree: { kind: "absent-from-state" },
      pr: { kind: "none" },
    };
  }

  const worktree = probeWorktree(state.worktree, git);
  const branch =
    worktree.kind === "present" ? probeBranch(worktree.path, git) : null;
  const pr = branch ? probePr(branch, gh) : { kind: "none" as const };

  return { slug, state, worktree, pr };
}

export function run(argv: string[], deps: Deps = {}): number {
  const gh = deps.gh ?? defaultGh;
  const git = deps.git ?? defaultGit;
  const stateDir = deps.stateDir ?? FLOW_STATE_DIR;
  const resolveSlug = deps.resolveSlug ?? (() => resolveSlugFromPane());

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
      "flow-epic-resume-decide: no slug given and could not resolve from $TMUX_PANE's @flow-slug option.\n" +
        "  pass <slug> explicitly, or run inside a tmux window created by `flow epic create`.",
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

  const inputs = gatherInputs(slug, state, gh, git);
  const decision = decide(inputs);
  process.stdout.write(JSON.stringify(decision) + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
