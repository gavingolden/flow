#!/usr/bin/env bun
/**
 * Thin CLI entrypoint over `runCollect` (`bin/lib/review-collect.ts`) —
 * `/flow-pr-review`'s lens-wait, consolidator-read and fix-applier-read
 * boundaries as one bounded call each instead of hand-written poll loops
 * and re-reads.
 *
 * Usage:
 *   flow-review-collect --stage <lenses|consolidator|fix-applier>
 *     --worktree <path> [--wait-sec <n=540>]
 *
 * The 540 s default wait sits inside the Bash tool's 600 s ceiling (same
 * rationale as `flow-plan-review-wait`'s `--max-sec 540`): callers MUST pass
 * the Bash tool an explicit `timeout: 600000`, or the call is killed at the
 * 120 s default with no envelope.
 *
 * Prints the `CollectEnvelope` as JSON on stdout. The helper never writes
 * `pr-review-result.json`; it only names the escalation tag.
 *
 * Exit codes:
 *   0 — ready and valid (lenses: every expected artifact present)
 *   1 — ready but invalid, or missing with --wait-sec 0 (the agent already
 *       returned); `escalationTag` is set for consolidator/fix-applier
 *   2 — bad CLI arguments
 *   3 — not ready when the wait ended (call again)
 */

import { runCollect, type CollectStage } from "./lib/review-collect";

const STAGES: readonly string[] = ["lenses", "consolidator", "fix-applier"];

function printHelp(): void {
  console.log(`
Usage: flow-review-collect --stage <lenses|consolidator|fix-applier>
         --worktree <path> [--wait-sec <n=540>]

Waits (bounded) for the review stage's artifacts under
<worktree>/.flow-tmp/, validates them, and prints one JSON envelope.
Pass the Bash tool an explicit timeout: 600000 for the default wait.
  `);
}

export type ParsedArgs =
  | { stage: CollectStage; worktree: string; waitSec: number }
  | { error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  let stage: string | undefined;
  let worktree: string | undefined;
  let waitSec = 540;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--stage":
        if (value === undefined) return { error: "--stage requires a value" };
        if (!STAGES.includes(value)) {
          return { error: `invalid --stage value: ${value}` };
        }
        stage = value;
        i++;
        break;
      case "--worktree":
        if (value === undefined)
          return { error: "--worktree requires a value" };
        worktree = value;
        i++;
        break;
      case "--wait-sec": {
        if (value === undefined)
          return { error: "--wait-sec requires a value" };
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) {
          return { error: `invalid --wait-sec value: ${value}` };
        }
        waitSec = n;
        i++;
        break;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }

  if (stage === undefined) return { error: "--stage is required" };
  if (worktree === undefined) return { error: "--worktree is required" };
  return { stage: stage as CollectStage, worktree, waitSec };
}

export async function run(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-review-collect: ${parsed.error}\n`);
    return 2;
  }
  const { envelope, exitCode } = await runCollect(parsed);
  console.log(JSON.stringify(envelope));
  return exitCode;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
