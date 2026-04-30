import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  Task,
  appendPhaseOutput,
  transitionStatus,
} from "../../state/task-file.js";
import { runHeadless } from "../headless.js";
import { retryN } from "../retry.js";
import { PhaseResult } from "../types.js";
import { runVerifyGate, surfaceVerifyFailureOnPr } from "./verify-gate.js";
import { NoopLogger, type Logger } from "../../util/logger.js";
import { NoopJsonlSink, type JsonlSink } from "../../util/jsonl-sink.js";

const NON_INTERACTIVE_PREAMBLE = `You are running in non-interactive headless mode driven by the flow orchestrator.
Do not pause for confirmations or ask the user any clarifying questions. Run
the verify skill end-to-end: identify failures, fix them in place, re-run
checks, and exit when everything is green or when you cannot make further
progress.`;

// Narrower than implement's tool list — verify never opens or edits PRs, so
// `Bash(gh *)` is omitted. Everything else mirrors implement's needs (read /
// edit code + run scripts via the standard package managers).
const ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "Bash(npm *)",
  "Bash(git *)",
  "Bash(npx *)",
  "Bash(bun *)",
  "Bash(node *)",
];

const HEADLESS_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const TAIL_LINES = 200;
const MAX_MATCH_LINES = 100;

export async function runVerifyPhase(
  task: Task,
  logger: Logger = NoopLogger,
  jsonl: JsonlSink = NoopJsonlSink,
): Promise<PhaseResult> {
  if (task.frontmatter.pr == null) {
    const reason = "verify phase requires task.frontmatter.pr (set by implement); got null";
    logger.error(reason);
    await transitionStatus(task, "needs-human", "pr-missing");
    return { status: "needs-human", reason: "pr-missing" };
  }
  if (!task.frontmatter.worktree || !existsSync(task.frontmatter.worktree)) {
    const reason = `verify phase requires an existing worktree; got ${task.frontmatter.worktree ?? "(null)"}`;
    logger.error(reason);
    return { status: "failed", reason };
  }
  if (!task.frontmatter.branch) {
    const reason = "verify phase requires a branch in frontmatter (set by worktree phase)";
    logger.error(reason);
    return { status: "failed", reason };
  }

  const worktree = task.frontmatter.worktree;
  const pr = task.frontmatter.pr;

  // Preflight `.flow/verify` before spawning any LLM. Same stat+access
  // pattern verify-gate.ts uses internally — collapsing
  // missing/non-file/non-executable into a single deterministic diagnostic
  // converts a 30-90 minute exhaustion into a sub-second failure with a
  // precise reason.
  const scriptPath = path.join(worktree, ".flow", "verify");
  try {
    const stat = await fs.stat(scriptPath);
    if (!stat.isFile()) {
      throw new Error("not a file");
    }
    await fs.access(scriptPath, fs.constants.X_OK);
  } catch {
    logger.error(
      `.flow/verify is missing or not executable in ${worktree}; cannot run verify phase`,
    );
    await transitionStatus(task, "needs-human", "verify-script-missing");
    return { status: "needs-human", reason: "verify-script-missing" };
  }

  await transitionStatus(task, "verifying");
  logger.event("task.status", "verifying");

  // `retryN` doesn't expose the iteration count to the caller, so capture
  // it in a closure for the success-path attempt-count line. The final
  // value of `attemptsRun` reflects how many attempts the loop ran before
  // success or exhaustion.
  let attemptsRun = 0;

  const result = await retryN<void>(async (attempt, lastFailure) => {
    attemptsRun = attempt;
    if (attempt > 1) {
      logger.warn(`verify attempt ${attempt} after prior failure`);
    }
    const prompt = buildVerifyPrompt(task, lastFailure);
    logger.info(`verify: invoking claude (attempt ${attempt}/${MAX_ATTEMPTS})`);
    const r = await runHeadless({
      cwd: worktree,
      prompt,
      allowedTools: ALLOWED_TOOLS,
      timeoutMs: HEADLESS_TIMEOUT_MS,
      logger,
      label: "claude (verify)",
      jsonl,
    });
    if (!r.ok) {
      const headlessError = r.error ?? `exit ${r.exitCode}`;
      return { ok: false, error: truncateForRetryPrompt(headlessError) };
    }

    // Deterministic ground truth. `/verify` may declare success after
    // self-healing, but the gate is what the rest of the pipeline trusts.
    // Disagreement (skill ok / gate fail) counts as a failed attempt.
    const gate = await runVerifyGate(worktree, logger);
    if (gate.ok) {
      logger.info("verify-gate ok");
      return { ok: true, value: undefined };
    }
    logger.warn("verify-gate failed — counting attempt as failed");
    return { ok: false, error: truncateForRetryPrompt(gate.output) };
  }, MAX_ATTEMPTS);

  if (result.ok) {
    const flake =
      attemptsRun > 1
        ? ` (${attemptsRun - 1} ${attemptsRun - 1 === 1 ? "retry" : "retries"} — suspected flake)`
        : "";
    await appendPhaseOutput(
      task,
      "verify",
      `verify: ${attemptsRun}/${MAX_ATTEMPTS} passed${flake}`,
    );
    await transitionStatus(task, "ci");
    logger.event("task.status", "ci");
    return { status: "ok" };
  }

  // Exhaustion: surface the final failure log on both the task file and
  // the PR body, then escalate to needs-human.
  const finalLog = result.error;
  await appendPhaseOutput(
    task,
    "verify",
    `verify: ${MAX_ATTEMPTS}/${MAX_ATTEMPTS} attempts failed\n\n\`\`\`text\n${finalLog}\n\`\`\``,
  );
  await surfaceVerifyFailureOnPr(pr, worktree, finalLog, logger);
  await transitionStatus(task, "needs-human", "verify-exhausted");
  return { status: "needs-human", reason: "verify-exhausted" };
}

