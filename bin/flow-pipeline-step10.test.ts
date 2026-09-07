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
const STAGE_B_PATH = path.resolve(
  HERE,
  "..",
  "workflows",
  "core",
  "flow-stage-b.workflow.js",
);

const skillContent = fs.readFileSync(SKILL_MD_PATH, "utf8");
const rubricContent = fs.readFileSync(RUBRIC_MD_PATH, "utf8");
const stageBContent = fs.readFileSync(STAGE_B_PATH, "utf8");

function extractStep10(content: string): string {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((line) =>
    line.startsWith("## Step 10 — Merge"),
  );
  if (startIdx === -1) {
    throw new Error(
      "Could not locate '## Step 10 — Merge' heading in SKILL.md",
    );
  }
  const afterStart = lines.slice(startIdx + 1);
  const nextStepOffset = afterStart.findIndex((line) => /^## Step /.test(line));
  const endIdx =
    nextStepOffset === -1 ? lines.length : startIdx + 1 + nextStepOffset;
  return lines.slice(startIdx, endIdx).join("\n");
}

const STEP_10 = extractStep10(skillContent);

describe("flow-pipeline SKILL.md step 10 — gh pr merge from primary worktree", () => {
  it('wraps every `gh pr merge --squash` invocation in `cd "$PRIMARY" && `', () => {
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
      stageBContent.includes(needle),
      `Stage B's merge agent must derive \`$PRIMARY\` via \`${needle}\` so the merge ` +
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
    //
    // Issue #486 re-litigated this exact negative pin (reopening the
    // no-`--body` question) and it was re-affirmed wontfix — see
    // references/git-workflow.md's "Why no authored squash body (issue #486)".
    const mergeInvocations = STEP_10.split("\n").filter(
      (line) => line.includes("gh pr merge") && line.includes('"$PR"'),
    );
    for (const line of mergeInvocations) {
      expect(
        line,
        `step 10 merge invocation must carry no --body/--subject: ${line}`,
      ).not.toMatch(/--body\b|--subject\b/);
    }
    expect(STEP_10).not.toMatch(/MERGE_FLAGS|flow-merge-body/);

    // The actual merge invocation moved into stage B's mergeOnce() helper
    // (workflows/core/flow-stage-b.workflow.js) — assert no --body/--subject
    // there either, and that MERGE_FLAGS / flow-merge-body never reappear.
    const stageBMergeLines = stageBContent
      .split("\n")
      .filter(
        (line) => line.includes("gh pr merge") && line.includes("${args.pr}"),
      );
    for (const line of stageBMergeLines) {
      expect(
        line,
        `flow-stage-b.workflow.js merge invocation must carry no --body/--subject: ${line}`,
      ).not.toMatch(/--body\b|--subject\b/);
    }
    expect(stageBContent).not.toMatch(/MERGE_FLAGS|flow-merge-body/);

    // The literal `gh pr merge --squash ${args.pr}` invocation must be
    // defined exactly once, inside mergeOnce, so every retry site shares
    // the same command instead of drifting per call site.
    const literalMergeOccurrences =
      stageBContent.match(/gh pr merge --squash \$\{args\.pr\}/g) ?? [];
    expect(
      literalMergeOccurrences,
      "flow-stage-b.workflow.js must define `gh pr merge --squash ${args.pr}` " +
        "exactly once, inside mergeOnce().",
    ).toHaveLength(1);

    // mergeOnce() must be called at exactly 3 sites: the initial merge, the
    // post-resolve retry, and the non-conflict retry.
    const mergeOnceCalls = stageBContent.match(/await mergeOnce\(/g) ?? [];
    expect(
      mergeOnceCalls,
      "flow-stage-b.workflow.js must call mergeOnce() at exactly 3 sites " +
        "(merge, merge-retry-after-resolve, merge-retry-non-conflict).",
    ).toHaveLength(3);
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

  it("a denied or died merge-resolver spawn folds into resolver-missing-artifact", () => {
    // The resolver's Task spawn now runs inside stage B
    // (workflows/core/flow-stage-b.workflow.js), not SKILL.md prose. A
    // denied/died spawn surfaces as a null agent() result; stage B must
    // null-guard it and fold it into the SAME outcome as a missing
    // resolver artifact (`resolver-missing-artifact`) rather than falling
    // through to a file read that would crash on the absent artifact.
    expect(
      /resolverAgentResult\s*===\s*null/.test(stageBContent),
      "flow-stage-b.workflow.js must null-guard the merge-resolver agent() result (a denied/died Task spawn).",
    ).toBe(true);
    const nullGuardIdx = stageBContent.search(
      /resolverAgentResult\s*===\s*null/,
    );
    const nullGuardBlock = stageBContent.slice(
      nullGuardIdx,
      nullGuardIdx + 400,
    );
    expect(
      nullGuardBlock.includes('"resolver-missing-artifact"'),
      "the null-guard branch must terminate with outcome `resolver-missing-artifact`.",
    ).toBe(true);

    // `## Stage B launch`'s outcome table must still branch that outcome
    // onto the existing NEEDS HUMAN render — deleting the row would leave
    // the escalation silently unrendered.
    const stageBLaunchIdx = skillContent.indexOf("## Stage B launch");
    expect(stageBLaunchIdx).toBeGreaterThan(-1);
    const stageBLaunchEnd = skillContent.indexOf("## Step 11", stageBLaunchIdx);
    const stageBLaunch = skillContent.slice(
      stageBLaunchIdx,
      stageBLaunchEnd > -1 ? stageBLaunchEnd : undefined,
    );
    expect(
      stageBLaunch.includes("`resolver-missing-artifact`") &&
        /NEEDS HUMAN: merge-resolver-missing-artifact/.test(stageBLaunch),
      "`## Stage B launch`'s outcome table must escalate `NEEDS HUMAN: merge-resolver-missing-artifact` on `.outcome` `resolver-missing-artifact`.",
    ).toBe(true);

    // The reason's NEXT ACTION line must still be non-empty.
    const gateSummarySrc = fs.readFileSync(
      path.resolve(HERE, "flow-gate-summary.ts"),
      "utf8",
    );
    expect(
      gateSummarySrc.includes('"merge-resolver-missing-artifact":'),
      "bin/flow-gate-summary.ts must define a NEXT_ACTION_BY_REASON entry for `merge-resolver-missing-artifact`.",
    ).toBe(true);
  });

  it("defines MARKER_CHECK_CMD via the flow-conflict-marker-check PATH helper", () => {
    // The resolver spawn now runs inside stage B
    // (workflows/core/flow-stage-b.workflow.js), which fills
    // MARKER_CHECK_CMD with the PATH-resolved name `flow-conflict-marker-check`
    // (verified on PATH by the installed symlink), not the bun-path form.
    expect(
      stageBContent.includes(
        'const markerCheckCmd = "flow-conflict-marker-check";',
      ),
      'flow-stage-b.workflow.js must define markerCheckCmd as "flow-conflict-marker-check".',
    ).toBe(true);
    expect(
      /MARKER_CHECK_CMD:\s*\$\{markerCheckCmd\}/.test(stageBContent),
      "flow-stage-b.workflow.js's resolver prompt must pass MARKER_CHECK_CMD via ${markerCheckCmd}.",
    ).toBe(true);
  });
});
