#!/usr/bin/env bun
/**
 * One-shot CI/Copilot decider. Replaces `flow-ci-wait`'s owned 20-minute
 * poll loop with a single fresh `gh` observation plus wall-clock anchors
 * durably persisted in `~/.flow/state/<slug>.json` (`ciWait`, see
 * `bin/lib/state.ts`). A backgrounded/suspended process can no longer
 * fabricate `ci-hang`: every invocation re-derives elapsed time from
 * `ciWait.startedAt`, never from how long the calling process itself has
 * been alive (`.flow-tmp/plan.md` "Story 3 — Suspension immunity").
 *
 * The decision matrix (`decideOnPoll`) and the `gh` observation layer are
 * unchanged — they moved byte-identical to `./lib/ci-decision` and
 * `./lib/ci-observe` (`.flow-tmp/plan.md` Tasks 1-2). This file is the
 * thin CLI shell: parse args, load/reset the anchor record, take exactly
 * one observation pass in the documented order (PR view → conflict
 * short-circuit → requested reviewers → checks → terminal-anchor update →
 * Copilot auto-detect → retrigger → decideOnPoll → blocked intercept),
 * persist the record, and emit a `CheckResult`.
 *
 * The waiter (`flow-ci-wait`) owns zero state and zero decisions — it
 * only sleeps. The supervisor alternates: `flow-ci-check` (foreground) →
 * `waiting` → backgrounded `flow-ci-wait --min-sec <nextCheckSec>` →
 * completion notification → `flow-ci-check` again. See
 * `skills/pipeline/flow-pipeline/references/polling-protocol.md`.
 *
 * Usage:
 *   flow-ci-check <PR> [--copilot-login <login>] [--wait-for-copilot]
 *     [--copilot-not-requested] [--claim-deadline-sec <n>] [--out <path>]
 *     [--max-elapsed <s>] [--copilot-timeout <s>] [--state-dir <dir>]
 *     [--now <iso>]
 *
 * Output: a single JSON object on stdout.
 *   waiting: { "status": "waiting", "nextCheckSec": 60,
 *              "observation"?: "failed", "observationFailedSec"?: number,
 *              "polls": number, "elapsedSec": number,
 *              "copilotConfigured": boolean, "ciConfigured": boolean }
 *   decided: { "status": "decided", "decision": Decision, "polls": number,
 *              "elapsedSec": number, "prState": ..., "prUrl": string,
 *              "ciFailedChecks"?: [...], "copilotConfigured": boolean,
 *              "ciConfigured": boolean, "copilotRetriggered": boolean,
 *              "copilotSkipReason": ... | null }
 *
 * `--out` (default `.flow-tmp/ci-wait-result.json`) is written ONLY on
 * `decided`, so the supervisor's "file exists and parses ⇒ branch" resume
 * logic keeps working unchanged — a `waiting` envelope must never appear
 * there.
 *
 * Exit codes:
 *   0 — every status (waiting, decided, or a failed observation)
 *   2 — bad CLI args
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_CLAIM_DEADLINE_SEC,
  FLAT_CADENCE_SEC,
  decideOnPoll,
  deriveBlockedState,
  deriveCheckState,
  deriveConflictState,
  deriveCopilotPosted,
  deriveCopilotSkipReason,
  extractLatestCopilotReviewCommit,
  isCiTerminal,
  isCopilotReviewStale,
  type Check,
  type CheckState,
  type Decision,
  type PrState,
} from "./lib/ci-decision";
import {
  allMergeCommitsBetween,
  defaultGh,
  defaultReadClaimDeadline,
  defaultReadCopilotLogin,
  defaultReadWorkflowsDir,
  fetchRequestedReviewers,
  isSmallFollowup,
  observeChecks,
  observeMergeState,
  observePr,
  registrySelfCheck,
  resolveCopilotConfigured,
  retriggerCopilotReview,
  type GhRunner,
  type TimedCheck,
} from "./lib/ci-observe";
import { matchesCopilot } from "./lib/copilot-config";
import { isModuleActive, noticeLine } from "./lib/module-status";
import { resolveSlugFromEnv } from "./lib/session-identity";
import { FLOW_STATE_DIR } from "./lib/paths";
import { readState, writeState, type CiWaitRecord } from "./lib/state";

const HELP =
  "usage: flow-ci-check <PR> [--copilot-login <login>] [--wait-for-copilot] [--copilot-not-requested] [--claim-deadline-sec <n>] [--out <path>] [--max-elapsed <s>] [--copilot-timeout <s>] [--state-dir <dir>] [--now <iso>]\n" +
  "  note: absent FLOW_SLUG runs in stateless mode — anchors reset every call, so the 20-min cap and the 10-min Copilot timeout can never fire.";

export type Args = {
  pr: number;
  copilotLogin?: string;
  /** Test-only: override the wall-clock cap (default 1200s). */
  maxElapsed?: number;
  /** Test-only: override the bot-review timeout (default 600s). */
  copilotTimeout?: number;
  waitForCopilot?: boolean;
  copilotNotRequested?: boolean;
  claimDeadlineSec?: number;
  out?: string;
  /** Test-only: override the state.json directory (mirrors `Deps.stateDir`). */
  stateDir?: string;
  /** Test-only: an ISO timestamp used as `now` when `Deps.now` is absent. */
  now?: string;
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
      case "--out":
        if (!value || value.startsWith("--"))
          return { error: "--out requires a value" };
        out.out = value;
        i++;
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
      case "--state-dir":
        if (!value || value.startsWith("--"))
          return { error: "--state-dir requires a value" };
        out.stateDir = value;
        i++;
        continue;
      case "--now":
        if (!value) return { error: "--now requires a value" };
        out.now = value;
        i++;
        continue;
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  return out;
}

