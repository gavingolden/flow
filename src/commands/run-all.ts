import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import pc from "picocolors";
import { findGitRoot } from "../util/git.js";
import { listTriagedTasks } from "../state/queue.js";
import { drain } from "../pipeline/worker-pool.js";
import {
  createRunAllLogger,
  type RunAllLogger,
} from "../util/run-all-logger.js";

export interface RunAllOptions {
  // Concurrency cap. When omitted, defaults to `min(os.cpus().length, 4)`.
  max?: number;
  // Keep the scheduler alive after the initial drain, polling for new
  // triaged tasks on `watchIntervalMs` cadence.
  watch?: boolean;
  // Polling interval in milliseconds. Default 5_000. CLI passes
  // `--watch-interval <seconds> * 1000`.
  watchIntervalMs?: number;
  // Re-exec the scheduler itself as a detached process tree, mirroring
  // `flow run <id> --detach`.
  detach?: boolean;
  // Whether `--max` was user-supplied. When false, the scheduler logs
  // the heuristic ("default --max=N (cpus=C, capped at 4)") so the user
  // sees why N children spawned.
  maxExplicit?: boolean;
}

// Hard cap on the auto-picked default. Phase work is API-bound, not
// CPU-bound — fan-out beyond 4 burns Claude API spend for marginal
// latency improvement on top of an already parallel pipeline. Users
// with the appetite override via `--max <N>`.
const DEFAULT_MAX_CAP = 4;
const DEFAULT_WATCH_INTERVAL_MS = 5_000;
// Window inside which a second SIGINT escalates to SIGTERM-cascade.
// Same shape as `make -j`. After the window, a fresh first-keystroke
// reset is documented behaviour.
const SIGINT_ESCALATION_WINDOW_MS = 5_000;

