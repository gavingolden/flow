#!/usr/bin/env bun
/**
 * Wraps the entire `/flow-pipeline` step-7 CI + Copilot poll loop as a
 * single Bash call. The supervisor today runs ~20 polls in its own
 * conversation turn, burning ~40-80 KB of context per pipeline; this
 * helper consolidates the loop into one tool call and emits a single
 * JSON decision when CI / Copilot reach a terminal state.
 *
 * Why: the polling-protocol.md contract has correctness rules the agent
 * routinely re-derives (terminal-state taxonomy, cadence ramp, lowercased
 * Copilot login on both sides, presence-check overrides, 10-min copilot
 * timeout relative to ci_terminal). Encoding them once here is the only
 * place those rules can be unit-tested.
 *
 * Usage:
 *   flow-ci-wait <PR> [--copilot-login <login>]
 *
 * Per-iteration progress goes to STDERR so the final JSON on stdout is
 * cleanly capturable: `RESULT=$(flow-ci-wait $PR)`.
 *
 * Output: a single JSON object on stdout when the loop exits.
 *   {
 *     "decision": "proceed-to-review" | "proceed-to-review-no-bot"
 *               | "ci-failed" | "merged-externally" | "pr-closed"
 *               | "pr-conflicted" | "ci-hang",
 *     "polls": number,
 *     "elapsedSec": number,
 *     "prState": "OPEN" | "MERGED" | "CLOSED",
 *     "prUrl": string,
 *     "ciFailedChecks"?: [{ "name": string, "state": string }],
 *     "copilotConfigured": boolean,
 *     "ciConfigured": boolean
 *   }
 *
 * Exit codes:
 *   0 — decision computed (any kind, including ci-hang/ci-failed/pr-closed)
 *   2 — bad CLI args
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { readCopilotLogin as readCopilotLoginFromConfig } from "./lib/copilot-config";

// --- Types -----------------------------------------------------------------

export type Decision =
  | "proceed-to-review"
  | "proceed-to-review-no-bot"
  | "ci-failed"
  | "merged-externally"
  | "pr-closed"
  | "pr-conflicted"
  | "ci-hang";

export type Check = { name: string; state: string };

export type CheckState =
  | { kind: "no-checks-reported" }
  | { kind: "pending" }
  | { kind: "all-passed" }
  | { kind: "failed"; failedChecks: Check[] };

export type Review = {
  author: { login: string };
  state: string;
  /** SHA the review was submitted against. Null when `gh` omits commit.oid. */
  commitOid: string | null;
};

export type PrState = "OPEN" | "MERGED" | "CLOSED";

export type PollState = {
  pollNum: number;
  elapsedSec: number;
  /** Seconds since start when CI first reached a terminal state. Null until then. */
  ciTerminalAt: number | null;
  prState: PrState;
  prUrl: string;
  ci: CheckState;
  /** Raw observation. The override (COPILOT_REQUESTED=0 → vacuously true) is applied inside decideOnPoll. */
  copilotPosted: boolean;
  /**
   * True iff the configured Copilot login was present in THIS poll's
   * `requested_reviewers` read (re-read each poll, not cached — GitHub
   * auto-removes Copilot once it posts its review). Informs the per-poll
   * stderr distinction only; `decideOnPoll` does not branch on it.
   */
  copilotRequestedThisPoll: boolean;
  ciConfigured: boolean;
  copilotConfigured: boolean;
  /** Wall-clock cap in seconds. Default 1200 (20 min). */
  maxElapsed: number;
  /** Seconds to wait for a bot review after CI goes terminal. Default 600 (10 min). */
  copilotTimeout: number;
};

export type PollVerdict =
  | { verdict: "loop"; cadenceSec: number }
  | { verdict: "exit"; decision: Decision; ciFailedChecks?: Check[] };

// --- State sets ------------------------------------------------------------
// Single source of truth for the gh state taxonomy. polling-protocol.md
// "Per-poll commands" calls these out explicitly.

export const PENDING_CHECK_STATES = new Set(["PENDING", "QUEUED", "IN_PROGRESS"]);
export const PASSED_CHECK_STATES = new Set(["SUCCESS", "SKIPPED"]);
export const FAILED_CHECK_STATES = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "STALE",
]);
export const REVIEW_POSTED_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]);
// The two mergeStateStatus values where GitHub cannot build the pull_request
// merge ref, so CI never starts. Single source of truth for the conflict taxonomy.
export const CONFLICTING_MERGE_STATES = new Set(["CONFLICTING", "DIRTY"]);

// --- Pure helpers ----------------------------------------------------------

/**
 * Cadence ramp: 30s for polls 1-5, 60s for 6-10, 90s for 11+.
 * Activated in Item 19; the boundaries are load-bearing on the worst-case
 * poll count of ~20 (the 20th iteration trips the 1200s cap).
 */
export function cadenceFor(pollNum: number): number {
  if (pollNum <= 5) return 30;
  if (pollNum <= 10) return 60;
  return 90;
}

/**
 * Classifies a list of `gh pr checks` results. Order of precedence:
 *   1. empty list   → "no-checks-reported" (CI configured but not yet posted)
 *   2. any pending  → "pending" (still in progress; keep polling)
 *   3. any failed   → "failed" (with the failed names — needed for the
 *                     supervisor's ci-fix loop prompt)
 *   4. otherwise    → "all-passed"
 *
 * Why 'pending' wins over 'failed': polling-protocol.md is explicit that
 * `ci_failed` requires `ci_terminal`, which means *every* check is no
 * longer pending. A single STALE check with one IN_PROGRESS is still
 * pending, not failed.
 */
export function deriveCheckState(checks: Check[]): CheckState {
  if (checks.length === 0) return { kind: "no-checks-reported" };
  if (checks.some((c) => PENDING_CHECK_STATES.has(c.state))) return { kind: "pending" };
  const failed = checks.filter((c) => FAILED_CHECK_STATES.has(c.state));
  if (failed.length > 0) return { kind: "failed", failedChecks: failed };
  return { kind: "all-passed" };
}

/**
 * Classifies a PR's mergeability into a branch-conflict verdict. Gates ONLY
 * on `mergeStateStatus` exact membership in {CONFLICTING, DIRTY} — the two
 * states where GitHub cannot build the merge ref so CI never starts.
 *
 * `mergeStateStatus` is the primary signal because GitHub reports it as
 * UNKNOWN while still computing mergeability; exact membership against
 * {CONFLICTING, DIRTY} naturally excludes that still-computing window. BEHIND /
 * BLOCKED / UNSTABLE / CLEAN / HAS_HOOKS are not conflicts. The
 * `mergeable !== "UNKNOWN"` clause is a belt-and-suspenders guard for the
 * eventual-consistency window where GitHub could momentarily report a stale
 * CONFLICTING/DIRTY `mergeStateStatus` while `mergeable` is recomputing — we
 * never short-circuit until mergeability has actually been computed.
 */
export function deriveConflictState(
  mergeable: string,
  mergeStateStatus: string,
): { conflicting: boolean } {
  return {
    conflicting:
      mergeable !== "UNKNOWN" && CONFLICTING_MERGE_STATES.has(mergeStateStatus),
  };
}

