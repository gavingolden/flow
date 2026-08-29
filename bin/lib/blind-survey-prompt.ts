/**
 * Prompt builder for `bin/flow-blind-survey.ts`'s two model-pinned blind
 * judges. Sibling of `bin/lib/plan-review-prompt.ts`: same read-only repo
 * access rules (file-reading tools only, a bounded file-count sample, no
 * shell-outs, `.flow-tmp/`/`.env*` off-limits, the headless auto-deny
 * warning), but a DIFFERENT framing — the judge sees only a goal-only
 * brief, never the plan or the user's proposed method, so it cannot
 * anchor on (or rubber-stamp) whatever the requester already has in mind.
 *
 * This module ships to consumer repos via `flow install`, so it carries no
 * flow-specific context (no AGENTS.md / SKILL.md file names baked in) —
 * any repo context the judge needs travels in the brief text itself.
 */

export const BLIND_FRAMING =
  "You are an independent judge in a blind design survey. You are given " +
  "ONLY a goal; you do not know what solution the requester has in mind, " +
  "and you must not guess at it. Recommend how to accomplish the goal on " +
  "its merits.";

export type SurveyPromptInput = {
  brief: string;
  worktreePath: string;
};

/**
 * Builds the judge prompt sent to each blind-survey judge. Pure — no I/O.
 */
export function buildSurveyPrompt(input: SurveyPromptInput): string {
  return `${BLIND_FRAMING}

${input.worktreePath} is the readable repository root — READ it to ground your recommendation in what already exists rather than guessing. Reach for it with your file-reading tools ONLY (read a file, list a directory). Spot-check AT MOST 8 files — you are sampling to understand the codebase, not auditing the repo. Do NOT spawn subagents or delegate this reading to other agents — read the files yourself. Spend at most a third of your run reading, then STOP and write your recommendation — a recommendation that is never written is worth nothing. Do NOT shell out — no \`grep\`, \`find\`, \`ls\`, \`cat\`, or \`git\` commands: this is a headless run in which shell commands need a permission nothing can grant mid-run, so they are auto-denied and your run ends silently with no output at all. Do NOT read the \`.flow-tmp/\` directory — it holds this pipeline's own scratch state, including the OTHER judge's in-flight or already-written recommendation; your independence from the other judge is the entire point of running a second model, so reading their output would silently turn an "independently converged" recommendation into an echo. Do NOT open \`.env*\` files or any credential/secret file — you never need them to recommend a method, and reading them would be a pure liability with no benefit.

## Goal brief

${input.brief}

## Output

Write your recommendation in AT MOST 500 words, in this exact four-part shape, under these EXACT headings:

### 1. Goal as understood

Restate the goal in your own words, in a sentence or two — this lets the requester audit whether you understood it before reading your recommendation.

### 2. Recommended method

Open with EXACTLY ONE sentence that stands alone as your recommendation — no hedging, no "it depends", a single concrete method a reader could quote out of context and still understand. After that sentence, give the mechanism, where it runs, and what the requester sees.

### 3. Alternatives considered and why not

Up to two alternatives you considered and ranked lower, and why.

### 4. Risks and what would change your mind

The main risk or cost of your recommendation, and what evidence would change your recommendation.

Plain markdown. Be concrete and opinionated; do not hedge across options.`;
}

const WORD_RE = /[a-z0-9]+/g;

function normalizeWords(text: string): string[] {
  return (text.toLowerCase().match(WORD_RE) ?? []).filter((w) => w.length > 0);
}

/**
 * Mechanical blindness guard: true when the brief contains a verbatim (or
 * near-verbatim, after case/punctuation/whitespace normalisation) run of
 * `shingleWords` consecutive words lifted from `corpus` (the raw
 * description plus any digest-answer lines) — i.e. the brief leaked the
 * user's proposed method/mechanism into what is supposed to be a
 * goal-only brief.
 *
 * Builds the set of every `shingleWords`-word shingle per CORPUS LINE (a
 * short line — fewer than `shingleWords` words — contributes itself as one
 * shingle, but only when it has >= 3 words, so a lone word or two never
 * trips the guard) and checks whether any shingle occurs in the brief's
 * normalised word sequence.
 */
export function briefLeaksCorpus(
  brief: string,
  corpus: string,
  shingleWords = 8,
): boolean {
  const briefWords = normalizeWords(brief);
  if (briefWords.length === 0) return false;
  const briefText = ` ${briefWords.join(" ")} `;

  const shingles = new Set<string>();
  for (const line of corpus.split("\n")) {
    const words = normalizeWords(line);
    if (words.length === 0) continue;
    if (words.length < shingleWords) {
      if (words.length >= 3) shingles.add(words.join(" "));
      continue;
    }
    for (let i = 0; i + shingleWords <= words.length; i++) {
      shingles.add(words.slice(i, i + shingleWords).join(" "));
    }
  }

  for (const shingle of shingles) {
    if (briefText.includes(` ${shingle} `)) return true;
  }
  return false;
}
