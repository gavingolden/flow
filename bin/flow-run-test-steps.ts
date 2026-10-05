#!/usr/bin/env bun
/**
 * Run every command-shaped `## Test Steps` item of a PR body in one call.
 *
 * Usage:
 *   flow-run-test-steps --body-file <path> [--worktree <path>] [--pr <n>]
 *     [--timeout-sec <n>] [--budget-sec <n>] [--only <line,...>]
 *
 * Runs each unchecked command item in a clean bash (FLOW_SLUG and TMUX_PANE
 * stripped), ticks the exit-0 ones, attaches a `flow:evidence` block to every
 * executed one, and rewrites --body-file once. `--pr` first fetches a fresh
 * body with `gh pr view` into --body-file. Prints the RunTestStepsResult JSON
 * on stdout; line numbers are post-rewrite, so `--only <line>` re-runs the
 * right item.
 *
 * Exit codes:
 *   0 — summary computed (failing items included)
 *   2 — bad CLI args, unreadable body file, or a failed gh fetch
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { runTestSteps } from "./lib/run-test-steps";

export type RunArgs = {
  bodyFile: string;
  worktree: string;
  pr?: number;
  timeoutSec: number;
  budgetSec: number;
  only?: number[];
};

const USAGE =
  "usage: flow-run-test-steps --body-file <path> [--worktree <path>] [--pr <n>] [--timeout-sec <n>] [--budget-sec <n>] [--only <line,...>]\n";
const FLAGS = new Set([
  "--body-file",
  "--worktree",
  "--pr",
  "--timeout-sec",
  "--budget-sec",
  "--only",
]);

function positiveInt(flag: string, raw: string): number | { error: string } {
  if (!/^\d+$/.test(raw) || Number(raw) < 1)
    return { error: `${flag} must be a positive integer, got '${raw}'` };
  return Number(raw);
}

export function parseArgs(argv: string[]): RunArgs | { error: string } {
  const out: RunArgs = {
    bodyFile: "",
    worktree: process.cwd(),
    timeoutSec: 240,
    budgetSec: 540,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (!FLAGS.has(flag)) return { error: `unknown flag: ${flag}` };
    if (val === undefined || val.startsWith("--"))
      return { error: `${flag} requires a value` };
    if (flag === "--body-file") out.bodyFile = val;
    else if (flag === "--worktree") out.worktree = val;
    else if (flag === "--only") {
      const lines: number[] = [];
      for (const part of val.split(",")) {
        const n = positiveInt(flag, part.trim());
        if (typeof n !== "number") return n;
        lines.push(n);
      }
      out.only = lines;
    } else {
      const n = positiveInt(flag, val);
      if (typeof n !== "number") return n;
      if (flag === "--pr") out.pr = n;
      else if (flag === "--timeout-sec") out.timeoutSec = n;
      else out.budgetSec = n;
    }
  }
  if (!out.bodyFile) return { error: "--body-file is required" };
  return out;
}

function fetchBody(pr: number, cwd: string): string | { error: string } {
  const r = spawnSync("gh", ["pr", "view", String(pr), "--json", "body"], {
    cwd,
    encoding: "utf8",
  });
  if (r.error || r.status !== 0)
    return {
      error: `gh pr view ${pr} failed: ${(r.error?.message ?? r.stderr ?? "").trim()}`,
    };
  try {
    const body = (JSON.parse(r.stdout) as { body?: unknown }).body;
    if (typeof body === "string") return body;
  } catch {
    // fall through to the shared error below
  }
  return { error: `gh pr view ${pr} returned no body` };
}

export function run(argv: string[]): number {
  const fail = (msg: string): number => {
    process.stderr.write(`flow-run-test-steps: ${msg}\n${USAGE}`);
    return 2;
  };
  const parsed = parseArgs(argv);
  if ("error" in parsed) return fail(parsed.error);
  if (parsed.pr !== undefined) {
    const body = fetchBody(parsed.pr, parsed.worktree);
    if (typeof body !== "string") return fail(body.error);
    writeFileSync(parsed.bodyFile, body);
  }
  try {
    readFileSync(parsed.bodyFile, "utf8");
  } catch {
    return fail(`cannot read ${parsed.bodyFile}`);
  }
  const result = runTestSteps({
    bodyFile: parsed.bodyFile,
    worktree: parsed.worktree,
    timeoutSec: parsed.timeoutSec,
    budgetSec: parsed.budgetSec,
    only: parsed.only,
  });
  process.stdout.write(JSON.stringify(result) + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