/**
 * Returns true iff some review was posted by the configured bot login.
 * "Posted" excludes PENDING reviews (still drafting) and DISMISSED reviews
 * (the bot dismissed itself or was dismissed). Login match is
 * case-insensitive — both sides are lowercased explicitly per
 * polling-protocol.md "Bot reviewer name". A substring rule is wrong: the
 * real Copilot login is `copilot-pull-request-reviewer`, not `Copilot`.
 */
export function deriveCopilotPosted(reviews: Review[], configuredLogin: string): boolean {
  const target = configuredLogin.toLowerCase();
  return reviews.some(
    (r) =>
      r.author.login.toLowerCase() === target && REVIEW_POSTED_STATES.has(r.state),
  );
}

/**
 * Whether CI has reached a terminal state. CI not configured collapses to
 * vacuously-terminal per the override rule.
 */
export function isCiTerminal(ci: CheckState, ciConfigured: boolean): boolean {
  if (!ciConfigured) return true;
  return ci.kind === "all-passed" || ci.kind === "failed";
}

/**
 * Returns the commit SHA of the most-recent (by array order, which `gh`
 * emits in submission order) review whose author login matches the
 * configured Copilot login case-insensitively and whose state is a posted
 * state (APPROVED / CHANGES_REQUESTED / COMMENTED). PENDING and DISMISSED
 * reviews are excluded — same posted-state taxonomy as
 * `deriveCopilotPosted`. Returns null when no qualifying review exists or
 * when the matched review's `commitOid` is null.
 *
 * PR #161 is the historical incident: Copilot reviewed commit
 * `1c59a70...` and a fix commit `91e18e8...` advanced `headRefOid`; the
 * helper needs the original review's commit SHA to detect that the
 * existing review is stale.
 */
export function extractLatestCopilotReviewCommit(
  reviews: Review[],
  configuredLogin: string,
): string | null {
  const target = configuredLogin.toLowerCase();
  let latest: string | null = null;
  // last-write-wins semantics on commitOid: when the latest matching review
  // has no commit.oid in the gh projection, we treat the whole signal as null
  // rather than falling back to an earlier review — preferring a safer
  // single-source-of-truth read over a stitched-together approximation.
  for (const r of reviews) {
    if (r.author.login.toLowerCase() !== target) continue;
    if (!REVIEW_POSTED_STATES.has(r.state)) continue;
    latest = r.commitOid;
  }
  return latest;
}

/**
 * Returns true iff the latest Copilot review's commit SHA is non-null AND
 * differs from the PR's current `headRefOid`. A null latest commit
 * collapses to false (no review to be stale); an empty `headRefOid`
 * collapses to false (transient `gh` projection miss; safer to keep the
 * existing decision matrix than fire a retrigger against an empty SHA).
 */
export function isCopilotReviewStale(
  latestCopilotCommit: string | null,
  headRefOid: string,
): boolean {
  if (latestCopilotCommit === null) return false;
  if (headRefOid === "") return false;
  return latestCopilotCommit !== headRefOid;
}

/**
 * Returns true iff every commit between `fromSha` (exclusive) and
 * `toSha` (inclusive) is a merge commit (has >= 2 parents).
 *
 * Why: merging main into a PR branch as a pre-merge integration step
 * advances `headRefOid` without introducing author-authored changes
 * that warrant another Copilot pass — the diff vs base is unchanged
 * from Copilot's perspective. Firing the stale-review retrigger in
 * that case burns the one-shot budget on a no-op review.
 *
 * Failure semantics — fail-open: any `gh` non-zero exit, malformed
 * JSON, or empty commits array collapses to `false` so the caller
 * proceeds to fire the retrigger. A transient `gh` hiccup must not
 * suppress a real retrigger.
 *
 * Conservative direction: false negative = one wasted POST on a no-op
 * review (cheap — one HTTP request per invocation); false positive =
 * re-introduces PR #161's "merged before Copilot reviewed the fix"
 * bug (expensive — silent correctness regression). The cheaper
 * failure mode is to fire the POST.
 */
export function allMergeCommitsBetween(
  fromSha: string,
  toSha: string,
  gh: GhRunner,
): boolean {
  const r = gh([
    "api",
    `repos/{owner}/{repo}/compare/${fromSha}...${toSha}`,
    "--jq",
    ".commits",
  ]);
  if (r.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(r.stdout) as unknown;
    if (!Array.isArray(parsed)) return false;
    if (parsed.length === 0) return false;
    return parsed.every(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        Array.isArray((c as { parents?: unknown }).parents) &&
        ((c as { parents: unknown[] }).parents.length >= 2),
    );
  } catch {
    return false;
  }
}

/** Total changed LOC at or below which the size signal treats an
 * intervening change as a small follow-up. Hardcoded constant — see
 * .flow-tmp/plan.md 'Resolved decisions'. */
export const SMALL_FOLLOWUP_MAX_LOC = 15;

/** Distinct files touched at or below which the size signal treats an
 * intervening change as a small follow-up. */
export const SMALL_FOLLOWUP_MAX_FILES = 3;

/**
 * Marks a `/pr-review` fix-applier review-fix commit. Fix-applier
 * commits carry a `(pr-review #<PR_NUMBER>)` suffix in the subject —
 * source of truth:
 * skills/pipeline/pr-review/references/fix-applier-instructions.md §7.
 */