function buildVerifyPrompt(task: Task, lastFailure?: string): string {
  const taskFile = task.path;
  const failureBlock = lastFailure
    ? `\n\nPRIOR ATTEMPT FAILED — failure log:\n${lastFailure}\n\nReview the failure, adjust your approach, and try again.`
    : "";

  return `${NON_INTERACTIVE_PREAMBLE}

You are running the *verify* phase for task ${task.frontmatter.id}.
You are operating inside the worktree at: ${task.frontmatter.worktree}
The feature branch is already checked out: ${task.frontmatter.branch}
The pull request is open at: #${task.frontmatter.pr}

Read these inputs first:
- Task file: ${taskFile}

Now invoke the project's verification skill:

/verify

Run the project's verify checks (see \`.flow/verify\`), fix any failures
in place, re-run the checks until they pass, then exit. Do not open or
edit the PR; the orchestrator runs an independent ground-truth check
after you exit and will retry up to ${MAX_ATTEMPTS} times if needed.${failureBlock}`;
}

// Pure function. If the log is short enough, pass it through. Otherwise,
// keep the last 200 lines plus up to 100 earlier error/fail/panic matches —
// the head of a long failure log is usually noise (test runner banners,
// successful steps); the tail is where the actual failure lives, and the
// error matches preserve any earlier escalation that the tail lost.
export function truncateForRetryPrompt(log: string): string {
  const lines = log.split("\n");
  if (lines.length <= TAIL_LINES) return log;

  const head = lines.slice(0, lines.length - TAIL_LINES);
  const tail = lines.slice(lines.length - TAIL_LINES);
  const matchedAll = head.filter((l) => /error|fail|panic/i.test(l));
  const matched = matchedAll.slice(0, MAX_MATCH_LINES);

  const sections: string[] = [];
  sections.push(
    `[matched ${matchedAll.length} error/fail/panic line${
      matchedAll.length === 1 ? "" : "s"
    } from earlier in the log${matchedAll.length > MAX_MATCH_LINES ? `; showing first ${MAX_MATCH_LINES}` : ""}]`,
  );
  if (matched.length > 0) sections.push(matched.join("\n"));
  sections.push("[…tail…]");
  sections.push(tail.join("\n"));
  return sections.join("\n");
}
