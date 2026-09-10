#!/usr/bin/env bun
/**
 * Thin CLI entrypoint over `runReviewPrep` (`bin/lib/review-prep.ts`) —
 * `/flow-pr-review` Step 2's fetch + Step 3's Preparation items 2-6 in one
 * call instead of ~8 supervisor Bash turns.
 *
 * Usage:
 *   flow-review-prep --pr <number> --worktree <path> [--out <path>]
 *
 * Prints the computed `ReviewPrep` envelope as JSON on stdout, and also
 * writes it to `--out` (default `<worktree>/.flow-tmp/review-prep.json`).
 *
 * Exit codes:
 *   0 — a ReviewPrep envelope was computed (sub-step skips still exit 0 —
 *       see `completeness`/`critical_skips` in the envelope itself)
 *   2 — bad CLI arguments
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runReviewPrep, type ReviewPrep } from "./lib/review-prep";

function printHelp(): void {
  console.log(`
Usage: flow-review-prep --pr <number> --worktree <path> [--out <path>]

Runs the review phase's mechanical setup (fetch, commit history,
static-analysis pre-digest, review-scope resolution, intent-comment
fetch, gatekeeper tension flag) in one call and prints the resulting
JSON envelope on stdout.

Arguments:
  --pr <number>       PR number (required)
  --worktree <path>   Absolute worktree path (required)
  --out <path>        Where to also write the envelope
                       (default: <worktree>/.flow-tmp/review-prep.json)
  `);
}

export type ParsedArgs =
  | { pr: number; worktree: string; out?: string }
  | { error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  let pr: number | undefined;
  let worktree: string | undefined;
  let out: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--pr": {
        if (value === undefined) return { error: "--pr requires a value" };
        const n = Number.parseInt(value, 10);
        if (Number.isNaN(n) || n <= 0) {
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
      case "--out":
        if (value === undefined) return { error: "--out requires a value" };
        out = value;
        i++;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }

  if (pr === undefined) return { error: "--pr is required" };
  if (worktree === undefined) return { error: "--worktree is required" };
  return { pr, worktree, out };
}

// `reviewPrep` is a test-only seam (defaults to the real `runReviewPrep`) so
// tests can exercise this CLI's arg-parsing / exit-code / --out behaviour
// without spawning real gh/flow-* subprocesses.
export async function run(
  argv: string[],
  reviewPrep: (opts: {
    pr: number;
    worktree: string;
  }) => Promise<ReviewPrep> = runReviewPrep,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-review-prep: ${parsed.error}\n`);
    return 2;
  }

  const prep = await reviewPrep({ pr: parsed.pr, worktree: parsed.worktree });

  const outPath =
    parsed.out ?? path.join(parsed.worktree, ".flow-tmp", "review-prep.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(prep));

  console.log(JSON.stringify(prep));
  return 0;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
