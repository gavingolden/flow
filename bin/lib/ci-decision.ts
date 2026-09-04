/**
 * Pure CI/Copilot decision matrix — types, state taxonomy, and the
 * deterministic `decideOnPoll` verdict function. Moved byte-identical
 * (bodies unchanged except the deleted `cadenceFor` ramp, see below) from
 * `bin/flow-ci-wait.ts` as part of the flow-ci-check split
 * (`.flow-tmp/plan.md` Task 1). No `gh`/filesystem I/O lives here — see
 * `./ci-observe` for the observation layer and `../flow-ci-check.ts` for
 * the one-shot CLI that wires them together with durable anchors.
 */

import { copilotAuthorMatch, matchesCopilot } from "./copilot-config";

// --- Types -----------------------------------------------------------------

export type Decision =
  | "proceed-to-review"
  | "proceed-to-review-no-bot"
  | "ci-failed"
  | "merged-externally"
  | "pr-closed"
  | "pr-conflicted"
  | "pr-blocked"
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

export const PENDING_CHECK_STATES = new Set([
  "PENDING",
  "QUEUED",
  "IN_PROGRESS",
]);
export const PASSED_CHECK_STATES = new Set(["SUCCESS", "SKIPPED"]);
export const FAILED_CHECK_STATES = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "STALE",
]);
export const REVIEW_POSTED_STATES = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
]);
// The two mergeStateStatus values where GitHub cannot build the pull_request
// merge ref, so CI never starts. Single source of truth for the conflict taxonomy.
export const CONFLICTING_MERGE_STATES = new Set(["CONFLICTING", "DIRTY"]);
// The mergeStateStatus value where a protection rule outside the `gh pr checks`
// surface (a failing required check, a missing required review, CODEOWNERS, a
// linear-history rule) blocks the merge. Distinct from the conflict taxonomy:
// BLOCKED is a legitimate *transient* state while required checks are still
// pending, so the short-circuit that consumes this set is gated on CI-terminal
// (see the poll loop), unlike the conflict check which fires at poll entry.
export const BLOCKED_MERGE_STATES = new Set(["BLOCKED"]);

// --- Pure helpers ----------------------------------------------------------

/**
 * Flat per-check cadence in seconds. Supersedes the deleted `cadenceFor`
 * 30/60/90s ramp (cross-model review, `.flow-tmp/plan.md` Cut list): the
 * 30s tier is superseded by the harness wake floor and the 90s tier only
 * delayed reporting a build that already finished. `flow-ci-check` emits
 * this as `nextCheckSec` on every `waiting` verdict.
 */
export const FLAT_CADENCE_SEC = 60;

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
  if (checks.some((c) => PENDING_CHECK_STATES.has(c.state)))
    return { kind: "pending" };
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
 * Classifies a PR's mergeability into a branch-protection-blocked verdict.
 * Gates ONLY on `mergeStateStatus === "BLOCKED"` — a protection rule (failing
 * required check, missing required review, CODEOWNERS, linear-history) the
 * pipeline does not own and cannot mechanically clear by waiting.
 *
 * Mirrors `deriveConflictState`'s shape, including the `mergeable !== "UNKNOWN"`
 * still-computing guard, but the verdict routes differently: the caller fires
 * this check only AFTER CI has reached a terminal state, because BLOCKED is a
 * legitimate transient state while required checks are still pending — firing
 * at poll entry (as the conflict check does) would bail before CI even runs.
 */
