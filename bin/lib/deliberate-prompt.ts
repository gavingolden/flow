/**
 * Prompt builder and result parser for `bin/flow-deliberate.ts`'s blind
 * second-opinion judge. Sibling of `bin/lib/blind-survey-prompt.ts`: same
 * read-only repo access rules (file-reading tools only, a bounded
 * file-count sample, no shell-outs, `.flow-tmp/`/`.env*` off-limits, the
 * headless auto-deny warning), but a DIFFERENT subject — the judge answers
 * ONE logical question rather than recommending a method for a goal, and
 * the caller's own lean is withheld rather than merely unstated.
 *
 * The four-step protocol (restate → enumerate → verify → weigh) is the
 * evidence-backed single structured pass: `docs/deliberation-assessment.md`
 * records why debate and multi-persona variants were cut in its favour, and
 * why the step-back restatement in step 1 is kept (it strips the framing a
 * question inherits from whoever asked it).
 *
 * This module ships to consumer repos via `flow install`, so it carries no
 * flow-specific context (no AGENTS.md / SKILL.md file names baked in) —
 * any repo context the judge needs travels in the question text itself.
 *
 * The file-reading-tools-only / no-shell-out read-access block is composed
 * from `bin/lib/agy-read-rules.ts` (the shared source of truth for every
 * repo-read-granting prompt), rather than hand-copied here. It is written
 * for agy but is model-agnostic — the rules it states (read with your file
 * tools, do not shell out, do not spawn subagents) hold identically for a
 * headless Claude child with an `Read,Grep,Glob` allowlist.
 */

import { agyReadRules } from "./agy-read-rules";

export const DELIBERATE_FRAMING =
  "You are an independent judge giving a second opinion on a single " +
  "question. You are given ONLY the question; you do not know what answer " +
  "the person asking already leans toward, and you must not guess at it. " +
  "Answer on the merits.";

export type DeliberatePromptInput = {
  question: string;
  worktreePath: string;
  productBrief?: string | null;
};

/**
 * Builds the judge prompt sent to the headless Claude child. Pure — no I/O.
 */
export function buildDeliberatePrompt(input: DeliberatePromptInput): string {
  const brief = input.productBrief?.trim()
    ? `\n## Product context\n\nThe following is the standing product brief for this repo. Treat it as background on whose interests the answer serves — it is NOT the question, and it is NOT an answer.\n\n${input.productBrief.trim()}\n`
    : "";

  return `${DELIBERATE_FRAMING}

${agyReadRules({
  worktreePath: input.worktreePath,
  readPurpose:
    "check the load-bearing factual claim behind each option you are weighing, rather than guessing",
  fileCap: 8,
  outputNoun: "run",
})} Write your answer once you stop reading — an answer that is never written is worth nothing. Do NOT read the \`.flow-tmp/\` directory — it holds this pipeline's own scratch state, including the plan, the transcript, and the asker's own lean; your blindness to that lean is the entire point of asking a second judge, so reading it would silently turn an independent opinion into an echo.
${brief}
## Question

${input.question}

## Method

Work the question in four steps, in order. Do not skip a step because the answer seems obvious — premature closure on the first plausible option is the failure this protocol exists to prevent.

1. **Restate.** Put the question in your own words, stripped of any framing, adjectives, or leading phrasing it arrived with. If the restatement changes what is actually being asked, answer YOUR restatement and say so.
2. **Enumerate.** Name AT LEAST THREE genuinely distinct options. "Do nothing" and "reject the premise" are legitimate options and count. Options that differ only in wording do not count as distinct.
3. **Verify.** For each option, identify the single load-bearing factual claim it depends on, and check that claim against the repository with your file-reading tools. A claim you could not check is an unverified claim — say so rather than assuming it.
4. **Weigh.** State which options are complementary (can be adopted together) and which are mutually exclusive (adopting one forecloses another). Then commit to one recommendation.

## Output

Write AT MOST 700 words, under these EXACT headings.

### 1. Question as understood

Your step-1 restatement, in a sentence or two.

### 2. Options

Each option you enumerated, with the load-bearing claim you checked and what the repository said about it.

### 3. Trade-offs

Which options are complementary, which are mutually exclusive, and the cost of each.

### 4. Recommendation

Open with EXACTLY ONE sentence that stands alone as your recommendation — no hedging, no "it depends", a single concrete answer a reader could quote out of context and still understand. Then give the reasoning in a short paragraph.

### 5. What would change my mind

The specific evidence that would flip your recommendation to a different option. Name the option it would flip to.

## Trailer

End your answer with EXACTLY these three lines, each on its own line, after all the headings above:

Recommendation: <your recommendation in one sentence>
Confidence: <high|medium|low>
Anchor: <the evidence your confidence rests on>

Choose Confidence by what the Anchor is, NOT by how sure you feel:

- \`high\` — the anchor is a file path (with an optional \`:line\`) you actually read, or a direct quotation of the asker's own words. Write it as \`path/to/file.ts:42\` (a line range like \`path/to/file.ts:45-59\` is fine) or \`user: "their exact words"\`.
- \`medium\` — the anchor is an adjacent precedent in this repo you read but which does not decide the question outright. Write it as \`adjacent: path/to/file.ts\`.
- \`low\` — the anchor is your own judgment, a convention, a general principle, or anything you could not check against the repository. Write it as \`inference\`, or as \`weighing: <the factor>\`.

A recommendation you cannot ground in a file you read or a quotation of the asker is \`low\`. Do not round \`low\` up to \`medium\` because the reasoning feels strong — an ungrounded preference tagged \`medium\` is worse than useless to the person reading this, because it is indistinguishable from a checked fact.

Plain markdown. Be concrete and opinionated; do not hedge across options.`;
}

