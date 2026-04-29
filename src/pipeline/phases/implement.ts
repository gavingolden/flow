import fs from "node:fs/promises";
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
import { runVerifyGate, surfaceVerifyFailureOnPr } from "./verify-gate.js";

const NON_INTERACTIVE_PREAMBLE = `You are running in non-interactive headless mode driven by the flow orchestrator.
Do not pause for confirmations or ask the user any clarifying questions. Work
through the entire skill end-to-end with reasonable assumptions, write all
deliverables, commit and push the branch, and write the PR body to the file
the orchestrator supplies — do not call \`gh pr create\` yourself.`;

const MANUAL_VALIDATION_RULE = `When you write the PR description, include a \`## Manual validation\` section.
Populate it with concrete steps if any of these apply: a database migration,
a new external API integration, a UI change (e.g. \`.svelte\` files in
\`src/lib/\`), or a behaviour change to a critical path. Otherwise leave the
section empty (just the heading and an HTML comment explaining the
convention). The orchestrator's gate phase reads this section to decide
whether to auto-merge.`;

export async function runImplementPhase(task: Task): Promise<PhaseResult> {
  // Legacy / already-complete: short-circuit only on the canonical
  // success state. `status: implementing` with `pr != null` is crash
  // recovery — fall through and re-run the gate against the open PR.
  if (task.frontmatter.pr != null && task.frontmatter.status === "pr-open") {
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

  const worktree = task.frontmatter.worktree;
  const branch = task.frontmatter.branch;
  const bodyDir = path.join(
    task.frontmatter.target_repo,
    ".orchestrator",
    "tasks",
    `${task.frontmatter.id}-implement`,
  );
  const bodyFilePath = path.join(bodyDir, "pr-body.md");
  await fs.mkdir(bodyDir, { recursive: true });

  const result = await retryOnce(async (_attempt, lastFailure) => {
    const prompt = buildImplementPrompt(task, bodyFilePath, lastFailure);
    const r = await runHeadless({
      cwd: worktree,
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
    if (!r.ok) {
      return { ok: false as const, error: r.error ?? `exit ${r.exitCode}` };
    }

    const gate = await runVerifyGate(worktree);
    if (gate.ok) return { ok: true as const, value: r };

    const truncated = truncate(gate.output, 4000);
    await appendPhaseOutput(
      task,
      "implement",
      `### verify-gate failure\n\n\`\`\`text\n${truncated}\n\`\`\``,
    );
    const existingPr = await detectOpenedPr(worktree, branch);
    if (existingPr != null) {
      await surfaceVerifyFailureOnPr(existingPr, worktree, truncated);
    }
    return {
      ok: false as const,
      error: `verify gate failed:\n${truncate(gate.output, 1500)}`,
    };
  });

  if (!result.ok) {
    return { status: "failed", reason: `implement phase failed: ${result.error}` };
  }

  let prNumber = await detectOpenedPr(worktree, branch);
  if (prNumber == null) {
    const bodyPath = await resolveBodyPath(task, bodyFilePath);
    const create = await execa("gh", ["pr", "create", "--body-file", bodyPath], {
      cwd: worktree,
      reject: false,
    });
    if (create.exitCode !== 0) {
      return {
        status: "failed",
        reason: `gh pr create failed: ${create.stderr || create.stdout || `exit ${create.exitCode}`}`,
      };
    }
    prNumber = await detectOpenedPr(worktree, branch);
  }

  if (prNumber == null) {
    return {
      status: "failed",
      reason: "implement phase opened a PR but 'gh pr list --head' returned no match",
    };
  }

  await updateTaskFrontmatter(task, { pr: prNumber });
  await appendPhaseOutput(
    task,
    "implement",
    `- PR: #${prNumber}\n- Branch: ${branch}`,
  );
  await transitionStatus(task, "pr-open");
  return { status: "ok" };
}

async function resolveBodyPath(task: Task, bodyFilePath: string): Promise<string> {
  if (existsSync(bodyFilePath)) return bodyFilePath;
  const fallback = path.join(
    task.frontmatter.target_repo,
    ".orchestrator",
    "tasks",
    `${task.frontmatter.id}-plan`,
    "pr-description-draft.md",
  );
  await appendPhaseOutput(
    task,
    "implement",
    `WARN: PR body file missing at ${bodyFilePath}; falling back to ${fallback}`,
  );
  return fallback;
}

function buildImplementPrompt(
  task: Task,
  bodyFilePath: string,
  lastFailure?: string,
): string {
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

Implement the feature, write tests, then commit and push the branch. Use
\`pr-description-draft.md\` as the starting point for the PR body. Write the
final PR body (including the \`## Manual validation\` section populated per
the rule below) to: ${bodyFilePath}

Do NOT call \`gh pr create\`. The orchestrator will run an independent
verify check and open the PR after the gate passes.

${MANUAL_VALIDATION_RULE}

Before exiting, confirm you have: (a) committed and pushed your changes on
branch ${task.frontmatter.branch}, and (b) written the PR body to
${bodyFilePath}.${failureNote}`;
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
