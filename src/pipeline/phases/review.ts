import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  Task,
  appendPhaseLog,
  appendPhaseOutput,
  transitionStatus,
  updateTaskFrontmatter,
} from "../../state/task-file.js";
import { runHeadless } from "../headless.js";
import { PhaseResult } from "../types.js";
import { runImplementPhase } from "./implement.js";
import { NoopLogger, type Logger } from "../../util/logger.js";
import { NoopJsonlSink, type JsonlSink } from "../../util/jsonl-sink.js";

// ---------- Output JSON contract ----------------------------------------

export type CriticalKind = "code" | "architectural";

export interface CriticalFinding {
  kind: CriticalKind;
  file: string;
  line: number;
  summary: string;
  body: string;
}

export interface MinorFinding {
  file: string;
  line: number;
  summary: string;
  body: string;
}

export interface ReviewResult {
  summary: string;
  critical: CriticalFinding[];
  minor: MinorFinding[];
}

export type ParseReviewResult =
  | { ok: true; value: ReviewResult }
  | { ok: false; error: string };

// ---------- Constants ----------------------------------------------------

// Cap of 2 review→implement(fix) cycles. After 2 fixes still produce
// critical-code findings, the third review escalates to needs-human. Tuning
// rationale: 1 cycle is too tight (real fixes often expose adjacent issues),
// 3+ is too long (token cost compounds, and humans get a cleaner handoff if
// the loop converges in 2). Persisted in frontmatter so resume-after-crash
// reads the same cap.
export const REVIEW_CYCLE_CAP = 2;

// Bot review excerpts pulled from `## Phase outputs > ci` are inlined into
// the review prompt verbatim. Cap at ~4 KB so a chatty Copilot summary
// can't blow the prompt budget. Truncation is best-effort signal; the JSON
// file `<task-dir>/review/result-<n>.json` carries the authoritative output.
const CI_EXCERPT_BUDGET_BYTES = 4 * 1024;

// Subprocess timeout: /pr-review with 4 parallel sub-agents typically
// finishes in 5–10 minutes; 30-min cap leaves headroom for slow gh API
// calls without becoming a runaway. Mirrors implement's timeout.
const HEADLESS_TIMEOUT_MS = 30 * 60 * 1000;

