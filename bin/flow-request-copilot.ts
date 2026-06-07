#!/usr/bin/env bun
/**
 * Decides whether a flow-opened PR warrants a Copilot review and, when the
 * answer is yes, fires the `requested_reviewers` POST.
 *
 * Two modes:
 *   --classify          read newline-delimited changed paths from stdin,
 *                       read glob sets from ~/.flow/config.json, print the
 *                       glob class ('always-review' | 'never-alone' |
 *                       'ambiguous') to stdout. No GitHub contact.
 *   --pr <n> [...]      resolve the request decision (override × glob class
 *                       × inline judgment) and, on "request", POST Copilot
 *                       to requested_reviewers + verify it queued.
 *
 * The pure cores live in `./lib/copilot-classify` (no fs/gh) and are
 * re-exported here. The request path uses an injectable GhRunner.
 * Fail-open: every uncertainty resolves to REQUESTING.
 */

import {
  matchesCopilot,
  readCopilotConfig,
  readCopilotSkipWait,
  type ReadConfigFile,
} from "./lib/copilot-config";
import {
  classifyByGlobs,
  isNotRequestableCollaborator422,
  resolveRequestDecision,
  type AgentDecision,
  type GlobClass,
  type ReviewOverride,
} from "./lib/copilot-classify";
import {
  retriggerCopilotReview,
  fetchRequestedReviewers,
  fetchHistoricalBotReview,
  type GhRunner,
} from "./flow-ci-wait";

export { classifyByGlobs, resolveRequestDecision };
export type { AgentDecision, GlobClass, ReviewOverride };

const defaultGh: GhRunner = (argv) => {
  const r = Bun.spawnSync(["gh", ...argv]);
  return {
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
    exitCode: r.exitCode,
  };
};

type Verdict = {
  requestCopilot: boolean;
  globClass: GlobClass;
  reason: string;
  posted?: boolean;
  queued?: boolean;
  /** False when the POST 422'd with the benign not-requestable-collaborator body. */
  copilotRequestable?: boolean;
  /** Set when the POST was skipped (auto-review already on) — distinct from the 422. */
  requestSkipReason?: string;
  /** When requestCopilot is false, names WHY the request was declined so callers can distinguish the two decline kinds structurally instead of string-sniffing `reason`. "skip-wait" = the bots.copilotSkipWait budget toggle; "skip-request" = an explicit per-PR decline (--override never) or a glob class that doesn't warrant a request. Both collapse the bot wait via the supervisor's --copilot-not-requested path. */
  declineKind?: "skip-wait" | "skip-request";
};

function parseArgs(argv: string[]):
  | { mode: "classify" }
  | { mode: "request"; pr: number; override?: ReviewOverride; decision?: AgentDecision }
  | { mode: "help" }
  | { error: string } {
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  if (argv.includes("--classify")) return { mode: "classify" };
  let pr: number | undefined;
  let override: ReviewOverride | undefined;
  let decision: AgentDecision | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--pr":
        if (!value || value.startsWith("--")) return { error: "--pr requires a value" };
        pr = Number.parseInt(value, 10);
        if (!Number.isFinite(pr) || pr <= 0) return { error: `--pr must be a positive integer, got '${value}'` };
        i++;
        continue;
      case "--override":
        if (value !== "auto" && value !== "always" && value !== "never")
          return { error: "--override must be one of: auto, always, never" };
        override = value;
        i++;
        continue;
      case "--decision":
        if (value !== "trivial" && value !== "non-trivial")
          return { error: "--decision must be one of: trivial, non-trivial" };
        decision = value;
        i++;
        continue;
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  if (pr === undefined) return { error: "--pr <n> is required (or pass --classify)" };
  return { mode: "request", pr, override, decision };
}

const USAGE =
  "usage: flow-request-copilot --classify  (paths on stdin)\n" +
  "       flow-request-copilot --pr <n> [--override auto|always|never] [--decision trivial|non-trivial]";

async function readStdinPaths(): Promise<string[]> {
  const text = await Bun.stdin.text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Fires the request (`gh pr edit --add-reviewer @copilot`) + verifies Copilot
 * queued. `matchLogin` is the configured login used to recognise the queued
 * reviewer — GitHub renders the queued Copilot as `Copilot` in
 * `requested_reviewers`, so `matchesCopilot` (not exact equality) is the
 * right test. A request failure whose body matches "may only be requested
 * from collaborators" degrades quietly (copilotRequestable:false, info
 * stderr, no NOTICE) as a defensive fallback; every OTHER non-zero exit
 * (403/network) keeps the loud fail-open NOTICE.
 */