export type RunResult = {
  decision: Decision;
  polls: number;
  elapsedSec: number;
  prState: PrState;
  prUrl: string;
  ciFailedChecks?: Check[];
  copilotConfigured: boolean;
  ciConfigured: boolean;
  copilotRetriggered: boolean;
  copilotSkipReason: "unclaimed-after-deadline" | "self-dismissed" | null;
};

export type CheckResult =
  | (RunResult & { status: "decided" })
  | {
      status: "waiting";
      nextCheckSec: 60;
      observation?: "failed";
      observationFailedSec?: number;
      polls: number;
      elapsedSec: number;
      copilotConfigured: boolean;
      ciConfigured: boolean;
    };

export type Deps = {
  gh?: GhRunner;
  /** Returns ms since epoch (or any monotonic origin). Injectable for tests. */
  now?: () => number;
  /** Overrides the state.json directory. Default: `FLOW_STATE_DIR`. */
  stateDir?: string;
  readWorkflowsDir?: () => boolean;
  readCopilotLogin?: () => string;
  readClaimDeadline?: () => number | undefined;
  readHistoricalBotReview?: (login: string) => boolean;
  readCommitsAreAllMerges?: (fromSha: string, toSha: string) => boolean;
  readIsSmallFollowup?: (fromSha: string, toSha: string) => boolean;
  readMergeState?: () => { mergeable: string; mergeStateStatus: string } | null;
  /** Test-only: override the cwd used to resolve `--out` and `readWorkflowsDir`. */
  cwd?: string;
  isCopilotModuleActive?: () => boolean;
  registrySelfCheck?: () => string | null;
};

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function formatElapsed(sec: number): string {
  return `${Math.floor(sec / 60)}m${(sec % 60).toString().padStart(2, "0")}s`;
}

function freshRecord(pr: number, nowMs: number): CiWaitRecord {
  return {
    pr,
    headSha: "",
    startedAt: isoOf(nowMs),
    ciTerminalAt: null,
    lastObservedAt: null,
    checks: 0,
    copilotRetriggered: false,
  };
}

/**
 * Derives this poll's relative `elapsedSec`/`ciTerminalAt` from the
 * persisted anchor record, and — the first time CI is observed terminal —
 * fixes `ciTerminalAt` durably into the returned record. GitHub-side
 * preference, floored at `startedAt` (Architecture Decisions,
 * `.flow-tmp/plan.md`): `ciTerminalAt = max(startedAt, max(checks[].completedAt))`.
 * `ciConfigured=false` collapses to vacuously-terminal at `startedAt`
 * (mirrors `isCiTerminal`'s override rule). Absent `completedAt` (older
 * `gh`, or a check still mid-flight when the terminal state was first
 * read) falls back to `nowMs` — the `lastObservedAt`-at-first-terminal-
 * observation floor. Every derived interval is clamped at 0 (host-vs-
 * GitHub clock skew can never yield a negative elapsed value).
 */
