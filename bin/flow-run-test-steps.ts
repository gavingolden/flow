#!/usr/bin/env bun
/**
 * Thin CLI entrypoint over `runTestSteps` (`bin/lib/run-test-steps.ts`) —
 * `/flow-pr-review` Step 8c's per-item execute/tick/evidence loop in one
 * call instead of ~3 supervisor Bash turns per Test Step.
 *
 * Usage:
 *   flow-run-test-steps --pr <number> --worktree <path> [--only <csv>]
 *     [--budget-sec <n=540>]
 *
 * The 540 s default budget sits inside the Bash tool's 600 s ceiling (same
 * rationale as `flow-plan-review-wait`'s `--max-sec 540`; each item's
 * timeout is clamped to the remaining budget): callers MUST pass the Bash
 * tool an explicit `timeout: 600000`, or the call is killed at the 120 s
 * default with no envelope.
 *
 * Prints the `RunEnvelope` as JSON on stdout. `--only <csv>` re-runs the
 * listed 1-based Test Step indices (after fixing a failure, or for the
 * `pending` items an exhausted budget left behind).
 *
 * Exit codes:
 *   0 — an envelope was computed (failing items are data, not an error)
 *   1 — `gh` read/write failure
 *   2 — bad CLI arguments
 */

import { defaultExec, runTestSteps } from "./lib/run-test-steps";

function printHelp(): void {
  console.log(`
Usage: flow-run-test-steps --pr <number> --worktree <path>
         [--only <csv>] [--budget-sec <n=540>]

Runs every unchecked command-kind Test Step in the PR body, ticks passes,
attaches evidence, repairs and pushes the body once, and prints a JSON
envelope. Pass the Bash tool an explicit timeout: 600000.
  `);
}

export type ParsedArgs =
  | { pr: number; worktree: string; only?: number[]; budgetSec: number }
  | { error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  let pr: number | undefined;
  let worktree: string | undefined;
  let only: number[] | undefined;
  let budgetSec = 540;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--pr": {
        if (value === undefined) return { error: "--pr requires a value" };
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          return { error: `invalid --pr value: ${value}` };
        }
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
      case "--only": {
        if (value === undefined) return { error: "--only requires a value" };
        const nums = value.split(",").map((p) => Number(p.trim()));
        if (nums.some((n) => !Number.isInteger(n) || n <= 0)) {
          return { error: `invalid --only value: ${value}` };
        }
        only = nums;
        i++;
        break;
      }
      case "--budget-sec": {
        if (value === undefined)
          return { error: "--budget-sec requires a value" };
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          return { error: `invalid --budget-sec value: ${value}` };
        }
        budgetSec = n;
        i++;
        break;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }

  if (pr === undefined) return { error: "--pr is required" };
  if (worktree === undefined) return { error: "--worktree is required" };
  return { pr, worktree, only, budgetSec };
}

export async function run(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-run-test-steps: ${parsed.error}\n`);
    return 2;
  }
  try {
    const envelope = await runTestSteps({ ...parsed, exec: defaultExec });
    console.log(JSON.stringify(envelope));
    return 0;
  } catch (e) {
    process.stderr.write(
      `flow-run-test-steps: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