export type Confidence = "high" | "medium" | "low";

export type Deliberation = {
  recommendation: string;
  confidence: Confidence;
  anchor: string;
  /** The full judge answer above the trailer — the human-readable note. */
  rationale: string;
};

const CONFIDENCE_VALUES: readonly Confidence[] = ["high", "medium", "low"];

function isConfidence(value: string): value is Confidence {
  return (CONFIDENCE_VALUES as readonly string[]).includes(value);
}

/**
 * Extracts the three-line trailer from a judge answer.
 *
 * Deliberately forgiving about everything EXCEPT the three trailer keys:
 * the five headings shape the human-readable note and are never parsed, so
 * a judge that renames or drops one still yields a usable result. Reads the
 * LAST occurrence of each key so a judge that quotes the trailer format
 * while explaining itself cannot shadow its own real answer.
 *
 * Returns `null` when any of the three keys is missing or when Confidence
 * is not one of the three literals — the caller treats that as
 * `unparseable-result` rather than guessing at a confidence.
 */
export function parseDeliberation(text: string): Deliberation | null {
  const lines = text.split("\n");

  let recommendation: string | undefined;
  let confidence: Confidence | undefined;
  let anchor: string | undefined;
  let recommendationLastIndex: number | undefined;
  let confidenceLastIndex: number | undefined;
  let anchorLastIndex: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
      .trim()
      .replace(/^[-*]\s+/, "")
      .replace(/\*\*/g, "");
    const match = /^(Recommendation|Confidence|Anchor):\s*(.*)$/i.exec(line);
    if (!match) continue;
    const value = match[2].trim();
    if (value.length === 0) continue;

    switch (match[1].toLowerCase()) {
      case "recommendation":
        recommendation = value;
        recommendationLastIndex = i;
        break;
      case "confidence": {
        const normalized = value.toLowerCase().replace(/[.`]/g, "").trim();
        if (isConfidence(normalized)) {
          confidence = normalized;
          confidenceLastIndex = i;
        }
        break;
      }
      case "anchor":
        anchor = value;
        anchorLastIndex = i;
        break;
    }
  }

  if (
    recommendation === undefined ||
    confidence === undefined ||
    anchor === undefined
  ) {
    return null;
  }

  // trailerStart is the MIN of each key's LAST occurrence, not the min of
  // every trailer-looking line — a `**Recommendation:**`-style lead-in
  // inside an earlier prose section (e.g. section 4) must not truncate the
  // rationale before the judge's actual trailer block.
  const trailerStart = Math.min(
    recommendationLastIndex ?? lines.length,
    confidenceLastIndex ?? lines.length,
    anchorLastIndex ?? lines.length,
  );

  const rationale = lines.slice(0, trailerStart).join("\n").trim();

  return { recommendation, confidence, anchor, rationale };
}

/**
 * The line suffix a judge may append to a path anchor: a single line
 * (`:42`), or a RANGE (`:45-59`).
 *
 * Ranges are accepted deliberately. A judge citing a block of code writes a
 * range as naturally as a single line, and a range is exactly as
 * re-verifiable — the caller checks the PATH exists, not the line numbers.
 * Rejecting them silently demoted genuine `high` answers to `low`
 * (measured: a live smoke call anchored `bin/lib/sources.ts:45–59` and was
 * demoted), which would have defeated the feature at the one site it is
 * wired into.
 *
 * All three dash characters are allowed because models emit typographic
 * dashes freely; an en dash in a citation is not a different claim.
 */
const LINE_SUFFIX = String.raw`(?::\d+(?:[-–—]\d+)?)?`;

/**
 * True when an anchor is a closed form the CALLER can mechanically
 * re-verify: a `path[:line[-line]]`, an `adjacent: path`, or a `user: "…"`
 * quote.
 *
 * A `weighing:` or `inference` anchor is free text no lint can check, so it
 * is deliberately NOT closed-form — `bin/flow-deliberate.ts` demotes such a
 * result to `low`, which routes it to the caller's existing escape rather
 * than laundering speculation into an adopted default.
 */
export function isClosedFormAnchor(anchor: string): boolean {
  const trimmed = anchor.trim().replace(/^`|`$/g, "").trim();
  if (trimmed.length === 0) return false;
  if (/^user:\s*["“]/.test(trimmed)) return true;

  // A judge that read several files cites several — `AGENTS.md:76,
  // bin/flow-release.ts:3-12` was a real live answer. That is MORE evidence
  // than a single citation, so demoting it would punish the better answer.
  // Split on commas/semicolons and require EVERY element to be closed-form:
  // one unverifiable element still demotes the whole anchor, so the check
  // stays conservative — a list cannot be used to smuggle prose in beside a
  // real path.
  const parts = trimmed
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  return parts.every(isClosedFormPath);
}

function isClosedFormPath(part: string): boolean {
  const path = /^adjacent:\s*(.+)$/.exec(part)?.[1]?.trim() ?? part;
  // A bare path, optionally line-suffixed. Must look like a path — carrying
  // an extension, or a directory separator — so a prose sentence cannot pass.
  return (
    new RegExp(String.raw`^[\w./@-]+\.\w+${LINE_SUFFIX}$`).test(path) ||
    new RegExp(String.raw`^[\w./@-]+/[\w./@-]+${LINE_SUFFIX}$`).test(path)
  );
}