function postAndVerify(
  pr: number,
  matchLogin: string,
  gh: GhRunner,
): { posted: boolean; queued: boolean; copilotRequestable?: boolean } {
  const post = retriggerCopilotReview(pr, gh);
  if (!post.ok) {
    if (isNotRequestableCollaborator422(post.stderr)) {
      process.stderr.write(
        "info: Copilot is not a requestable reviewer on this repo; skipping the bot wait\n",
      );
      return { posted: false, queued: false, copilotRequestable: false };
    }
    // Fail-open: a request error must not silently suppress the review.
    process.stderr.write(`NOTICE: Copilot request failed: ${post.stderr.slice(0, 200)}\n`);
    return { posted: false, queued: false };
  }
  const queued = fetchRequestedReviewers(pr, gh).some((l) => matchesCopilot(l, matchLogin));
  if (!queued) {
    process.stderr.write(
      `NOTICE: Copilot request returned ok but Copilot is not in requested_reviewers — silent rejection, not queued.\n`,
    );
  }
  return { posted: true, queued };
}

export async function run(
  argv: string[],
  deps: { gh?: GhRunner; readConfig?: ReadConfigFile; stdinPaths?: () => Promise<string[]> } = {},
): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-request-copilot: ${parsed.error}\n${USAGE}\n`);
    return 2;
  }
  if (parsed.mode === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const cfg = readCopilotConfig(deps.readConfig);
  const stdinPaths = deps.stdinPaths ?? readStdinPaths;

  if (parsed.mode === "classify") {
    process.stdout.write(`${classifyByGlobs(await stdinPaths(), cfg.globs)}\n`);
    return 0;
  }

  // Request mode: recompute the glob class from the same diff (paths on
  // stdin) so the helper owns the decision end-to-end.
  const globClass = classifyByGlobs(await stdinPaths(), cfg.globs);
  // Budget short-circuit (highest precedence — overrides override=always):
  // when `bots.copilotSkipWait` is set, the user's Copilot budget is spent,
  // so decline the request entirely. requestCopilot=false rides the existing
  // decline channel (supervisor appends --copilot-not-requested), collapsing
  // the bot wait so the pipeline doesn't block on a review that won't come.
  const skipWaitBudget = readCopilotSkipWait(deps.readConfig);
  const requestCopilot = skipWaitBudget
    ? false
    : resolveRequestDecision({
        override: parsed.override,
        globClass,
        agentDecision: parsed.decision,
      });
  const verdict: Verdict = {
    requestCopilot,
    globClass,
    reason: skipWaitBudget
      ? `copilot-skip-wait (budget) globClass=${globClass}`
      : `override=${parsed.override ?? "auto"} globClass=${globClass} decision=${parsed.decision ?? "none"}`,
  };
  if (!requestCopilot) {
    verdict.declineKind = skipWaitBudget ? "skip-wait" : "skip-request";
  }
  if (requestCopilot) {
    const gh = deps.gh ?? defaultGh;
    const forced = parsed.override === "always";
    // Story 3: detect repos where automatic Copilot review is already on —
    // the in-flight PR has no explicit reviewRequest yet recent merged PRs
    // carry a Copilot review. Firing a redundant requested_reviewers POST
    // there is noise, so skip it and let the bot review post on its own.
    // A forced request (`--override always`, `forced`) bypasses this
    // short-circuit entirely (#260): the user explicitly asked for the POST,
    // so it always fires.
    const alreadyRequested = !forced && fetchRequestedReviewers(parsed.pr, gh).length > 0;
    if (!forced && !alreadyRequested && fetchHistoricalBotReview(cfg.login, gh)) {
      verdict.posted = false;
      verdict.requestSkipReason = "auto-review-already-enabled";
      // #260 Story 3: the suppression was previously invisible (only in the
      // JSON verdict). Surface it so a silent skip is auditable in the log.
      process.stderr.write(
        "NOTICE: skipping Copilot request — auto-review already enabled (recent merged PRs carry Copilot reviews); pass --override always to force the request.\n",
      );
    } else {
      const { posted, queued, copilotRequestable } = postAndVerify(parsed.pr, cfg.login, gh);
      verdict.posted = posted;
      verdict.queued = queued;
      if (copilotRequestable === false) verdict.copilotRequestable = false;
    }
  }
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  return 0;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
