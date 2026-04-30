import fsp from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import pc from "picocolors";
import { execa } from "execa";
import { findGitRoot, resolveTaskInput } from "../util/git.js";
import { readTask, transitionStatus } from "../state/task-file.js";
import { taskDirFor } from "../pipeline/runner.js";
import { clearPauseFlag } from "../state/pause-flag.js";
import {
  pidFilePath,
  readPidFileSync,
  unlinkPidFileSync,
} from "../state/runner-pid.js";

export interface AbortOptions {
  confirm?: boolean;
}

export interface AbortIo {
  stdout?: Writable;
  stderr?: Writable;
  cwd?: string;
}

// Statuses where the task is already in a terminal state and abort is a
// no-op. Distinct from `pause.ts`'s wider `PAUSE_REFUSAL_STATUSES` —
// pause refuses on `needs-human` too (no runner to halt), but abort
// *should* fire against `needs-human` to tear down a stuck task's
// worktree/PR.
const ABORT_TERMINAL_STATUSES = new Set(["merged", "aborted"]);

export async function abortCommand(
  taskId: string,
  opts: AbortOptions = {},
  io: AbortIo = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();

  if (!opts.confirm) {
    stderr.write(
      `${pc.red(
        "error: abort requires --confirm (this is destructive: closes PR, removes worktree, archives task)",
      )}\n`,
    );
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    stderr.write(
      `${pc.red("error: flow abort must be executed inside a git repository")}\n`,
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
  if (ABORT_TERMINAL_STATUSES.has(status)) {
    stderr.write(
      `${pc.red(`error: cannot abort task at terminal status ${status}`)}\n`,
    );
    return 1;
  }

  const pr = task.frontmatter.pr;
  const worktree = task.frontmatter.worktree;
  const branch = task.frontmatter.branch;
  const targetRepo = task.frontmatter.target_repo;

  // Detect a still-active runner so we can warn (the runner will see the
  // terminal status on its next phase boundary and bail; this just
  // surfaces the race so the user isn't surprised by a stray phase line
  // landing after abort prints "ok").
  const taskDir = taskDirFor(repoRoot, task.frontmatter.id);
  const livePid = detectLiveRunner(taskDir);

  // Step 1: status transition first. Even if a downstream cleanup step
  // fails, the task ends up in the right terminal state — mirrors
  // merge.ts's defensive ordering.
  await transitionStatus(task, "aborted", "user-aborted");

  const summary: string[] = [`aborted ${task.frontmatter.id}:`];

  // Step 2: close the PR if one is open.
  if (pr != null) {
    const ghCwd = worktree && existsSync(worktree) ? worktree : targetRepo;
    const closeRes = await execa(
      "gh",
      [
        "pr",
        "close",
        String(pr),
        "--comment",
        `aborted by user via flow (task ${task.frontmatter.id})`,
      ],
      { cwd: ghCwd, reject: false },
    );
    if (closeRes.exitCode === 0) {
      summary.push(`- PR #${pr}: closed`);
    } else {
      const detail = (closeRes.stderr || closeRes.stdout || `exit ${closeRes.exitCode}`).trim();
      summary.push(`- PR #${pr}: WARN: close failed: ${truncate(detail, 200)}`);
    }
  } else {
    summary.push("- PR: (none)");
  }

  // Step 3: remove the worktree (and branch) via the existing helper if
  // either field is set and a worktree directory still exists. Best-effort.
  let worktreeHandled = false;
  if (worktree && existsSync(worktree)) {
    const removeScript = path.join(targetRepo, "scripts", "remove-agent-worktree.ts");
    if (!existsSync(removeScript)) {
      summary.push(
        `- Worktree: WARN: remove-agent-worktree.ts not found at ${removeScript}; manual cleanup required`,
      );
    } else {
      const args = branch ? [branch, "--delete-branch"] : [worktree];
      try {
        const rm = await execa(removeScript, args, {
          cwd: targetRepo,
          reject: false,
        });
        if (rm.exitCode === 0) {
          summary.push(
            `- Worktree: removed${branch ? ` (branch ${branch} deleted)` : ""}`,
          );
        } else {
          const detail = (rm.stderr || rm.stdout || `exit ${rm.exitCode}`).trim();
          summary.push(
            `- Worktree: WARN: removal failed: ${truncate(detail, 200)}`,
          );
        }
      } catch (err) {
        const e = err as { shortMessage?: string; message?: string };
        summary.push(
          `- Worktree: WARN: removal threw: ${e.shortMessage ?? e.message ?? String(err)}`,
        );
      }
    }
    worktreeHandled = true;
  } else if (worktree) {
    summary.push("- Worktree: already gone (no-op)");
    worktreeHandled = true;
  }
  if (!worktreeHandled) {
    summary.push("- Worktree: (none)");
  }

  // Step 4: archive the task file (mirrors merge.ts's archive step).
  const archiveDir = path.join(targetRepo, ".orchestrator", "tasks", "archive");
  await fsp.mkdir(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, `${task.frontmatter.id}.md`);
  if (task.path !== archivePath) {
    if (existsSync(task.path)) {
      await fsp.rename(task.path, archivePath);
      task.path = archivePath;
    } else if (!existsSync(archivePath)) {
      summary.push(
        `- Archive: WARN: source task file missing during archive: ${task.path}`,
      );
    }
  }
  if (existsSync(archivePath)) {
    summary.push(`- Archived: ${archivePath}`);
  }

  // Step 5: best-effort cleanup of the pause flag and pid file (lingering
  // state that's irrelevant once the task is terminal). ENOENT is silent.
  try { await clearPauseFlag(taskDir); } catch {}
  if (existsSync(pidFilePath(taskDir))) {
    try { unlinkPidFileSync(taskDir); } catch {}
  }

  for (const line of summary) stdout.write(`${line}\n`);

  if (livePid != null) {
    stdout.write(
      `WARN: runner pid ${livePid} is still active — abort proceeded but the running phase will continue until it exits\n`,
    );
  }
  return 0;
}

function detectLiveRunner(taskDir: string): number | null {
  const pid = readPidFileSync(taskDir);
  if (pid == null) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return pid;
    return null;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
