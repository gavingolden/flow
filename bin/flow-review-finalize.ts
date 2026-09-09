#!/usr/bin/env bun
/**
 * Thin CLI entrypoint over `runReviewFinalize` (`bin/lib/review-finalize.ts`)
 * — `/flow-pr-review`'s Step 11e body write + Step 12 telemetry + Step 13
 * result-artifact/marker/untracked-seed wrap-up in one call.
 *
 * Usage:
 *   flow-review-finalize --pr <number> --worktree <path> --body-file <path>
 *     --status <clean|partial|escalated>
 *     [--ran <n> --total <n> --prose-promoted <n>]
 *     [--lens-model <lens>=<alias> ...] [--lens-tokens <lens>=<n> ...]
 *     [--widened <reason>] [--session-id <id>]
 *     [--summary <text>] [--completed-steps <csv>] [--missed-steps <csv>]
 *     [--escalation-tag <tag>]
 *
 * Prints the computed `ReviewFinalize` envelope as JSON on stdout.
 *
 * Exit codes:
 *   0 — a ReviewFinalize envelope was computed (sub-step skips still exit
 *       0 — see `skips[]` in the envelope itself)
 *   2 — bad CLI arguments
 */

import { runReviewFinalize, type ReviewFinalize } from "./lib/review-finalize";

function printHelp(): void {
  console.log(`
Usage: flow-review-finalize --pr <number> --worktree <path> --body-file <path> --status <clean|partial|escalated> [options]

Runs the review phase's mechanical wrap-up (PR body upsert, telemetry
collection, result-artifact write, pr-review-last-sha marker, untracked
follow-up seeding) in one call and prints the resulting JSON envelope on
stdout.

Arguments:
  --pr <number>            PR number (required)
  --worktree <path>        Absolute worktree path (required)
  --body-file <path>       PR body file to upsert (required)
  --status <s>             clean | partial | escalated (required)
  --ran <n>                Test-steps ran count (optional)
  --total <n>               Test-steps total count (optional)
  --prose-promoted <n>     Prose-promoted count (optional)
  --lens-model <l>=<a>     Repeatable lens->model-alias pair
  --lens-tokens <l>=<n>    Repeatable lens->token-count pair (forwarded to
                           flow-review-telemetry collect)
  --widened <reason>       Forwarded to flow-review-telemetry collect
  --session-id <id>        Claude session id for telemetry
  --summary <text>         Result-artifact summary (default: generated)
  --completed-steps <csv>  Comma-separated step labels
  --missed-steps <csv>     Comma-separated step labels
  --escalation-tag <tag>   Escalation tag string
  `);
}

export type ParsedArgs =
  | {
      pr: number;
      worktree: string;
      bodyFile: string;
      status: "clean" | "partial" | "escalated";
      ran?: number;
      total?: number;
      prosePromoted?: number;
      reasons?: string[];
      lensModels: string[];
      lensTokens: string[];
      widened?: string;
      sessionId?: string;
      summary?: string;
      completedSteps?: string[];
      missedSteps?: string[];
      escalationTag?: string;
    }
  | { error: string };

const VALID_STATUSES = new Set(["clean", "partial", "escalated"]);

export function parseArgs(argv: string[]): ParsedArgs {
  let pr: number | undefined;
  let worktree: string | undefined;
  let bodyFile: string | undefined;
  let status: "clean" | "partial" | "escalated" | undefined;
  let ran: number | undefined;
  let total: number | undefined;
  let prosePromoted: number | undefined;
  const reasons: string[] = [];
  const lensModels: string[] = [];
  const lensTokens: string[] = [];
  let widened: string | undefined;
  let sessionId: string | undefined;
  let summary: string | undefined;
  let completedSteps: string[] | undefined;
  let missedSteps: string[] | undefined;
  let escalationTag: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--pr": {
        if (value === undefined) return { error: "--pr requires a value" };
        const n = Number.parseInt(value, 10);
        if (Number.isNaN(n) || n <= 0)
          return { error: `invalid --pr value: ${value}` };
        pr = n;
        i++;
        break;
      }
      case "--worktree":
        if (value === undefined)
          return { error: "--worktree requires a value" };
        worktree = value;
        i++;
        break;
      case "--body-file":
        if (value === undefined)
          return { error: "--body-file requires a value" };
        bodyFile = value;
        i++;
        break;
      case "--status":
        if (value === undefined || !VALID_STATUSES.has(value)) {
          return { error: `invalid --status value: ${value}` };
        }
        status = value as "clean" | "partial" | "escalated";
        i++;
        break;
      case "--ran":
        if (value === undefined) return { error: "--ran requires a value" };
        ran = Number.parseInt(value, 10);
        i++;
        break;
      case "--total":
        if (value === undefined) return { error: "--total requires a value" };
        total = Number.parseInt(value, 10);
        i++;
        break;
      case "--prose-promoted":
        if (value === undefined)
          return { error: "--prose-promoted requires a value" };
        prosePromoted = Number.parseInt(value, 10);
        i++;
        break;
      case "--reason":
        if (value === undefined) return { error: "--reason requires a value" };
        reasons.push(value);
        i++;
        break;
      case "--lens-model":
        if (value === undefined)
          return { error: "--lens-model requires a value" };
        lensModels.push(value);
        i++;
        break;
      case "--lens-tokens":
        if (value === undefined)
          return { error: "--lens-tokens requires a value" };
        lensTokens.push(value);
        i++;
        break;
      case "--widened":
        if (value === undefined) return { error: "--widened requires a value" };
        widened = value;
        i++;
        break;
      case "--session-id":
        if (value === undefined)
          return { error: "--session-id requires a value" };
        sessionId = value;
        i++;
        break;
      case "--summary":
        if (value === undefined) return { error: "--summary requires a value" };
        summary = value;
        i++;
        break;
      case "--completed-steps":
        if (value === undefined)
          return { error: "--completed-steps requires a value" };
        completedSteps = value.split(",").filter(Boolean);
        i++;
        break;
      case "--missed-steps":
        if (value === undefined)
          return { error: "--missed-steps requires a value" };
        missedSteps = value.split(",").filter(Boolean);
        i++;
        break;
      case "--escalation-tag":
        if (value === undefined)
          return { error: "--escalation-tag requires a value" };
        escalationTag = value;
        i++;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }

  if (pr === undefined) return { error: "--pr is required" };
  if (worktree === undefined) return { error: "--worktree is required" };
  if (bodyFile === undefined) return { error: "--body-file is required" };
  if (status === undefined) return { error: "--status is required" };
  return {
    pr,
    worktree,
    bodyFile,
    status,
    ran,
    total,
    prosePromoted,
    reasons,
    lensModels,
    lensTokens,
    widened,
    sessionId,
    summary,
    completedSteps,
    missedSteps,
    escalationTag,
  };
}

// `reviewFinalize` is a test-only seam (defaults to the real
// `runReviewFinalize`) so tests can exercise this CLI's arg-parsing /
// exit-code behaviour without spawning real gh/flow-* subprocesses.
export async function run(
  argv: string[],
  reviewFinalize: (
    opts: Exclude<ParsedArgs, { error: string }>,
  ) => Promise<ReviewFinalize> = runReviewFinalize,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-review-finalize: ${parsed.error}\n`);
    return 2;
  }

  const result = await reviewFinalize(parsed);
  console.log(JSON.stringify(result));
  return 0;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
