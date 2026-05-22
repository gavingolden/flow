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
  it("wraps every `gh pr merge --squash` invocation in `cd \"$PRIMARY\" && `", () => {
    // An "invocation" is an executable shell line — it always has `"$PR"`
    // as the PR argument. Bare-prose backtick references like
    // "`gh pr merge --squash` stderr that triggered this resolver:" are
    // descriptions, not invocations, and are excluded.
    const needle = 'gh pr merge --squash "$PR"';
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
      "PRIMARY=$(git worktree list --porcelain | awk '/^worktree / {sub(/^worktree /, \"\"); print; exit}')";
    expect(
      STEP_10.includes(needle),
      `Step 10 must derive \`$PRIMARY\` via \`${needle}\` so the merge ` +
        `subshell can \`cd\` into the primary worktree. The awk form keys ` +
        `on the literal \`worktree \` prefix and strips it (rather than ` +
        `field-splitting \`{print $2}\`), so worktree paths containing ` +
        `whitespace survive intact — a naive \`{print $2}\` truncates at the ` +
        `first space and reintroduces \`merge-failed\` escalations on ` +
        `machines with spaced checkout paths.`,
    ).toBe(true);
  });

  it("pins the absence of the removed --body / MERGE_FLAGS / flow-merge-body machinery", () => {
    // PR #213 reverted step 10 to a bare `gh pr merge --squash` — the squash
    // body now comes from gh's default concatenation, not a custom `--body`
    // built by the deleted `flow-merge-body` helper. Without this negative
    // assertion a future edit that reintroduces `--body` manipulation would
    // pass the whole vitest suite.
    //
    // An "invocation" is an executable shell line — it always carries `"$PR"`
    // as the PR argument (same convention the wrapping test above relies on).
    // Bare-prose backtick mentions like "runs a bare `gh pr merge --squash` —
    // no `--body`, no `--subject`" are descriptions, not invocations, and are
    // excluded. Each real invocation must carry no `--body`/`--subject` flag —
    // the legitimate `--body-file` on the unrelated `flow-create-issue`
    // post-merge sweep never appears on a `gh pr merge ... "$PR"` line, so it
    // does not trip a false positive. `MERGE_FLAGS` and `flow-merge-body` were
    // unique to the removed machinery and must not reappear anywhere.
    const mergeInvocations = STEP_10.split("\n").filter(
      (line) => line.includes("gh pr merge") && line.includes('"$PR"'),
    );
    for (const line of mergeInvocations) {
      expect(line, `step 10 merge invocation must carry no --body/--subject: ${line}`).not.toMatch(
        /--body\b|--subject\b/,
      );
    }
    expect(STEP_10).not.toMatch(/MERGE_FLAGS|flow-merge-body/);

    const mergeCalls = STEP_10.match(/gh pr merge --squash "\$PR"/g) ?? [];
    expect(mergeCalls).toHaveLength(4);
  });

  it("keeps the auto-merge rubric's action row in sync with the wrapped form", () => {
    const needle = '(cd "$PRIMARY" && gh pr merge --squash';
    expect(
      rubricContent.includes(needle),
      `auto-merge-rubric.md must reference the wrapped form \`${needle}\` ` +
        `in its OPEN/0/auto-merge action so the rubric and the executable ` +
        `step 10 agree on the primary-worktree CWD requirement.`,
    ).toBe(true);
  });

  it('wraps the resolver-spawn `git fetch origin "$BASE_BRANCH"` in `cd "$WORKTREE" && `', () => {
    const needle = 'git fetch origin "$BASE_BRANCH"';
    const wrapper = 'cd "$WORKTREE" && ';
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
      `Every \`${needle}\` inside step 10's resolver-spawn block must be ` +
        `preceded on the same line by \`${wrapper}\` (so the fetch runs from ` +
        `the per-task worktree, not the supervisor's ambient CWD — which a ` +
        `future refactor might silently change). Offending lines:\n` +
        `${offending.join("\n")}`,
    ).toEqual([]);
  });

  it('wraps the resolver-spawn `git diff --name-only --diff-filter=U` in `cd "$WORKTREE" && `', () => {
    const needle = "git diff --name-only --diff-filter=U";
    const wrapper = 'cd "$WORKTREE" && ';
    const offending: string[] = [];
    const stepLines = STEP_10.split("\n");
    stepLines.forEach((line, idx) => {
      if (!line.includes(needle)) return;
      const needleIdx = line.indexOf(needle);
      const preceding = line.slice(0, needleIdx);
      // Skip markdown prose mentions (the needle appearing inside an inline
      // backtick code-span). Only the actual fenced shell invocation needs
      // the wrapper; prose that quotes the command for explanation does not.
      if (preceding.includes("`")) return;
      if (!preceding.includes(wrapper)) {
        offending.push(`step10:line ${idx + 1}: ${line}`);
      }
    });
    expect(
      offending,
      `Every \`${needle}\` inside step 10's resolver-spawn block must be ` +
        `preceded on the same line by \`${wrapper}\` (so \`CONFLICTING_FILES\` ` +
        `is computed from the per-task worktree's index, not whatever CWD the ` +
        `supervisor happens to be in when step 10 runs). Offending lines:\n` +
        `${offending.join("\n")}`,
    ).toEqual([]);
  });
});
