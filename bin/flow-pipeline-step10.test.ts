import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Doc-lint regression for `/flow-pipeline` step 10's merge invocation.
 *
 * The bug this guards: gh's post-merge `git checkout <base>` (triggered
 * by `--delete-branch`) collides with the primary worktree's checkout
 * of the same base when invoked from a per-task worktree. The fix wraps
 * every merge call in `(cd "$PRIMARY" && ...)`. This lint pins both the
 * SKILL.md occurrences and the matching auto-merge-rubric.md row so a
 * future refactor can't silently drop the wrapping.
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

const skillContent = fs.readFileSync(SKILL_MD_PATH, "utf8");
const rubricContent = fs.readFileSync(RUBRIC_MD_PATH, "utf8");

function extractStep10(content: string): string {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((line) => line.startsWith("## Step 10 — Merge"));
  if (startIdx === -1) {
    throw new Error("Could not locate '## Step 10 — Merge' heading in SKILL.md");
  }
  const afterStart = lines.slice(startIdx + 1);
  const nextStepOffset = afterStart.findIndex((line) => /^## Step /.test(line));
  const endIdx = nextStepOffset === -1 ? lines.length : startIdx + 1 + nextStepOffset;
  return lines.slice(startIdx, endIdx).join("\n");
}

const STEP_10 = extractStep10(skillContent);

describe("flow-pipeline SKILL.md step 10 — gh pr merge from primary worktree", () => {
  it("wraps every `gh pr merge --squash --delete-branch` in `cd \"$PRIMARY\" && `", () => {
    const needle = 'gh pr merge --squash --delete-branch';
    const wrapper = 'cd "$PRIMARY" && ';
    const offending: string[] = [];
    const stepLines = STEP_10.split("\n");
    stepLines.forEach((line, idx) => {
      if (!line.includes(needle)) return;
      const needleIdx = line.indexOf(needle);
      const preceding = line.slice(0, needleIdx);
      if (!preceding.includes(wrapper)) {
        offending.push(`step10:line ${idx + 1}: ${line}`);
      }
    });
    expect(
      offending,
      `Every \`${needle}\` inside step 10 must be preceded on the same line ` +
        `by \`${wrapper}\` (so the merge runs from the primary worktree, not ` +
        `the per-task worktree). Offending lines:\n${offending.join("\n")}`,
    ).toEqual([]);
  });

  it("derives `$PRIMARY` from `git worktree list` exactly once inside step 10", () => {
    const needle =
      "PRIMARY=$(git worktree list --porcelain | awk '/^worktree / {print $2; exit}')";
    expect(
      STEP_10.includes(needle),
      `Step 10 must derive \`$PRIMARY\` via \`${needle}\` so the merge ` +
        `subshell can \`cd\` into the primary worktree.`,
    ).toBe(true);
  });

  it("keeps the auto-merge rubric's action row in sync with the wrapped form", () => {
    const needle = '(cd "$PRIMARY" && gh pr merge --squash --delete-branch';
    expect(
      rubricContent.includes(needle),
      `auto-merge-rubric.md must reference the wrapped form \`${needle}\` ` +
        `in its OPEN/0/auto-merge action so the rubric and the executable ` +
        `step 10 agree on the primary-worktree CWD requirement.`,
    ).toBe(true);
  });
});
