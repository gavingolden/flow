#!/usr/bin/env bun
/**
 * Computes the resume-from-disk decision for a crashed `/flow-pipeline`
 * session. Walks the 10-row decision tree from
 * `references/failure-recovery.md` section (b) and the supervisor's
 * "Resume mode" doc, returning a single JSON object the supervisor can
 * branch on.
 *
 * Why: the resume tree is correctness-critical (wrong row choice either
 * re-runs done work or skips undone work) and has subtle precedence
 * rules — most notably row 9's "PR is MERGED but worktree still exists"
 * branch, which must NOT fall through to row 10's `gh pr merge` on an
 * already-merged PR. The supervisor reinventing the walk on every
 * `flow new --resume` is the failure mode this helper closes.
 *
 * Usage:
 *   flow-resume-decide <slug>
 *
 * Output: a single JSON object on stdout.
 *   {
 *     "resumeAt": "step-2"|"step-3"|"step-4"|"step-5"|"step-5.5"
 *               | "step-6"|"step-7"|"step-8"|"step-9"
 *               | "terminal"|"escalate"|"abort",
 *     "reason": "<one-line summary>",
 *     "context": {
 *       "slug": string,
 *       "phase": string,
 *       "worktree"?: string,
 *       "pr"?: number,
 *       "prState"?: "OPEN"|"MERGED"|"CLOSED",
 *       "planExists"?: boolean,
 *       "headCommitSubject"?: string,
 *       "hasSkillAdditions"?: boolean
 *     }
 *   }
 *
 * Exit codes:
 *   0 — decision computed (any kind including abort/escalate/terminal). The
 *       supervisor doc captures stdout via `RESULT=$(flow-resume-decide "$SLUG")`
 *       and branches on `.resumeAt`; a non-zero exit on the abort case would
 *       trip strict-shell callers before they could read the JSON, so abort
 *       (state.json missing) also exits 0 and surfaces via the JSON verdict.
 *       Same exit-0-for-every-decision contract as `flow-ci-wait` and
 *       `flow-gate-decide`.
 *   2 — bad CLI args
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { readState, type PipelineState, TERMINAL_PHASES } from "./lib/state";
import { FLOW_STATE_DIR } from "./lib/paths";
import { resolveSlugFromPane } from "./lib/tmux";

// --- Types -----------------------------------------------------------------

export type ResumeAt =
  | "step-2"
  | "step-3"
  | "step-4"
  | "step-5"
  | "step-5.5"
  | "step-6"
  | "step-7"
  | "step-8"
  | "step-9"
  | "terminal"
  | "escalate"
  | "abort";

export type DecisionContext = {
  slug: string;
  phase: string;
  worktree?: string;
  pr?: number;
  prState?: "OPEN" | "MERGED" | "CLOSED";
  planExists?: boolean;
  headCommitSubject?: string;
  hasSkillAdditions?: boolean;
};

export type DecisionResult = {
  resumeAt: ResumeAt;
  reason: string;
  context: DecisionContext;
};

export type WorktreeInfo =
  | { kind: "absent-from-state" }
  | { kind: "missing-on-disk"; path: string }
  | { kind: "present"; path: string };

export type PrInfo =
  | { kind: "none" }
  | {
      kind: "found";
      state: "OPEN" | "MERGED" | "CLOSED";
      number: number;
      url: string;
    };

export type CiState =
  | { kind: "all-terminal" }
  | { kind: "pending" }
  | { kind: "no-checks-reported" };

export type HeadCommit = { subject: string; body: string };

export type Inputs = {
  slug: string;
  state: PipelineState;
  worktree: WorktreeInfo;
  planExists: boolean;
  pr: PrInfo;
  hasSkillAdditions: boolean;
  ciState: CiState;
  headCommit: HeadCommit | null;
};

// --- Phase sets ------------------------------------------------------------
//
// The supervisor writes phase BEFORE each step's work begins, so a phase value
// transitively implies all earlier phases are complete. These sets answer
// "is row N's phase precondition satisfied?" — they're exactly the table from
// failure-recovery.md (b).

// Sourced from the canonical taxonomy in lib/state so the resume reader can't
// drift from the supervisor's own phase set — the prior local literal
// (["merged","gated","cancelled"]) silently omitted `needs-human`, so a crashed
// escalation fell through the row tree to whatever disk state implied instead of
// resolving terminal. Wrapped in a Set for O(1) membership, mirroring
// lib/state's own PIPELINE_PHASE_SET.
export const TERMINAL_PHASE_SET = new Set<string>(TERMINAL_PHASES);

// The pending phases that have NO in-flight work on a clean crash — no worktree,
// no plan, no PR — because they occur BEFORE step 2 creates the worktree.
// `triaged-no-change`: the no-change investigation already produced its answer
// and ended. `triage-pending-clarification`: awaiting the user's reply to a
// clarifying question, which a `--resume` can't re-ask in-context. A resume of
// either must resolve to a terminal no-op, NOT fall through to Row 2 (which
// would spin up a worktree + plan + build, contradicting the recorded triage).
// The other PENDING_PHASES (plan-pending-review, approval-pending-clarification,
// ci-wait-pending) DO have in-flight work and fall through to their correct rows
// (4 / 4 / 7) — deliberately excluded here. The subset relationship to the
// canonical PENDING_PHASES is guarded in flow-resume-decide.test.ts.
export const NO_INFLIGHT_WORK_PHASES = new Set<string>([
  "triaged-no-change",
  "triage-pending-clarification",
]);

// Row 4: approval done — phase advanced past plan-pending-review.
// `ci-wait-pending` (the step-7 yield-while-backgrounded pending phase)
// implies every earlier phase is complete, so it belongs in all three
// "phase advanced past row N" sets below alongside `ci-wait`.
const POST_APPROVAL_PHASES = new Set([
  "implementing",
  "installing-skills",
  "verifying",
  "ci-wait",
  "ci-wait-pending",
  "reviewing",
  "gating",
  "merging",
  "merged",
  "gated",
]);

// Row 5.5: re-symlink done — phase advanced past installing-skills.
const POST_SYMLINK_PHASES = new Set([
  "verifying",
  "ci-wait",
  "ci-wait-pending",
  "reviewing",
  "gating",
  "merging",
  "merged",
  "gated",
]);

// Row 6: verify done — phase advanced past verifying. `ci-wait-pending`
// is the step-7 yield-while-backgrounded pending phase; it implies verify
// is complete just as `ci-wait` does, so a crash while yielded resumes at
// step-7 (row 7) rather than falling through to step-6.
const POST_VERIFY_PHASES = new Set([
  "ci-wait",
  "ci-wait-pending",
  "reviewing",
  "gating",
  "merging",
  "merged",
  "gated",
]);

// Row 7 lookup: which check states count as still-pending.
const PENDING_CHECK_STATES = new Set(["PENDING", "QUEUED", "IN_PROGRESS"]);

// --- Pure decision function -----------------------------------------------

/**
 * Pre-tree edge cases short-circuit the walk; otherwise fall through to the
 * 10-row tree. The order of these checks matters — terminal phases must win
 * over pr-state checks (e.g. phase=`merged` is terminal even if the PR record
 * carries CLOSED for some reason).
 */
