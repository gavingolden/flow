import fsp from "node:fs/promises";
import type { Writable } from "node:stream";
import pc from "picocolors";
import { findGitRoot, resolveTaskInput } from "../util/git.js";
import {
  readTask,
  transitionStatus,
  updateTaskFrontmatter,
} from "../state/task-file.js";
import { TaskStatus } from "../state/phases.js";
import { clearPauseFlag } from "../state/pause-flag.js";
import { taskDirFor } from "../pipeline/runner.js";
import { respawnDetached } from "../util/respawn.js";

export interface ResumeOptions {
  resume?: boolean;
}

export interface ResumeIo {
  stdout?: Writable;
  stderr?: Writable;
  cwd?: string;
}

export async function resumeCommand(
  taskId: string,
  opts: ResumeOptions = {},
  io: ResumeIo = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    stderr.write(
      `${pc.red("error: flow resume must be executed inside a git repository")}\n`,
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

  if (status === "plan-pending-review") {
    stderr.write(
      `${pc.red(
        `error: task ${task.frontmatter.id} is at plan-pending-review — use /flow-approve ${task.frontmatter.id} or /flow-revise ${task.frontmatter.id} instead`,
      )}\n`,
    );
    return 1;
  }
  if (status !== "needs-human") {
    stderr.write(
      `${pc.red(`error: task is not paused (current status: ${status})`)}\n`,
    );
    return 1;
  }

  const pausedFrom = task.frontmatter.paused_from ?? null;
  if (!pausedFrom) {
    stderr.write(
      `${pc.red(
        `error: task is at needs-human but not paused via \`flow pause\`; resolve manually or use \`flow run ${task.frontmatter.id}\``,
      )}\n`,
    );
    return 1;
  }

  const taskDir = taskDirFor(repoRoot, task.frontmatter.id);
  await fsp.mkdir(taskDir, { recursive: true });
  await clearPauseFlag(taskDir);

  // Capture the restore target before we mutate the field. `transitionStatus`
  // writes the Phase log and persists the new status; `updateTaskFrontmatter`
  // then clears `paused_from` so a future `flow pause` doesn't see a stale
  // value. Order: clear flag → restore status → clear paused_from. If a
  // crash interleaves between the status write and the paused_from clear,
  // the next `flow resume` re-reads paused_from, sees it equal to the
  // current status (resume just rewound to that point), and the no-op
  // path triggers the "task is not paused" refusal — annoying but safe.
  const restoreTarget = pausedFrom as TaskStatus;
  await transitionStatus(task, restoreTarget, "resumed by user");
  await updateTaskFrontmatter(task, { paused_from: null });

  stdout.write(
    `resumed ${task.frontmatter.id}: status now ${restoreTarget}\n`,
  );

  if (opts.resume === false) {
    stdout.write(
      `pipeline NOT resumed (--no-resume); run \`flow run ${task.frontmatter.id}\` when ready.\n`,
    );
    return 0;
  }

  const { pid, logPath } = await respawnDetached(task.frontmatter.id, repoRoot);
  stdout.write(`flow run ${task.frontmatter.id} detached as pid ${pid}\n`);
  stdout.write(`log → ${logPath}\n`);
  return 0;
}
