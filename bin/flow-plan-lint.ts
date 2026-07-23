#!/usr/bin/env bun
/**
 * Advisory plan-shape linter: checks a generated plan.md instance for the
 * always-present sections the plan-artifact contract requires — the Goal
 * line, Behavioral contrast (+ its Lost affirmation), Recommendation, Plan
 * risks, the Task breakdown heading, and a Contract block under every task.
 * Also cross-checks the machine-readable closed-path mirror
 * (excluded-paths.json) against the plan's `## Alternatives considered`
 * prose. Run by discovery itself as a self-check before returning
 * (discovery-instructions.md `# Verification`) AND by the `/flow-pipeline`
 * supervisor as a step-3 advisory backstop, next to
 * `flow-candidate-issues --lint`.
 *
 * Advisory by design: this NEVER blocks planning. A miss is named, never
 * enforced — the caller decides whether to surface it in chat and move on.
 *
 * Usage:
 *   flow-plan-lint --plan-md-file <path>
 *
 * Output (stdout): one named miss per line; nothing on a conforming plan.
 *
 * Exit codes:
 *   0 — conforming plan (no misses).
 *   1 — one or more named misses (printed to stdout, one per line).
 *   2 — bad CLI args, or the file could not be read.
 *
 * Never throws on malformed markdown or malformed excluded-paths.json — a
 * parse failure is reported as a named miss, not an uncaught exception.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { extractRecommendedPath } from "./flow-step3-route";

export type LintResult = { misses: string[] };

type ExcludedPathsFile = {
  version?: number;
  excluded?: Array<{ id?: string; path?: string; reason?: string }>;
};

/** Slice `text` from `startIdx` up to (but not including) the next top-level
 * (`# `) or second-level (`## `) heading — whichever comes first. Bounds a
 * section body without assuming a specific closing heading. */
