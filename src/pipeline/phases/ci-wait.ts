import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { execa } from "execa";
import {
  Task,
  appendPhaseOutput,
  transitionStatus,
} from "../../state/task-file.js";
import { PhaseResult } from "../types.js";
import { NoopLogger, type Logger } from "../../util/logger.js";
import { NoopJsonlSink, type JsonlSink } from "../../util/jsonl-sink.js";

// 5-minute heartbeat. ci-wait can run for up to 20 minutes — verify-gate's
// 15s default would dilute the signal, but no heartbeat at all (a single
// 20-min execa) leaves the user staring at a frozen log.
const CI_WAIT_HEARTBEAT_MS = 5 * 60 * 1000;

interface CiWaitScriptOutput {
  outcome: "ok" | "ci-hang" | "config-invalid" | "gh-error";
  polls?: number;
  durMs?: number;
  section?: string;
  missingBots?: string[];
  pendingChecks?: string[];
  reason?: string;
  ghErrorCall?: string;
  ghErrorMessage?: string;
}

export async function runCiWaitPhase(
  task: Task,
  logger: Logger = NoopLogger,
  jsonl: JsonlSink = NoopJsonlSink,
): Promise<PhaseResult> {
  // Defensive fail-fast: this should never fire on the happy path because
  // implement opens the PR before transitioning to `pr-open`. It catches
  // resume-from-bad-state and direct `flow run --phase ci-wait` invocations.
  if (task.frontmatter.pr == null) {
    const reason = "ci-wait phase requires task.frontmatter.pr (set by implement); got null";
    logger.error(reason);
    await transitionStatus(task, "needs-human", "pr-missing");
    return { status: "needs-human", reason: "pr-missing" };
  }
  if (!task.frontmatter.worktree || !existsSync(task.frontmatter.worktree)) {
    const reason = `ci-wait phase requires an existing worktree; got ${task.frontmatter.worktree ?? "(null)"}`;
    logger.error(reason);
    return { status: "failed", reason };
  }

  const worktree = task.frontmatter.worktree;
  const pr = task.frontmatter.pr;
  const scriptPath = path.join(worktree, "scripts", "ci-wait.ts");

  // Preflight the script symlink before spawning. Mirrors verify-gate.ts:
  // a directory at scripts/ci-wait.ts (or a missing symlink after a partial
  // `flow install`) would otherwise surface as a platform-dependent
  // execa spawn error rather than a deterministic phase diagnostic.
  try {
    const stat = await fs.stat(scriptPath);
    if (!stat.isFile()) {
      throw new Error("not a file");
    }
    await fs.access(scriptPath, fs.constants.X_OK);
  } catch {
    const reason = `ci-wait script is missing or not executable at ${scriptPath}; ensure \`flow install\` has linked templates/scripts/ci-wait.ts into the worktree's scripts/ directory`;
    logger.error(reason);
    return { status: "failed", reason };
  }

  await transitionStatus(task, "ci");
  logger.event("task.status", "ci");

  logger.event("ci-wait.start", `pr=#${pr} script=${scriptPath}`);
  const start = Date.now();

  // Counters mutated by the stderr forwarder; read by the heartbeat. Living
  // up here (not inside `exec`) keeps them in scope for the heartbeat
  // interval set up after `exec` is defined.
  const errorState = { ghErrors: 0, lastError: "" };

  const exec = async (): Promise<{
    exitCode: number;
    stdout: string;
    spawnError?: Error;
  }> => {
    const subprocess = execa(scriptPath, ["--pr", String(pr)], {
      cwd: worktree,
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
      buffer: { stdout: true, stderr: false },
    });

    // Tee stderr line-by-line. Each line is expected to be a JSON event from
    // the script (`ci-wait.start`, `ci-wait.poll`, `ci-wait.exit`,
    // `ci-wait.gh_retry`, `ci-wait.gh_retry_exhausted`, `ci-wait.gh_permanent`);
    // non-JSON lines fall back to logger.warn so a crash inside the script
    // (stack trace) is still surfaced.
    if (subprocess.stderr) {
      let pending = "";
      subprocess.stderr.setEncoding("utf8");
      subprocess.stderr.on("data", (chunk: string) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          forwardStderrLine(line, jsonl, logger, errorState);
        }
      });
      subprocess.stderr.on("end", () => {
        if (pending.trim().length > 0) forwardStderrLine(pending, jsonl, logger, errorState);
      });
    }

    try {
      const result = await subprocess;
      return {
        exitCode: typeof result.exitCode === "number" ? result.exitCode : -1,
        stdout: result.stdout ?? "",
      };
    } catch (err) {
      // Spawn-time failure (script missing, bad shebang, etc). Surface a
      // deterministic diagnostic — the wrapper translates this into a
      // `failed` PhaseResult below.
      return { exitCode: -1, stdout: "", spawnError: err as Error };
    }
  };

  // Local 5-minute heartbeat. We don't reuse `logger.withHeartbeat` because
  // its cadence is a logger-creation-time constant (15s default) and ci-wait
  // runs up to 20 min — a 15s heartbeat would dump 80 "still running" lines
  // into the per-task log. Five-minute beats keep liveness without noise.
  // We append the gh-error counter when non-zero so a sustained gh outage
  // is visible in the user-facing heartbeat instead of buried in jsonl —
  // the original silent-loop bug looked like "still running, 300s elapsed"
  // for an hour while every poll was failing under the hood.
  const heartbeatHandle = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - start) / 1000);
    const errSuffix =
      errorState.ghErrors > 0
        ? ` (${errorState.ghErrors} gh errors; last: ${truncateForLog(errorState.lastError)})`
        : "";
    logger.heartbeat(`ci-wait: still running, ${elapsedSec}s elapsed…${errSuffix}`);
  }, CI_WAIT_HEARTBEAT_MS);
  let exitCode: number;
  let stdout: string;
  let spawnError: Error | undefined;
  try {
    ({ exitCode, stdout, spawnError } = await exec());
  } finally {
    clearInterval(heartbeatHandle);
  }

  const durSec = Math.round((Date.now() - start) / 1000);
  logger.event("ci-wait.exit", `exit=${exitCode} dur=${durSec}s`);

  if (spawnError) {
    const reason = `ci-wait script failed to spawn: ${spawnError.message}`;
    logger.error(reason);
    return { status: "failed", reason };
  }

  let parsed: CiWaitScriptOutput;
  try {
    parsed = JSON.parse(stdout.trim()) as CiWaitScriptOutput;
  } catch (err) {
    const reason = `ci-wait script produced unparseable stdout (exit=${exitCode}): ${(err as Error).message}`;
    logger.error(reason);
    return { status: "failed", reason };
  }

  if (parsed.outcome === "ok") {
    if (parsed.section) {
      await appendPhaseOutput(task, "ci", parsed.section);
    }
    await transitionStatus(task, "reviewing");
    logger.event("task.status", "reviewing");
    return { status: "ok" };
  }

  if (parsed.outcome === "ci-hang") {
    if (parsed.section) {
      await appendPhaseOutput(task, "ci", parsed.section);
    }
    await transitionStatus(task, "needs-human", "ci-hang");
    return { status: "needs-human", reason: "ci-hang" };
  }

  if (parsed.outcome === "config-invalid") {
    // No phase output write — the section is invalid input, not a polling
    // result. Keep `reviews` clean for a re-run after the user fixes the
    // config file.
    await transitionStatus(task, "needs-human", "config-invalid");
    return { status: "needs-human", reason: "config-invalid" };
  }

  if (parsed.outcome === "gh-error") {
    // Permanent gh failure (schema drift, auth, missing PR). Skip phase
    // output — the polling never reached a coherent state. Surface the
    // call+message so the user can fix the gh CLI / config and re-run
    // without spelunking jsonl.
    const detail =
      parsed.ghErrorCall && parsed.ghErrorMessage
        ? `${parsed.ghErrorCall}: ${parsed.ghErrorMessage}`
        : "gh CLI returned a non-recoverable error";
    logger.error(`ci-wait: ${detail}`);
    await transitionStatus(task, "needs-human", "gh-error");
    return { status: "needs-human", reason: "gh-error" };
  }

  const reason = `ci-wait script returned unknown outcome: ${parsed.outcome}`;
  logger.error(reason);
  return { status: "failed", reason };
}