export const FIX_APPLIER_COMMIT_MARKER = /\(pr-review #\d+\)/;

/**
 * Returns true iff the commits between `fromSha` (exclusive) and
 * `toSha` (inclusive) are a 'small follow-up' — a change unlikely to
 * surface new Copilot findings, so re-requesting a review would waste
 * a paid Copilot credit on a no-op pass.
 *
 * A follow-up is small when EITHER signal matches (OR composition):
 *  - Kind signal: every intervening commit subject carries the
 *    `/pr-review` fix-applier marker (FIX_APPLIER_COMMIT_MARKER). A
 *    fix-applier commit is by construction a narrow review-fix.
 *  - Size signal: total changed LOC (additions + deletions summed
 *    across files) <= SMALL_FOLLOWUP_MAX_LOC AND distinct files
 *    touched <= SMALL_FOLLOWUP_MAX_FILES (LOC and files compose with
 *    AND).
 *
 * Failure semantics — fail-open: any `gh` non-zero exit, malformed
 * JSON, or empty `messages` array collapses to `false` so the caller
 * proceeds to fire the retrigger. A transient `gh` hiccup must not
 * suppress a real retrigger.
 *
 * Conservative direction: false negative = one wasted POST on a no-op
 * review (cheap — one HTTP request per invocation); false positive =
 * suppresses a real fix's Copilot review, re-introducing PR #161's
 * stale-review correctness regression (expensive). The cheaper
 * failure mode is to fire the POST. Mirrors `allMergeCommitsBetween`.
 */
export function isSmallFollowup(
  fromSha: string,
  toSha: string,
  gh: GhRunner,
): boolean {
  const r = gh([
    "api",
    `repos/{owner}/{repo}/compare/${fromSha}...${toSha}`,
    "--jq",
    "{ messages: [.commits[].commit.message], files: [.files[]? | { additions, deletions, filename }] }",
  ]);
  if (r.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(r.stdout) as unknown;
    if (typeof parsed !== "object" || parsed === null) return false;
    const messages = (parsed as { messages?: unknown }).messages;
    const files = (parsed as { files?: unknown }).files;
    if (!Array.isArray(messages) || messages.length === 0) return false;

    // Kind signal: every intervening commit is a /pr-review fix-applier
    // review-fix commit (subject line carries the (pr-review #N) marker).
    const allFixApplier = messages.every(
      (m) =>
        typeof m === "string" &&
        FIX_APPLIER_COMMIT_MARKER.test(m.split("\n")[0]),
    );
    if (allFixApplier) return true;

    // Size signal: small total diff AND few distinct files touched.
    if (!Array.isArray(files)) return false;
    let loc = 0;
    const names = new Set<string>();
    for (const f of files) {
      if (typeof f !== "object" || f === null) continue;
      const fo = f as {
        additions?: unknown;
        deletions?: unknown;
        filename?: unknown;
      };
      if (typeof fo.additions === "number") loc += fo.additions;
      if (typeof fo.deletions === "number") loc += fo.deletions;
      if (typeof fo.filename === "string") names.add(fo.filename);
    }
    return (
      loc <= SMALL_FOLLOWUP_MAX_LOC && names.size <= SMALL_FOLLOWUP_MAX_FILES
    );
  } catch {
    return false;
  }
}

/**
 * Re-requests the configured Copilot login on the PR via the GitHub
 * `requested_reviewers` endpoint — the same endpoint the GitHub UI's
 * "Re-request review" button uses, and the only documented way to force
 * Copilot to re-review after its initial review removed it from
 * `requested_reviewers`. The `{owner}/{repo}` template is `gh api`'s
 * documented substitution, so no manual repo resolution is needed.
 *
 * Returns `{ ok: true, stderr: "" }` on `exitCode === 0`, `{ ok: false,
 * stderr: r.stderr }` otherwise. No retry logic; the caller (the run
 * loop) consumes the one-shot retrigger budget regardless of POST
 * success per the PRD's recorded-on-failure rule.
 */
export function retriggerCopilotReview(
  prNumber: number,
  login: string,
  gh: GhRunner,
): { ok: boolean; stderr: string } {
  const r = gh([
    "api",
    "-X",
    "POST",
    `repos/{owner}/{repo}/pulls/${prNumber}/requested_reviewers`,
    "-f",
    `reviewers[]=${login}`,
  ]);
  if (r.exitCode === 0) return { ok: true, stderr: "" };
  return { ok: false, stderr: r.stderr };
}

/**
 * Default seconds after CI reaches terminal during which Copilot is expected
 * to "claim" the review by appearing as a non-DISMISSED review on the
 * current `headRefOid` or as a PENDING review on the current `headRefOid`
 * or as an entry in `requested_reviewers`. After this deadline, an
 * un-claimed Copilot exits via `proceed-to-review-no-bot` with
 * `copilotSkipReason: 'unclaimed-after-deadline'` rather than waiting the
 * full 10-min copilot timeout. Override on the CLI with
 * `--claim-deadline-sec <n>`; suppress entirely with `--wait-for-copilot`.
 */
export const DEFAULT_CLAIM_DEADLINE_SEC = 60;

/**
 * Decides whether `flow-ci-wait` should short-circuit the bot wait early
 * with a Copilot-skip attribution. Returns the attribution string when the
 * skip should fire, `null` when the existing decision matrix applies.
 *
 * Takes discrete params (mirroring `extractLatestCopilotReviewCommit`'s
 * style) rather than expanding `PollState`. Scout flagged the alternative
 * (threading `reviews` + `headRefOid` + `copilotLogin` + `requestedReviewers`
 * into `PollState`) as an anti-pattern: `PollState` is the pure-decision
 * input for `decideOnPoll`, and these are upstream observations that need
 * to be derived once per poll rather than baked into the matrix.
 *
 * Precedence (when both signals fire on the same poll, `self-dismissed`
 * wins — the bot's DISMISSED on the current SHA is the stronger negative
 * signal):
 *   1. waitForCopilot=true       → null (user opted out of auto-detect)
 *   2. DISMISSED on current SHA  → 'self-dismissed'
 *      AND no non-dismissed review by the same login on the same SHA
 *   3. CI terminal + deadline    → 'unclaimed-after-deadline'
 *      elapsed + no review of any
 *      kind on current SHA + not
 *      requested
 *   4. otherwise                 → null
 */
export function deriveCopilotSkipReason(args: {
  reviews: Review[];
  headRefOid: string;
  copilotLogin: string;
  ciTerminalAt: number | null;
  elapsedSec: number;
  claimDeadlineSec: number;
  waitForCopilot: boolean;
  requestedReviewers: string[];
}): "unclaimed-after-deadline" | "self-dismissed" | null {
  if (args.waitForCopilot) return null;
  if (args.headRefOid === "") return null;
  const target = args.copilotLogin.toLowerCase();
  const copilotReviewsOnCurrentSha = args.reviews.filter(
    (r) =>
      r.author.login.toLowerCase() === target &&
      r.commitOid === args.headRefOid,
  );
  const hasDismissedOnCurrentSha = copilotReviewsOnCurrentSha.some(
    (r) => r.state === "DISMISSED",
  );
  const hasNonDismissedOnCurrentSha = copilotReviewsOnCurrentSha.some(
    (r) => r.state !== "DISMISSED",
  );
  if (hasDismissedOnCurrentSha && !hasNonDismissedOnCurrentSha) {
    return "self-dismissed";
  }
  if (
    args.ciTerminalAt !== null &&
    args.elapsedSec - args.ciTerminalAt >= args.claimDeadlineSec
  ) {
    // hasAnyReviewOnCurrentSha already filters to login + headRefOid match,
    // and PENDING is one of the included review states, so a separate
    // `!hasPendingOnCurrentSha` check would be dead-by-construction: if
    // `hasAnyReviewOnCurrentSha` is false then no review of any state
    // (including PENDING) by `target` exists on the current SHA.
    const hasAnyReviewOnCurrentSha = copilotReviewsOnCurrentSha.length > 0;
    const isRequested = args.requestedReviewers.includes(target);
    if (!hasAnyReviewOnCurrentSha && !isRequested) {
      return "unclaimed-after-deadline";
    }
  }
  return null;
}

// --- Pure decision -- the matrix from polling-protocol.md -----------------

/**
 * Single per-poll decision. Order matches polling-protocol.md "Decision
 * matrix" exactly. Override rules (CI_CONFIGURED=0, COPILOT_REQUESTED=0)
 * are applied here so callers can pass raw observations and unit-test the
 * override semantics directly.
 */
export function decideOnPoll(state: PollState): PollVerdict {
  // pr_state precedence — the user merged externally, or closed mid-flight.
  if (state.prState === "MERGED") return { verdict: "exit", decision: "merged-externally" };
  if (state.prState === "CLOSED") return { verdict: "exit", decision: "pr-closed" };

  // Apply overrides so the rest of the matrix reads cleanly. 'failed' is
  // also CI-terminal but routes via the dedicated ci-failed branch below.
  const ciFailed = state.ciConfigured && state.ci.kind === "failed";
  const ciPassed = !state.ciConfigured || state.ci.kind === "all-passed";
  const effectiveCopilotPosted = !state.copilotConfigured || state.copilotPosted;

  if (ciFailed) {
    const failedChecks = state.ci.kind === "failed" ? state.ci.failedChecks : [];
    return { verdict: "exit", decision: "ci-failed", ciFailedChecks: failedChecks };
  }

  if (ciPassed && effectiveCopilotPosted) {
    return { verdict: "exit", decision: "proceed-to-review" };
  }

  if (
    ciPassed &&
    !effectiveCopilotPosted &&
    state.ciTerminalAt !== null &&
    state.elapsedSec - state.ciTerminalAt >= state.copilotTimeout
  ) {
    return { verdict: "exit", decision: "proceed-to-review-no-bot" };
  }

  // Wall-clock cap. Per polling-protocol.md the cap row in the decision
  // matrix only applies when ci_passed=false AND ci_failed=false (i.e. CI
  // hasn't reached terminal yet). If CI already passed, fall through to
  // loop and let the 10-min copilot-timeout branch above eventually exit.
  // Otherwise a slow-but-eventually-passing CI that finishes near minute 18
  // would race the 20-min cap and ship 'ci-hang' instead of waiting the
  // documented 10 minutes for Copilot.
  if (!ciPassed && state.elapsedSec >= state.maxElapsed) {
    return { verdict: "exit", decision: "ci-hang" };
  }

  return { verdict: "loop", cadenceSec: cadenceFor(state.pollNum) };
}

// --- I/O wiring -----------------------------------------------------------

type CmdResult = { stdout: string; stderr: string; exitCode: number };
export type GhRunner = (argv: string[]) => CmdResult;

const defaultGh: GhRunner = (argv) => {
  const r = spawnSync("gh", argv, { encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? -1 };
};

export type Deps = {
  gh?: GhRunner;
  /** Returns ms since epoch (or any monotonic origin). Injectable for tests. */
  now?: () => number;
  /** Sleeps the requested number of milliseconds. Tests pass a logical-clock fake. */
  sleep?: (ms: number) => Promise<void>;
  /** Returns true iff `.github/workflows/` contains at least one .yml/.yaml file. */
  readWorkflowsDir?: () => boolean;
  /** Returns the configured Copilot login (default: "copilot-pull-request-reviewer"). */
  readCopilotLogin?: () => string;
  /**
   * Returns true iff the configured Copilot login has reviewed any recent merged
   * PR on the current repo. Default uses fetchHistoricalBotReview against the
   * injected `gh`. Tests inject a fake to avoid sequencing list+view calls.
   */
  readHistoricalBotReview?: (login: string) => boolean;
  /**
   * Returns true iff every commit between `fromSha` (exclusive) and
   * `toSha` (inclusive) is a merge commit. Default uses
   * `allMergeCommitsBetween` against the injected `gh`. Tests inject
   * a fake to skip sequencing a compare-API call. Mirrors the
   * `readHistoricalBotReview` pattern.
   */
  readCommitsAreAllMerges?: (fromSha: string, toSha: string) => boolean;
  /**
   * Returns true iff the commits between `fromSha` (exclusive) and
   * `toSha` (inclusive) are a 'small follow-up' unlikely to surface
   * new Copilot findings. Default uses `isSmallFollowup` against the
   * injected `gh`. Tests inject a fake to skip sequencing a
   * compare-API call. Mirrors the `readCommitsAreAllMerges` pattern.
   */
  readIsSmallFollowup?: (fromSha: string, toSha: string) => boolean;
  /**
   * Returns the PR's mergeability projection, or null on a transient gh
   * error / malformed JSON (fail-open = not conflicting). Default uses
   * `observeMergeState` against the injected `gh`. Tests inject a fake to
   * drive the conflict short-circuit deterministically without sequencing a
   * real merge-state gh call.
   */
  readMergeState?: () => { mergeable: string; mergeStateStatus: string } | null;
  /** Test-only: override the cwd used by readWorkflowsDir. */
  cwd?: string;
};

/**
 * Triggers that fire a workflow on an in-flight PR. Schedule / push /
 * workflow_dispatch / workflow_call workflows correctly fail to match —
 * they don't run on the PR under inspection. PR #152 (`cloudflare-pages-
 * prune.yml`, schedule-only) hung the 20-min cap because the old presence
 * check counted any `.yml` file regardless of trigger.
 */
export const QUALIFYING_PR_TRIGGERS = new Set([
  "pull_request",
  "pull_request_target",
  "merge_group",
]);

/**
 * Parses a single workflow YAML's top-level `on:` block and returns true
 * iff one of the QUALIFYING_PR_TRIGGERS is present. Conservative on
 * malformed input — returns false (false negative re-introduces a 20-min
 * slow-CI wait; false positive re-introduces PR #152's hang).
 *
 * Known out-of-scope syntax: inline-flow map (`on: { pull_request: foo }`)
 * is not parsed and falls through to the conservative `false` return,
 * matching the documented malformed-YAML rule. Block-sequence (`on:\n  -
 * pull_request`) IS supported alongside the bare-map child-key form.
 */
export function hasQualifyingWorkflowTrigger(yamlText: string): boolean {
  const stripInline = (s: string) => s.replace(/\s+#.*$/, "").trim();
  const unquote = (s: string) => s.replace(/^["'](.*)["']$/, "$1");
  const lines = yamlText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^on\s*:(.*)$/.exec(line);
    if (!m) continue;
    const after = stripInline(m[1]);
    if (after === "") {
      // Block form. Two sub-syntaxes share this branch: map (`pull_request:`
      // child keys) and block-sequence (`- pull_request` dash items). Find
      // children at the first deeper indentation level and test both shapes.
      let childIndent = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const raw = lines[j];
        const stripped = raw.replace(/\s+#.*$/, "");
        if (stripped.trim() === "") continue;
        const indent = raw.length - raw.trimStart().length;
        if (indent === 0) break;
        if (childIndent === -1) childIndent = indent;
        if (indent !== childIndent) continue;
        const trimmed = stripped.trim();
        const km = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(trimmed);
        if (km && QUALIFYING_PR_TRIGGERS.has(km[1])) return true;
        const dm = /^-\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*$/.exec(trimmed);
        if (dm && QUALIFYING_PR_TRIGGERS.has(dm[1])) return true;
      }
      return false;
    }
    if (after.startsWith("[")) {
      const inner = after.replace(/^\[|\]$/g, "");
      return inner.split(",").map((t) => unquote(t.trim())).some((t) => QUALIFYING_PR_TRIGGERS.has(t));
    }
    // Inline-flow map (`on: { ... }`) is out of scope — falls through here
    // to the unquote+membership-check, which fails on the `{...}` literal.
    return QUALIFYING_PR_TRIGGERS.has(unquote(after));
  }
  return false;
}

/**
 * Returns true iff `.github/workflows/` contains at least one workflow
 * whose `on:` block lists a qualifying PR trigger. Short-circuits on the
 * first match. Filesystem-only — no API call.
 */
function defaultReadWorkflowsDir(cwd: string): boolean {
  const dir = path.join(cwd, ".github", "workflows");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (!(e.isFile() || e.isSymbolicLink())) continue;
    if (!/\.(ya?ml)$/i.test(e.name)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, e.name), "utf8");
    } catch {
      continue;
    }
    if (hasQualifyingWorkflowTrigger(text)) return true;
  }
  return false;
}

/**
 * Reads the Copilot login from ~/.flow/config.json `bots.copilot` via the
 * shared tolerant boundary reader (accepts both the bare-string login and
 * the `{ login, globs }` object form). Falls back to GitHub's default
 * reviewer login when the file or the field is absent.
 */
function defaultReadCopilotLogin(): string {
  return readCopilotLoginFromConfig();
}

/** Fetches the PR's requested-reviewers list (used at loop entry, per-poll, and for post-POST verification). Returns lowercased logins. */
export function fetchRequestedReviewers(prNumber: number, gh: GhRunner): string[] {
  const r = gh(["pr", "view", String(prNumber), "--json", "reviewRequests"]);
  if (r.exitCode !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout) as { reviewRequests?: Array<{ login?: string }> };
    return (parsed.reviewRequests ?? [])
      .map((rr) => rr.login)
      .filter((l): l is string => typeof l === "string")
      .map((l) => l.toLowerCase());
  } catch {
    return [];
  }
}

