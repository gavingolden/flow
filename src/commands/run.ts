import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import pc from "picocolors";
import { findGitRoot, resolveTaskInput } from "../util/git.js";
import { readTask } from "../state/task-file.js";
import { isClaimableStatus, runPipeline, taskDirFor } from "../pipeline/runner.js";
import { createLogger } from "../util/logger.js";
import {
  unlinkPidFileSync,
  writePidFileSync,
} from "../state/runner-pid.js";
import {
  type ReaperReason,
  reapStatusAsync,
  reapStatusSync,
} from "../state/reaper.js";
import { acquireClaim, type Claim } from "../state/claim.js";

export interface RunOptions {
  detach?: boolean;
}

// Env var the parent uses to hand a pre-opened plaintext-log path to a
// detached child so the child's `createLogger` reuses the same file
// (appending) rather than opening a second one. Internal — not part of the
// public CLI surface.
const FLOW_LOG_PATH_ENV = "FLOW_LOG_PATH";

export async function runCommand(
  taskId: string,
  opts: RunOptions = {},
): Promise<void> {
  const repoRoot = await findGitRoot();
  if (!repoRoot) {
    console.error(
      pc.red("error: flow run must be executed inside a git repository"),
    );
    process.exit(1);
  }

  const resolved = await resolveTaskInput(taskId, repoRoot, process.cwd());
  if (resolved.kind === "not-found") {
    // Tailor the wording: a bare id failure points the user at the two
    // task roots they should check, while a path failure should not
    // suggest the CLI ignored their path.
    const message =
      resolved.inputKind === "id"
        ? `error: task '${resolved.input}' not found in .orchestrator/tasks/ or .orchestrator/tasks/archive/`
        : `error: path '${resolved.input}' not found`;
    console.error(pc.red(message));
    process.exit(1);
  }
  if (resolved.kind === "ambiguous") {
    console.error(pc.red(`error: input '${taskId}' is ambiguous; candidates:`));
    for (const c of resolved.candidates) console.error(pc.red(`  ${c}`));
    process.exit(1);
  }
  if (resolved.kind === "invalid") {
    console.error(pc.red(`error: ${resolved.reason}`));
    process.exit(1);
  }
  const taskPath = resolved.path;

  const task = await readTask(taskPath);
  // The task directory is conceptually "owned" by the worktree phase, but
  // PR 1 needs it earlier — runner.pid and per-phase jsonl files both
  // live there. mkdir-p is cheap and idempotent.
  const taskDir = taskDirFor(repoRoot, task.frontmatter.id);
  await fsp.mkdir(taskDir, { recursive: true });

  if (opts.detach) {
    await detachAndExit(taskId, repoRoot);
    return; // not reached — detachAndExit calls process.exit(0)
  }

  // Cross-process claim acquisition. Two `flow run <id>` invocations
  // against the same task race here; the loser exits cleanly with no
  // work to do. Skipped for terminal statuses so we preserve the
  // runner's existing no-op behaviour for `merged`/`aborted`/etc.
  //
  // `acquireClaim` returns `null` only on contention (live holder, lost
  // EEXIST race). Unexpected I/O failures throw — those are real
  // problems we don't want to mask as "already claimed", so we let them
  // propagate to the runner's normal error path.
  let claim: Claim | null = null;
  if (isClaimableStatus(task.frontmatter.status)) {
    claim = acquireClaim(taskDir, task.frontmatter.id);
    if (!claim) {
      process.stderr.write(
        `task ${task.frontmatter.id} already claimed by another runner\n`,
      );
      process.exit(0);
    }
  }

  // Install a release-on-exit hook *immediately* after acquiring the
  // claim, before any further async/sync work that could throw. Without
  // this, an exception from `createLogger` / `writePidFileSync` /
  // anything between here and the main `exitHandler` install below
  // would leave the canonical lock in place until stale-claim recovery
  // kicked in on the next attempt.
  const releaseClaimOnExit = (): void => {
    if (claim) {
      try { claim.release(); } catch {}
    }
  };
  process.on("exit", releaseClaimOnExit);

  const runsDir = path.join(repoRoot, ".orchestrator", "runs");
  // When this process is the detached child, the parent has already
  // opened the plaintext log file and inherited its fd to us. The env
  // var carries the path so our logger appends to the same file rather
  // than opening a fresh one with a slightly later stamp. Constrain the
  // path to a child of `runsDir` so a stray external `FLOW_LOG_PATH=...`
  // (set in a parent shell, an attacker-controlled wrapper, or a buggy
  // worktree script that re-execs flow) can't redirect logs to an
  // arbitrary filesystem location.
  const logFilePath = resolveSafeLogPath(process.env[FLOW_LOG_PATH_ENV], runsDir);
  const logger = await createLogger({
    runsDir,
    taskId: task.frontmatter.id,
    filePath: logFilePath,
  });

  // Install reaper / pid file *after* the logger so the very first events
  // reach disk, but *before* the pipeline so a synchronous early throw is
  // still caught by the exit handler.
  writePidFileSync(taskDir, process.pid);

  // Set when the pipeline returns a clean `failed` / `needs-human`
  // PhaseResult — the runner already surfaced the reason via the logger
  // and is exiting non-zero. The reaper must not overwrite that path with
  // a generic `immediate-exit` / `signaled` line.
  let cleanlyHandled = false;
  let reapReason: ReaperReason = "immediate-exit";

  const exitHandler = (): void => {
    // Sync only — Node tears down the event loop before any async I/O
    // queued from inside `'exit'` can complete.
    try { unlinkPidFileSync(taskDir); } catch {}
    if (claim) { try { claim.release(); } catch {} }
    if (cleanlyHandled) return;
    // Use the tracked `reapReason` so the recorded reason matches what
    // actually happened: "signaled" set by the SIGTERM/SIGINT handlers,
    // "runner-crashed" set by the catch clause, "immediate-exit" by
    // default. Hardcoding "signaled" here would mislabel non-signal exits
    // (e.g. uncaught throws routed through the catch+finally that didn't
    // get to await the async reaper before process.exit).
    try { reapStatusSync(taskPath, reapReason); } catch {}
  };
  process.on("exit", exitHandler);
  // Default signal disposition is "kill the process without running 'exit'
  // handlers". Translating to process.exit(<conventional code>) routes
  // through the exit handler and runs our cleanup. Idempotent across
  // re-delivery because process.exit is final.
  const sigHandler = (code: number) => () => {
    reapReason = "signaled";
    process.exit(code);
  };
  process.on("SIGTERM", sigHandler(143));
  process.on("SIGINT", sigHandler(130));

  let exitCode = 0;
  try {
    logger.info(`log → ${logger.filePath}`);
    logger.info(`task ${task.frontmatter.id}`);
    logger.info(`status ${task.frontmatter.status}`);

    const result = await runPipeline(task, logger, { taskDir });

    if (result.status === "ok") {
      const { frontmatter } = await readTask(taskPath);
      logger.success(`pipeline ok — status now ${frontmatter.status}`);
      cleanlyHandled = true;
      if (frontmatter.pr) {
        const url = await fetchPrUrl(
          frontmatter.pr,
          frontmatter.worktree ?? repoRoot,
        );
        logger.success(url ?? `PR #${frontmatter.pr} opened`);
      }
      return;
    }

    logger.error(`pipeline ${result.status} — ${result.reason}`);
    // Mark cleanly-handled so the reaper doesn't overwrite the phase's
    // failure context with a generic `immediate-exit` line. Per PRD: the
    // reaper does not turn `failed` outcomes into `needs-human`.
    cleanlyHandled = true;
    exitCode = 1;
  } catch (err) {
    const e = err as { message?: string; stack?: string };
    logger.error(`pipeline crashed: ${e.message ?? String(err)}`);
    if (e.stack) logger.error(e.stack);
    reapReason = "runner-crashed";
    exitCode = 1;
    throw err;
  } finally {
    if (!cleanlyHandled) {
      // immediate-exit (no exception, no handled failure, status still
      // transient) or runner-crashed (exception path set the reason). The
      // reaper itself decides whether to actually rewrite based on the
      // task's current on-disk status.
      try { await reapStatusAsync(taskPath, reapReason); } catch {}
    }
    try { unlinkPidFileSync(taskDir); } catch {}
    if (claim) { try { claim.release(); } catch {} }
    await logger.close();
    // Removing the listener before process.exit is cosmetic (process is
    // about to die) but keeps the test harness clean — vitest re-imports
    // this module across tests and we don't want stale listeners
    // accumulating on the singleton `process`.
    process.removeListener("exit", exitHandler);
    process.removeListener("exit", releaseClaimOnExit);
    if (exitCode !== 0) process.exit(exitCode);
  }
}

