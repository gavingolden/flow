import fsp from "node:fs/promises";
import type { Writable } from "node:stream";
import pc from "picocolors";
import { findGitRoot, resolveTaskInput } from "../util/git.js";
import { readTask } from "../state/task-file.js";
import { dropPauseFlag, pauseFlagPath } from "../state/pause-flag.js";
import { readPidFileSync } from "../state/runner-pid.js";
import { taskDirFor } from "../pipeline/runner.js";

export interface PauseIo {
  stdout?: Writable;
  stderr?: Writable;
  cwd?: string;
}

// Statuses where `flow pause` refuses to drop the flag. `merged` and
// `aborted` are genuinely terminal; `needs-human` is non-running by
// definition (a paused, exhausted, or failed task already sits there)
// so dropping a pause flag on it has no effect — the runner isn't going
// to pick it up. Distinct from `abort.ts`'s narrower `ABORT_TERMINAL_STATUSES`
// (which only excludes `merged`/`aborted`) — abort *can* fire against a
// `needs-human` task to clean up its worktree/PR.
const PAUSE_REFUSAL_STATUSES = new Set(["merged", "aborted", "needs-human"]);

export async function pauseCommand(
  taskId: string,
  _opts: Record<string, never> = {},
  io: PauseIo = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    stderr.write(
      `${pc.red("error: flow pause must be executed inside a git repository")}\n`,
    );
    return 1;
  }

  const resolved = await resolveTaskInput(taskId, repoRoot, cwd);
  if (resolved.kind === "not-found") {
    const message =
      resolved.inputKind === "id"
        ? `error: task '${resolved.input}' not found in .orchestrator/tasks/ or .orchestrator/tasks/archive/`
        : `error: path '${resolved.input}' not found`;
    stderr.write(`${pc.red(message)}\n`);
    return 1;
  }
  if (resolved.kind === "ambiguous") {
    stderr.write(`${pc.red(`error: input '${taskId}' is ambiguous; candidates:`)}\n`);
    for (const c of resolved.candidates) stderr.write(`${pc.red(`  ${c}`)}\n`);
    return 1;
  }
  if (resolved.kind === "invalid") {
    stderr.write(`${pc.red(`error: ${resolved.reason}`)}\n`);
    return 1;
  }

  const task = await readTask(resolved.path);
  const status = task.frontmatter.status;

  if (PAUSE_REFUSAL_STATUSES.has(status)) {
    stderr.write(
      `${pc.red(`error: cannot pause task at status ${status}`)}\n`,
    );
    return 1;
  }
  if (status === "plan-pending-review") {
    stderr.write(
      `${pc.red(
        `error: task ${task.frontmatter.id} is already paused at plan-pending-review — use /flow-revise ${task.frontmatter.id} or /flow-abort ${task.frontmatter.id}`,
      )}\n`,
    );
    return 1;
  }

  const taskDir = taskDirFor(repoRoot, task.frontmatter.id);
  await fsp.mkdir(taskDir, { recursive: true });
  await dropPauseFlag(taskDir);

  stdout.write(
    `paused ${task.frontmatter.id}: pause flag dropped at ${pauseFlagPath(taskDir)}\n`,
  );

  const runnerLive = isRunnerLive(taskDir);
  if (runnerLive) {
    stdout.write(
      `runner is active — pipeline will exit cleanly at the next phase boundary (status → needs-human, reason user-paused).\n`,
    );
  } else {
    stdout.write(
      `no active runner detected — task will not start until you run \`flow resume ${task.frontmatter.id}\`.\n`,
    );
  }
  return 0;
}

function isRunnerLive(taskDir: string): boolean {
  const pid = readPidFileSync(taskDir);
  if (pid == null) return false;
  try {
    // Signal 0 doesn't deliver — it just probes pid existence and
    // permissions. ESRCH means "no such process" (runner already exited
    // and the pid file is stale); EPERM means the pid is alive but owned
    // by another user (treat as alive — same effect for our hint).
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