/**
 * Detects whether the configured Copilot login has reviewed any of the
 * recent merged PRs on the current repo. Used as a fallback when the
 * in-flight PR's `reviewRequests` list is empty: org / repo-level
 * auto-review configurations don't populate `reviewRequests` even when
 * Copilot is guaranteed to post a review, and the supervisor must not
 * race past it (the PR #78 / 2026-05-03 incident).
 *
 * Implementation: list the last `n` merged PRs (`gh pr list --state
 * merged --limit n --json number`), then per-PR `gh pr view --json
 * reviews` and short-circuit on first match. `gh pr list --json` does
 * not expose `reviews`, so a single-call solution is unavailable; the
 * list+view pattern is repo-agnostic and reuses the injected `gh`
 * runner. Errors and malformed JSON collapse to `false`.
 */
export function fetchHistoricalBotReview(
  login: string,
  gh: GhRunner,
  n = 5,
): boolean {
  const target = login.toLowerCase();
  const list = gh(["pr", "list", "--state", "merged", "--limit", String(n), "--json", "number"]);
  if (list.exitCode !== 0) return false;
  let prs: Array<{ number: number }>;
  try {
    const parsed = JSON.parse(list.stdout) as Array<{ number?: number }>;
    if (!Array.isArray(parsed)) return false;
    prs = parsed.filter((p): p is { number: number } => typeof p.number === "number");
  } catch {
    return false;
  }
  for (const pr of prs) {
    const view = gh(["pr", "view", String(pr.number), "--json", "reviews"]);
    if (view.exitCode !== 0) continue;
    try {
      const parsed = JSON.parse(view.stdout) as {
        reviews?: Array<{ author?: { login?: string } }>;
      };
      const matched = (parsed.reviews ?? []).some(
        (rv) => typeof rv.author?.login === "string" && rv.author.login.toLowerCase() === target,
      );
      if (matched) return true;
    } catch {
      continue;
    }
  }
  return false;
}