export function deriveAnchors(
  record: CiWaitRecord,
  checks: TimedCheck[],
  ciConfigured: boolean,
  nowMs: number,
): { elapsedSec: number; ciTerminalAt: number | null; record: CiWaitRecord } {
  const startedMs = Date.parse(record.startedAt);
  const elapsedSec = Math.max(0, (nowMs - startedMs) / 1000);

  let ciTerminalAtIso = record.ciTerminalAt;
  if (ciTerminalAtIso === null) {
    const ci = deriveCheckState(checks);
    if (isCiTerminal(ci, ciConfigured)) {
      if (!ciConfigured) {
        ciTerminalAtIso = record.startedAt;
      } else {
        const completedMsValues = checks
          .map((c) => (c.completedAt ? Date.parse(c.completedAt) : NaN))
          .filter((n) => Number.isFinite(n));
        const maxCompletedMs =
          completedMsValues.length > 0 ? Math.max(...completedMsValues) : nowMs;
        ciTerminalAtIso = isoOf(Math.max(startedMs, maxCompletedMs));
      }
    }
  }

  const ciTerminalAt =
    ciTerminalAtIso === null
      ? null
      : Math.max(0, (Date.parse(ciTerminalAtIso) - startedMs) / 1000);

  return {
    elapsedSec,
    ciTerminalAt,
    record: { ...record, ciTerminalAt: ciTerminalAtIso },
  };
}