export function decide(inputs: Inputs): DecisionResult {
  const ctx: DecisionContext = {
    slug: inputs.slug,
    phase: inputs.state.phase,
  };
  if (inputs.worktree.kind !== "absent-from-state") {
    ctx.worktree = inputs.worktree.path;
  }

  // Edge 1.3-1.5: terminal phases — pipeline already ended.
  if (TERMINAL_PHASE_SET.has(inputs.state.phase)) {
    return {
      resumeAt: "terminal",
      reason: `phase: ${inputs.state.phase}`,
      context: ctx,
    };
  }

  // No-in-flight-work pending phases: the pipeline already produced its answer
  // and ended (triaged-no-change), or is awaiting a user reply a `--resume`
  // can't re-ask in-context (triage-pending-clarification). Both occur before
  // the worktree exists, so there is nothing to resume — resolve to a terminal
  // no-op. Checked here, before the worktree/PR branches, precisely because
  // these phases carry no worktree and no PR: without this short-circuit they
  // reach Row 2's "worktree not yet created" → step-2 and mechanically spin up
  // a worktree + plan + build, contradicting the recorded triage.
  if (NO_INFLIGHT_WORK_PHASES.has(inputs.state.phase)) {
    return {
      resumeAt: "terminal",
      reason:
        inputs.state.phase === "triaged-no-change"
          ? "no-change-investigation-complete"
          : "awaiting-triage-clarification",
      context: ctx,
    };
  }

  // Populate PR context up front so all downstream branches can reference it.
  if (inputs.pr.kind === "found") {
    ctx.pr = inputs.pr.number;
    ctx.prState = inputs.pr.state;
  }

  // PR-MERGED precedence: when the merge already happened, the rest of the
  // tree's preconditions are moot. Worktree absence here is *expected*
  // (post-merge cleanup), not the worktree-missing-on-resume failure mode.
  // Worktree present means the merge succeeded but flow-remove-worktree
  // hasn't run yet → resume at step-9's MERGED-cleanup branch (NOT step-10,
  // which would re-run gh pr merge on an already-merged PR).
  if (inputs.pr.kind === "found" && inputs.pr.state === "MERGED") {
    if (inputs.worktree.kind === "present") {
      return {
        resumeAt: "step-9",
        reason: "pr-merged-worktree-still-exists",
        context: ctx,
      };
    }
    return {
      resumeAt: "terminal",
      reason: "pr-merged-worktree-cleaned-up",
      context: ctx,
    };
  }

  // Edge 1.2: worktree path recorded but directory is gone, AND the PR isn't
  // already merged (that case was handled above). User removed the worktree
  // mid-flight — escalate rather than guess.
  if (inputs.worktree.kind === "missing-on-disk") {
    return {
      resumeAt: "escalate",
      reason: "worktree-missing-on-resume",
      context: ctx,
    };
  }

  // Edge 1.6: PR exists but is CLOSED without merge.
  if (inputs.pr.kind === "found" && inputs.pr.state === "CLOSED") {
    return {
      resumeAt: "escalate",
      reason: "pr-closed-without-merge",
      context: ctx,
    };
  }

  // Row 2 — worktree present + git checkout.
  if (inputs.worktree.kind !== "present") {
    return {
      resumeAt: "step-2",
      reason: "worktree not yet created",
      context: ctx,
    };
  }

  // Row 3 — plan.md exists and is non-empty.
  ctx.planExists = inputs.planExists;
  if (!inputs.planExists) {
    return {
      resumeAt: "step-3",
      reason: "plan.md missing or empty",
      context: ctx,
    };
  }

  // Row 4 — approval reached; phase advanced past plan-pending-review.
  if (!POST_APPROVAL_PHASES.has(inputs.state.phase)) {
    return {
      resumeAt: "step-4",
      reason: `phase ${inputs.state.phase} predates approval`,
      context: ctx,
    };
  }

  // Row 5 — implement; PR exists for the worktree's branch.
  if (inputs.pr.kind === "none") {
    return { resumeAt: "step-5", reason: "no PR for branch", context: ctx };
  }

  // Row 5.5 — re-symlink. Done when phase post-symlink, OR no skill/agent
  // additions on this branch (nothing to re-symlink).
  ctx.hasSkillAdditions = inputs.hasSkillAdditions;
  if (
    !POST_SYMLINK_PHASES.has(inputs.state.phase) &&
    inputs.hasSkillAdditions
  ) {
    return {
      resumeAt: "step-5.5",
      reason: "skills/agents added but re-symlink not yet run",
      context: ctx,
    };
  }

  // Row 6 — verify; phase advanced past verifying.
  if (!POST_VERIFY_PHASES.has(inputs.state.phase)) {
    return {
      resumeAt: "step-6",
      reason: `phase ${inputs.state.phase} predates verify`,
      context: ctx,
    };
  }

  // Row 7 — ci-wait; every PR check has reached a terminal state. Empty list
  // means "CI hasn't reported yet" per polling-protocol.md, NOT terminal.
  if (inputs.ciState.kind !== "all-terminal") {
    return {
      resumeAt: "step-7",
      reason:
        inputs.ciState.kind === "no-checks-reported"
          ? "CI configured but no checks reported yet"
          : "CI checks still pending",
      context: ctx,
    };
  }

  // Row 8 — pr-review commit on HEAD.
  if (inputs.headCommit) ctx.headCommitSubject = inputs.headCommit.subject;
  if (!hasPrReviewCommit(inputs.headCommit)) {
    return {
      resumeAt: "step-8",
      reason: "no pr-review commit on HEAD",
      context: ctx,
    };
  }

  // Row 9 — gate. PR-MERGED branches (step-9 cleanup vs row-10 terminal) were
  // handled above as a pre-tree precedence. Reaching here means PR is OPEN
  // and every upstream row is done — supervisor re-evaluates the gate.
  return { resumeAt: "step-9", reason: "at-auto-merge-gate", context: ctx };
}

