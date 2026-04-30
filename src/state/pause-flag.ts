import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// Per-task pause flag at <taskDir>/.pause. Existence is the signal — file
// contents are intentionally empty so a hand-`touch`ed flag works the same
// as one created via `flow pause`. Per-task (not global) so concurrent
// runners under `flow run --all` keep working when the user pauses one
// task; see prd.md "Pause flag location" for the rationale.

export function pauseFlagPath(taskDir: string): string {
  return path.join(taskDir, ".pause");
}

export function isPaused(taskDir: string): boolean {
  return fs.existsSync(pauseFlagPath(taskDir));
}

export async function dropPauseFlag(taskDir: string): Promise<void> {
  await fsp.writeFile(pauseFlagPath(taskDir), "", "utf8");
}

// Idempotent — second call swallows ENOENT. Resume calls this before
// re-spawning the runner; abort calls it during best-effort cleanup. Both
// paths must tolerate a missing flag (user typed `rm .pause` between
// pause and resume, abort fires on a never-paused task, etc.).
export async function clearPauseFlag(taskDir: string): Promise<void> {
  try {
    await fsp.unlink(pauseFlagPath(taskDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
