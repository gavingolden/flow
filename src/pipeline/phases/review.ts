import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  Task,
  appendPhaseOutput,
  readTask,
  transitionStatus,
} from "../../state/task-file.js";
import { runHeadless } from "../headless.js";
import { PhaseResult } from "../types.js";
import { runCiWaitPhase } from "./ci-wait.js";
import { NoopLogger, type Logger } from "../../util/logger.js";
import { NoopJsonlSink, type JsonlSink } from "../../util/jsonl-sink.js";

// ---------- Output JSON contract ----------------------------------------

export type DeferredKind = "code" | "architectural";

export interface AddressedFinding {
  file: string;
  line: number;
  summary: string;
}

export interface DeferredFinding {
  file: string;
  line: number;
  summary: string;
  kind: DeferredKind;
  // Path or URL to the tracker entry the skill logged
  // (e.g. "docs/roadmap.md#followup-foo", "gh:repo#42").
  tracker_ref: string;
}

export interface ReviewSummary {
  // Mode the skill picked at Step 3.
  mode: "address" | "review";
  // True if the skill pushed any commit during this run.
  // Drives the orchestrator's conditional ci-wait back-edge.
  committed: boolean;
  // True iff any deferred finding has kind: "architectural".
  escalate: boolean;
  // Reason string when escalate = true; empty otherwise.
  reason: string;
  addressed: AddressedFinding[];
  deferred: DeferredFinding[];
}

export type ParseReviewSummary =
  | { ok: true; value: ReviewSummary }
  | { ok: false; error: string };

// ---------- Constants ----------------------------------------------------

// Bot review excerpts pulled from `## Phase outputs > ci` are inlined into
// the review prompt verbatim. Cap at ~4 KB so a chatty Copilot summary
// can't blow the prompt budget.
const CI_EXCERPT_BUDGET_BYTES = 4 * 1024;

// Subprocess timeout: /pr-review (Address mode + auto-fix + pre-commit
// checks) typically finishes in 5–15 minutes; 30-min cap leaves headroom
// for slow gh API calls without becoming a runaway.
const HEADLESS_TIMEOUT_MS = 30 * 60 * 1000;

const ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "Task",
  "Bash(gh *)",
  "Bash(git *)",
  "Bash(npm *)",
  "Bash(npx *)",
  "Bash(bun *)",
  "Bash(node *)",
];

const NON_INTERACTIVE_PREAMBLE = `You are running in non-interactive headless mode driven by the flow orchestrator.
Do not pause for confirmations or ask the user any clarifying questions. Run
the /pr-review skill end-to-end exactly as it would run interactively: detect
mode (Address vs Review), perform the independent multi-agent review,
auto-fix findings, address any existing inline comments, commit, push, and
reply.`;

// ---------- Pure helpers --------------------------------------------------

export function parseReviewSummary(json: string): ParseReviewSummary {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `JSON.parse failed: ${(err as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "expected an object at the JSON root" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.mode !== "address" && obj.mode !== "review") {
    return {
      ok: false,
      error: `\`mode\` must be "address" or "review"; got ${JSON.stringify(obj.mode)}`,
    };
  }
  if (typeof obj.committed !== "boolean") {
    return { ok: false, error: "missing or non-boolean `committed`" };
  }
  if (typeof obj.escalate !== "boolean") {
    return { ok: false, error: "missing or non-boolean `escalate`" };
  }
  if (typeof obj.reason !== "string") {
    return { ok: false, error: "missing or non-string `reason`" };
  }
  if (!Array.isArray(obj.addressed)) {
    return { ok: false, error: "missing or non-array `addressed`" };
  }
  if (!Array.isArray(obj.deferred)) {
    return { ok: false, error: "missing or non-array `deferred`" };
  }

  const addressed: AddressedFinding[] = [];
  for (let i = 0; i < obj.addressed.length; i++) {
    const item = obj.addressed[i] as Record<string, unknown>;
    if (typeof item !== "object" || item === null) {
      return { ok: false, error: `addressed[${i}]: expected object` };
    }
    if (typeof item.file !== "string" || typeof item.summary !== "string") {
      return { ok: false, error: `addressed[${i}]: missing string fields (file/summary)` };
    }
    if (typeof item.line !== "number" || !Number.isFinite(item.line)) {
      return { ok: false, error: `addressed[${i}]: \`line\` must be a finite number` };
    }
    addressed.push({ file: item.file, line: item.line, summary: item.summary });
  }

  const deferred: DeferredFinding[] = [];
  for (let i = 0; i < obj.deferred.length; i++) {
    const item = obj.deferred[i] as Record<string, unknown>;
    if (typeof item !== "object" || item === null) {
      return { ok: false, error: `deferred[${i}]: expected object` };
    }
    if (typeof item.file !== "string" || typeof item.summary !== "string" || typeof item.tracker_ref !== "string") {
      return {
        ok: false,
        error: `deferred[${i}]: missing string fields (file/summary/tracker_ref)`,
      };
    }
    if (typeof item.line !== "number" || !Number.isFinite(item.line)) {
      return { ok: false, error: `deferred[${i}]: \`line\` must be a finite number` };
    }
    if (item.kind !== "code" && item.kind !== "architectural") {
      return {
        ok: false,
        error: `deferred[${i}]: \`kind\` must be "code" or "architectural"; got ${JSON.stringify(item.kind)}`,
      };
    }
    deferred.push({
      file: item.file,
      line: item.line,
      summary: item.summary,
      kind: item.kind,
      tracker_ref: item.tracker_ref,
    });
  }

  return {
    ok: true,
    value: {
      mode: obj.mode,
      committed: obj.committed,
      escalate: obj.escalate,
      reason: obj.reason,
      addressed,
      deferred,
    },
  };
}

