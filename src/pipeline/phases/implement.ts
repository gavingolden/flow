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
import { type AttemptResult } from "../retry.js";
import { PhaseResult } from "../types.js";
import { NoopLogger, type Logger } from "../../util/logger.js";
import { NoopJsonlSink, type JsonlSink } from "../../util/jsonl-sink.js";

// Discriminated union: `failureLog` is required exactly when `mode === "fix"`,
// so TypeScript enforces it at every call site rather than relying on
// implementer discipline.
export type ImplementOpts =
  | { mode: "create" }
  | { mode: "fix"; failureLog: string };

const NON_INTERACTIVE_PREAMBLE = `You are running in non-interactive headless mode driven by the flow orchestrator.
Do not pause for confirmations or ask the user any clarifying questions. Work
through the entire skill end-to-end with reasonable assumptions, write all
deliverables, commit and push the branch, and write the PR body to the file
the orchestrator supplies — do not call \`gh pr create\` yourself.`;

const MANUAL_VALIDATION_RULE = `The PR body must include a \`## Manual validation\` section. Edit
\`pr-description-draft.md\` on disk to add it before opening the PR.
Populate it with concrete steps if any of these apply: a database migration,
a new external API integration, a UI change (e.g. \`.svelte\` files in
\`src/lib/\`), or a behaviour change to a critical path. Otherwise leave the
section empty (just the heading and an HTML comment explaining the
convention). The orchestrator's gate phase reads this section to decide
whether to auto-merge.`;

const ALLOWED_TOOLS = [
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
];

const HEADLESS_TIMEOUT_MS = 30 * 60 * 1000;

export async function runImplementPhase(
  task: Task,
  opts: ImplementOpts,
  logger: Logger = NoopLogger,
  jsonl: JsonlSink = NoopJsonlSink,
): Promise<PhaseResult> {
  if (!task.frontmatter.worktree || !existsSync(task.frontmatter.worktree)) {
    const reason = `implement phase requires an existing worktree; got ${task.frontmatter.worktree ?? "(null)"}`;
    logger.error(reason);
    return { status: "failed", reason };
  }
  if (!task.frontmatter.branch) {
    const reason = "implement phase requires a branch in frontmatter (set by worktree phase)";
    logger.error(reason);
    return { status: "failed", reason };
  }

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

  if (opts.mode === "create") {
    return runCreate(task, worktree, branch, bodyFilePath, logger, jsonl);
  }
  return runFix(
    task,
    worktree,
    branch,
    bodyFilePath,
    opts.failureLog,
    logger,
    jsonl,
  );
}

async function runCreate(
  task: Task,
  worktree: string,
  branch: string,
  bodyFilePath: string,
  logger: Logger,
  jsonl: JsonlSink,
): Promise<PhaseResult> {
  // Entry gate: if a PR already exists for this branch — either persisted in
  // frontmatter (`pr != null`) or live on the remote (`detectOpenedPr` hit) —
  // the work-product is achieved. Skip the LLM, reconcile any frontmatter /
  // status drift, and return ok. Covers two distinct crash windows in one
  // block: status not yet transitioned to pr-open, and pr not yet persisted
  // in frontmatter despite a branch already carrying an open PR.
  const preexisting =
    task.frontmatter.pr ?? (await detectOpenedPr(worktree, branch));
  if (preexisting != null) {
    if (task.frontmatter.pr == null) {
      await updateTaskFrontmatter(task, { pr: preexisting });
      logger.event("task.frontmatter", `pr=${preexisting}`);
    }
    if (task.frontmatter.status !== "pr-open") {
      await transitionStatus(task, "pr-open");
      logger.event("task.status", "pr-open");
    }
    return { status: "ok" };
  }

  await transitionStatus(task, "implementing");
  logger.event("task.status", "implementing");

  const result = await runImplementAttempt(
    task,
    worktree,
    branch,
    bodyFilePath,
    1,
    undefined,
    logger,
    jsonl,
  );

  if (!result.ok) {
    logger.error(`implement: ${result.error}`);
    return { status: "failed", reason: `implement phase failed: ${result.error}` };
  }

  // Side-effect gate: re-probe before `gh pr create` in case the LLM pushed
  // and opened a PR itself. Mitigates the "crash between push and PR-create"
  // race for the rare path that gets past the entry gate.
  let prNumber = await detectOpenedPr(worktree, branch);
  if (prNumber == null) {
    const bodyPath = await resolveBodyPath(task, bodyFilePath, logger);
    logger.event(
      "subprocess.spawn",
      `gh pr create --fill-first --body-file ${bodyPath}`,
    );
    const create = await execa(
      "gh",
      ["pr", "create", "--fill-first", "--body-file", bodyPath],
      { cwd: worktree, reject: false },
    );
    logger.event("subprocess.exit", `gh pr create exit=${create.exitCode}`);
    if (create.exitCode !== 0) {
      const reason = `gh pr create failed: ${create.stderr || create.stdout || `exit ${create.exitCode}`}`;
      logger.error(reason);
      return { status: "failed", reason };
    }
    prNumber = await detectOpenedPr(worktree, branch);
  }

  if (prNumber == null) {
    const reason = "implement phase opened a PR but 'gh pr list --head' returned no match";
    logger.error(reason);
    return { status: "failed", reason };
  }

  logger.event("pr.opened", `#${prNumber}`);
  await updateTaskFrontmatter(task, { pr: prNumber });
  logger.event("task.frontmatter", `pr=${prNumber}`);
  await appendPhaseOutput(
    task,
    "implement",
    `- PR: #${prNumber}\n- Branch: ${branch}`,
  );
  await transitionStatus(task, "pr-open");
  logger.event("task.status", "pr-open");
  return { status: "ok" };
}

