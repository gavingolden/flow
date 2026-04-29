import fsp from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import pc from "picocolors";
import { findGitRoot, findTaskFile } from "../util/git.js";
import { concatRender } from "../log/concat.js";
import {
  filterByPhase,
  listLogFiles,
  listTaskIds,
  taskDirFor,
} from "../log/discover.js";
import { follow } from "../log/follow.js";
import { streamRaw } from "../log/raw.js";

export interface LogOptions {
  phase?: string;
  follow?: boolean;
  raw?: boolean;
}

export interface LogIo {
  stdout?: Writable;
  stderr?: Writable;
  cwd?: string;
}

export async function logCommand(
  taskId: string | undefined,
  opts: LogOptions = {},
  io: LogIo = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  const repoRoot = await findGitRoot(io.cwd);
  if (!repoRoot) {
    stderr.write(
      `${pc.red("error: flow log must be executed inside a git repository")}\n`,
    );
    return 1;
  }

  if (!taskId) {
    const ids = await listTaskIds(repoRoot);
    if (ids.length === 0) {
      stdout.write("no tasks found in .orchestrator/tasks/\n");
      return 0;
    }
    for (const id of ids) stdout.write(`${id}\n`);
    return 0;
  }

  if (!(await findTaskFile(taskId, repoRoot))) {
    stderr.write(
      `${pc.red(`error: task '${taskId}' not found in .orchestrator/tasks/`)}\n`,
    );
    return 1;
  }

  const taskDir = taskDirFor(repoRoot, taskId);
  const logsDir = path.join(taskDir, "logs");
  if (!(await dirExists(logsDir))) {
    stdout.write(`no logs yet for ${taskId}\n`);
    return 0;
  }

  const allFiles = await listLogFiles(taskDir);
  const filtered = opts.phase
    ? filterByPhase(allFiles, opts.phase)
    : allFiles;
  if (filtered.length === 0) {
    if (opts.phase) {
      stderr.write(
        `no log files match phase '${opts.phase}' for task '${taskId}'\n`,
      );
    } else {
      stdout.write(`no logs yet for ${taskId}\n`);
    }
    return 0;
  }

  if (opts.raw) {
    await streamRaw(filtered, stdout);
    return 0;
  }

  if (opts.follow) {
    await follow({
      stdout,
      stderr,
      taskDir,
      taskId,
      targetSet: filtered,
    });
    return 0;
  }

  await concatRender(filtered, {
    stdout,
    stderr,
    bannerWidth: bannerWidthFor(stdout),
  });
  return 0;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function bannerWidthFor(stdout: Writable): number | undefined {
  // process.stdout has `columns` only when it's a TTY; injected sinks won't.
  const cols = (stdout as { columns?: number }).columns;
  return typeof cols === "number" && cols > 0 ? cols : undefined;
}