export interface BuildReviewPromptArgs {
  task: Task;
  ciExcerpts: string | null;
  resultJsonPath: string;
}

export function buildReviewPrompt(args: BuildReviewPromptArgs): string {
  const { task, ciExcerpts, resultJsonPath } = args;
  const pr = task.frontmatter.pr;
  const planDir = path.join(
    task.frontmatter.target_repo,
    ".orchestrator",
    "tasks",
    `${task.frontmatter.id}-plan`,
  );

  // Inline bot excerpts only when present. A blank section reads as
  // "context was supposed to be here but is missing" and could nudge the
  // LLM to fabricate findings; omit cleanly instead.
  const botContextSection = ciExcerpts
    ? `\n\nBot review excerpts collected during ci-wait (verbatim — treat as second-opinion input, not authoritative):\n\n\`\`\`\n${ciExcerpts}\n\`\`\``
    : "";

  return `${NON_INTERACTIVE_PREAMBLE}

You are running the *review* phase for task ${task.frontmatter.id}.
You are operating inside the worktree at: ${task.frontmatter.worktree}
The PR under review: #${pr}
Task file: ${task.path}
Plan deliverables (the spec the implementation should match):
- ${planDir}/prd.md
- ${planDir}/task-breakdown.md

Now invoke the project's PR review skill in orchestrator output mode:

/pr-review ${pr}

RESULT_JSON_PATH=${resultJsonPath}

After Step 13 of /pr-review, also write a JSON escalation summary to
${resultJsonPath} matching the SKILL.md "Orchestrator output mode" contract:
{
  "mode": "address" | "review",
  "committed": <true if Step 9b pushed any commit, else false>,
  "escalate": <true iff at least one deferred finding has kind: "architectural">,
  "reason": "architectural-concern" | "",
  "addressed": [{ "file": "...", "line": N, "summary": "..." }, ...],
  "deferred":  [{ "file": "...", "line": N, "summary": "...", "kind": "code"|"architectural", "tracker_ref": "..." }, ...]
}
The orchestrator parses this file to decide whether to advance, escalate,
or re-trigger CI before gate.${botContextSection}

Before exiting, confirm: (a) ${resultJsonPath} exists and parses, (b) any
fixes are committed and pushed (if Step 9b ran), (c) replies are posted
(if Address mode).`;
}

// ---------- Phase output rendering ---------------------------------------

export function renderSummarySubsection(summary: ReviewSummary): string {
  const lines: string[] = [];
  lines.push(`- mode: ${summary.mode}`);
  lines.push(`- committed: ${summary.committed}`);
  lines.push(`- escalate: ${summary.escalate}${summary.reason ? ` (${summary.reason})` : ""}`);
  if (summary.addressed.length > 0) {
    lines.push("- addressed:");
    for (const f of summary.addressed) {
      lines.push(`  - ${f.file}:${f.line} — ${f.summary}`);
    }
  } else {
    lines.push("- addressed: (none)");
  }
  if (summary.deferred.length > 0) {
    lines.push("- deferred:");
    for (const f of summary.deferred) {
      lines.push(`  - ${f.file}:${f.line} (${f.kind}) — ${f.summary} [tracker: ${f.tracker_ref}]`);
    }
  } else {
    lines.push("- deferred: (none)");
  }
  return lines.join("\n");
}

export function renderEarlyExitSubsection(reason: string): string {
  return `- decision: needs-human (${reason})`;
}

export function renderFailureSubsection(reason: string): string {
  return `- decision: failed (${reason})`;
}

// ---------- runReviewPhase -----------------------------------------------

