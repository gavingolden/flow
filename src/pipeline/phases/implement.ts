import path from "node:path";
import { existsSync } from "node:fs";
import { execa } from "execa";
import {
  Task,
  appendPhaseOutput,
  transitionStatus,
  updateTaskFrontmatter,
} from "../../state/task-file.js";
import { runHeadless } from "../headless.js";
import { retryOnce } from "../retry.js";
import { PhaseResult } from "../types.js";

const NON_INTERACTIVE_PREAMBLE = `You are running in non-interactive headless mode driven by the flow orchestrator.
Do not pause for confirmations or ask the user any clarifying questions. Work
through the entire skill end-to-end with reasonable assumptions, write all
deliverables, commit, push, and open the PR before exiting.`;

const MANUAL_VALIDATION_RULE = `The PR body must include a \`## Manual validation\` section. Edit
\`pr-description-draft.md\` on disk to add it before opening the PR.
Populate it with concrete steps if any of these apply: a database migration,
a new external API integration, a UI change (e.g. \`.svelte\` files in
\`src/lib/\`), or a behaviour change to a critical path. Otherwise leave the
section empty (just the heading and an HTML comment explaining the
convention). The orchestrator's gate phase reads this section to decide
whether to auto-merge.`;

export async function runImplementPhase(task: Task): Promise<PhaseResult> {
  // PR already populated → skip claude. Catch crash-recovery where pr was
  // set but the final transitionStatus didn't run.
  if (task.frontmatter.pr != null) {
    if (task.frontmatter.status !== "pr-open") {
      await transitionStatus(task, "pr-open");
    }
    return { status: "ok" };
  }
  if (!task.frontmatter.worktree || !existsSync(task.frontmatter.worktree)) {
    return {
      status: "failed",
      reason: `implement phase requires an existing worktree; got ${task.frontmatter.worktree ?? "(null)"}`,
    };
  }
  if (!task.frontmatter.branch) {
    return {
      status: "failed",
      reason: "implement phase requires a branch in frontmatter (set by worktree phase)",
    };
  }

  await transitionStatus(task, "implementing");

  const result = await retryOnce(async (_attempt, lastFailure) => {
    const prompt = buildImplementPrompt(task, lastFailure);
    const r = await runHeadless({
      cwd: task.frontmatter.worktree!,
      prompt,
      allowedTools: [
        "Read",
        "Write",
        "Edit",
        "MultiEdit",
        "Glob",
        "Grep",
        "Bash(npm *)",
        "Bash(git *)",
        "Bash(gh *)",
        "Bash(npx *)",
        "Bash(bun *)",
        "Bash(node *)",
      ],
      timeoutMs: 30 * 60 * 1000,
    });
    return r.ok
      ? { ok: true as const, value: r }
      : { ok: false as const, error: r.error ?? `exit ${r.exitCode}` };
  });

  if (!result.ok) {
    return { status: "failed", reason: `implement phase failed: ${result.error}` };
  }

  const prNumber = await detectOpenedPr(
    task.frontmatter.worktree!,
    task.frontmatter.branch,
  );
  if (prNumber == null) {
    return {
      status: "failed",
      reason: "implement phase exited 0 but no PR was found via 'gh pr list --head'",
    };
  }

  await updateTaskFrontmatter(task, { pr: prNumber });
  await appendPhaseOutput(
    task,
    "implement",
    `- PR: #${prNumber}\n- Branch: ${task.frontmatter.branch}`,
  );
  await transitionStatus(task, "pr-open");
  return { status: "ok" };
}

function buildImplementPrompt(task: Task, lastFailure?: string): string {
  const planDir = path.join(
    task.frontmatter.target_repo,
    ".orchestrator",
    "tasks",
    `${task.frontmatter.id}-plan`,
  );
  const taskFile = task.path;
  const userPromptArg = extractUserPrompt(task.body);
  const failureNote = lastFailure
    ? `\n\nPRIOR ATTEMPT FAILED — failure log:\n${truncate(lastFailure, 4000)}\n\nReview the failure, adjust your approach, and try again.`
    : "";

  return `${NON_INTERACTIVE_PREAMBLE}

You are running the *implement* phase for task ${task.frontmatter.id}.
You are operating inside the worktree at: ${task.frontmatter.worktree}
The feature branch is already checked out: ${task.frontmatter.branch}

Read these inputs first:
- Task file: ${taskFile}
- Plan deliverables in: ${planDir}
  - prd.md
  - task-breakdown.md
  - pr-description-draft.md  ← seed your PR body from this draft

Now invoke the project's implementation skill:

/new-feature ${userPromptArg}

Implement the feature, write tests, commit, and push the branch.

${MANUAL_VALIDATION_RULE}

When opening the PR, run:

\`gh pr create --title '<title>' --body-file ${planDir}/pr-description-draft.md\`

Do NOT inline the body, do NOT use a heredoc, do NOT pass \`--body\`.
Pointing \`gh\` directly at the file on disk is what keeps fenced code
blocks from being re-escaped on github.com. If you need to amend the
description (e.g. to add the Manual validation section above), edit
\`pr-description-draft.md\` in place first, then point \`gh\` at it.

Before exiting, confirm you have: (a) committed and pushed your changes, and
(b) opened a GitHub PR for branch ${task.frontmatter.branch}.${failureNote}`;
}

async function detectOpenedPr(
  worktreePath: string,
  branch: string,
): Promise<number | null> {
  const result = await execa(
    "gh",
    ["pr", "list", "--head", branch, "--json", "number", "--limit", "1"],
    { cwd: worktreePath, reject: false },
  );
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as Array<{ number: number }>;
    return parsed[0]?.number ?? null;
  } catch {
    return null;
  }
}

function extractUserPrompt(body: string): string {
  const match = body.match(/^## User prompt\s*\n([\s\S]*?)(?=\n## |$)/m);
  const captured = match?.[1];
  if (!captured) return "(see task file)";
  return captured.trim().replace(/\s+/g, " ").slice(0, 2000);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated]`;
}