function sliceToNextHeading(text: string, startIdx: number): string {
  const rest = text.slice(startIdx);
  const next = rest.search(/^#{1,2} /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * The `# PRD` top-level section wraps the whole structured PRD, which
 * itself opens with a nested `# [Feature Name]` heading (per
 * discovery-instructions.md step 8) — so bounding "the PRD section" by
 * "the next `# ` heading" would false-negative on that nested title. Bound
 * instead by the next KNOWN sibling top-level section
 * (`# Candidate follow-up issues` / `# Task breakdown` /
 * `# PR description draft`), or end-of-file when none is present.
 */
function findPrdSectionEnd(planText: string, startIdx: number): number {
  const rest = planText.slice(startIdx);
  const siblingRe =
    /^# (?:Candidate follow-up issues|Task breakdown|PR description draft)\s*$/m;
  const m = rest.match(siblingRe);
  return m ? startIdx + (m.index ?? rest.length) : planText.length;
}

function checkGoalLine(planText: string, misses: string[]): void {
  const prdMatch = planText.match(/^# PRD\s*$/m);
  if (!prdMatch) {
    misses.push("missing '# PRD' heading — cannot locate the Goal line");
    return;
  }
  const afterPrd = (prdMatch.index ?? 0) + prdMatch[0].length;
  const sectionEnd = findPrdSectionEnd(planText, afterPrd);
  const prdBody = planText.slice(afterPrd, sectionEnd);

  const goalMatch = prdBody.match(/^\*\*Goal:\*\*\s*(.*)$/m);
  if (!goalMatch) {
    misses.push(
      "missing '**Goal:**' line inside the '# PRD' section — every plan must open with a one-line outcome-phrased Goal",
    );
    return;
  }
  const words = goalMatch[1].trim().split(/\s+/).filter(Boolean);
  if (words.length > 30) {
    misses.push(
      `warn: Goal line is ${words.length} words (advisory bound: <=30) — check for ceremony inflation`,
    );
  }
}

function checkHeadingPresent(
  planText: string,
  heading: string,
  misses: string[],
  description: string,
): void {
  const re = new RegExp(`^${escapeRegExp(heading)}\\s*$`, "m");
  if (!re.test(planText)) {
    misses.push(`missing '${heading}' heading — ${description}`);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function checkBehavioralContrast(planText: string, misses: string[]): void {
  const match = planText.match(/^## Behavioral contrast\s*$/m);
  if (!match) {
    misses.push(
      "missing '## Behavioral contrast' heading — every plan must show the before -> after delta",
    );
    return;
  }
  const body = sliceToNextHeading(
    planText,
    (match.index ?? 0) + match[0].length,
  );
  if (!/\*\*Lost:\*\*/.test(body)) {
    misses.push(
      "'## Behavioral contrast' is missing its closing '**Lost:**' affirmation line",
    );
  }
}

function checkRedundancyLine(planText: string, misses: string[]): void {
  const match = planText.match(/^## Recommendation\s*$/m);
  if (!match) {
    // Absent heading is already reported by the sibling checkHeadingPresent
    // call in lintPlan; don't double-report here.
    return;
  }
  const body = sliceToNextHeading(
    planText,
    (match.index ?? 0) + match[0].length,
  );
  if (!/\*\*Redundancy:\*\*/.test(body)) {
    misses.push(
      "'## Recommendation' is missing its required '**Redundancy:**' affirmation line",
    );
  }
}

/**
 * Slice a task body's `- **Contract:**` block — from the label line up to
 * (but not including) the next top-level (unindented) `- **` bullet, or
 * end of body when none follows. Returns null when the body has no
 * `- **Contract:**` line.
 */
function sliceContractBlock(body: string): string | null {
  const contractMatch = body.match(/^- \*\*Contract:\*\*.*$/m);
  if (!contractMatch) return null;
  const start = (contractMatch.index ?? 0) + contractMatch[0].length;
  const rest = body.slice(start);
  const nextTopLevel = rest.search(/^- \*\*/m);
  return nextTopLevel === -1 ? rest : rest.slice(0, nextTopLevel);
}

function checkTaskContracts(planText: string, misses: string[]): void {
  if (!/^# Task breakdown\s*$/m.test(planText)) {
    misses.push(
      "missing '# Task breakdown' heading — the task breakdown is a required top-level section",
    );
  }

  const taskHeadingRe = /^### Task \d+:[^\n]*$/gm;
  const headers: Array<{ index: number; text: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = taskHeadingRe.exec(planText)) !== null) {
    headers.push({ index: m.index, text: m[0] });
  }
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index + headers[i].text.length;
    const end = i + 1 < headers.length ? headers[i + 1].index : planText.length;
    const body = planText.slice(start, end);
    const taskName = headers[i].text.trim();
    if (!body.includes("- **Contract:**")) {
      misses.push(`'${taskName}' is missing its '- **Contract:**' block`);
    } else {
      const contractBody = sliceContractBlock(body) ?? "";
      const subBulletRe = /^\s+- \*\*(.+?):\*\*/gm;
      const subBullets: string[] = [];
      let sm: RegExpExecArray | null;
      while ((sm = subBulletRe.exec(contractBody)) !== null) {
        subBullets.push(sm[1].trim());
      }
      if (!subBullets.includes("Files")) {
        misses.push(
          `'${taskName}' Contract block is missing its '- **Files:**' sub-bullet`,
        );
      }
      if (subBullets.length < 2) {
        misses.push(
          `'${taskName}' Contract block has no surgical sub-bullet beyond Files (Interfaces / Call-site edits or a change-type surgical form; see discovery-instructions.md step 6)`,
        );
      }
    }

    const acceptanceMatch = body.match(/^- \*\*Acceptance criteria:\*\*.*$/m);
    if (acceptanceMatch && !acceptanceMatch[0].includes("`")) {
      misses.push(
        `warn: '${taskName}' acceptance criteria has no backtick-quoted runnable command`,
      );
    }
  }
}

/**
 * Advisory check for the `# Candidate follow-up issues` section's ranking
 * table (see discovery-instructions.md "Candidate follow-up issues
 * (optional)"). Never fires when the section is absent or has zero
 * checkbox items — only a populated section is expected to carry a table.
 */
function checkCandidateTable(planText: string, misses: string[]): void {
  const headingMatch = planText.match(/^# Candidate follow-up issues\s*$/m);
  if (!headingMatch) return;

  const start = (headingMatch.index ?? 0) + headingMatch[0].length;
  const body = sliceToNextHeading(planText, start);

  if (!/^- \[[ xX]\] /m.test(body)) return; // empty section — nothing to lint

  const tableRowRe = /^\|.*\|\s*$/m;
  if (!tableRowRe.test(body)) {
    misses.push(
      "'# Candidate follow-up issues' is missing candidate ranking table",
    );
    return;
  }

  const headerLine = body.match(tableRowRe)?.[0] ?? "";
  if (!/Relation to current request/.test(headerLine)) {
    misses.push(
      "'# Candidate follow-up issues' candidate ranking table missing 'Relation to current request' column",
    );
  }
}

function checkPromptInterpretation(planText: string, misses: string[]): void {
  if (!/^## Prompt interpretation\s*$/m.test(planText)) return;
  const recommendedPath = extractRecommendedPath(planText);
  if (recommendedPath === null) {
    misses.push(
      "'## Prompt interpretation' is present but has no parseable one-line '- **Recommended path:** <enum>' form",
    );
  }
}

/** Extract the `- **<alternative>** — rejected: <why>` bullet names from
 * `## Alternatives considered`. Returns null when the heading is absent. */
function extractAlternativesNames(planText: string): string[] | null {
  const match = planText.match(/^## Alternatives considered\s*$/m);
  if (!match) return null;
  const body = sliceToNextHeading(
    planText,
    (match.index ?? 0) + match[0].length,
  );
  const names: string[] = [];
  const bulletRe = /^-\s+\*\*(.+?)\*\*\s+—\s+rejected:/gm;
  let bm: RegExpExecArray | null;
  while ((bm = bulletRe.exec(body)) !== null) {
    names.push(bm[1].trim());
  }
  return names;
}

function checkExcludedPathsMirror(
  planText: string,
  excludedPathsJson: string | undefined,
  misses: string[],
): void {
  const proseNames = extractAlternativesNames(planText);
  const proseNonEmpty = proseNames !== null && proseNames.length > 0;

  if (!proseNonEmpty && excludedPathsJson === undefined) {
    // Absent file + absent/empty section is clean — nothing to cross-check.
    return;
  }

  if (excludedPathsJson === undefined) {
    misses.push(
      `'.flow-tmp/excluded-paths.json' is missing while '## Alternatives considered' has ${proseNames?.length ?? 0} entries`,
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(excludedPathsJson);
  } catch {
    misses.push("'.flow-tmp/excluded-paths.json' is not valid JSON");
    return;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    ("excluded" in parsed &&
      !Array.isArray((parsed as ExcludedPathsFile).excluded))
  ) {
    misses.push(
      "'.flow-tmp/excluded-paths.json' is not the expected shape — expected an object with an 'excluded' array",
    );
    return;
  }

  const jsonPaths = ((parsed as ExcludedPathsFile).excluded ?? [])
    .map((e) => (typeof e.path === "string" ? e.path.trim() : ""))
    .filter(Boolean);

  if (!proseNonEmpty) {
    if (jsonPaths.length > 0) {
      misses.push(
        "'.flow-tmp/excluded-paths.json' has entries but '## Alternatives considered' is empty or absent",
      );
    }
    return;
  }

  const prose = proseNames ?? [];
  for (const name of prose) {
    if (!jsonPaths.some((p) => p === name)) {
      misses.push(
        `'## Alternatives considered' bullet '${name}' has no matching entry in '.flow-tmp/excluded-paths.json'`,
      );
    }
  }
  for (const p of jsonPaths) {
    if (!prose.some((name) => name === p)) {
      misses.push(
        `'.flow-tmp/excluded-paths.json' entry '${p}' has no matching '## Alternatives considered' bullet`,
      );
    }
  }
}

/**
 * Pure: lint a plan.md instance's text. Never throws — malformed markdown or
 * malformed `excludedPathsJson` degrade to named misses, not exceptions.
 */
export function lintPlan(
  planText: string,
  opts: { excludedPathsJson?: string } = {},
): LintResult {
  const misses: string[] = [];
  try {
    checkGoalLine(planText, misses);
    checkHeadingPresent(
      planText,
      "## Problem Statement",
      misses,
      "every plan must state the problem before the solution",
    );
    checkBehavioralContrast(planText, misses);
    checkHeadingPresent(
      planText,
      "## Recommendation",
      misses,
      "every plan must commit to one recommendation verdict",
    );
    checkRedundancyLine(planText, misses);
    checkHeadingPresent(
      planText,
      "## Plan risks",
      misses,
      "every plan must name its single weakest assumption",
    );
    checkTaskContracts(planText, misses);
    checkCandidateTable(planText, misses);
    checkPromptInterpretation(planText, misses);
    checkExcludedPathsMirror(planText, opts.excludedPathsJson, misses);
  } catch (e) {
    misses.push(
      `internal lint error (treated as advisory, non-blocking): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return { misses };
}

// --- CLI ---

export type ParsedArgs = { planMdFile: string } | { error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  let planMdFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--plan-md-file") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: "--plan-md-file requires a value" };
      }
      planMdFile = value;
      i++;
      continue;
    }
    return { error: `unknown flag: ${flag}` };
  }
  if (planMdFile === undefined) {
    return { error: "missing required flag: --plan-md-file" };
  }
  return { planMdFile };
}

function readExcludedPathsBestEffort(planMdFile: string): string | undefined {
  const sibling = path.join(path.dirname(planMdFile), "excluded-paths.json");
  try {
    return readFileSync(sibling, "utf8");
  } catch {
    return undefined;
  }
}

export function run(argv: string[]): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-plan-lint: ${parsed.error}\n`);
    process.stderr.write("usage: flow-plan-lint --plan-md-file <path>\n");
    return 2;
  }

  let planText: string;
  try {
    planText = readFileSync(parsed.planMdFile, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `flow-plan-lint: failed to read --plan-md-file '${parsed.planMdFile}': ${msg}\n`,
    );
    return 2;
  }

  const excludedPathsJson = readExcludedPathsBestEffort(parsed.planMdFile);
  const { misses } = lintPlan(planText, { excludedPathsJson });
  if (misses.length === 0) return 0;
  for (const miss of misses) {
    process.stdout.write(miss + "\n");
  }
  return 1;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