type PrObservation = {
  state: PrState;
  url: string;
  reviews: Review[];
  /** Current HEAD SHA of the PR branch. Empty string when `gh` omits it. */
  headRefOid: string;
  /**
   * Logins currently in `requested_reviewers` (lowercased). Re-projected
   * per poll because GitHub auto-removes Copilot after its first review,
   * so a loop-entry snapshot can stale during the wait. Empty when `gh`
   * omits `reviewRequests`.
   */
  requestedReviewers: string[];
};

export function observePr(prNumber: number, gh: GhRunner): PrObservation | null {
  const r = gh([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "state,url,reviews,headRefOid,reviewRequests",
  ]);
  if (r.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as {
      state?: string;
      url?: string;
      reviews?: Array<{
        author?: { login?: string };
        state?: string;
        commit?: { oid?: string } | null;
      }>;
      headRefOid?: string;
      reviewRequests?: Array<{ login?: string }>;
    };
    if (
      typeof parsed.url !== "string" ||
      (parsed.state !== "OPEN" && parsed.state !== "MERGED" && parsed.state !== "CLOSED")
    ) {
      return null;
    }
    const reviews: Review[] = (parsed.reviews ?? [])
      .filter(
        (rv): rv is { author: { login: string }; state: string; commit?: { oid?: string } | null } =>
          typeof rv.author?.login === "string" && typeof rv.state === "string",
      )
      .map((rv) => ({
        author: { login: rv.author.login },
        state: rv.state,
        commitOid:
          rv.commit && typeof rv.commit.oid === "string" && rv.commit.oid.length > 0
            ? rv.commit.oid
            : null,
      }));
    const headRefOid = typeof parsed.headRefOid === "string" ? parsed.headRefOid : "";
    const requestedReviewers = (parsed.reviewRequests ?? [])
      .map((rr) => rr.login)
      .filter((l): l is string => typeof l === "string")
      .map((l) => l.toLowerCase());
    return { state: parsed.state, url: parsed.url, reviews, headRefOid, requestedReviewers };
  } catch {
    return null;
  }
}

/**
 * Reads the PR's mergeability projection (`mergeable` + `mergeStateStatus`).
 * FAIL-OPEN: any non-zero exit or malformed JSON returns null. This is the
 * OPPOSITE conservative direction from the sibling readers (which fail toward
 * firing a POST) — here a false `conflicting` is the expensive error (it
 * routes a non-conflicted PR to the merge path), so null (= not conflicting)
 * is the safe failure mode.
 */
export function observeMergeState(
  prNumber: number,
  gh: GhRunner,
): { mergeable: string; mergeStateStatus: string } | null {
  const r = gh(["pr", "view", String(prNumber), "--json", "mergeable,mergeStateStatus"]);
  if (r.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as {
      mergeable?: unknown;
      mergeStateStatus?: unknown;
    };
    return {
      mergeable: typeof parsed.mergeable === "string" ? parsed.mergeable : "",
      mergeStateStatus:
        typeof parsed.mergeStateStatus === "string" ? parsed.mergeStateStatus : "",
    };
  } catch {
    return null;
  }
}

export function observeChecks(prNumber: number, gh: GhRunner): Check[] {
  const r = gh(["pr", "checks", String(prNumber), "--json", "name,state"]);
  if (r.exitCode !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout) as Check[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is Check => typeof c.name === "string" && typeof c.state === "string",
    );
  } catch {
    return [];
  }
}

// --- CLI -------------------------------------------------------------------

