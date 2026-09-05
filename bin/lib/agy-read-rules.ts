/**
 * Shared file-reading-tools-only / no-shell-out instruction block for every
 * agy prompt that passes `--add-dir` and therefore grants the model repo
 * read access. Modeled on `bin/lib/blind-survey-prompt.ts`'s paragraph (the
 * shorter, cleaner of the two prior hand-copies) so a fourth `--add-dir`
 * caller composes this instead of hand-copying the paragraph a third time.
 *
 * `bin/flow-research-run.ts` passes no `--add-dir` and therefore must NOT
 * carry this block — there is deliberately no repo-wide lint enforcing
 * adoption (see the excluded-paths entries for `repo-wide-grep-lint` and a
 * cross-site lint constant); each `--add-dir` caller opts in explicitly by
 * calling this function.
 */
export function agyReadRules(input: {
  worktreePath: string;
  readPurpose: string;
  fileCap: number;
  outputNoun: string;
  // Optional site-specific override for the verb/noun used in the
  // "delegate this X to other agents" sentence and the pacing clause's
  // trailing phrase. Defaults to "reading" (the wording both agyReadRules
  // itself and every NEW `--add-dir` caller should use). Only
  // `bin/lib/plan-review-prompt.ts`'s pre-existing, byte-pinned test
  // (`plan-review-prompt.test.ts` asserting "delegate this verification to
  // other agents" / "run on verification") needs an override — see that
  // file's own header comment.
  readVerb?: string;
  pacingPhrase?: string;
}): string {
  const readVerb = input.readVerb ?? "reading";
  const pacingPhrase = input.pacingPhrase ?? readVerb;
  return `${input.worktreePath} is the readable repository root — READ it to ${input.readPurpose}. Reach for it with your file-reading tools ONLY (read a file, list a directory). Spot-check AT MOST ${input.fileCap} files — you are sampling, not auditing the repo. Do NOT spawn subagents or delegate this ${readVerb} to other agents — read the files yourself. Spend at most a third of your run ${pacingPhrase}, then STOP. Do NOT shell out — no \`grep\`, \`find\`, \`ls\`, \`cat\`, or \`git\` commands: this is a headless run in which shell commands need a permission nothing can grant mid-run, so they are auto-denied and your ${input.outputNoun} ends silently with no output at all.`;
}
