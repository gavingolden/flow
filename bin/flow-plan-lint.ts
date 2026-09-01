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
 *   flow-plan-lint --plan-md-file <path> [--survey-ran]
 *
 * `--survey-ran` is a valueless flag: it tells the linter the Step-3 blind
 * method survey ran this pass, so an entirely absent `## Method selection`
 * section becomes a named miss instead of the default silent skip (see
 * checkMethodSelection below) — without it, behaviour is unchanged.
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

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
  extractRecommendedPath,
  extractSurveyVerdict,
  SURVEY_VERDICTS,
} from "./flow-step3-route";
import { extractPathAnchors, resolveAnchorRepoRoot } from "./lib/value-anchors";

const CONFIDENCE_RE = /\[confidence:\s*(high|medium|low)\]/g;
const WEIGHING_FACTORS = [
  "convention",
  "footprint",
  "risk",
  "reversibility",
  "effort",
  "symmetry",
];

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

/**
 * Per discovery-instructions.md's `## Cut list` contract, a bare "nothing"
 * with no justification fails this check — the author must say WHY nothing
 * was cut, not just assert it. Absent heading is already reported by the
 * sibling `checkHeadingPresent` call in `lintPlan`; don't double-report.
 */
function checkCutListJustification(planText: string, misses: string[]): void {
  const match = planText.match(/^## Cut list\s*$/m);
  if (!match) return;
  const body = sliceToNextHeading(
    planText,
    (match.index ?? 0) + match[0].length,
  ).trim();
  if (/^nothing\W*$/im.test(body)) {
    misses.push(
      "'## Cut list' asserts 'nothing' with no justification — say WHY nothing was cut (e.g. 'nothing — plan is already minimal')",
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
    const contractBody = sliceContractBlock(body);
    if (contractBody === null) {
      misses.push(`'${taskName}' is missing its '- **Contract:**' block`);
    } else {
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
    if (
      acceptanceMatch &&
      !body.slice(acceptanceMatch.index ?? 0).includes("`")
    ) {
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

/**
 * Advisory check for the (omit-when-no-blind-survey) `## Method selection`
 * section discovery writes after the Step-3 blind method survey (see
 * skills/pipeline/flow-pipeline/references/blind-survey.md). When the
 * heading is absent, this is a named miss ONLY if `opts.surveyRan` is
 * true (the caller confirmed the survey actually ran this pass — a plan
 * predating the survey, or a pass where it never ran, stays silent, same
 * as before this flag existed). When present, checks:
 *   1. a `- **Survey verdict:**` line that exact-matches one of
 *      `SURVEY_VERDICTS` (a paraphrase like "converge-against (single
 *      judge)" is a named miss, exactly the guard `extractSurveyVerdict`'s
 *      own docstring warns about);
 *   2. a `- **Chosen method:**` line;
 *   3. a `- **Judge A (...):**` line and a `- **Judge B (...):**` line are
 *      both present — a section with a verdict but zero judge lines loses
 *      the whole point of the section: the verbatim-quote audit trail;
 *   4. every non-`skipped:` `- **Judge A (...):**` / `- **Judge B (...):**`
 *      line opens its value with a double-quoted verbatim excerpt
 *      (`"…"`) before the ` — ` paraphrase, so the verdict stays
 *      auditable — a `skipped:` judge line is exempt (it has no
 *      recommendation to quote).
 */
function checkMethodSelection(
  planText: string,
  misses: string[],
  opts: { surveyRan?: boolean } = {},
): void {
  const headingMatch = planText.match(/^## Method selection\s*$/m);
  if (!headingMatch) {
    if (opts.surveyRan) {
      misses.push(
        "survey ran but plan.md has no '## Method selection' section",
      );
    }
    return;
  }
  const body = sliceToNextHeading(
    planText,
    (headingMatch.index ?? 0) + headingMatch[0].length,
  );

  const verdict = extractSurveyVerdict(planText);
  if (
    verdict === null ||
    !(SURVEY_VERDICTS as readonly string[]).includes(verdict)
  ) {
    misses.push(
      `'## Method selection' has no exact-match '- **Survey verdict:** <${SURVEY_VERDICTS.join(" | ")}>' line` +
        (verdict === null ? "" : ` (got '${verdict}')`),
    );
  }

  if (!/^- \*\*Chosen method:\*\*/m.test(body)) {
    misses.push(
      "'## Method selection' is missing a '- **Chosen method:**' line",
    );
  }

  for (const label of ["Judge A", "Judge B"] as const) {
    const labelRe = new RegExp(`^- \\*\\*${label} \\(`, "m");
    if (!labelRe.test(body)) {
      misses.push(
        `'## Method selection' has no '${label} (...)' line — the verbatim-quote audit trail is incomplete`,
      );
    }
  }

  // The model name inside the parens can itself carry parens (e.g. no
  // known case today, but agy display names are free-form strings) — a
  // lazy `.*?` rather than a negated `[^)]*` class lets the match extend
  // past an inner `)` to find the outer `):**` that actually closes the
  // label.
  const judgeLineRe = /^- \*\*(Judge [AB]) \(.*?\):\*\*\s*(.*)$/gm;
  let judgeMatch: RegExpExecArray | null;
  while ((judgeMatch = judgeLineRe.exec(body)) !== null) {
    const judgeLabel = judgeMatch[1];
    const rest = judgeMatch[2].trim();
    if (/^skipped:/.test(rest)) continue;
    if (!/^"[^"]+"/.test(rest)) {
      misses.push(
        `'## Method selection' ${judgeLabel} line is missing a double-quoted verbatim excerpt before its paraphrase`,
      );
    }
  }
}

/**
 * Slices `## Open Questions` into its top-level `- [ ]` / `- [x]` entry
 * blocks (each block runs up to, but not including, the next top-level
 * `- ` bullet — indented sub-bullets like `  - **Stakes:**` stay inside).
 * Returns `null` when the heading is absent (callers no-op in that case).
 */
function extractOpenQuestionsBlocks(
  planText: string,
): Array<{ checked: boolean; block: string }> | null {
  const headingMatch = planText.match(/^## Open Questions\s*$/m);
  if (!headingMatch) return null;
  const body = sliceToNextHeading(
    planText,
    (headingMatch.index ?? 0) + headingMatch[0].length,
  );

  const entryRe = /^- \[[ xX]\]/gm;
  const entries: Array<{ index: number; text: string }> = [];
  let em: RegExpExecArray | null;
  while ((em = entryRe.exec(body)) !== null) {
    entries.push({ index: em.index, text: em[0] });
  }
  const out: Array<{ checked: boolean; block: string }> = [];
  for (let i = 0; i < entries.length; i++) {
    const start = entries[i].index;
    const rest = body.slice(start + entries[i].text.length);
    const nextTopLevel = rest.search(/^- /m);
    const block =
      body.slice(start, start + entries[i].text.length) +
      (nextTopLevel === -1 ? rest : rest.slice(0, nextTopLevel));
    out.push({ checked: /^- \[[xX]\]/.test(entries[i].text), block });
  }
  return out;
}

/**
 * Advisory resolution-first check for `## Open Questions`: every unchecked
 * `- [ ]` entry block must carry a `**Recommended:**` answer or a
 * `**Needs user input:**` escape (markers may sit on nested sub-bullets).
 * Checked `- [x]` entries and an absent heading are exempt.
 */
function checkOpenQuestions(planText: string, misses: string[]): void {
  const blocks = extractOpenQuestionsBlocks(planText);
  if (blocks === null) return;
  for (const { checked, block } of blocks) {
    if (checked) continue; // checked entry — exempt
    if (
      !/\*\*Recommended:\*\*/.test(block) &&
      !/\*\*Needs user input:\*\*/.test(block)
    ) {
      const entryLine = block.split("\n", 1)[0].slice(0, 60);
      misses.push(
        `'## Open Questions' entry '${entryLine}' has neither a '**Recommended:**' answer nor a '**Needs user input:**' escape (resolution-first contract; see discovery-instructions.md)`,
      );
    }
  }
}

/**
 * Advisory confidence-marker check for `## Open Questions`: every unchecked
 * entry with a `**Recommended:**` line must carry exactly one
 * `[confidence: high|medium|low]` and one `[anchor: …]`, and the anchor's
 * FORM must match the confidence level (see discovery-instructions.md's
 * Confidence + stakes rubric). Advisory — never blocks planning.
 */
function checkConfidenceMarkers(
  planText: string,
  misses: string[],
  planMdFile?: string,
): void {
  const blocks = extractOpenQuestionsBlocks(planText);
  if (blocks === null) return;
  for (const { checked, block } of blocks) {
    if (checked) continue;
    const recLineMatch = block.match(/^.*\*\*Recommended:\*\*.*$/m);
    if (!recLineMatch) continue;
    const recLine = recLineMatch[0];
    const entryLine = block.split("\n", 1)[0].slice(0, 60);

    // The tag pair is only meaningful when it TERMINATES the Recommended
    // line (per the rubric's "ends with" contract) — a Recommended line
    // may legitimately reference `[confidence: ...]` / `[anchor: ...]`
    // syntax inline as prose (e.g. describing the rubric itself), which
    // must not be mistaken for the real trailing tag pair.
    const allConfMatches = [...recLine.matchAll(new RegExp(CONFIDENCE_RE))];
    if (allConfMatches.length > 1) {
      misses.push(
        `confidence-missing: '## Open Questions' entry '${entryLine}' Recommended line carries more than one '[confidence: …]' tag`,
      );
      continue;
    }
    const endTagMatch = recLine.match(
      /\[confidence:\s*(high|medium|low)\]\s*\[anchor:\s*([^\]]+)\]\s*\.?\s*$/,
    );
    if (!endTagMatch) {
      if (allConfMatches.length === 0) {
        misses.push(
          `confidence-missing: '## Open Questions' entry '${entryLine}' Recommended line must end with '[confidence: high|medium|low] [anchor: …]'`,
        );
      } else {
        misses.push(
          `anchor-missing-tag: '## Open Questions' entry '${entryLine}' Recommended line has a confidence tag but no trailing '[anchor: …]' tag`,
        );
      }
      continue;
    }
    const level = endTagMatch[1] as "high" | "medium" | "low";
    const anchorContent = endTagMatch[2].trim();

    if (level === "high") {
      if (/^user:\s*"/.test(anchorContent)) continue;
      const paths = extractPathAnchors(`[anchor: ${anchorContent}]`);
      if (paths.length === 0) {
        misses.push(
          `high-anchor-form: '## Open Questions' entry '${entryLine}' is 'high' but its anchor '${anchorContent}' is neither a file path nor a 'user: "..."' quote`,
        );
        continue;
      }
      const root = resolveAnchorRepoRoot(planMdFile ?? process.cwd());
      if (!existsSync(path.resolve(root, paths[0]))) {
        misses.push(
          `anchor-missing: '## Open Questions' entry '${entryLine}' is 'high' but its anchor path '${paths[0]}' does not exist under '${root}'`,
        );
      }
      continue;
    }

    if (level === "medium") {
      if (anchorContent.startsWith("adjacent: ")) {
        const remainder = anchorContent.slice("adjacent: ".length).trim();
        const paths = extractPathAnchors(`[anchor: ${remainder}]`);
        if (paths.length === 0) {
          misses.push(
            `medium-anchor-form: '## Open Questions' entry '${entryLine}' is 'medium' with an 'adjacent:' anchor that has no parseable file path`,
          );
          continue;
        }
        const root = resolveAnchorRepoRoot(planMdFile ?? process.cwd());
        if (!existsSync(path.resolve(root, paths[0]))) {
          misses.push(
            `anchor-missing: '## Open Questions' entry '${entryLine}' is 'medium' but its 'adjacent:' anchor path '${paths[0]}' does not exist under '${root}'`,
          );
        }
        continue;
      }
      if (anchorContent.startsWith("weighing: ")) {
        const factor = anchorContent
          .slice("weighing: ".length)
          .trim()
          .split(/\s+/)[0];
        if (!WEIGHING_FACTORS.includes(factor)) {
          misses.push(
            `medium-anchor-form: '## Open Questions' entry '${entryLine}' is 'medium' with a 'weighing:' anchor whose factor '${factor}' is not in the closed list (${WEIGHING_FACTORS.join(" | ")})`,
          );
        }
        continue;
      }
      misses.push(
        `medium-anchor-form: '## Open Questions' entry '${entryLine}' is 'medium' but its anchor '${anchorContent}' is neither 'adjacent: …' nor 'weighing: <factor> — …'`,
      );
      continue;
    }

    // level === "low"
    if (!/^inference\b/.test(anchorContent)) {
      misses.push(
        `low-anchor-form: '## Open Questions' entry '${entryLine}' is 'low' but its anchor '${anchorContent}' does not start with 'inference'`,
      );
    }
  }
}

/**
 * Advisory stakes-line check for `## Open Questions`: every unchecked entry
 * must carry a `**Stakes:**` line whose lens is `system`, `user`, or
 * `both`. A checked `- [x]` entry is never inspected — `**Stakes:** none`
 * is only valid there. Advisory — never blocks planning.
 */
function checkStakesLines(planText: string, misses: string[]): void {
  const blocks = extractOpenQuestionsBlocks(planText);
  if (blocks === null) return;
  for (const { checked, block } of blocks) {
    if (checked) continue;
    const entryLine = block.split("\n", 1)[0].slice(0, 60);
    const stakesMatch = block.match(/\*\*Stakes:\*\*\s*(\w+)/);
    const lens = stakesMatch?.[1];
    if (!lens || !["system", "user", "both"].includes(lens)) {
      misses.push(
        `stakes-missing: '## Open Questions' entry '${entryLine}' has no '**Stakes:** system|user|both' line — a zero-stakes question must be a checked resolved-without-asking entry`,
      );
    }
  }
}

/**
 * Advisory verdict-confidence check: every `Verdict:` line under
 * `## Decision analysis`, and the first bold verdict line of
 * `## Recommendation`, must carry a `[confidence: …]` tag. Absent
 * headings no-op. Advisory — never blocks planning.
 */
function checkVerdictConfidence(planText: string, misses: string[]): void {
  const daMatch = planText.match(
    /^### Decision analysis\s*$|^## Decision analysis\s*$/m,
  );
  if (daMatch) {
    const body = sliceToNextHeading(
      planText,
      (daMatch.index ?? 0) + daMatch[0].length,
    );
    const lineRe = /^.*Verdict:.*$/gm;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(body)) !== null) {
      if (!new RegExp(CONFIDENCE_RE).test(lm[0])) {
        misses.push(
          `verdict-confidence-missing: '## Decision analysis' verdict line '${lm[0].slice(0, 60)}' has no '[confidence: …]' tag`,
        );
      }
    }
  }

  const recMatch = planText.match(/^## Recommendation\s*$/m);
  if (recMatch) {
    const body = sliceToNextHeading(
      planText,
      (recMatch.index ?? 0) + recMatch[0].length,
    );
    const verdictLineMatch = body.match(
      /^.*\*\*(Proceed|Reconsider scope|Defer|Reject — do nothing)\*\*.*$/m,
    );
    if (
      verdictLineMatch &&
      !new RegExp(CONFIDENCE_RE).test(verdictLineMatch[0])
    ) {
      misses.push(
        `verdict-confidence-missing: '## Recommendation' verdict line '${verdictLineMatch[0].slice(0, 60)}' has no '[confidence: …]' tag`,
      );
    }
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
  opts: {
    excludedPathsJson?: string;
    surveyRan?: boolean;
    planMdFile?: string;
  } = {},
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
    checkHeadingPresent(
      planText,
      "## Cut list",
      misses,
      "every plan must name its unnecessary complexity (or affirm none)",
    );
    checkCutListJustification(planText, misses);
    checkTaskContracts(planText, misses);
    checkCandidateTable(planText, misses);
    checkPromptInterpretation(planText, misses);
    checkMethodSelection(planText, misses, { surveyRan: opts.surveyRan });
    checkOpenQuestions(planText, misses);
    checkConfidenceMarkers(planText, misses, opts.planMdFile);
    checkStakesLines(planText, misses);
    checkVerdictConfidence(planText, misses);
    checkExcludedPathsMirror(planText, opts.excludedPathsJson, misses);
  } catch (e) {
    misses.push(
      `internal lint error (treated as advisory, non-blocking): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return { misses };
}

// --- CLI ---

export type ParsedArgs =
  | { planMdFile: string; surveyRan: boolean }
  | { error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  let planMdFile: string | undefined;
  let surveyRan = false;
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
    if (flag === "--survey-ran") {
      surveyRan = true;
      continue;
    }
    return { error: `unknown flag: ${flag}` };
  }
  if (planMdFile === undefined) {
    return { error: "missing required flag: --plan-md-file" };
  }
  return { planMdFile, surveyRan };
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
    process.stderr.write(
      "usage: flow-plan-lint --plan-md-file <path> [--survey-ran]\n",
    );
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
  const { misses } = lintPlan(planText, {
    excludedPathsJson,
    surveyRan: parsed.surveyRan,
    planMdFile: parsed.planMdFile,
  });
  if (misses.length === 0) return 0;
  for (const miss of misses) {
    process.stdout.write(miss + "\n");
  }
  return 1;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