// Fix mode: caller invoked deliberately against an existing PR (PR 7 review
// loop-back). Single-shot — the caller owns the retry loop, so an inner
// retry would compound non-deterministically. Never calls `gh pr create`,
// never mutates `task.frontmatter.pr`, never transitions to `"pr-open"`
// (the caller owns the post-fix transition since the task is already past
// `"pr-open"` by the time fix is invoked).
async function runFix(
  task: Task,
  worktree: string,
  branch: string,
  bodyFilePath: string,
  failureLog: string,
  logger: Logger,
  jsonl: JsonlSink,
): Promise<PhaseResult> {
  await transitionStatus(task, "implementing");
  logger.event("task.status", "implementing");

  const result = await runImplementAttempt(
    task,
    worktree,
    branch,
    bodyFilePath,
    1,
    failureLog,
    logger,
    jsonl,
  );

  if (!result.ok) {
    logger.error(`implement: ${result.error}`);
    return { status: "failed", reason: `implement phase failed: ${result.error}` };
  }
  return { status: "ok" };
}

async function runImplementAttempt(
  task: Task,
  worktree: string,
  branch: string,
  bodyFilePath: string,
  attemptNum: number,
  failureNote: string | undefined,
  logger: Logger,
  jsonl: JsonlSink,
): Promise<AttemptResult<void>> {
  if (attemptNum > 1) {
    logger.warn(
      `implement attempt ${attemptNum} after failure: ${truncate(failureNote ?? "", 200)}`,
    );
  }
  const prompt = buildImplementPrompt(task, bodyFilePath, failureNote);
  logger.info(`implement: invoking claude (attempt ${attemptNum})`);
  const r = await runHeadless({
    cwd: worktree,
    prompt,
    allowedTools: ALLOWED_TOOLS,
    timeoutMs: HEADLESS_TIMEOUT_MS,
    logger,
    label: "claude (implement)",
    jsonl,
  });
  if (!r.ok) {
    return { ok: false, error: r.error ?? `exit ${r.exitCode}` };
  }
  return { ok: true, value: undefined };
}

async function resolveBodyPath(
  task: Task,
  bodyFilePath: string,
  logger: Logger,
): Promise<string> {
  if (existsSync(bodyFilePath)) return bodyFilePath;
  const fallback = path.join(
    task.frontmatter.target_repo,
    ".orchestrator",
    "tasks",
    `${task.frontmatter.id}-plan`,
    "pr-description-draft.md",
  );
  logger.warn(`PR body file missing at ${bodyFilePath}; falling back to ${fallback}`);
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
  failureNote?: string,
): string {
  const planDir = path.join(
    task.frontmatter.target_repo,
    ".orchestrator",
    "tasks",
    `${task.frontmatter.id}-plan`,
  );
  const taskFile = task.path;
  const userPromptArg = extractUserPrompt(task.body);
  const failureBlock = failureNote
    ? `\n\nPRIOR ATTEMPT FAILED — failure log:\n${truncate(failureNote, 4000)}\n\nReview the failure, adjust your approach, and try again.`
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

Do NOT call \`gh pr create\`. The orchestrator opens the PR after your
run completes; verification runs as a later phase.

${MANUAL_VALIDATION_RULE}

Before exiting, confirm you have: (a) committed and pushed your changes on
branch ${task.frontmatter.branch}, and (b) written the PR body to
${bodyFilePath}.${failureBlock}`;
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