export async function runAllCommand(opts: RunAllOptions = {}): Promise<void> {
  const repoRoot = await findGitRoot();
  if (!repoRoot) {
    console.error(
      pc.red("error: flow run --all must be executed inside a git repository"),
    );
    process.exit(1);
  }

  const cpus = os.cpus().length;
  const explicitMax = opts.max != null;
  const max = opts.max ?? Math.min(cpus, DEFAULT_MAX_CAP);
  const watchIntervalMs = opts.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;

  if (opts.detach) {
    await detachAndExit(repoRoot, opts);
    return; // not reached — detachAndExit calls process.exit(0)
  }

  const runsDir = path.join(repoRoot, ".orchestrator", "runs");
  // When this process is the detached child, the parent has already
  // opened the plaintext .log file and inherited its fd to us. The env
  // var carries the stamp so our logger appends to the same file rather
  // than computing a fresh stamp (which would split scheduler activity
  // across two files when the parent and child are seconds apart).
  const inheritedStamp = process.env.FLOW_RUN_ALL_STAMP;
  // The detached parent writes `runs/all-<stamp>.pid` so the user can
  // see its path immediately. The child owns cleanup — without this,
  // stale pid files accumulate in `.orchestrator/runs/` forever.
  const inheritedPidPath = inheritedStamp
    ? path.join(runsDir, `all-${inheritedStamp}.pid`)
    : null;
  const logger = await createRunAllLogger({
    runsDir,
    stamp: inheritedStamp,
  });
  // Print the log path immediately so the user can `tail -f` while the
  // scheduler is running. Mirrors the per-task runner's "log → <path>"
  // line. Skip when we're the detached child — the parent already
  // printed it.
  if (!inheritedStamp) {
    console.log(`flow run --all → ${logger.filePath}`);
  }

  if (!explicitMax) {
    logger.info(
      `default --max=${max} (cpus=${cpus}, capped at ${DEFAULT_MAX_CAP})`,
    );
  }
  logger.event("scheduler.start", {
    pid: process.pid,
    max,
    watch: opts.watch === true,
    watchIntervalMs: opts.watch ? watchIntervalMs : null,
  });

  // Process-exit cleanup for the detached pid file. Sync only — Node tears
  // down the event loop before any async I/O queued from inside `'exit'`
  // can complete. The `finally` block's unlinkSync also runs on the happy
  // path; this handler is the safety net for crashes / signal-cascade
  // exits that bypass the finally.
  const exitPidCleanup = (): void => {
    if (!inheritedPidPath) return;
    try { fs.unlinkSync(inheritedPidPath); } catch {}
  };
  process.on("exit", exitPidCleanup);

  const ac = new AbortController();
  // Track in-flight children so the second-SIGINT escalation can
  // propagate SIGTERM to every still-alive process. Children are added
  // on spawn and removed on exit (the worker pool's onSpawn/onExit
  // hooks do the bookkeeping).
  const liveChildren = new Map<string, ChildProcess>();

  let sigintCount = 0;
  let lastSigintAt = 0;
  let escalated = false;

  const sigintHandler = (): void => {
    const now = Date.now();
    // Outside the escalation window, the next Ctrl+C is treated as a
    // fresh first keystroke. Matches `make -j`: the user's "I've waited
    // long enough, kill it" intent has to be deliberate.
    if (sigintCount > 0 && now - lastSigintAt > SIGINT_ESCALATION_WINDOW_MS) {
      sigintCount = 0;
    }
    sigintCount++;
    lastSigintAt = now;
    logger.event("signal.received", { signal: "SIGINT", count: sigintCount });
    if (sigintCount === 1) {
      // Skip the "stopping new claims" line if we've already escalated to
      // SIGTERM-cascade — the user's mental model after escalation is
      // "everything is dying," and re-suggesting "waiting for in-flight
      // children" after the post-window reset is misleading.
      if (!escalated) {
        logger.info(
          "received SIGINT — stopping new claims, waiting for in-flight children",
        );
      }
      ac.abort();
      return;
    }
    // Second SIGINT inside the window — propagate SIGTERM to every
    // live child. The child's existing reaper rewrites its task to
    // `needs-human (signaled)`.
    if (!escalated) {
      escalated = true;
      logger.warn(
        `received second SIGINT — propagating SIGTERM to ${liveChildren.size} child(ren)`,
      );
      for (const [, child] of liveChildren) {
        try {
          child.kill("SIGTERM");
        } catch {}
      }
    }
  };
  process.on("SIGINT", sigintHandler);
  // Deliver-on-SIGTERM: same behaviour as the second SIGINT — propagate
  // SIGTERM to children and exit. The detached-scheduler's documented
  // stop signal. Idempotent on repeat delivery: if the cascade has
  // already fired, just record the signal and return — re-iterating
  // `liveChildren` and re-emitting the warn line on every duplicate
  // SIGTERM would noise up the log without changing behaviour.
  const sigtermHandler = (): void => {
    logger.event("signal.received", { signal: "SIGTERM" });
    if (escalated) return;
    logger.warn(
      `received SIGTERM — propagating to ${liveChildren.size} child(ren) and exiting`,
    );
    ac.abort();
    escalated = true;
    for (const [, child] of liveChildren) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  };
  process.on("SIGTERM", sigtermHandler);

  let totalSpawned = 0;
  let totalSucceeded = 0;
  let totalErrored = 0;

  try {
    while (true) {
      const queue = await listTriagedTasks(repoRoot, {
        onSkip: (filePath, err) => {
          // `catch` bindings are `unknown`; a non-Error throw (null,
          // string, etc.) would TypeError on `.message` access and
          // crash the scheduler before the skip is logged.
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`skipping malformed task file ${filePath}: ${msg}`);
        },
      });
      logger.event("queue.size", { count: queue.length });

      if (queue.length === 0) {
        if (!opts.watch || ac.signal.aborted) {
          if (totalSpawned === 0 && !opts.watch) {
            // Idiomatic Unix message on stderr so a wrapper script can
            // distinguish "queue empty" from "real failure" by exit code
            // (still 0) plus stderr presence.
            process.stderr.write("flow: queue empty — nothing to do\n");
          }
          break;
        }
        logger.event("watch.poll", { intervalMs: watchIntervalMs });
        const stopped = await sleepOrAbort(watchIntervalMs, ac.signal);
        if (stopped) break;
        continue;
      }

      const ids = queue.map((q) => q.id);
      const result = await drain(ids, {
        max,
        signal: ac.signal,
        spawn: (id) => {
          const child = spawnChildRunner(id, repoRoot);
          totalSpawned++;
          liveChildren.set(id, child);
          logger.event("worker.spawn", { id, pid: child.pid ?? null });
          return child;
        },
        onExit: ({ id, exitCode, signal }) => {
          liveChildren.delete(id);
          if (signal != null) totalErrored++;
          else if (exitCode === 0) totalSucceeded++;
          else totalErrored++;
          logger.event("worker.exit", {
            id,
            exitCode,
            signal,
          });
        },
      });

      // If the abort signal fired, do not refill. Watch-mode honours the
      // signal too: aborting means "exit cleanly," not "skip this drain
      // and poll again."
      if (result.aborted) break;
      if (!opts.watch) break;

      // Watch mode with a non-empty drain just completed. Sleep one
      // poll interval before re-listing — without this, a fast drain
      // would tight-loop the readdir/parse path and violate the
      // documented `--watch-interval` cadence. New tasks created
      // during the sleep are picked up on the next pass.
      logger.event("watch.poll", { intervalMs: watchIntervalMs });
      const stopped = await sleepOrAbort(watchIntervalMs, ac.signal);
      if (stopped) break;
    }
  } finally {
    let exitCode = 0;
    if (escalated) {
      exitCode = 130;
    } else if (totalSpawned === 0) {
      exitCode = 0;
    } else if (totalSucceeded === 0) {
      // Every spawned child errored — surface a non-zero exit so a
      // wrapper script (`flow run --all && echo done`) doesn't claim
      // success on a totally failed batch.
      exitCode = 1;
    }
    logger.event("scheduler.exit", {
      spawned: totalSpawned,
      succeeded: totalSucceeded,
      errored: totalErrored,
      exitCode,
    });
    // Remove signal handlers BEFORE awaiting logger.close(). A SIGINT
    // delivered while the streams are mid-flush would invoke
    // `logger.event()` against an `end()`-ing write stream and trip
    // ERR_STREAM_WRITE_AFTER_END. Once handlers are gone, signals
    // restore default behaviour (terminate) which is what the user
    // expects after the scheduler has decided its exit code.
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigtermHandler);
    await logger.close();
    if (inheritedPidPath) {
      // Best-effort: a missing file (already cleaned, or never written
      // because the parent failed) is fine; any other error surfaces to
      // stderr but doesn't change the exit code.
      try {
        fs.unlinkSync(inheritedPidPath);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ENOENT") {
          process.stderr.write(
            `[run-all] could not remove pid file ${inheritedPidPath}: ${e.message}\n`,
          );
        }
      }
    }
    process.removeListener("exit", exitPidCleanup);
    if (exitCode !== 0) process.exit(exitCode);
  }
}