export type Args = {
  pr: number;
  copilotLogin?: string;
  /** Test-only: override the wall-clock cap (default 1200s). */
  maxElapsed?: number;
  /** Test-only: override the bot-review timeout (default 600s). */
  copilotTimeout?: number;
  /**
   * When true, suppress both Copilot auto-detect skips
   * (`unclaimed-after-deadline` and `self-dismissed`) and wait the full
   * 10-min copilot timeout. Plumbed through from `flow new
   * --wait-for-copilot` via state.json's `waitForCopilot` field.
   */
  waitForCopilot?: boolean;
  /**
   * When true, hard-forces `copilotConfigured = false` — bypassing BOTH
   * the `requestedReviewers` check and the `readHistoricalBotReview`
   * historical fallback. Set by `/flow-pipeline` step 7 whenever the
   * request decision was to DECLINE (auto-mode trivial decline, or
   * `--copilot-review never`), so a declined PR collapses the bot wait
   * immediately instead of waiting the 10-min timeout that the historical
   * fallback would otherwise trigger. Absent ≡ false (current behaviour:
   * the two signals decide).
   */
  copilotNotRequested?: boolean;
  /**
   * Seconds after CI reaches terminal during which Copilot is expected
   * to claim the review. Default: `DEFAULT_CLAIM_DEADLINE_SEC` (60s).
   * Direct-invocation-only override.
   */
  claimDeadlineSec?: number;
};

