#!/usr/bin/env bun
/**
 * Lint one PR body's `## Test Steps` checklist.
 *
 * Usage:
 *   flow-test-steps-lint --body-file <path> [--phase authoring|review]
 *
 * Prints `{ headingPresent, steps, findings }` as JSON on stdout. Findings
 * are advisory input to the caller's auto-fix — a non-empty list is still
 * exit 0.
 *
 * Exit codes:
 *   0 — result computed
 *   2 — bad CLI args or unreadable body file
 */
import { readFileSync } from "node:fs";
import { lintTestSteps, parseTestSteps } from "./lib/test-steps-parse";

export type LintArgs = { bodyFile: string; phase: "authoring" | "review" };

const USAGE =
  "usage: flow-test-steps-lint --body-file <path> [--phase authoring|review]\n";

export function parseArgs(argv: string[]): LintArgs | { error: string } {
  let bodyFile: string | undefined;
  let phase: LintArgs["phase"] = "authoring";
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag !== "--body-file" && flag !== "--phase")
      return { error: `unknown flag: ${flag}` };
    if (val === undefined || val.startsWith("--"))
      return { error: `${flag} requires a value` };
    if (flag === "--body-file") bodyFile = val;
    else if (val === "authoring" || val === "review") phase = val;
    else return { error: `--phase must be authoring or review, got '${val}'` };
  }
  if (!bodyFile) return { error: "--body-file is required" };
  return { bodyFile, phase };
}

export function run(argv: string[]): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-test-steps-lint: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  let body: string;
  try {
    body = readFileSync(parsed.bodyFile, "utf8");
  } catch {
    process.stderr.write(
      `flow-test-steps-lint: cannot read ${parsed.bodyFile}\n${USAGE}`,
    );
    return 2;
  }
  const { headingPresent, steps } = parseTestSteps(body);
  const findings = lintTestSteps(steps, parsed.phase);
  process.stdout.write(
    JSON.stringify({ headingPresent, phase: parsed.phase, steps, findings }) +
      "\n",
  );
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