// Re-exec the scheduler as a detached process tree, mirroring
// `flow run <id> --detach`. The parent opens log + pid files so it can
// print their paths immediately, then `process.exit(0)`s — the child
// inherits the open log fds via stdio.
async function detachAndExit(
  repoRoot: string,
  opts: RunAllOptions,
): Promise<void> {
  const runsDir = path.join(repoRoot, ".orchestrator", "runs");
  await fsp.mkdir(runsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(runsDir, `all-${stamp}.log`);
  const pidPath = path.join(runsDir, `all-${stamp}.pid`);
  // Open the log fd ourselves so the child's stdout/stderr land in the
  // same file the scheduler logger appends to. We don't open the jsonl
  // fd here — the child opens it itself via `createRunAllLogger` with
  // the same stamp (passed via env var below).
  const logFd = fs.openSync(logPath, "a");

  const entry = process.argv[1];
  if (!entry) {
    throw new Error("flow run --all --detach: process.argv[1] missing — cannot re-exec");
  }
  // Re-exec without `--detach`. The child's `runAllCommand` will see no
  // detach flag and proceed to the foreground path. Forward `--max`,
  // `--watch`, `--watch-interval` if they were set so the child has the
  // same intent.
  const childArgs = [
    ...process.execArgv,
    entry,
    "run",
    "--all",
  ];
  if (opts.max != null) childArgs.push("--max", String(opts.max));
  if (opts.watch) childArgs.push("--watch");
  if (opts.watchIntervalMs != null) {
    childArgs.push("--watch-interval", String(Math.round(opts.watchIntervalMs / 1000)));
  }

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: repoRoot,
    // Tell the child to use this exact stamp so the log path printed by
    // the parent matches the file the child writes to.
    env: { ...process.env, FLOW_RUN_ALL_STAMP: stamp },
  });
  child.unref();
  try { fs.closeSync(logFd); } catch {}

  // `child.pid` is undefined only if `spawn()` itself failed (e.g. ENOENT
  // on the node binary, EAGAIN on fork). Surface that as a real error
  // rather than printing "detached as pid undefined" and silently exiting
  // 0 with no pid file.
  if (child.pid == null) {
    console.error(
      `error: failed to spawn detached scheduler — check ${logPath} for details`,
    );
    process.exit(1);
  }
  fs.writeFileSync(pidPath, `${child.pid}\n`, "utf8");

  console.log(`flow run --all detached as pid ${child.pid}`);
  console.log(`log → ${logPath}`);
  console.log(`pid → ${pidPath}`);
  process.exit(0);
}

function spawnChildRunner(taskId: string, repoRoot: string): ChildProcess {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error(
      "flow run --all: process.argv[1] missing — cannot spawn child runner",
    );
  }
  // Re-exec the same Node binary with the same loader argv so tsx (in
  // dev) propagates. The child runs `flow run <id>` (no `--detach`)
  // — the scheduler reaps via `child.on("exit", …)`. Stdio is fully
  // ignored: the child's per-task log file is the only sink we need,
  // and an unread "pipe" would deadlock once the OS pipe buffer
  // (~64KB on macOS) filled with a chatty child's output.
  return spawn(
    process.execPath,
    [...process.execArgv, entry, "run", taskId],
    {
      stdio: ["ignore", "ignore", "ignore"],
      cwd: repoRoot,
      // Strip scheduler-only env vars before handing off to the
      // per-task child:
      //   - FLOW_LOG_PATH: scheduler's createLogger uses this; the
      //     child must open its own per-task file at
      //     `runs/<safeTaskId>-<stamp>.log` rather than appending to
      //     the scheduler's.
      //   - FLOW_RUN_ALL_STAMP: only the scheduler interprets this
      //     (to inherit the parent-detached log stamp); leaking it
      //     into per-task children means a future read of the var
      //     would silently bind to the scheduler's stamp instead of
      //     no-op'ing.
      env: stripSchedulerEnv(process.env),
    },
  );
}

function stripSchedulerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { FLOW_LOG_PATH, FLOW_RUN_ALL_STAMP, ...rest } = env;
  return rest;
}

async function sleepOrAbort(
  ms: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