export function deriveBlockedState(
  mergeable: string,
  mergeStateStatus: string,
): { blocked: boolean } {
  return {
    blocked:
      mergeable !== "UNKNOWN" && BLOCKED_MERGE_STATES.has(mergeStateStatus),
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
export function deriveCopilotPosted(
  reviews: Review[],
  configuredLogin: string,
): boolean {
  const target = copilotAuthorMatch(configuredLogin);
  return reviews.some(
    (r) =>
      copilotAuthorMatch(r.author.login) === target &&
      REVIEW_POSTED_STATES.has(r.state),
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
  const target = copilotAuthorMatch(configuredLogin);
  let latest: string | null = null;
  // last-write-wins semantics on commitOid: when the latest matching review
  // has no commit.oid in the gh projection, we treat the whole signal as null
  // rather than falling back to an earlier review — preferring a safer
  // single-source-of-truth read over a stitched-together approximation.
  for (const r of reviews) {
    if (copilotAuthorMatch(r.author.login) !== target) continue;
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
 * Pure parser for the effective-rules view of
 * `GET /repos/{owner}/{repo}/rules/branches/{branch}`. The body is an
 * ARRAY of rule objects each shaped `{ type: string, ... }`; a rule whose
 * `type === "copilot_code_review"` is the authoritative signal that repo
 * auto-review is configured.
 *
 * Tri-state: a non-array input (null/undefined/object/string) returns
 * "unknown" — the shape couldn't be interpreted, so the caller falls back
 * to the heuristic rather than mistaking an unreadable response for "off".
 */
export function deriveCopilotRulesetEnabled(
  json: unknown,
): boolean | "unknown" {
  if (!Array.isArray(json)) return "unknown";
  return json.some(
    (rule) =>
      typeof rule === "object" &&
      rule !== null &&
      (rule as { type?: unknown }).type === "copilot_code_review",
  );
}

/** Total changed LOC at or below which the size signal treats an
 * intervening change as a small follow-up. Hardcoded constant — see
 * .flow-tmp/plan.md 'Resolved decisions'. */
export const SMALL_FOLLOWUP_MAX_LOC = 15;

/** Distinct files touched at or below which the size signal treats an
 * intervening change as a small follow-up. */
export const SMALL_FOLLOWUP_MAX_FILES = 3;

/**
 * Marks a `/flow-pr-review` fix-applier review-fix commit. Fix-applier
 * commits carry a `(pr-review #<PR_NUMBER>)` suffix in the subject —
 * source of truth:
 * skills/pipeline/flow-fix-applier-instructions/SKILL.md §7.
 */
export const FIX_APPLIER_COMMIT_MARKER = /\(pr-review #\d+\)/;

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
 * Decides whether `flow-ci-check` should short-circuit the bot wait early
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
  const target = copilotAuthorMatch(args.copilotLogin);
  const copilotReviewsOnCurrentSha = args.reviews.filter(
    (r) =>
      copilotAuthorMatch(r.author.login) === target &&
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
    const isRequested = args.requestedReviewers.some((l) =>
      matchesCopilot(l, args.copilotLogin),
    );
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
  if (state.prState === "MERGED")
    return { verdict: "exit", decision: "merged-externally" };
  if (state.prState === "CLOSED")
    return { verdict: "exit", decision: "pr-closed" };

  // Apply overrides so the rest of the matrix reads cleanly. 'failed' is
  // also CI-terminal but routes via the dedicated ci-failed branch below.
  const ciFailed = state.ciConfigured && state.ci.kind === "failed";
  const ciPassed = !state.ciConfigured || state.ci.kind === "all-passed";
  const effectiveCopilotPosted =
    !state.copilotConfigured || state.copilotPosted;

  if (ciFailed) {
    const failedChecks =
      state.ci.kind === "failed" ? state.ci.failedChecks : [];
    return {
      verdict: "exit",
      decision: "ci-failed",
      ciFailedChecks: failedChecks,
    };
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

  return { verdict: "loop", cadenceSec: FLAT_CADENCE_SEC };
}

// --- Presence / follow-up size helpers (pure; GhRunner-taking siblings ----
// allMergeCommitsBetween/isSmallFollowup live in ./ci-observe) -------------

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
      return inner
        .split(",")
        .map((t) => unquote(t.trim()))
        .some((t) => QUALIFYING_PR_TRIGGERS.has(t));
    }
    // Inline-flow map (`on: { ... }`) is out of scope — falls through here
    // to the unquote+membership-check, which fails on the `{...}` literal.
    return QUALIFYING_PR_TRIGGERS.has(unquote(after));
  }
  return false;
}
