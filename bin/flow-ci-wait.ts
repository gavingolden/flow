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
 *               | "ci-failed" | "merged-externally" | "pr-closed" | "ci-hang",
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
import { FLOW_CONFIG } from "./lib/paths";

// --- Types -----------------------------------------------------------------

export type Decision =
  | "proceed-to-review"
  | "proceed-to-review-no-bot"
  | "ci-failed"
  | "merged-externally"
  | "pr-closed"
  | "ci-hang";

export type Check = { name: string; state: string };

export type CheckState =
  | { kind: "no-checks-reported" }
  | { kind: "pending" }
  | { kind: "all-passed" }
  | { kind: "failed"; failedChecks: Check[] };

export type Review = { author: { login: string }; state: string };

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
      // Map form. Find child keys at the first deeper indentation level.
      let childIndent = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const raw = lines[j];
        const stripped = raw.replace(/\s+#.*$/, "");
        if (stripped.trim() === "") continue;
        const indent = raw.length - raw.trimStart().length;
        if (indent === 0) break;
        if (childIndent === -1) childIndent = indent;
        if (indent !== childIndent) continue;
        const km = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(stripped.trim());
        if (km && QUALIFYING_PR_TRIGGERS.has(km[1])) return true;
      }
      return false;
    }
    if (after.startsWith("[")) {
      const inner = after.replace(/^\[|\]$/g, "");
      return inner.split(",").map((t) => unquote(t.trim())).some((t) => QUALIFYING_PR_TRIGGERS.has(t));
    }
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
 * Reads the Copilot login from ~/.flow/config.json `bots.copilot`. Falls
 * back to GitHub's default reviewer login when the file or the field is
 * absent.
 */
function defaultReadCopilotLogin(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(FLOW_CONFIG, "utf8")) as {
      bots?: { copilot?: string };
    };
    return cfg.bots?.copilot ?? "copilot-pull-request-reviewer";
  } catch {
    return "copilot-pull-request-reviewer";
  }
}

/** Fetches the requested-reviewers list once at loop entry. Returns lowercased logins. */
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

type PrObservation = { state: PrState; url: string; reviews: Review[] };

export function observePr(prNumber: number, gh: GhRunner): PrObservation | null {
  const r = gh(["pr", "view", String(prNumber), "--json", "state,url,reviews"]);
  if (r.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as {
      state?: string;
      url?: string;
      reviews?: Array<{ author?: { login?: string }; state?: string }>;
    };
    if (
      typeof parsed.url !== "string" ||
      (parsed.state !== "OPEN" && parsed.state !== "MERGED" && parsed.state !== "CLOSED")
    ) {
      return null;
    }
    const reviews: Review[] = (parsed.reviews ?? [])
      .filter(
        (rv): rv is { author: { login: string }; state: string } =>
          typeof rv.author?.login === "string" && typeof rv.state === "string",
      )
      .map((rv) => ({ author: { login: rv.author.login }, state: rv.state }));
    return { state: parsed.state, url: parsed.url, reviews };
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

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      console.log("usage: flow-ci-wait <PR> [--copilot-login <login>]");
      return 0;
    }
    console.error(`flow-ci-wait: ${parsed.error}`);
    console.error("usage: flow-ci-wait <PR> [--copilot-login <login>]");
    return 2;
  }

  const copilotLogin = parsed.copilotLogin ?? readCopilotLogin();
  const maxElapsed = parsed.maxElapsed ?? 1200;
  const copilotTimeout = parsed.copilotTimeout ?? 600;

  const ciConfigured = readWorkflowsDir();
  const requestedReviewers = fetchRequestedReviewers(parsed.pr, gh);
  // Two signals for "is Copilot expected to review?": the in-flight PR's
  // reviewRequests, and the repo's recent PR history. Org / repo-level
  // auto-review configurations don't populate reviewRequests, so a single
  // signal misses them and the supervisor races past Copilot (PR #78,
  // 2026-05-03). The history fallback runs only when reviewRequests is
  // negative — the common case (Copilot explicitly requested) stays a
  // single gh call.
  const copilotConfigured =
    requestedReviewers.includes(copilotLogin.toLowerCase()) ||
    readHistoricalBotReview(copilotLogin);

  const startMs = now();
  let pollNum = 0;
  let ciTerminalAt: number | null = null;
  let lastPrState: PrState = "OPEN";
  let lastPrUrl = "";

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
        });
        return 0;
      }
      await sleep(cadence * 1000);
      continue;
    }
    lastPrState = prInfo.state;
    lastPrUrl = prInfo.url;

    // Observe CI checks only when CI is configured (presence override).
    const ci: CheckState = ciConfigured
      ? deriveCheckState(observeChecks(parsed.pr, gh))
      : { kind: "no-checks-reported" };

    // Update the carryover CI_TERMINAL_AT timestamp on the first poll
    // where CI reaches terminal. Used by the 10-min copilot timeout.
    if (isCiTerminal(ci, ciConfigured) && ciTerminalAt === null) {
      ciTerminalAt = elapsedSec;
    }

    const copilotPosted = deriveCopilotPosted(prInfo.reviews, copilotLogin);

    const verdict = decideOnPoll({
      pollNum,
      elapsedSec,
      ciTerminalAt,
      prState: prInfo.state,
      prUrl: prInfo.url,
      ci,
      copilotPosted,
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