interface ErrorState {
  ghErrors: number;
  lastError: string;
}

function forwardStderrLine(
  line: string,
  jsonl: JsonlSink,
  logger: Logger,
  errorState: ErrorState,
): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof obj.event === "string") {
      // Preserve the script-emitted `ts` so the jsonl log reflects the
      // script's poll timing rather than the wrapper's read-time. JsonlSink
      // is documented as payload-takes-precedence over its synthesized base
      // (`{ ts, kind }`), so passing `ts` through is the canonical way to
      // anchor the event to the source moment.
      const { event, ...rest } = obj;
      jsonl.event(event, rest);
      // Tally gh failures so the heartbeat can surface them. We count both
      // first-attempt retries and exhausted retries — either signal is
      // useful for "is the gh CLI working at all" at a glance.
      if (
        event === "ci-wait.gh_retry" ||
        event === "ci-wait.gh_retry_exhausted" ||
        event === "ci-wait.gh_permanent"
      ) {
        errorState.ghErrors += 1;
        const errMsg = typeof rest.error === "string" ? rest.error : "";
        if (errMsg) errorState.lastError = errMsg;
      }
      return;
    }
  } catch {
    // Fall through — non-JSON line.
  }
  logger.warn(`ci-wait stderr: ${trimmed}`);
}

// Heartbeat lines render to a single terminal row; a multi-line gh error
// (the schema-drift one is multi-paragraph) would wrap and obscure the
// liveness signal. Trim to the first line and a fixed width.
function truncateForLog(message: string, max = 120): string {
  const firstLine = message.split("\n", 1)[0] ?? message;
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}
