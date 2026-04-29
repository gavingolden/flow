import fs from "node:fs/promises";
import path from "node:path";
import {
  Task,
  appendPhaseOutput,
  transitionStatus,
} from "../../state/task-file.js";
import { runHeadless } from "../headless.js";
import { retryOnce } from "../retry.js";
import { PhaseResult } from "../types.js";
import { NoopLogger, type Logger } from "../../util/logger.js";
import { NoopJsonlSink, type JsonlSink } from "../../util/jsonl-sink.js";

const NON_INTERACTIVE_PREAMBLE = `You are running in non-interactive headless mode driven by the flow orchestrator.
Do not pause for confirmations or ask the user any clarifying questions. Work
through the entire skill end-to-end with reasonable assumptions, write all
deliverables to disk, and exit when finished. If a question would normally
gate a confirmation, answer it yourself and proceed.`;

export async function runPlanPhase(
  task: Task,
  logger: Logger = NoopLogger,
  jsonl: JsonlSink = NoopJsonlSink,
): Promise<PhaseResult> {
  if (task.frontmatter.status === "planned") return { status: "ok" };
  if (!task.frontmatter.worktree) {
    return {
      status: "failed",
      reason: "plan phase requires frontmatter.worktree (set by worktree phase)",
    };
  }
  await transitionStatus(task, "planning");
  logger.event("task.status", "planning");

  const planDir = path.join(
    task.frontmatter.target_repo,
    ".orchestrator",
    "tasks",
    `${task.frontmatter.id}-plan`,
  );
  await fs.mkdir(planDir, { recursive: true });
  logger.event("plan.dir", planDir);

  const result = await retryOnce(async (attempt, lastFailure) => {
    if (attempt > 1) {
      logger.warn(
        `plan attempt ${attempt} after failure: ${truncate(lastFailure ?? "", 200)}`,
      );
    }
    const prompt = buildPlanPrompt(task, planDir, lastFailure);
    logger.info(`plan: invoking claude (attempt ${attempt})`);
    const r = await runHeadless({
      cwd: task.frontmatter.worktree!,
      prompt,
      allowedTools: [
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "Bash(ls *)",
        "Bash(cat *)",
      ],
      timeoutMs: 10 * 60 * 1000,
      logger,
      label: "claude (plan)",
      jsonl,
    });
    return r.ok
      ? { ok: true as const, value: r }
      : { ok: false as const, error: r.error ?? `exit ${r.exitCode}` };
  });

  if (!result.ok) {
    logger.error(`plan: ${result.error}`);
    return { status: "failed", reason: `plan phase failed: ${result.error}` };
  }

  const summary = await summarizePlanOutputs(planDir, logger);
  await appendPhaseOutput(task, "plan", summary);
  logger.event("task.appendPhaseOutput", "plan");
  await transitionStatus(task, "planned");
  logger.event("task.status", "planned");
  return { status: "ok" };
}

function buildPlanPrompt(
  task: Task,
  planDir: string,
  lastFailure?: string,
): string {
  const taskFile = task.path;
  const userPromptArg = extractUserPrompt(task.body);
  const failureNote = lastFailure
    ? `\n\nPRIOR ATTEMPT FAILED — failure log:\n${truncate(lastFailure, 4000)}\n\nReview the failure, adjust your approach, and try again.`
    : "";

  return `${NON_INTERACTIVE_PREAMBLE}

You are running the *plan* phase for task ${task.frontmatter.id}.

The task file is at: ${taskFile}
Read it to understand:
- ## User prompt — the verbatim user request
- ## Triage — intent and summary
- ## Clarifications — what was settled in triage
- ## Constraints / out of scope — explicit exclusions
- ## Open questions — anything still unresolved

Now invoke the project's planning skill:

/product-planning ${userPromptArg}

Write all deliverables into this directory:
${planDir}

Specifically, ensure the following files exist there when you finish:
- prd.md           — the full PRD
- task-breakdown.md — ordered task list with skill assignments
- pr-description-draft.md — the PR description draft

Do not present the plan to the user for review or wait for approval — the
orchestrator will read the files directly. Generate the artefacts and exit.${failureNote}`;
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

async function summarizePlanOutputs(
  planDir: string,
  logger: Logger,
): Promise<string> {
  const expected = ["prd.md", "task-breakdown.md", "pr-description-draft.md"];
  const lines: string[] = [`- Plan directory: ${planDir}`];
  for (const name of expected) {
    const p = path.join(planDir, name);
    try {
      await fs.access(p);
      lines.push(`- ${name}: present`);
      logger.info(`plan deliverable present: ${name}`);
    } catch {
      lines.push(`- ${name}: MISSING`);
      logger.warn(`plan deliverable missing: ${name}`);
    }
  }
  return lines.join("\n");
}
