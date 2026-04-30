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
  await appendPhaseOutput(task, "plan", summary.text);
  logger.event("task.appendPhaseOutput", "plan");
  if (summary.blocked) {
    // The runner only translates `result.status` into a phaseEnd outcome
    // string — it does not call `transitionStatus` for non-ok results.
    // Mirror the explicit transition the `planned` happy path does below
    // so the on-disk status reflects the block (otherwise `/flow-status`
    // shows `planning` and the next `flow run` re-enters the phase).
    await transitionStatus(task, "needs-human", "plan-blocked");
    logger.event("task.status", "needs-human");
    logger.warn("plan: BLOCKED.md present — escalating to needs-human");
    return { status: "needs-human", reason: "plan-blocked" };
  }
  await transitionStatus(task, "planned");
  logger.event("task.status", "planned");
  return { status: "ok" };
}

export function buildPlanPrompt(
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
  const revisionNote = buildRevisionNoteSection(task.body);

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

Escape hatch — if you encounter a load-bearing question you cannot resolve
from ${taskFile} alone (e.g. an ambiguity that would force you to guess at
which way the user wants the feature to behave), DO NOT guess and DO NOT
produce the normal artefacts. Instead, write a single file
${planDir}/BLOCKED.md containing the question(s) the user must answer,
phrased so the user can resolve them by editing the task body or running
/flow-revise. The orchestrator will surface BLOCKED.md to the user and
pause the pipeline.

Do not present the plan to the user for review or wait for approval — the
orchestrator will read the files directly. Generate the artefacts and exit.${failureNote}${revisionNote}`;
}

// Reads the latest entry from the body's `## Revision notes` section (if
// present) and emits a dedicated `REVISION NOTES:` block. Distinct from
// the failure-note slot above — failure means "you broke, retry"; revision
// means "user redirected, re-plan." Conflating the two would muddle the
// prompt. Only the latest entry is threaded; older entries stay in the
// body for audit but aren't re-injected (avoids prompt growth and matches
// "the user redirected most recently with this").
function buildRevisionNoteSection(body: string): string {
  const latest = extractLatestRevisionNote(body);
  if (!latest) return "";
  return `\n\nREVISION NOTES — the user paused the previous plan and asked you to re-plan with this redirection:\n${truncate(latest, 4000)}\n\nIncorporate the redirection into the new plan; the old artefacts in the plan directory may be overwritten.`;
}

function extractLatestRevisionNote(body: string): string | null {
  const sectionMatch = body.match(
    /^## Revision notes\b[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/m,
  );
  const section = sectionMatch?.[1]?.trim();
  if (!section) return null;
  // Each entry begins with `- <ISO ts>:` at column 0; continuation lines
  // are indented. Walk backwards through the section to find the start of
  // the last entry.
  const lines = section.split("\n");
  let lastEntryStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^- /.test(lines[i] ?? "")) {
      lastEntryStart = i;
      break;
    }
  }
  if (lastEntryStart === -1) return section;
  return lines.slice(lastEntryStart).join("\n").trim();
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

export interface PlanOutputSummary {
  text: string;
  blocked: boolean;
}

const BLOCKED_CONTENT_MAX = 4000;

export async function summarizePlanOutputs(
  planDir: string,
  logger: Logger,
): Promise<PlanOutputSummary> {
  const blockedPath = path.join(planDir, "BLOCKED.md");
  let blockedContent: string | null = null;
  try {
    blockedContent = await fs.readFile(blockedPath, "utf8");
  } catch {
    blockedContent = null;
  }
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
  if (blockedContent != null) {
    lines.push("- BLOCKED.md: present");
    lines.push("");
    lines.push("BLOCKED:");
    lines.push("");
    lines.push(truncate(blockedContent.trim(), BLOCKED_CONTENT_MAX));
    logger.warn("plan: BLOCKED.md present");
  }
  return { text: lines.join("\n"), blocked: blockedContent != null };
}
