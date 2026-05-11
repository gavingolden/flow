import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Doc-lint regression for `/flow-pipeline` step 11's MERGED-cleanup contract.
 *
 * The bug this guards: prior runs invoked `gh pr merge --squash --delete-branch`
 * to delete the remote branch as a side-effect of merging, which left the
 * matching local feature branch dangling on the user's checkout. The fix
 * drops `--delete-branch` from `gh pr merge` and adds it to the post-merge
 * `flow-remove-worktree` call (which deletes both local + remote refs in
 * one place). This lint pins the new shape so a future refactor can't
 * silently re-introduce the orphaned-local-branch regression.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pipeline",
  "SKILL.md",
);
const RUBRIC_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pipeline",
  "references",
  "auto-merge-rubric.md",
);

const skillContent = readFileSync(SKILL_MD_PATH, "utf8");
const rubricContent = readFileSync(RUBRIC_MD_PATH, "utf8");

function extractStepSection(content: string, headingPrefix: string): string {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((line) => line.startsWith(headingPrefix));
  if (startIdx === -1) {
    throw new Error(`Could not locate '${headingPrefix}' heading in SKILL.md`);
  }
  const afterStart = lines.slice(startIdx + 1);
  const nextHeadingOffset = afterStart.findIndex(
    (line) => /^## Step /.test(line) || /^# /.test(line),
  );
  const endIdx =
    nextHeadingOffset === -1 ? lines.length : startIdx + 1 + nextHeadingOffset;
  return lines.slice(startIdx, endIdx).join("\n");
}

describe("flow-pipeline step 11 doc-lint", () => {
  it('step 10 contains zero "gh pr merge --squash --delete-branch" substrings', () => {
    const step10 = extractStepSection(skillContent, "## Step 10 — Merge");
    const needle = "gh pr merge --squash --delete-branch";
    const lines = step10.split("\n");
    const offending: string[] = [];
    lines.forEach((line, idx) => {
      if (line.includes(needle)) {
        offending.push(`step10:line ${idx + 1}: ${line}`);
      }
    });
    expect(
      offending,
      `Step 10 must not reference \`${needle}\` — the flag was moved off ` +
        `\`gh pr merge\` and onto \`flow-remove-worktree --delete-branch\` ` +
        `so the matching local branch is also reaped. Offending lines:\n` +
        offending.join("\n"),
    ).toEqual([]);
  });

  it("step 11 MERGED block uses `flow-remove-worktree --delete-branch`", () => {
    const step11 = extractStepSection(
      skillContent,
      "## Step 11 — Local follow-ups",
    );
    const needle = "flow-remove-worktree --delete-branch";
    expect(
      step11.includes(needle),
      `Step 11's MERGED end-state must invoke \`${needle}\` so the local ` +
        `feature branch is deleted in lockstep with the worktree (the remote ` +
        `branch is no longer reaped by \`gh pr merge\`). Missing the flag ` +
        `leaves an orphaned local branch on the user's checkout.`,
    ).toBe(true);
  });

  it("auto-merge rubric uses the new form", () => {
    const oldNeedle = "gh pr merge --squash --delete-branch";
    const newNeedle = "flow-remove-worktree --delete-branch";
    expect(
      rubricContent.includes(oldNeedle),
      `auto-merge-rubric.md must not reference \`${oldNeedle}\` — the rubric's ` +
        `auto-merge action row was updated in lockstep with step 10 to drop ` +
        `the flag from \`gh pr merge\`.`,
    ).toBe(false);
    expect(
      rubricContent.includes(newNeedle),
      `auto-merge-rubric.md must reference \`${newNeedle}\` so the rubric and ` +
        `step 11's MERGED end-state agree on where the branch deletion now ` +
        `happens.`,
    ).toBe(true);
  });
});