async function detachAndExit(
  taskId: string,
  repoRoot: string,
): Promise<void> {
  // Open the plaintext log file ourselves so the child writes to a
  // pre-known path — that way we can print "log → <path>" to the user
  // immediately (rather than only after the child opens its own file with
  // a slightly different stamp). The child's `createLogger` honours the
  // env var and appends to this same file.
  //
  // Implementer's note re: PRD open-question: fd-inheritance is the path
  // taken here. If a future port to Windows or an exotic shell makes fd
  // inheritance fragile, fall back to "child opens its own log; parent
  // prints a predicted path" — both modes use the same env-var contract.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeTaskId = taskId.replace(/[^A-Za-z0-9._-]/g, "_");
  const runsDir = path.join(repoRoot, ".orchestrator", "runs");
  await fsp.mkdir(runsDir, { recursive: true });
  const logPath = path.join(runsDir, `${safeTaskId}-${stamp}.log`);
  const logFd = fs.openSync(logPath, "a");
  // The child re-execs the same Node binary with the same loader-script
  // argv (so the tsx loader propagates in dev) and the same `run <id>`
  // sub-command, minus `--detach`. The argv0 fallback to argv[1] handles
  // the rare case of being invoked without process.argv[1] (impossible
  // for the CLI but cheap to guard).
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("flow run --detach: process.argv[1] missing — cannot re-exec");
  }
  const child = spawn(
    process.execPath,
    [...process.execArgv, entry, "run", taskId],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: repoRoot,
      env: { ...process.env, [FLOW_LOG_PATH_ENV]: logPath },
    },
  );
  child.unref();
  // Close our copy of the fd so the parent's exit doesn't keep the file
  // open beyond when the child wants to fsync/rotate. The child's own fd
  // (inherited via stdio) keeps the file alive.
  try { fs.closeSync(logFd); } catch {}

  console.log(`flow run ${taskId} detached as pid ${child.pid}`);
  console.log(`log → ${logPath}`);
  process.exit(0);
}