/**
 * Detects a pr-review commit per the failure-recovery.md spec: subject prefix
 * `review:` OR a `Co-Authored-By: ... pr-review` trailer in the body.
 */
export function hasPrReviewCommit(commit: HeadCommit | null): boolean {
  if (!commit) return false;
  if (/^review:/.test(commit.subject)) return true;
  if (/^Co-Authored-By:.*pr-review/m.test(commit.body)) return true;
  return false;
}

// --- I/O wiring -----------------------------------------------------------

type CmdResult = { stdout: string; stderr: string; exitCode: number };
export type GhRunner = (argv: string[]) => CmdResult;
export type GitRunner = (argv: string[], cwd: string) => CmdResult;

const defaultGh: GhRunner = (argv) => {
  const r = spawnSync("gh", argv, { encoding: "utf8" });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };
};

const defaultGit: GitRunner = (argv, cwd) => {
  const r = spawnSync("git", argv, { cwd, encoding: "utf8" });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };
};

export type Deps = {
  gh?: GhRunner;
  git?: GitRunner;
  stateDir?: string;
  resolveSlug?: () => string | null;
};

/** Probes the worktree path's status. Used by the runner to build Inputs.worktree. */
export function probeWorktree(
  stateWorktree: string | undefined,
  git: GitRunner,
): WorktreeInfo {
  if (!stateWorktree) return { kind: "absent-from-state" };
  if (!fs.existsSync(stateWorktree)) {
    return { kind: "missing-on-disk", path: stateWorktree };
  }
  const r = git(["rev-parse", "--is-inside-work-tree"], stateWorktree);
  if (r.exitCode !== 0 || r.stdout.trim() !== "true") {
    // Directory exists but isn't a git checkout — treat as missing-on-disk
    // for safety; the supervisor escalates either way.
    return { kind: "missing-on-disk", path: stateWorktree };
  }
  return { kind: "present", path: stateWorktree };
}