// Tools the subprocess is allowed to use. Mirrors implement's list with
// Task added explicitly so `/pr-review` can spawn its 4 review sub-agents.
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
the /pr-review skill end-to-end, post inline review comments to GitHub via
the comments endpoint (never \`gh pr review\`), write the structured JSON
result to RESULT_JSON_PATH, and exit.`;

// ---------- Pure helpers --------------------------------------------------

export function parseReviewResult(json: string): ParseReviewResult {
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
  if (typeof obj.summary !== "string") {
    return { ok: false, error: "missing or non-string `summary`" };
  }
  if (!Array.isArray(obj.critical)) {
    return { ok: false, error: "missing or non-array `critical`" };
  }
  if (!Array.isArray(obj.minor)) {
    return { ok: false, error: "missing or non-array `minor`" };
  }

  const critical: CriticalFinding[] = [];
  for (let i = 0; i < obj.critical.length; i++) {
    const item = obj.critical[i] as Record<string, unknown>;
    if (typeof item !== "object" || item === null) {
      return { ok: false, error: `critical[${i}]: expected object` };
    }
    if (item.kind !== "code" && item.kind !== "architectural") {
      return {
        ok: false,
        error: `critical[${i}]: \`kind\` must be "code" or "architectural"; got ${JSON.stringify(item.kind)}`,
      };
    }
    if (typeof item.file !== "string" || typeof item.summary !== "string" || typeof item.body !== "string") {
      return { ok: false, error: `critical[${i}]: missing string fields (file/summary/body)` };
    }
    if (typeof item.line !== "number" || !Number.isFinite(item.line)) {
      return { ok: false, error: `critical[${i}]: \`line\` must be a finite number` };
    }
    critical.push({
      kind: item.kind,
      file: item.file,
      line: item.line,
      summary: item.summary,
      body: item.body,
    });
  }

  const minor: MinorFinding[] = [];
  for (let i = 0; i < obj.minor.length; i++) {
    const item = obj.minor[i] as Record<string, unknown>;
    if (typeof item !== "object" || item === null) {
      return { ok: false, error: `minor[${i}]: expected object` };
    }
    if (typeof item.file !== "string" || typeof item.summary !== "string" || typeof item.body !== "string") {
      return { ok: false, error: `minor[${i}]: missing string fields (file/summary/body)` };
    }
    if (typeof item.line !== "number" || !Number.isFinite(item.line)) {
      return { ok: false, error: `minor[${i}]: \`line\` must be a finite number` };
    }
    minor.push({
      file: item.file,
      line: item.line,
      summary: item.summary,
      body: item.body,
    });
  }

  return { ok: true, value: { summary: obj.summary, critical, minor } };
}

export interface BuildReviewPromptArgs {
  task: Task;
  ciExcerpts: string | null;
  resultJsonPath: string;
  // 1-indexed cycle number for human-readable references in the prompt.
  cycleNum: number;
}

export function buildReviewPrompt(args: BuildReviewPromptArgs): string {
  const { task, ciExcerpts, resultJsonPath, cycleNum } = args;
  const pr = task.frontmatter.pr;
  const planDir = path.join(
    task.frontmatter.target_repo,
    ".orchestrator",
    "tasks",
    `${task.frontmatter.id}-plan`,
  );

  // Inline bot excerpts only when present. The plan calls out: "no 'no
  // excerpts' placeholder text — just no section." A blank section reads as
  // "context was supposed to be here but is missing" and could nudge the LLM
  // to fabricate findings; omit cleanly instead.
  const botContextSection = ciExcerpts
    ? `\n\nBot review excerpts collected during ci-wait (verbatim — treat as second-opinion input, not authoritative):\n\n\`\`\`\n${ciExcerpts}\n\`\`\``
    : "";

  return `${NON_INTERACTIVE_PREAMBLE}

You are running the *review* phase for task ${task.frontmatter.id}, review cycle ${cycleNum} of up to ${REVIEW_CYCLE_CAP + 1}.
You are operating inside the worktree at: ${task.frontmatter.worktree}
The PR under review: #${pr}
Task file: ${task.path}
Plan deliverables (the spec the implementation should match):
- ${planDir}/prd.md
- ${planDir}/task-breakdown.md

Now invoke the project's PR review skill in **machine-readable output mode**:

/pr-review ${pr}

RESULT_JSON_PATH=${resultJsonPath}

Mode overrides (per skill SKILL.md § "Machine-readable output mode"):
- Force Review mode (no Address-mode flows).
- Do NOT auto-fix findings, do NOT commit, do NOT push, do NOT call \`gh pr review\` or \`gh pr edit\`. The orchestrator routes fixes through a separate implement(fix) phase that owns the commit.
- Post each finding as an individual inline review comment via \`gh api repos/{owner}/{repo}/pulls/${pr}/comments\` (the comments endpoint, never the reviews endpoint).
- After posting, write the JSON contract to ${resultJsonPath} (create parent directories if needed):
  {
    "summary": "<one-paragraph>",
    "critical": [{ "kind": "code"|"architectural", "file": "...", "line": N, "summary": "...", "body": "..." }, ...],
    "minor":    [{ "file": "...", "line": N, "summary": "...", "body": "..." }, ...]
  }
- The \`kind\` discriminator on each critical finding is load-bearing: \`code\` means an implementer can fix it without rethinking the plan; \`architectural\` means the plan itself is wrong and looping implement(fix) won't help. When in doubt, prefer \`code\` — \`architectural\` short-circuits the loop and routes the PR to a human.${botContextSection}

Before exiting, confirm: (a) inline comments posted via the comments endpoint, (b) ${resultJsonPath} exists with the contract above, (c) no commits or pushes from this skill run.`;
}

export function renderFailureLogFromReview(result: ReviewResult): string {
  const lines: string[] = [];
  lines.push(`Review summary: ${result.summary}`);
  if (result.critical.length > 0) {
    lines.push("");
    lines.push("Critical findings to address:");
    for (const f of result.critical) {
      lines.push(`- ${f.file}:${f.line} (${f.kind}) — ${f.summary}`);
      lines.push(`  ${f.body}`);
    }
  }
  if (result.minor.length > 0) {
    lines.push("");
    lines.push("Minor findings (lower priority — fix opportunistically):");
    for (const f of result.minor) {
      lines.push(`- ${f.file}:${f.line} — ${f.summary}`);
    }
  }
  return lines.join("\n");
}

// ---------- Phase output rendering ---------------------------------------

export type ReviewDecision =
  | { kind: "pending" } // mid-loop; render as "(in progress)"
  | { kind: "clean" }
  | { kind: "needs-human"; reason: string }
  | { kind: "failed"; reason: string };

export interface ReviewCycleRecord {
  // 1-indexed for display.
  cycleNumber: number;
  timestamp: string;
  resultJsonPath: string;
  result: ReviewResult;
}

export function renderReviewSubsection(
  cycles: readonly ReviewCycleRecord[],
  decision: ReviewDecision,
): string {
  const lines: string[] = [];
  for (const c of cycles) {
    lines.push(
      `- cycle ${c.cycleNumber} (${c.timestamp}): summary "${c.result.summary}"`,
    );
    for (const f of c.result.critical) {
      lines.push(`  - critical (${f.kind}): ${f.file}:${f.line} — ${f.summary}`);
    }
    for (const f of c.result.minor) {
      lines.push(`  - minor: ${f.file}:${f.line} — ${f.summary}`);
    }
  }
  // Decision line
  if (decision.kind === "clean") {
    lines.push("- decision: clean — advancing");
  } else if (decision.kind === "needs-human") {
    lines.push(`- decision: needs-human (${decision.reason})`);
  } else if (decision.kind === "failed") {
    lines.push(`- decision: failed (${decision.reason})`);
  } else {
    lines.push("- decision: in progress");
  }
  // Most-recent JSON pointer for grep-ability.
  if (cycles.length > 0) {
    lines.push(`- JSON: ${cycles[cycles.length - 1]!.resultJsonPath}`);
  }
  return lines.join("\n");
}

// ---------- runReviewPhase -----------------------------------------------

export async function runReviewPhase(
  task: Task,
  logger: Logger = NoopLogger,
  jsonl: JsonlSink = NoopJsonlSink,
): Promise<PhaseResult> {
  // Defensive fail-fast: reviewing a missing PR is incoherent. Mirrors
  // ci-wait's pr-missing handling so resume-from-bad-state lands in the
  // same needs-human branch consistently. Both early-exit paths render
  // a `### review` subsection so a post-mortem reader of the task file
  // sees *why* the phase bailed without having to chase the runner log.
  if (task.frontmatter.pr == null) {
    const reason = "review phase requires task.frontmatter.pr (set by implement); got null";
    logger.error(reason);
    await appendPhaseOutput(
      task,
      "review",
      renderReviewSubsection([], { kind: "needs-human", reason: "pr-missing" }),
    );
    await transitionStatus(task, "needs-human", "pr-missing");
    return { status: "needs-human", reason: "pr-missing" };
  }
  // Worktree-missing is an unrecoverable-without-user-action case (someone
  // would have to recreate the worktree on disk); the pr-missing path above
  // takes the same view, so route to needs-human for consistency rather
  // than `failed` which a runner would treat as transient and re-enter.
  if (!task.frontmatter.worktree || !existsSync(task.frontmatter.worktree)) {
    const reason = `review phase requires an existing worktree; got ${task.frontmatter.worktree ?? "(null)"}`;
    logger.error(reason);
    await appendPhaseOutput(
      task,
      "review",
      renderReviewSubsection([], { kind: "needs-human", reason: "worktree-missing" }),
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

  // Initialize the cycle counter. Persist immediately when null so resume
  // after a mid-loop crash sees a concrete number rather than re-defaulting.
  let cycles = task.frontmatter.review_cycles ?? 0;
  if (task.frontmatter.review_cycles == null) {
    await updateTaskFrontmatter(task, { review_cycles: cycles });
    logger.event("task.frontmatter", `review_cycles=${cycles}`);
  }

  const ciExcerpts = extractCiExcerpts(task.body);

  // Resume contract: rehydrate prior cycles from `result-<i>.json` files on
  // disk so the rendered `### review` subsection re-includes all cycles after
  // a crash. `appendPhaseOutput` overwrites the entire `### review` block on
  // each call, so without seeding `cycleRecords` from disk a resume would
  // erase pre-crash cycle history from the task file. Read up to `cycles - 1`
  // (i.e. cycles that were *completed* pre-crash); a missing or malformed
  // file is non-fatal — we render what we can recover and continue.
  const cycleRecords: ReviewCycleRecord[] = await rehydrateCycleRecords(
    reviewDir,
    cycles,
    logger,
  );

  // Use a manual loop rather than retryN; the cap must persist across crashes
  // (frontmatter), and each iteration calls runImplementPhase between reviews.
  while (true) {
    const cycleIdx = cycles; // 0-indexed for the file path
    const cycleNum = cycleIdx + 1; // 1-indexed for display
    const resultJsonPath = path.join(reviewDir, `result-${cycleIdx}.json`);

    logger.info(`review: starting cycle ${cycleNum} (cap ${REVIEW_CYCLE_CAP + 1}); result=${resultJsonPath}`);

    // Pre-spawn cleanup: remove any stale result file at the deterministic
    // path before the subprocess runs. Crash-resume re-uses the same path
    // (review_cycles only increments on a *successful* fix, so a crash
    // before that lands replays this cycle index), and a subprocess that
    // exits 0 without writing the file would otherwise let us read the
    // pre-crash content as if it were fresh. ENOENT is the expected
    // first-cycle case and is not an error.
    try {
      await fs.unlink(resultJsonPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const prompt = buildReviewPrompt({
      task,
      ciExcerpts,
      resultJsonPath,
      cycleNum,
    });

    const r = await runHeadless({
      cwd: task.frontmatter.worktree,
      prompt,
      allowedTools: ALLOWED_TOOLS,
      timeoutMs: HEADLESS_TIMEOUT_MS,
      logger,
      label: `claude (review cycle ${cycleNum})`,
      jsonl,
    });

    if (!r.ok) {
      const reason = `review subprocess failed (cycle ${cycleNum}): ${r.error ?? `exit ${r.exitCode}`}`;
      logger.error(reason);
      await appendPhaseOutput(
        task,
        "review",
        renderReviewSubsection(cycleRecords, { kind: "failed", reason }),
      );
      return { status: "failed", reason };
    }

    let json: string;
    try {
      json = await fs.readFile(resultJsonPath, "utf8");
    } catch (err) {
      const reason = `review JSON missing at ${resultJsonPath} (cycle ${cycleNum}): ${(err as Error).message}`;
      logger.error(reason);
      await appendPhaseOutput(
        task,
        "review",
        renderReviewSubsection(cycleRecords, { kind: "failed", reason }),
      );
      return { status: "failed", reason };
    }

    const parsed = parseReviewResult(json);
    if (!parsed.ok) {
      const reason = `review JSON malformed (cycle ${cycleNum}): ${parsed.error}`;
      logger.error(reason);
      await appendPhaseOutput(
        task,
        "review",
        renderReviewSubsection(cycleRecords, { kind: "failed", reason }),
      );
      return { status: "failed", reason };
    }

    const record: ReviewCycleRecord = {
      cycleNumber: cycleNum,
      timestamp: new Date().toISOString(),
      resultJsonPath,
      result: parsed.value,
    };
    cycleRecords.push(record);
    logger.event(
      "review.cycle",
      `cycle=${cycleNum} critical=${parsed.value.critical.length} minor=${parsed.value.minor.length}`,
    );

    // Branch on findings.
    if (parsed.value.critical.length === 0) {
      await appendPhaseOutput(
        task,
        "review",
        renderReviewSubsection(cycleRecords, { kind: "clean" }),
      );
      logger.info(`review: cycle ${cycleNum} clean — leaving status at "reviewing" for the gate phase`);
      return { status: "ok" };
    }

    const hasArchitectural = parsed.value.critical.some((c) => c.kind === "architectural");
    if (hasArchitectural) {
      await appendPhaseOutput(
        task,
        "review",
        renderReviewSubsection(cycleRecords, {
          kind: "needs-human",
          reason: "architectural-concern",
        }),
      );
      await transitionStatus(task, "needs-human", "architectural-concern");
      logger.event("task.status", "needs-human (architectural-concern)");
      return { status: "needs-human", reason: "architectural-concern" };
    }

    if (cycles >= REVIEW_CYCLE_CAP) {
      await appendPhaseOutput(
        task,
        "review",
        renderReviewSubsection(cycleRecords, {
          kind: "needs-human",
          reason: "review-cycles-exhausted",
        }),
      );
      await transitionStatus(task, "needs-human", "review-cycles-exhausted");
      logger.event("task.status", "needs-human (review-cycles-exhausted)");
      return { status: "needs-human", reason: "review-cycles-exhausted" };
    }

    // critical-code, under the cap → loop back to implement(fix).
    await appendPhaseOutput(
      task,
      "review",
      renderReviewSubsection(cycleRecords, { kind: "pending" }),
    );

    const failureLog = renderFailureLogFromReview(parsed.value);
    await appendPhaseLog(
      task,
      `- ${new Date().toISOString()} review cycle ${cycleNum} → implement(fix)`,
    );

    const fix = await runImplementPhase(
      task,
      { mode: "fix", failureLog },
      logger,
      jsonl,
    );

    // `review_cycles` counts loop-backs that completed (implement(fix)
    // returned ok). Incrementing only on success keeps the counter aligned
    // with the doc-comment in `task-file.ts` and means a failed fix does not
    // burn budget — the resume re-runs the same cycle. The cap was already
    // checked above, so an `ok` here is guaranteed to be under-cap.
    if (fix.status === "ok") {
      cycles += 1;
      await updateTaskFrontmatter(task, { review_cycles: cycles });
      logger.event("task.frontmatter", `review_cycles=${cycles}`);
      // Loop iteration repeats and re-runs review against the new PR head.
      continue;
    }

    // Defensive: `runFix` (implement.ts) currently only returns ok or
    // failed. If it ever surfaces `needs-human` or `retry`, surface the
    // inner reason cleanly rather than letting an unknown status fall
    // through. These branches are belt-and-suspenders against future
    // changes to implement(fix)'s contract.
    if (fix.status === "needs-human") {
      await appendPhaseOutput(
        task,
        "review",
        renderReviewSubsection(cycleRecords, {
          kind: "needs-human",
          reason: `implement-fix:${fix.reason}`,
        }),
      );
      return fix;
    }
    if (fix.status === "failed") {
      const reason = `implement(fix) failed during review cycle ${cycleNum}: ${fix.reason}`;
      logger.error(reason);
      await appendPhaseOutput(
        task,
        "review",
        renderReviewSubsection(cycleRecords, { kind: "failed", reason }),
      );
      return { status: "failed", reason };
    }
    // Status is "retry" — not expected from runFix today, but handle it
    // explicitly so a future reintroduction doesn't silently loop.
    const reason = `implement(fix) returned unexpected retry during review cycle ${cycleNum}: ${fix.reason}`;
    logger.error(reason);
    return { status: "failed", reason };
  }
}

// Read prior cycles' result JSON files into ReviewCycleRecord[] so the
// rendered `### review` subsection survives a resume. The on-disk JSON is
// authoritative; the timestamp is derived from the file mtime since the
// original cycle's wall-clock isn't recorded in the JSON itself. A missing
// or malformed file is logged and skipped — the visible cycle history will
// be incomplete, but the loop's correctness is unaffected.
async function rehydrateCycleRecords(
  reviewDir: string,
  cycles: number,
  logger: Logger,
): Promise<ReviewCycleRecord[]> {
  if (cycles <= 0) return [];
  const records: ReviewCycleRecord[] = [];
  for (let i = 0; i < cycles; i++) {
    const p = path.join(reviewDir, `result-${i}.json`);
    let raw: string;
    try {
      raw = await fs.readFile(p, "utf8");
    } catch {
      logger.warn(`review: prior cycle ${i + 1} JSON missing at ${p}; rendering history will be incomplete`);
      continue;
    }
    const parsed = parseReviewResult(raw);
    if (!parsed.ok) {
      logger.warn(`review: prior cycle ${i + 1} JSON malformed at ${p} (${parsed.error}); rendering history will be incomplete`);
      continue;
    }
    let timestamp = "";
    try {
      const stat = await fs.stat(p);
      timestamp = stat.mtime.toISOString();
    } catch {
      timestamp = "";
    }
    records.push({
      cycleNumber: i + 1,
      timestamp,
      resultJsonPath: p,
      result: parsed.value,
    });
  }
  return records;
}

// ---------- Internal: extract bot review excerpts from `## Phase outputs > ci`

// Returns the raw content of the `### ci (latest: ...)` subsection (without
// the heading line), truncated to ~4 KB. Returns null when the section is
// absent or empty — callers omit the bot-context block from the prompt
// rather than passing through a placeholder.
function extractCiExcerpts(body: string): string | null {
  // Anchor on the Phase outputs section first; a stray `### ci` outside that
  // section (unlikely but possible in hand-edited tasks) shouldn't be picked
  // up as ci-wait output.
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
  // bullets at the top, and dropping the tail keeps the leading summary
  // intact. The string slice is byte-approximate (UTF-8 chars are <= 4
  // bytes); leave a marker so a debugger reading the prompt knows it was cut.
  const truncated = content.slice(0, CI_EXCERPT_BUDGET_BYTES);
  return `${truncated}\n…[truncated for prompt budget]`;
}