// Validate `FLOW_LOG_PATH` if set: must resolve to a path inside `runsDir`.
// Anything else (absent, empty, or pointing outside `runsDir`) returns
// `undefined` so the logger falls back to its computed path. Symlink
// traversal isn't a concern because the parent path created the file
// itself before exec'ing the child; the constraint is defence-in-depth
// against an environment-variable injection by a wrapper shell.
function resolveSafeLogPath(
  envValue: string | undefined,
  runsDir: string,
): string | undefined {
  if (!envValue) return undefined;
  const resolved = path.resolve(envValue);
  const runsDirResolved = path.resolve(runsDir);
  // Use `path.relative` + `..` check — startsWith on raw strings would
  // accept e.g. `<runsDir>-evil/log` as a sibling.
  const rel = path.relative(runsDirResolved, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    console.warn(
      pc.yellow(
        `warning: ignoring FLOW_LOG_PATH=${envValue} — path is not under ${runsDirResolved}`,
      ),
    );
    return undefined;
  }
  return resolved;
}

async function fetchPrUrl(
  prNumber: number,
  cwd: string,
): Promise<string | null> {
  // execa with reject:false still throws on spawn-time errors (gh missing,
  // cwd deleted). The success path of `flow run` must never crash on a
  // best-effort URL lookup, so swallow any throw and let the caller fall
  // back to the bare `PR #<n>` line.
  try {
    const result = await execa(
      "gh",
      ["pr", "view", String(prNumber), "--json", "url", "-q", ".url"],
      { cwd, reject: false },
    );
    if (result.exitCode !== 0) return null;
    const url = result.stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}