/** Reads <worktree>/.flow-tmp/plan.md and returns true iff present + non-empty. */
export function probePlan(worktreePath: string): boolean {
  const planPath = path.join(worktreePath, ".flow-tmp", "plan.md");
  try {
    const stat = fs.statSync(planPath);
    if (!stat.isFile()) return false;
    return stat.size > 0;
  } catch {
    return false;
  }
}

/** Resolves the default branch (e.g. "main", "master") from the worktree's origin/HEAD. */
export function resolveDefaultBranch(
  worktreePath: string,
  git: GitRunner,
): string {
  const r = git(["symbolic-ref", "refs/remotes/origin/HEAD"], worktreePath);
  if (r.exitCode === 0) {
    const m = r.stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  }
  return "main";
}

/**
 * Detects whether the worktree's branch adds files under skills/ or agents/
 * relative to its merge-base with origin/<default>. Step 5.5's input.
 */
export function probeSkillAdditions(
  worktreePath: string,
  git: GitRunner,
): boolean {
  const defaultBranch = resolveDefaultBranch(worktreePath, git);
  const r = git(
    ["diff", "--name-only", `origin/${defaultBranch}...HEAD`],
    worktreePath,
  );
  if (r.exitCode !== 0) return false;
  for (const line of r.stdout.split("\n")) {
    if (/^(skills|agents)\//.test(line)) return true;
  }
  return false;
}

/** Reads the HEAD commit's subject + body via `git log -1 --pretty=%B`. */
export function probeHeadCommit(
  worktreePath: string,
  git: GitRunner,
): HeadCommit | null {
  const r = git(["log", "-1", "--pretty=%B"], worktreePath);
  if (r.exitCode !== 0) return null;
  const lines = r.stdout.replace(/\n+$/, "").split("\n");
  const subject = lines[0] ?? "";
  const body = lines.slice(1).join("\n").replace(/^\n+/, "");
  return { subject, body };
}

/**
 * Looks up the current branch's PR via `gh pr view <branch>`. Maps gh's
 * "no PRs found" stderr to {kind: "none"}; treats anything else as not-found
 * (the resume tree should not crash on transient gh errors).
 */
export function probePr(branch: string, gh: GhRunner): PrInfo {
  const r = gh(["pr", "view", branch, "--json", "number,state,url"]);
  if (r.exitCode !== 0) {
    if (/no pull requests? found|no pull request associated/i.test(r.stderr)) {
      return { kind: "none" };
    }
    return { kind: "none" };
  }
  try {
    const parsed = JSON.parse(r.stdout) as {
      number?: number;
      state?: string;
      url?: string;
    };
    if (
      typeof parsed.number !== "number" ||
      typeof parsed.url !== "string" ||
      (parsed.state !== "OPEN" &&
        parsed.state !== "MERGED" &&
        parsed.state !== "CLOSED")
    ) {
      return { kind: "none" };
    }
    return {
      kind: "found",
      number: parsed.number,
      state: parsed.state,
      url: parsed.url,
    };
  } catch {
    return { kind: "none" };
  }
}

/** Computes the worktree's current branch (used for `gh pr view <branch>`). */
export function probeBranch(
  worktreePath: string,
  git: GitRunner,
): string | null {
  const r = git(["branch", "--show-current"], worktreePath);
  if (r.exitCode !== 0) return null;
  const branch = r.stdout.trim();
  return branch.length > 0 ? branch : null;
}

/** Polls `gh pr checks <pr> --json name,state` and classifies the result. */
export function probeCi(prNumber: number, gh: GhRunner): CiState {
  const r = gh(["pr", "checks", String(prNumber), "--json", "name,state"]);
  if (r.exitCode !== 0) return { kind: "no-checks-reported" };
  let parsed: Array<{ name: string; state: string }>;
  try {
    parsed = JSON.parse(r.stdout) as Array<{ name: string; state: string }>;
  } catch {
    return { kind: "no-checks-reported" };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { kind: "no-checks-reported" };
  }
  for (const check of parsed) {
    if (PENDING_CHECK_STATES.has(check.state)) return { kind: "pending" };
  }
  return { kind: "all-terminal" };
}

// --- CLI -------------------------------------------------------------------

export function parseArgs(
  argv: string[],
): { slug?: string } | { error: string } {
  // Slug is optional: when omitted, the caller resolves from $TMUX_PANE.
  // A leading flag is treated as "no slug given" (matches the auto-resolve
  // contract used by flow-state-update / flow-open-pr).
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
 * Composes Inputs from disk + GitHub state. Tests bypass this and call
 * decide() directly; only the runner needs the full I/O dance.
 */
export function gatherInputs(
  slug: string,
  state: PipelineState,
  gh: GhRunner,
  git: GitRunner,
): Inputs {
  // Terminal phases — and the no-in-flight-work pending phases — short-circuit
  // all I/O: decide() returns terminal from the phase check alone, so probing
  // gh/git on a completed (or pre-worktree) pipeline is wasted work (and unsafe
  // under a stub gh/git in tests).
  if (
    TERMINAL_PHASE_SET.has(state.phase) ||
    NO_INFLIGHT_WORK_PHASES.has(state.phase)
  ) {
    return {
      slug,
      state,
      worktree: { kind: "absent-from-state" },
      planExists: false,
      pr: { kind: "none" },
      hasSkillAdditions: false,
      ciState: { kind: "no-checks-reported" },
      headCommit: null,
    };
  }

  const worktree = probeWorktree(state.worktree, git);

  const planExists =
    worktree.kind === "present" ? probePlan(worktree.path) : false;
  const hasSkillAdditions =
    worktree.kind === "present"
      ? probeSkillAdditions(worktree.path, git)
      : false;
  const headCommit =
    worktree.kind === "present" ? probeHeadCommit(worktree.path, git) : null;
  const branch =
    worktree.kind === "present" ? probeBranch(worktree.path, git) : null;
  const pr = branch ? probePr(branch, gh) : { kind: "none" as const };
  const ciState =
    pr.kind === "found"
      ? probeCi(pr.number, gh)
      : { kind: "no-checks-reported" as const };

  return {
    slug,
    state,
    worktree,
    planExists,
    pr,
    hasSkillAdditions,
    ciState,
    headCommit,
  };
}

export function run(argv: string[], deps: Deps = {}): number {
  const gh = deps.gh ?? defaultGh;
  const git = deps.git ?? defaultGit;
  const stateDir = deps.stateDir ?? FLOW_STATE_DIR;
  const resolveSlug = deps.resolveSlug ?? (() => resolveSlugFromPane());

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      console.log("usage: flow-resume-decide [<slug>]");
      return 0;
    }
    console.error(`flow-resume-decide: ${parsed.error}`);
    console.error("usage: flow-resume-decide [<slug>]");
    return 2;
  }

  const slug = parsed.slug ?? resolveSlug();
  if (!slug) {
    console.error(
      "flow-resume-decide: no slug given and could not resolve from $TMUX_PANE's @flow-slug option.\n" +
        "  pass <slug> explicitly, or run inside a tmux window created by `flow new`.",
    );
    return 2;
  }

  const state = readState(slug, stateDir);
  if (!state) {
    const result: DecisionResult = {
      resumeAt: "abort",
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
