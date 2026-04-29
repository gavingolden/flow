import fs from "node:fs";
import path from "node:path";

// One pid file per task at <taskDir>/runner.pid. Holds the PID of the
// `flow run <id>` Node process — the *task-level* runner, not per-phase.
// Per-phase pid files are deferred to PR 16 (pause/abort).
//
// Both the write and the unlink need a sync API: the unlink runs from
// `process.on('exit', ...)`, which is sync-only because Node tears down
// the event loop before the queued microtask can fire.

export function pidFilePath(taskDir: string): string {
  return path.join(taskDir, "runner.pid");
}

export function writePidFileSync(taskDir: string, pid: number): void {
  // taskDir is guaranteed to exist by the time this is called (the runner
  // mkdir's it before installing handlers). No retry / mkdir here keeps
  // the boundary tight: if it fails, something else is broken.
  fs.writeFileSync(pidFilePath(taskDir), `${pid}\n`, "utf8");
}

// Idempotent — second call swallows ENOENT. The clean-exit path unlinks
// in `finally`, then the `'exit'` handler tries again; we don't want the
// second attempt to throw and mask whatever exit code we wanted.
export function unlinkPidFileSync(taskDir: string): void {
  try {
    fs.unlinkSync(pidFilePath(taskDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export function readPidFileSync(taskDir: string): number | null {
  try {
    const raw = fs.readFileSync(pidFilePath(taskDir), "utf8");
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