export function parseArgs(argv: string[]): Args | { error: string } {
  if (argv.length === 0) return { error: "PR number is required" };
  if (argv.includes("--help") || argv.includes("-h")) return { error: "help" };
  const [first, ...rest] = argv;
  if (first.startsWith("--")) {
    return { error: "PR number must be the first positional argument" };
  }
  const pr = Number.parseInt(first, 10);
  if (!Number.isFinite(pr) || pr <= 0 || String(pr) !== first) {
    return { error: `PR must be a positive integer, got '${first}'` };
  }
  const out: Args = { pr };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    switch (flag) {
      case "--copilot-login":
        if (!value || value.startsWith("--"))
          return { error: "--copilot-login requires a value" };
        out.copilotLogin = value;
        i++;
        continue;
      case "--max-elapsed":
        if (!value) return { error: "--max-elapsed requires a value" };
        out.maxElapsed = Number.parseInt(value, 10);
        i++;
        continue;
      case "--copilot-timeout":
        if (!value) return { error: "--copilot-timeout requires a value" };
        out.copilotTimeout = Number.parseInt(value, 10);
        i++;
        continue;
      case "--wait-for-copilot":
        out.waitForCopilot = true;
        continue;
      case "--copilot-not-requested":
        out.copilotNotRequested = true;
        continue;
      case "--claim-deadline-sec": {
        if (!value) return { error: "--claim-deadline-sec requires a value" };
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n <= 0 || String(n) !== value) {
          return {
            error: `--claim-deadline-sec must be a positive integer, got '${value}'`,
          };
        }
        out.claimDeadlineSec = n;
        i++;
        continue;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  return out;
}

function formatElapsed(sec: number): string {
  return `${Math.floor(sec / 60)}m${(sec % 60).toString().padStart(2, "0")}s`;
}

// --- Runner ---------------------------------------------------------------

export type RunResult = {
  decision: Decision;
  polls: number;
  elapsedSec: number;
  prState: PrState;
  prUrl: string;
  ciFailedChecks?: Check[];
  copilotConfigured: boolean;
  ciConfigured: boolean;
  /**
   * True iff the stale-review retrigger POST was attempted in this
   * invocation. Recorded on POST failure too — the budget is consumed
   * either way; the supervisor's ci-fix-loop re-invocation is the
   * recovery path.
   */
  copilotRetriggered: boolean;
  /**
   * Attribution for an early `proceed-to-review-no-bot` exit driven by
   * the auto-detect path (see `deriveCopilotSkipReason`). One of:
   *   - 'unclaimed-after-deadline' — CI terminal + claim deadline elapsed
   *     + no Copilot review of any kind on the current headRefOid +
   *     Copilot not in `requested_reviewers`.
   *   - 'self-dismissed' — Copilot dismissed its own review on the
   *     current `headRefOid` and has no non-dismissed review on the
   *     same SHA.
   *   - null — the existing 10-min copilot-timeout branch fired, the
   *     skip didn't apply, or the decision was not
   *     `proceed-to-review-no-bot` at all (every normal-exit path
   *     normalises to null so the wire shape is stable). The field is
   *     always present on the emitted JSON.
   */
  copilotSkipReason: "unclaimed-after-deadline" | "self-dismissed" | null;
};

export async function run(argv: string[], deps: Deps = {}): Promise<number> {
  const gh = deps.gh ?? defaultGh;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const cwd = deps.cwd ?? process.cwd();
  const readWorkflowsDir = deps.readWorkflowsDir ?? (() => defaultReadWorkflowsDir(cwd));
  const readCopilotLogin = deps.readCopilotLogin ?? defaultReadCopilotLogin;
  const readHistoricalBotReview =
    deps.readHistoricalBotReview ?? ((login: string) => fetchHistoricalBotReview(login, gh));
  const readCommitsAreAllMerges =
    deps.readCommitsAreAllMerges ??
    ((fromSha: string, toSha: string) => allMergeCommitsBetween(fromSha, toSha, gh));
  const readIsSmallFollowup =
    deps.readIsSmallFollowup ??
    ((fromSha: string, toSha: string) => isSmallFollowup(fromSha, toSha, gh));

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      console.log("usage: flow-ci-wait <PR> [--copilot-login <login>] [--wait-for-copilot] [--copilot-not-requested] [--claim-deadline-sec <n>]");
      return 0;
    }
    console.error(`flow-ci-wait: ${parsed.error}`);
    console.error("usage: flow-ci-wait <PR> [--copilot-login <login>] [--wait-for-copilot] [--copilot-not-requested] [--claim-deadline-sec <n>]");
    return 2;
  }

  const copilotLogin = parsed.copilotLogin ?? readCopilotLogin();
  const maxElapsed = parsed.maxElapsed ?? 1200;
  const copilotTimeout = parsed.copilotTimeout ?? 600;
  const waitForCopilot = parsed.waitForCopilot ?? false;
  const claimDeadlineSec = parsed.claimDeadlineSec ?? DEFAULT_CLAIM_DEADLINE_SEC;
  const readMergeState =
    deps.readMergeState ?? (() => observeMergeState(parsed.pr, gh));

  const ciConfigured = readWorkflowsDir();
  const requestedReviewers = fetchRequestedReviewers(parsed.pr, gh);
  // Two signals for "is Copilot expected to review?": the in-flight PR's
  // reviewRequests, and the repo's recent PR history. Org / repo-level
  // auto-review configurations don't populate reviewRequests, so a single
  // signal misses them and the supervisor races past Copilot (PR #78,
  // 2026-05-03). The history fallback runs only when reviewRequests is
  // negative — the common case (Copilot explicitly requested) stays a
  // single gh call.
  // `--copilot-not-requested` is the explicit decline signal from
  // /flow-pipeline step 7: the supervisor decided NOT to request Copilot
  // for this PR. Hard-force false BEFORE the two-signal `||` so neither
  // the in-flight reviewRequests NOR the historical-PR fallback can keep
  // the bot wait alive — otherwise a declined PR in a repo with recent
  // Copilot history would still incur the capped 10-min timeout.
  const copilotConfigured =
    !parsed.copilotNotRequested &&
    (requestedReviewers.includes(copilotLogin.toLowerCase()) ||
      readHistoricalBotReview(copilotLogin));

  const startMs = now();
  let pollNum = 0;
  let ciTerminalAt: number | null = null;
  let lastPrState: PrState = "OPEN";
  let lastPrUrl = "";
  // One-shot per invocation. Recorded true on POST failure too; the
  // supervisor's ci-fix-loop re-invocation grants a fresh budget per fix
  // cycle. See plan.md "Story 3" + "Open Questions" assumption.
  let copilotRetriggered = false;

  while (true) {
    pollNum++;
    const elapsedSec = Math.floor((now() - startMs) / 1000);
    const cadence = cadenceFor(pollNum);
    process.stderr.write(
      `CI poll ${pollNum}, elapsed ${formatElapsed(elapsedSec)} of 20m, cadence ${cadence}s\n`,
    );

    // Observe PR state + reviews (always — pr_state can change mid-flight).
    const prInfo = observePr(parsed.pr, gh);
    if (!prInfo) {
      // Transient gh failure on PR observation. Treat as "still polling" — let
      // the cap eventually fire ci-hang. Do not loop-fail on a single
      // hiccup; the poll loop is the supervisor's tolerance for the gh
      // surface.
      if (elapsedSec >= maxElapsed) {
        emitResult({
          decision: "ci-hang",
          polls: pollNum,
          elapsedSec,
          prState: lastPrState,
          prUrl: lastPrUrl,
          copilotConfigured,
          ciConfigured,
          copilotRetriggered,
          // Mirrors the verdict-driven exit path below: every normal-exit
          // emits an explicit null so the wire shape stays stable across
          // the transient-gh-failure ci-hang and the standard ci-hang.
          copilotSkipReason: null,
        });
        return 0;
      }
      await sleep(cadence * 1000);
      continue;
    }
    lastPrState = prInfo.state;
    lastPrUrl = prInfo.url;

    // Branch-conflict short-circuit. When the PR branch conflicts with base,
    // GitHub cannot build the pull_request merge ref, so CI never starts and
    // the loop would otherwise wait out the full 20-min cap to ci-hang. The
    // conflict can appear at loop entry (poll 1) or mid-wait (a later poll
    // once base advances), so this per-poll placement covers both. The
    // `prInfo.state === "OPEN"` guard preserves MERGED/CLOSED precedence: a
    // MERGED/CLOSED PR falls through to decideOnPoll, which returns
    // merged-externally/pr-closed. Placed before the requested_reviewers /
    // observeChecks reads so a conflicted PR never pays for those gh calls.
    // Modeled on the Copilot auto-detect early-emit short-circuit below; the
    // extra observation is read here rather than threaded into PollState (see
    // the rejected-anti-pattern note at deriveCopilotSkipReason).
    if (prInfo.state === "OPEN") {
      const mergeState = readMergeState();
      if (
        mergeState !== null &&
        deriveConflictState(mergeState.mergeable, mergeState.mergeStateStatus).conflicting
      ) {
        process.stderr.write(
          `Branch conflict detected (mergeStateStatus=${mergeState.mergeStateStatus}) — exiting pr-conflicted at poll ${pollNum}\n`,
        );
        emitResult({
          decision: "pr-conflicted",
          polls: pollNum,
          elapsedSec,
          prState: prInfo.state,
          prUrl: prInfo.url,
          copilotConfigured,
          ciConfigured,
          copilotRetriggered,
          copilotSkipReason: null,
        });
        return 0;
      }
    }

    // Per-poll requested_reviewers read (item 1). Re-read every poll rather
    // than caching the loop-entry value: GitHub auto-removes Copilot from
    // requested_reviewers once it posts its review, so membership genuinely
    // changes across polls. Only meaningful when Copilot is configured; skip
    // the gh call otherwise.
    const copilotRequestedThisPoll = copilotConfigured
      ? fetchRequestedReviewers(parsed.pr, gh).includes(copilotLogin.toLowerCase())
      : false;

    // Observe CI checks only when CI is configured (presence override).
    const ci: CheckState = ciConfigured
      ? deriveCheckState(observeChecks(parsed.pr, gh))
      : { kind: "no-checks-reported" };

    // Update the carryover CI_TERMINAL_AT timestamp on the first poll
    // where CI reaches terminal. Used by the 10-min copilot timeout.
    if (isCiTerminal(ci, ciConfigured) && ciTerminalAt === null) {
      ciTerminalAt = elapsedSec;
    }

    // Copilot auto-detect short-circuits (must run BEFORE the stale-review
    // retrigger so a self-dismissed signal does not POST a doomed re-request).
    // Two attributions: `self-dismissed` (DISMISSED on current headRefOid
    // with no fresher non-dismissed review by the same login) and
    // `unclaimed-after-deadline` (CI terminal + claim deadline elapsed +
    // no Copilot review of any kind on the current headRefOid + not
    // requested). `--wait-for-copilot` suppresses both. See
    // `deriveCopilotSkipReason` for the precedence rules.
    //
    // Precedence guards: the short-circuit must not pre-empt `decideOnPoll`'s
    // documented pr-state and ci-failed branches. A MERGED/CLOSED PR routes
    // to `merged-externally` / `pr-closed`; a failed CI routes to `ci-failed`
    // (which feeds the 3-loop ci-fix recovery). Without these guards the
    // auto-detect can silently reroute any of those decisions to
    // `proceed-to-review-no-bot` — see consolidator finding bug-detection:1044.
    if (
      copilotConfigured &&
      !copilotRetriggered &&
      prInfo.state === "OPEN" &&
      ci.kind !== "failed"
    ) {
      const skipReason = deriveCopilotSkipReason({
        reviews: prInfo.reviews,
        headRefOid: prInfo.headRefOid,
        copilotLogin,
        ciTerminalAt,
        elapsedSec,
        claimDeadlineSec,
        waitForCopilot,
        requestedReviewers: prInfo.requestedReviewers,
      });
      if (skipReason !== null) {
        process.stderr.write(
          `Copilot auto-detect: ${skipReason} — exiting proceed-to-review-no-bot at poll ${pollNum}\n`,
        );
        emitResult({
          decision: "proceed-to-review-no-bot",
          polls: pollNum,
          elapsedSec,
          prState: prInfo.state,
          prUrl: prInfo.url,
          copilotConfigured,
          ciConfigured,
          copilotRetriggered,
          copilotSkipReason: skipReason,
        });
        return 0;
      }
    }

    // Stale-Copilot-review retrigger (PR #161 incident). Fire the
    // `requested_reviewers` POST when (a) Copilot is configured, (b) the
    // one-shot budget is unused, (c) CI is terminal — gating on terminal
    // avoids burning the budget on a commit that may be force-pushed mid-
    // CI — and (d) the latest Copilot review is against a SHA older than
    // the PR's current headRefOid. Recorded as consumed on POST failure
    // too; the supervisor's ci-fix-loop re-invocation is the recovery path.
    if (
      copilotConfigured &&
      !copilotRetriggered &&
      isCiTerminal(ci, ciConfigured)
    ) {
      const latestCopilotCommit = extractLatestCopilotReviewCommit(
        prInfo.reviews,
        copilotLogin,
      );
      if (isCopilotReviewStale(latestCopilotCommit, prInfo.headRefOid)) {
        // Merge-only skip: when every intervening commit between the
        // reviewed SHA and headRefOid is a merge commit, the diff vs
        // base is unchanged from Copilot's perspective and re-firing
        // would burn the one-shot budget on a no-op review. latestCopilotCommit
        // is guaranteed non-null here because isCopilotReviewStale
        // returned true (which requires a non-null commit).
        if (readCommitsAreAllMerges(latestCopilotCommit as string, prInfo.headRefOid)) {
          const oldShort = (latestCopilotCommit as string).slice(0, 8);
          const newShort = prInfo.headRefOid.slice(0, 8);
          process.stderr.write(
            `Copilot review stale (commit ${oldShort}… < headRefOid ${newShort}…) — every intervening commit is a merge, skipping retrigger\n`,
          );
        } else if (
          readIsSmallFollowup(latestCopilotCommit as string, prInfo.headRefOid)
        ) {
          // Small-follow-up skip: when the only intervening commits are
          // a small follow-up (every commit a /pr-review fix-applier
          // review-fix, or a change under the LOC/files thresholds),
          // re-requesting Copilot would burn a paid credit on a review
          // unlikely to surface findings. Sibling of the merge-only
          // skip above; same one-shot-budget-saving intent.
          const oldShort = (latestCopilotCommit as string).slice(0, 8);
          const newShort = prInfo.headRefOid.slice(0, 8);
          process.stderr.write(
            `Copilot review stale (commit ${oldShort}… < headRefOid ${newShort}…) — intervening commits are a small follow-up, skipping retrigger\n`,
          );
        } else {
          const retrigger = retriggerCopilotReview(parsed.pr, copilotLogin, gh);
          const oldShort = (latestCopilotCommit as string).slice(0, 8);
          const newShort = prInfo.headRefOid.slice(0, 8);
          if (!retrigger.ok) {
            // POST non-zero (the existing 422/403 path): unchanged. The
            // attempt consumed the one-shot budget; mark retriggered, reset
            // the Copilot timeout window, log the POST failure, and fall
            // through to the existing decision matrix.
            copilotRetriggered = true;
            ciTerminalAt = elapsedSec;
            process.stderr.write(
              `Copilot retrigger POST failed: ${retrigger.stderr.slice(0, 200)}\n`,
            );
            process.stderr.write(
              `Copilot review stale (commit ${oldShort}… < headRefOid ${newShort}…) — re-requested at poll ${pollNum}\n`,
            );
          } else {
            // POST ok — verify Copilot is actually queued (item 2). GitHub can
            // return exit 0 while silently declining to add Copilot to
            // requested_reviewers; re-read and confirm membership rather than
            // trusting the POST blindly.
            const queued = fetchRequestedReviewers(parsed.pr, gh).includes(
              copilotLogin.toLowerCase(),
            );
            if (queued) {
              // Confirmed queued: today's behavior. Reset the Copilot timeout
              // window so the existing 10-min branch measures from re-request.
              copilotRetriggered = true;
              ciTerminalAt = elapsedSec;
              process.stderr.write(
                `Copilot review stale (commit ${oldShort}… < headRefOid ${newShort}…) — re-requested at poll ${pollNum}\n`,
              );
            } else {
              // Silent rejection: POST accepted but Copilot was not queued.
              // Do NOT set copilotRetriggered or reset ciTerminalAt — that
              // would burn the full 10-min Copilot timeout on a review that
              // will never post. Short-circuit immediately, mirroring the
              // transient-gh early-emit above. copilotRetriggered stays false.
              process.stderr.write(
                `NOTICE: Copilot retrigger POST returned ok but ${copilotLogin} is not in requested_reviewers — silent rejection, not queued. Proceeding to review without bot.\n`,
              );
              emitResult({
                decision: "proceed-to-review-no-bot",
                polls: pollNum,
                elapsedSec,
                prState: prInfo.state,
                prUrl: prInfo.url,
                copilotConfigured,
                ciConfigured,
                copilotRetriggered,
                copilotSkipReason: null,
              });
              return 0;
            }
          }
        }
      }
    }

    // Once retriggered, the existing-review path is invalidated for the
    // rest of polling — the stale review's state is still POSTED but it
    // was against the prior commit. The fresh review is recognised by
    // its commit.oid matching the current headRefOid. Before retrigger,
    // the original semantics apply (any POSTED Copilot review counts).
    const copilotPosted = copilotRetriggered
      ? extractLatestCopilotReviewCommit(prInfo.reviews, copilotLogin) ===
        prInfo.headRefOid
      : deriveCopilotPosted(prInfo.reviews, copilotLogin);

    // Per-poll in-progress distinction (item 1). When CI is terminal and we
    // are still waiting on a Copilot review that has not posted, distinguish
    // "queued, still waiting" (a healthy wait) from "no Copilot review yet"
    // (none queued) using the per-poll requested_reviewers membership.
    if (copilotConfigured && isCiTerminal(ci, ciConfigured) && !copilotPosted) {
      process.stderr.write(
        copilotRequestedThisPoll
          ? "Copilot queued, still waiting\n"
          : "no Copilot review yet\n",
      );
    }

    const verdict = decideOnPoll({
      pollNum,
      elapsedSec,
      ciTerminalAt,
      prState: prInfo.state,
      prUrl: prInfo.url,
      ci,
      copilotPosted,
      copilotRequestedThisPoll,
      ciConfigured,
      copilotConfigured,
      maxElapsed,
      copilotTimeout,
    });

    if (verdict.verdict === "exit") {
      const result: RunResult = {
        decision: verdict.decision,
        polls: pollNum,
        elapsedSec,
        prState: prInfo.state,
        prUrl: prInfo.url,
        copilotConfigured,
        ciConfigured,
        copilotRetriggered,
        // Explicit null on every normal-exit path so the wire JSON matches
        // the documented schema (`copilotSkipReason: ... | null`). The
        // auto-detect short-circuit above sets its own non-null value; any
        // verdict-driven exit (including the 10-min copilot timeout) emits
        // null. See SKILL.md step 7 and polling-protocol.md decision matrix.
        copilotSkipReason: null,
      };
      if (verdict.ciFailedChecks) result.ciFailedChecks = verdict.ciFailedChecks;
      emitResult(result);
      return 0;
    }

    await sleep(verdict.cadenceSec * 1000);
  }
}

function emitResult(result: RunResult): void {
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