export async function runReviewPhase(
  task: Task,
  logger: Logger = NoopLogger,
  jsonl: JsonlSink = NoopJsonlSink,
): Promise<PhaseResult> {
  // Defensive fail-fast: reviewing a missing PR is incoherent.
  if (task.frontmatter.pr == null) {
    const reason = "review phase requires task.frontmatter.pr (set by implement); got null";
    logger.error(reason);
    await appendPhaseOutput(task, "review", renderEarlyExitSubsection("pr-missing"));
    await transitionStatus(task, "needs-human", "pr-missing");
    return { status: "needs-human", reason: "pr-missing" };
  }
  // Worktree-missing requires user action (recreate worktree); routes to
  // needs-human like the pr-missing branch above for consistency.
  if (!task.frontmatter.worktree || !existsSync(task.frontmatter.worktree)) {
    const reason = `review phase requires an existing worktree; got ${task.frontmatter.worktree ?? "(null)"}`;
    logger.error(reason);
    await appendPhaseOutput(
      task,
      "review",
      renderEarlyExitSubsection("worktree-missing"),
    );
    await transitionStatus(task, "needs-human", "worktree-missing");
    return { status: "needs-human", reason: "worktree-missing" };
  }

  const taskDir = path.join(
    task.frontmatter.target_repo,
    ".orchestrator",
    "tasks",
    task.frontmatter.id,
  );
  const reviewDir = path.join(taskDir, "review");
  await fs.mkdir(reviewDir, { recursive: true });
  const resultJsonPath = path.join(reviewDir, "summary.json");

  // Pre-spawn cleanup: remove any stale summary file. A subprocess that
  // exits 0 without writing the file would otherwise let us read pre-crash
  // content as if it were fresh. ENOENT is the expected first-run case.
  try {
    await fs.unlink(resultJsonPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const ciExcerpts = extractCiExcerpts(task.body);
  const prompt = buildReviewPrompt({ task, ciExcerpts, resultJsonPath });

  const r = await runHeadless({
    cwd: task.frontmatter.worktree,
    prompt,
    allowedTools: ALLOWED_TOOLS,
    timeoutMs: HEADLESS_TIMEOUT_MS,
    logger,
    label: "claude (review)",
    jsonl,
  });

  if (!r.ok) {
    const reason = `review subprocess failed: ${r.error ?? `exit ${r.exitCode}`}`;
    logger.error(reason);
    await appendPhaseOutput(task, "review", renderFailureSubsection(reason));
    return { status: "failed", reason };
  }

  let json: string;
  try {
    json = await fs.readFile(resultJsonPath, "utf8");
  } catch (err) {
    const reason = `review summary.json missing at ${resultJsonPath}: ${(err as Error).message}`;
    logger.error(reason);
    await appendPhaseOutput(task, "review", renderFailureSubsection(reason));
    return { status: "failed", reason };
  }

  const parsed = parseReviewSummary(json);
  if (!parsed.ok) {
    const reason = `review summary.json malformed: ${parsed.error}`;
    logger.error(reason);
    await appendPhaseOutput(task, "review", renderFailureSubsection(reason));
    return { status: "failed", reason };
  }

  const summary = parsed.value;
  await appendPhaseOutput(task, "review", renderSummarySubsection(summary));
  logger.event(
    "review.summary",
    `mode=${summary.mode} committed=${summary.committed} escalate=${summary.escalate} addressed=${summary.addressed.length} deferred=${summary.deferred.length}`,
  );

  if (summary.escalate) {
    const reason = summary.reason || "architectural-concern";
    await transitionStatus(task, "needs-human", reason);
    logger.event("task.status", `needs-human (${reason})`);
    return { status: "needs-human", reason };
  }

  if (summary.committed) {
    // The skill pushed a commit — re-trigger CI before gate so gate reads
    // fresh checks state. ci-wait expects entry status "ci"; transition
    // before invocation so its own preflight matches.
    await transitionStatus(task, "ci", "review-pushed-commit");
    logger.event("task.status", "ci (review-pushed-commit)");
    const ciResult = await runCiWaitPhase(task, logger, jsonl);
    if (ciResult.status !== "ok") return ciResult;
    // ci-wait mutated the task on disk; reload so the runner observes
    // any post-ci-wait status changes.
    Object.assign(task, await readTask(task.path));
  }

  return { status: "ok" };
}

// ---------- Internal: extract bot review excerpts from `## Phase outputs > ci`

// Returns the raw content of the `### ci (latest: ...)` subsection (without
// the heading line), truncated to ~4 KB. Returns null when the section is
// absent or empty.
function extractCiExcerpts(body: string): string | null {
  const phaseOutputsRe = /^## Phase outputs\b[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/m;
  const phaseOutputsMatch = body.match(phaseOutputsRe);
  if (!phaseOutputsMatch) return null;
  const phaseOutputs = phaseOutputsMatch[1] ?? "";

  const ciRe = /^### ci\b[^\n]*\n([\s\S]*?)(?=\n### |\n## |(?![\s\S]))/m;
  const ciMatch = phaseOutputs.match(ciRe);
  if (!ciMatch) return null;
  const content = (ciMatch[1] ?? "").trim();
  if (content.length === 0) return null;

  if (Buffer.byteLength(content, "utf8") <= CI_EXCERPT_BUDGET_BYTES) {
    return content;
  }
  // Truncate from the head — bot reviews tend to put the most actionable
  // bullets at the top. Marker so a debugger reading the prompt knows it
  // was cut.
  const truncated = content.slice(0, CI_EXCERPT_BUDGET_BYTES);
  return `${truncated}\n…[truncated for prompt budget]`;
}
