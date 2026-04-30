import fs from "node:fs/promises";
import path from "node:path";
import {
  Task,
  appendPhaseOutput,
  transitionStatus,
} from "../../state/task-file.js";
import { runHeadless } from "../headless.js";
import { retryN } from "../retry.js";
import { PhaseResult } from "../types.js";
import { NoopLogger, type Logger } from "../../util/logger.js";
import { NoopJsonlSink, type JsonlSink } from "../../util/jsonl-sink.js";

const NON_INTERACTIVE_PREAMBLE = `You are running in non-interactive headless mode driven by the flow orchestrator.
Do not pause for confirmations or ask the user any clarifying questions. Work
through the entire skill end-to-end with reasonable assumptions, write all
deliverables to disk, and exit when finished. If a question would normally
gate a confirmation, answer it yourself and proceed.`;

// Match the other LLM phases (implement / verify / review). 10 minutes was
// previously enough for trivial tasks but bigger PRDs reliably exhausted it
// during the research pass before any deliverable hit disk. The retry note
// (see buildPlanPrompt) flags the timeout so attempt 2 stops re-exploring.
const HEADLESS_TIMEOUT_MS = 30 * 60 * 1000;
// Sentinel prefix on the retry-thread error string. The plan callback emits
// this when execa reports `timedOut`; buildPlanPrompt branches on it to
// switch the retry guidance from "review the failure" to "stop researching,
// start writing." Anything else falls through to the generic-failure note.
const TIMEOUT_MARKER = "TIMEOUT:";

const PLAN_DELIVERABLES = [
  "prd.md",
  "task-breakdown.md",
  "pr-description-draft.md",
] as const;

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

  const result = await retryN(async (attempt, lastFailure) => {
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
      timeoutMs: HEADLESS_TIMEOUT_MS,
      logger,
      label: "claude (plan)",
      jsonl,
    });
    if (r.ok) return { ok: true as const, value: r };
    // Subprocess didn't exit cleanly, but if every deliverable is on disk
    // the skill effectively finished — most often this is a SIGTERM after
    // the model wrote all three files but kept exploring. Accept the work
    // instead of burning another attempt redoing it.
    const missing = await findMissingDeliverables(planDir);
    if (missing.length === 0) {
      logger.warn(
        `plan: subprocess exit=${r.exitCode}${r.timedOut ? " (timeout)" : ""} but all deliverables present — treating as success`,
      );
      return { ok: true as const, value: r };
    }
    const error = r.timedOut
      ? `${TIMEOUT_MARKER} subprocess killed after ${Math.round(HEADLESS_TIMEOUT_MS / 60_000)} minutes — missing deliverables: ${missing.join(", ")}`
      : (r.error ?? `exit ${r.exitCode}`);
    return { ok: false as const, error };
  }, 2);

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
    ? lastFailure.startsWith(TIMEOUT_MARKER)
      ? `\n\nPRIOR ATTEMPT TIMED OUT — ${lastFailure.slice(TIMEOUT_MARKER.length).trim()}.\n\nThe previous run spent its entire budget reading and exploring before writing anything. Be aggressive about cutting research short: skim, don't re-read, and start writing prd.md / task-breakdown.md / pr-description-draft.md within the first few minutes. Drafts you can refine in place beat perfect plans you never write.`
      : `\n\nPRIOR ATTEMPT FAILED — failure log:\n${truncate(lastFailure, 4000)}\n\nReview the failure, adjust your approach, and try again.`
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

async function findMissingDeliverables(planDir: string): Promise<string[]> {
  const missing: string[] = [];
  for (const name of PLAN_DELIVERABLES) {
    try {
      await fs.access(path.join(planDir, name));
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

async function summarizePlanOutputs(
  planDir: string,
  logger: Logger,
): Promise<string> {
  const missing = new Set(await findMissingDeliverables(planDir));
  const lines: string[] = [`- Plan directory: ${planDir}`];
  for (const name of PLAN_DELIVERABLES) {
    if (missing.has(name)) {
      lines.push(`- ${name}: MISSING`);
      logger.warn(`plan deliverable missing: ${name}`);
    } else {
      lines.push(`- ${name}: present`);
      logger.info(`plan deliverable present: ${name}`);
    }
  }
  return lines.join("\n");
}
