import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Doc-lint regression for `/flow-pipeline` step 10's merge invocation.
 *
 * Step 10 runs `flow-merge-guard merge "$PR"` as a standalone Bash call so
 * flow's launch-settings allow rule `Bash(flow-merge-guard merge *)` matches
 * it (a `$(...)` wrapper, pipe or `cd ... &&` prefix never would). The bare
 * `gh pr merge --squash` and its base-checkout cwd (gh's post-merge `git
 * checkout <base>` collides with a feature worktree) live in the helper and
 * are pinned by bin/flow-merge-guard.test.ts. This lint pins the SKILL.md
 * call shape and the matching auto-merge-rubric.md row.
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

describe("flow-pipeline SKILL.md step 10 — standalone gate-checked merge", () => {
  it('invokes `flow-merge-guard merge "$PR"` as its own standalone Bash call', () => {
    // flow's launch-settings allow rule `Bash(flow-merge-guard merge *)`
    // only matches a standalone call: a `$(...)` wrapper, a pipe or a
    // `cd ... &&` prefix falls back to the permission classifier.
    const needle = 'flow-merge-guard merge "$PR"';
    const fenceLines = STEP_10.split("\n").filter((l) => l.trim() === needle);
    expect(
      fenceLines.length,
      `step 10 must carry a fenced line that is exactly \`${needle}\``,
    ).toBeGreaterThanOrEqual(1);
    const wrapped = STEP_10.split("\n").filter(
      (l) =>
        l.includes(needle) &&
        !l.startsWith("`") &&
        l.trim() !== needle &&
        /(\$\(|\||&&|;\s*flow-merge-guard|^\s*\w+=)/.test(
          l.slice(0, l.indexOf(needle) + needle.length),
        ),
    );
    expect(
      wrapped,
      `no \`${needle}\` invocation may sit inside $(...), a pipe, or a cd/&& prefix:\n${wrapped.join("\n")}`,
    ).toEqual([]);
    expect(STEP_10).not.toMatch(/\$\(\s*flow-merge-guard/);
    expect(STEP_10).not.toMatch(/=\$\(flow-merge-guard/);
  });

  it("reads .flow-tmp/merge-result.json instead of capturing stdout", () => {
    expect(STEP_10).toContain(".flow-tmp/merge-result.json");
    expect(STEP_10).not.toMatch(/GUARD_JSON|GUARD_RC/);
  });

  it("contains no raw `gh pr merge` invocation and no `$PRIMARY` plumbing (the merge happens inside the helper, from the base checkout)", () => {
    expect(STEP_10).not.toMatch(/gh pr merge --squash "\$PR"/);
    expect(STEP_10).not.toMatch(/PRIMARY=|\$PRIMARY|\$\{PRIMARY\}/);
    const mergeInvocations = STEP_10.split("\n").filter(
      (line) => line.includes("gh pr merge") && line.includes('"$PR"'),
    );
    expect(mergeInvocations).toEqual([]);
  });

  it("pins the absence of the removed --body / MERGE_FLAGS / flow-merge-body machinery", () => {
    // PR #213 reverted step 10 to a bare `gh pr merge --squash` — now run
    // inside `flow-merge-guard merge` (bin/flow-merge-guard.test.ts pins the
    // bare argv and the base-checkout cwd). Without this negative assertion
    // a future edit that reintroduces `--body` manipulation to the step 10
    // prose would pass the whole vitest suite. Issue #486 re-litigated the
    // question and it was re-affirmed wontfix — see
    // references/git-workflow.md's "Why no authored squash body (issue #486)".
    expect(STEP_10).not.toMatch(/MERGE_FLAGS|flow-merge-body/);
  });

  it("keeps the auto-merge rubric's action row in sync with the standalone merge call", () => {
    const needle = "`flow-merge-guard merge <pr>`";
    expect(
      rubricContent.includes(needle),
      `auto-merge-rubric.md must reference the standalone gate-checked ` +
        `merge \`${needle}\` in its OPEN/0/auto-merge action so the rubric ` +
        `and the executable step 10 agree.`,
    ).toBe(true);
    expect(rubricContent).not.toContain('(cd "$PRIMARY" && gh pr merge');
  });

  it("shows the rubric's GATED stdout example with the gate-checked merge command", () => {
    expect(rubricContent).toContain(
      "NEXT ACTION: tick each step once validated, then run: flow-merge-guard merge",
    );
  });

  it("routes merge refusals by .reason instead of one catch-all tag", () => {
    for (const needle of [
      "`checks-pending` / `checks-unreadable`",
      "`checks-failed`",
      "`gate-blocked`",
      "`merge-refused`",
      '--reason "$TAG"',
    ]) {
      expect(STEP_10).toContain(needle);
    }
    expect(STEP_10).toContain("gate-override-without-confirmation");
  });

  it("re-enters step 7 after a resolver push instead of re-running the merge immediately", () => {
    const at = STEP_10.indexOf("`push_status`. If `succeeded`");
    expect(at).toBeGreaterThan(-1);
    const item = STEP_10.slice(at, at + 700);
    expect(item).toMatch(/re-enter step 7/);
    expect(item).not.toMatch(/exactly once/);
  });

  it("routes a permission-refused merge call to the merge-permission-denied pause with its own reap", () => {
    const at = STEP_10.indexOf("--reason merge-permission-denied");
    expect(at).toBeGreaterThan(-1);
    expect(
      STEP_10.lastIndexOf("flow-browser-teardown --reap --record", at),
    ).toBeGreaterThan(STEP_10.indexOf("flow-merge-guard merge"));
    expect(STEP_10).toMatch(/never try another merge command/);
  });

  it('runs the resolver-spawn fetch as `git -C "$WORKTREE" fetch origin "$BASE_BRANCH"` (no cd wrapper)', () => {
    // `git -C` keeps the supervisor's cwd put (a `cd` in a compound command
    // trips the permission classifier) while still fetching from the per-task
    // worktree, not the supervisor's ambient CWD.
    const pinned = 'git -C "$WORKTREE" fetch origin "$BASE_BRANCH"';
    expect(STEP_10).toContain(pinned);
    const offending = STEP_10.split("\n")
      .map((line, idx) => ({ line, idx }))
      .filter(
        ({ line }) =>
          line.includes('fetch origin "$BASE_BRANCH"') &&
          !line.includes(pinned),
      )
      .map(({ line, idx }) => `step10:line ${idx + 1}: ${line}`);
    expect(
      offending,
      `Every step-10 \`fetch origin "$BASE_BRANCH"\` must be \`${pinned}\`:\n${offending.join("\n")}`,
    ).toEqual([]);
  });

  it('computes CONFLICTING_FILES with `git -C "$WORKTREE" diff --name-only --diff-filter=U` (no cd wrapper)', () => {
    const pinned = 'git -C "$WORKTREE" diff --name-only --diff-filter=U';
    expect(STEP_10).toContain(pinned);
    const offending = STEP_10.split("\n")
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => {
        const at = line.indexOf("git diff --name-only --diff-filter=U");
        if (at === -1) return false;
        // Prose mentions inside an inline code span are not invocations.
        return !line.slice(0, at).includes("`");
      })
      .map(({ line, idx }) => `step10:line ${idx + 1}: ${line}`);
    expect(
      offending,
      `Every step-10 conflict-file diff invocation must be \`${pinned}\` so ` +
        `\`CONFLICTING_FILES\` is computed from the per-task worktree's index:\n${offending.join("\n")}`,
    ).toEqual([]);
    expect(STEP_10).not.toMatch(/cd "\$WORKTREE" && git/);
  });

  it("structurally pins the merge-resolver-spawn-denied escalation branch", () => {
    // Deleting this branch (and its reason tag) leaves the suite green
    // plus an orphan `merge-resolver-spawn-denied` key in
    // NEXT_ACTION_BY_REASON and an orphan failure-recovery row in
    // auto-merge-rubric.md — nothing else in this repo pins its presence.
    expect(
      STEP_10.includes("merge-resolver-spawn-denied"),
      "step 10 must escalate `NEEDS HUMAN: merge-resolver-spawn-denied` on a Task spawn denial.",
    ).toBe(true);
    expect(
      /do \*\*not\*\* resolve inline/i.test(STEP_10),
      "step 10's spawn-denial branch must forbid inline resolution in the supervisor.",
    ).toBe(true);
    expect(
      STEP_10.includes("flow-gate-summary --status needs-human --reason"),
      "step 10's spawn-denial branch must call flow-gate-summary to render the escalation.",
    ).toBe(true);
    // The `merge-resolver-spawn-denied` key itself must exist so the
    // rendered NEXT ACTION line is non-empty.
    const gateSummarySrc = fs.readFileSync(
      path.resolve(HERE, "flow-gate-summary.ts"),
      "utf8",
    );
    expect(
      gateSummarySrc.includes('"merge-resolver-spawn-denied":'),
      "bin/flow-gate-summary.ts must define a NEXT_ACTION_BY_REASON entry for `merge-resolver-spawn-denied`.",
    ).toBe(true);
  });

  it("defines $MARKER_CHECK_CMD via `bun $FLOW_ROOT/bin/flow-conflict-marker-check.ts`", () => {
    // Both consumers (step 5's per-file check and the resolver instructions)
    // are pinned elsewhere; this pins the PRODUCER line that defines the
    // variable, so a refold can't drop it with every other lint green.
    expect(
      STEP_10.includes(
        'MARKER_CHECK_CMD="bun $FLOW_ROOT/bin/flow-conflict-marker-check.ts"',
      ),
      "step 10 must define MARKER_CHECK_CMD as `bun $FLOW_ROOT/bin/flow-conflict-marker-check.ts`.",
    ).toBe(true);
  });

  it("resolves FLOW_ROOT to the checkout from a private skill copy that has no bin/", () => {
    const start = STEP_10.indexOf('FLOW_ROOT=$(cd -P "$SKILL_DIR');
    const end = STEP_10.indexOf("; MARKER_CHECK_CMD=", start);
    expect(start).toBeGreaterThan(-1);
    const assignments = STEP_10.slice(start, end);
    const tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "flow-step10-root-")),
    );
    try {
      const checkout = path.join(tmp, "checkout");
      fs.mkdirSync(path.join(checkout, "bin"), { recursive: true });
      fs.writeFileSync(
        path.join(checkout, "bin", "flow-conflict-marker-check"),
        "",
      );
      const pluginRoot = path.join(tmp, "copy", "flow-module-core");
      const skillDir = path.join(pluginRoot, "skills", "flow-pipeline");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.mkdirSync(path.join(pluginRoot, "bin"));
      fs.symlinkSync(
        path.join(checkout, "bin", "flow-conflict-marker-check"),
        path.join(pluginRoot, "bin", "flow-conflict-marker-check"),
      );
      const r = spawnSync(
        "bash",
        ["-c", `${assignments}; printf '%s' "$FLOW_ROOT"`],
        { env: { ...process.env, SKILL_DIR: skillDir }, encoding: "utf8" },
      );
      expect(r.stdout).toBe(checkout);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

const REPO_ROOT = path.resolve(HERE, "..");

function markdownFilesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return markdownFilesUnder(full);
    return e.name.endsWith(".md") ? [full] : [];
  });
}