export async function run(argv: string[], deps: Deps = {}): Promise<number> {
  const gh = deps.gh ?? defaultGh;
  const cwd = deps.cwd ?? process.cwd();
  const readWorkflowsDir =
    deps.readWorkflowsDir ?? (() => defaultReadWorkflowsDir(cwd));
  const readCopilotLogin = deps.readCopilotLogin ?? defaultReadCopilotLogin;
  const readClaimDeadline = deps.readClaimDeadline ?? defaultReadClaimDeadline;
  const readHistoricalBotReview =
    deps.readHistoricalBotReview ??
    ((login: string) => resolveCopilotConfigured(login, gh));
  const readCommitsAreAllMerges =
    deps.readCommitsAreAllMerges ??
    ((fromSha: string, toSha: string) =>
      allMergeCommitsBetween(fromSha, toSha, gh));
  const readIsSmallFollowup =
    deps.readIsSmallFollowup ??
    ((fromSha: string, toSha: string) => isSmallFollowup(fromSha, toSha, gh));
  const isCopilotModuleActive =
    deps.isCopilotModuleActive ?? (() => isModuleActive("copilot"));
  const registrySelfCheckFn = deps.registrySelfCheck ?? registrySelfCheck;

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      console.log(HELP);
      return 0;
    }
    console.error(`flow-ci-check: ${parsed.error}`);
    console.error(HELP);
    return 2;
  }

  // Fired ONCE at startup, stderr-only: never touches the exit code or
  // either verdict write.
  const registryWarning = registrySelfCheckFn();
  if (registryWarning !== null) {
    process.stderr.write(`flow-ci-check: ${registryWarning}\n`);
  }

  const now =
    deps.now ?? (() => (parsed.now ? Date.parse(parsed.now) : Date.now()));
  const nowMs = now();
  const stateDir = deps.stateDir ?? parsed.stateDir ?? FLOW_STATE_DIR;

  const slug = resolveSlugFromEnv(process.env);
  const stateless = slug === null;
  if (stateless) {
    process.stderr.write(
      "flow-ci-check: no FLOW_SLUG resolved — running in stateless mode; anchors reset every call, so the 20-min cap and the 10-min Copilot timeout can never fire. Run inside a /flow-pipeline session (or export FLOW_SLUG) for durable anchors.\n",
    );
  }

  const copilotLogin = parsed.copilotLogin ?? readCopilotLogin();
  const maxElapsed = parsed.maxElapsed ?? 1200;
  const copilotTimeout = parsed.copilotTimeout ?? 600;
  const waitForCopilot = parsed.waitForCopilot ?? false;
  const claimDeadlineSec =
    parsed.claimDeadlineSec ??
    readClaimDeadline() ??
    DEFAULT_CLAIM_DEADLINE_SEC;
  const outPath = path.resolve(
    cwd,
    parsed.out ?? path.join(".flow-tmp", "ci-wait-result.json"),
  );
  const readMergeState =
    deps.readMergeState ?? (() => observeMergeState(parsed.pr, gh));

  const priorState = stateless ? null : readState(slug, stateDir);
  let record: CiWaitRecord =
    priorState?.ciWait && priorState.ciWait.pr === parsed.pr
      ? priorState.ciWait
      : freshRecord(parsed.pr, nowMs);

  let stateMissingWarned = false;
  const persistRecord = (): void => {
    if (stateless) return;
    const base = priorState ?? readState(slug, stateDir);
    if (base === null) {
      if (!stateMissingWarned) {
        stateMissingWarned = true;
        process.stderr.write(
          `flow-ci-check: FLOW_SLUG resolved to "${slug}" but no readable state file at ~/.flow/state/${slug}.json — anchors will not persist this call, so the 20-min cap and the 10-min Copilot timeout can never fire. Run 'flow-state-update' to (re)create it.\n`,
        );
      }
      return;
    }
    writeState({ ...base, ciWait: record }, stateDir);
  };

  const emit = (result: CheckResult): void => {
    const serialized = JSON.stringify(result) + "\n";
    process.stdout.write(serialized);
    if (result.status === "decided") {
      try {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, serialized);
      } catch (err) {
        process.stderr.write(
          `flow-ci-check: failed to persist verdict to ${outPath}: ${(err as Error).message}\n`,
        );
      }
    }
  };

  const ciConfigured = readWorkflowsDir();
  const copilotModuleActive = isCopilotModuleActive();
  if (!copilotModuleActive && !parsed.copilotNotRequested) {
    process.stderr.write(
      `${noticeLine("copilot")} — skipping Copilot review\n`,
    );
  }
  const requestedReviewersAtEntry =
    copilotModuleActive && !parsed.copilotNotRequested
      ? fetchRequestedReviewers(parsed.pr, gh)
      : [];
  const copilotConfigured =
    copilotModuleActive &&
    !parsed.copilotNotRequested &&
    (requestedReviewersAtEntry.some((l) => matchesCopilot(l, copilotLogin)) ||
      readHistoricalBotReview(copilotLogin));

  // One observation pass, counted regardless of outcome — a failed
  // observation is still "a check" for the per-check log line / polls
  // counter (polling-protocol.md "Per-check line").
  record.checks += 1;
  const startupElapsedSec = Math.max(
    0,
    Math.floor((nowMs - Date.parse(record.startedAt)) / 1000),
  );
  process.stderr.write(
    `CI check ${record.checks}, elapsed ${formatElapsed(startupElapsedSec)} of 20m (anchor ${record.startedAt})\n`,
  );

  const prInfo = observePr(parsed.pr, gh);
  if (!prInfo) {
    // Failed observation. Never fabricates a decision — see "The
    // transient-gh ci-hang path is removed, not preserved" (Architecture
    // Decisions). The supervisor's runbook rule is a single deterministic
    // threshold: observationFailedSec >= 1200 => NEEDS HUMAN: gh-unavailable.
    const anchorMs = Date.parse(record.lastObservedAt ?? record.startedAt);
    const observationFailedSec = Math.max(0, (nowMs - anchorMs) / 1000);
    persistRecord();
    emit({
      status: "waiting",
      nextCheckSec: FLAT_CADENCE_SEC,
      observation: "failed",
      observationFailedSec,
      polls: record.checks,
      elapsedSec: Math.floor(
        Math.max(0, (nowMs - Date.parse(record.startedAt)) / 1000),
      ),
      copilotConfigured,
      ciConfigured,
    });
    return 0;
  }

  // Cycle identity = (pr, headSha). Reset ONLY when both the persisted and
  // observed head SHA are non-empty and differ — a `gh` hiccup that
  // observes "" must never wipe anchors (pre-mortem (c), Architecture
  // Decisions).
  if (
    record.headSha !== "" &&
    prInfo.headRefOid !== "" &&
    record.headSha !== prInfo.headRefOid
  ) {
    record = freshRecord(parsed.pr, nowMs);
    record.checks = 1;
  }
  if (prInfo.headRefOid !== "") record.headSha = prInfo.headRefOid;
  record.lastObservedAt = isoOf(nowMs);

  const decided = (result: Omit<RunResult, "polls">): void => {
    persistRecord();
    emit({ status: "decided", polls: record.checks, ...result });
  };

  // Branch-conflict short-circuit. GitHub cannot build the pull_request
  // merge ref, so CI never starts — fires at poll entry, before the
  // requested_reviewers / observeChecks reads.
  let mergeState: { mergeable: string; mergeStateStatus: string } | null = null;
  if (prInfo.state === "OPEN") {
    mergeState = readMergeState();
    if (
      mergeState !== null &&
      deriveConflictState(mergeState.mergeable, mergeState.mergeStateStatus)
        .conflicting
    ) {
      process.stderr.write(
        `Branch conflict detected (mergeStateStatus=${mergeState.mergeStateStatus}) — exiting pr-conflicted\n`,
      );
      decided({
        decision: "pr-conflicted",
        elapsedSec: Math.floor(
          Math.max(0, (nowMs - Date.parse(record.startedAt)) / 1000),
        ),
        prState: prInfo.state,
        prUrl: prInfo.url,
        copilotConfigured,
        ciConfigured,
        copilotRetriggered: record.copilotRetriggered,
        copilotSkipReason: null,
      });
      return 0;
    }
  }

  // Per-invocation requested_reviewers signal, observability-only. Since
  // PR #666 split flow-ci-wait into flow-ci-check (one invocation ==
  // one poll), a second per-poll re-read inside this same invocation is
  // redundant — cross-poll freshness against GitHub auto-removing
  // Copilot after its first review comes from the NEXT process's own
  // entry-snapshot read, not from re-reading here.
  const copilotRequestedThisPoll =
    copilotConfigured &&
    requestedReviewersAtEntry.some((l) => matchesCopilot(l, copilotLogin));

  const checksList: TimedCheck[] = ciConfigured
    ? observeChecks(parsed.pr, gh)
    : [];
  const ci: CheckState = ciConfigured
    ? deriveCheckState(checksList)
    : { kind: "no-checks-reported" };

  // Terminal-anchor update — the durable, suspension-immune replacement
  // for the old in-process `ciTerminalAt = elapsedSec` carryover.
  const anchors = deriveAnchors(record, checksList, ciConfigured, nowMs);
  record = anchors.record;
  let ciTerminalAt = anchors.ciTerminalAt;
  const elapsedSec = Math.floor(anchors.elapsedSec);

  // Copilot auto-detect short-circuits (must run BEFORE the stale-review
  // retrigger so a self-dismissed signal does not POST a doomed
  // re-request). Precedence guards mirror decideOnPoll's own pr-state /
  // ci-failed precedence: a MERGED/CLOSED PR and a failed CI never reach
  // this branch.
  if (
    copilotConfigured &&
    !record.copilotRetriggered &&
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
      requestedReviewers: requestedReviewersAtEntry,
    });
    if (skipReason !== null) {
      process.stderr.write(
        `Copilot auto-detect: ${skipReason} — exiting proceed-to-review-no-bot\n`,
      );
      decided({
        decision: "proceed-to-review-no-bot",
        elapsedSec,
        prState: prInfo.state,
        prUrl: prInfo.url,
        copilotConfigured,
        ciConfigured,
        copilotRetriggered: record.copilotRetriggered,
        copilotSkipReason: skipReason,
      });
      return 0;
    }
  }

  // Stale-Copilot-review retrigger (PR #161 incident). `copilotRetriggered`
  // is persisted BEFORE acting on the POST result — a one-shot process
  // that crashed between firing the POST and writing state must never
  // re-fire it on the next invocation (pre-mortem (d), Architecture
  // Decisions).
  if (
    copilotConfigured &&
    !record.copilotRetriggered &&
    isCiTerminal(ci, ciConfigured)
  ) {
    const latestCopilotCommit = extractLatestCopilotReviewCommit(
      prInfo.reviews,
      copilotLogin,
    );
    if (isCopilotReviewStale(latestCopilotCommit, prInfo.headRefOid)) {
      if (
        readCommitsAreAllMerges(
          latestCopilotCommit as string,
          prInfo.headRefOid,
        )
      ) {
        process.stderr.write(
          "Copilot review stale — every intervening commit is a merge, skipping retrigger\n",
        );
      } else if (
        readIsSmallFollowup(latestCopilotCommit as string, prInfo.headRefOid)
      ) {
        process.stderr.write(
          "Copilot review stale — intervening commits are a small follow-up, skipping retrigger\n",
        );
      } else {
        // Snapshot the pre-retrigger anchors so a confirmed silent
        // rejection (below) can restore them — mirrors the pre-split
        // helper's documented contract: a silently-declined re-request
        // must not burn the 10-min Copilot timeout on a review that will
        // never post (PR #161 incident write-up).
        const preRetriggerCiTerminalAtIso = record.ciTerminalAt;
        const preRetriggerCiTerminalAt = ciTerminalAt;
        record.copilotRetriggered = true;
        record.copilotRetriggeredAt = isoOf(nowMs);
        record.ciTerminalAt = isoOf(nowMs);
        ciTerminalAt = elapsedSec;
        persistRecord();

        const retrigger = retriggerCopilotReview(parsed.pr, gh);
        if (!retrigger.ok) {
          process.stderr.write(
            `Copilot retrigger failed: ${retrigger.stderr.slice(0, 200)}\n`,
          );
        } else {
          const queued = fetchRequestedReviewers(parsed.pr, gh).some((l) =>
            matchesCopilot(l, copilotLogin),
          );
          if (!queued) {
            process.stderr.write(
              "NOTICE: Copilot retrigger returned ok but Copilot is not in requested_reviewers — silent rejection, not queued. Proceeding to review without bot.\n",
            );
            // Confirmed silent rejection: restore the pre-retrigger anchors
            // and leave copilotRetriggered false on the wire and in the
            // persisted record — a declined re-request never spent the
            // one-shot retrigger budget.
            record.copilotRetriggered = false;
            record.copilotRetriggeredAt = undefined;
            record.ciTerminalAt = preRetriggerCiTerminalAtIso;
            ciTerminalAt = preRetriggerCiTerminalAt;
            persistRecord();
            decided({
              decision: "proceed-to-review-no-bot",
              elapsedSec,
              prState: prInfo.state,
              prUrl: prInfo.url,
              copilotConfigured,
              ciConfigured,
              copilotRetriggered: record.copilotRetriggered,
              copilotSkipReason: null,
            });
            return 0;
          }
        }
      }
    }
  }

  const copilotPosted = record.copilotRetriggered
    ? extractLatestCopilotReviewCommit(prInfo.reviews, copilotLogin) ===
      prInfo.headRefOid
    : deriveCopilotPosted(prInfo.reviews, copilotLogin);

  if (copilotConfigured && isCiTerminal(ci, ciConfigured) && !copilotPosted) {
    process.stderr.write(
      copilotRequestedThisPoll
        ? "Copilot queued, still waiting\n"
        : "no Copilot review yet\n",
    );
  }

  const verdict = decideOnPoll({
    pollNum: record.checks,
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

  if (verdict.verdict === "loop") {
    persistRecord();
    emit({
      status: "waiting",
      nextCheckSec: FLAT_CADENCE_SEC,
      polls: record.checks,
      elapsedSec,
      copilotConfigured,
      ciConfigured,
    });
    return 0;
  }

  // Branch-protection short-circuit. CI reached terminal and the PR would
  // otherwise proceed to review, yet mergeStateStatus is still BLOCKED — a
  // protection rule outside the `gh pr checks` surface. Fires ONLY here,
  // after decideOnPoll, so the pr-state / ci-failed precedence is inherited
  // for free.
  if (
    (verdict.decision === "proceed-to-review" ||
      verdict.decision === "proceed-to-review-no-bot") &&
    mergeState !== null &&
    deriveBlockedState(mergeState.mergeable, mergeState.mergeStateStatus)
      .blocked
  ) {
    process.stderr.write(
      `Branch protection blocked (mergeStateStatus=${mergeState.mergeStateStatus}) — exiting pr-blocked\n`,
    );
    decided({
      decision: "pr-blocked",
      elapsedSec,
      prState: prInfo.state,
      prUrl: prInfo.url,
      copilotConfigured,
      ciConfigured,
      copilotRetriggered: record.copilotRetriggered,
      copilotSkipReason: null,
    });
    return 0;
  }

  decided({
    decision: verdict.decision,
    elapsedSec,
    prState: prInfo.state,
    prUrl: prInfo.url,
    ...(verdict.ciFailedChecks
      ? { ciFailedChecks: verdict.ciFailedChecks }
      : {}),
    copilotConfigured,
    ciConfigured,
    copilotRetriggered: record.copilotRetriggered,
    copilotSkipReason: null,
  });
  return 0;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