const MERGE_COMMAND = /gh pr merge|flow-merge-guard merge/g;
const COMPOUND_PREFIX = /\bcd\s|\(|\$\(|&&/;

/**
 * 1-based line numbers where a merge command sits behind a `cd`, subshell,
 * `$(` or `&&`. The prefix is the text before the command back to the nearest
 * backtick, `|`, double quote, `;` or line start; an immediate `Bash(` prefix
 * is permission-rule text, not an invocation.
 */
export function compoundMergeLines(text: string): number[] {
  const hits: number[] = [];
  text.split("\n").forEach((line, idx) => {
    for (const m of line.matchAll(MERGE_COMMAND)) {
      const before = line.slice(0, m.index);
      const cut = Math.max(
        before.lastIndexOf("`"),
        before.lastIndexOf("|"),
        before.lastIndexOf('"'),
        before.lastIndexOf(";"),
      );
      const prefix = before.slice(cut + 1);
      if (prefix === "Bash(") continue;
      if (COMPOUND_PREFIX.test(prefix)) hits.push(idx + 1);
    }
  });
  return hits;
}

describe("manual-merge instructions are one standalone gate-checked command", () => {
  it("no skill, reference or gate-summary text puts a cd / subshell / && before a merge command", () => {
    const files = [
      ...markdownFilesUnder(path.join(REPO_ROOT, "skills")),
      ...markdownFilesUnder(path.join(REPO_ROOT, "references")),
      path.join(REPO_ROOT, "bin", "flow-gate-summary.ts"),
    ];
    expect(files.length).toBeGreaterThan(10);
    const offending = files.flatMap((f) =>
      compoundMergeLines(fs.readFileSync(f, "utf8")).map(
        (n) => `${path.relative(REPO_ROOT, f)}:${n}`,
      ),
    );
    expect(
      offending,
      `a human-facing merge command must be standalone (a cd/subshell/&& prefix ` +
        `falls back to the permission classifier and skips the Test Steps gate):\n${offending.join("\n")}`,
    ).toEqual([]);
  });

  it("the pin itself flags a reintroduced `(cd <repo> && gh pr merge` and spares rule text", () => {
    expect(
      compoundMergeLines("run (cd <repo> && gh pr merge --squash 5) now"),
    ).toEqual([1]);
    expect(compoundMergeLines("cd /repo && flow-merge-guard merge 5")).toEqual([
      1,
    ]);
    expect(
      compoundMergeLines("x=$(flow-merge-guard merge 5 --slug s)"),
    ).toEqual([1]);
    expect(compoundMergeLines("`Bash(flow-merge-guard merge *)`")).toEqual([]);
    expect(
      compoundMergeLines("`flow-merge-guard merge 5 --slug s` in a terminal"),
    ).toEqual([]);
  });
});
