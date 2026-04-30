import type { Writable } from "node:stream";
import pc from "picocolors";
import { findGitRoot, resolveTaskInput } from "../util/git.js";
import {
  appendToBodySection,
  readTask,
  transitionStatus,
} from "../state/task-file.js";
import { resolvePromptSource } from "./resolve-prompt.js";
import { respawnDetached } from "../util/respawn.js";

export interface ReviseOptions {
  message?: string;
  resume?: boolean;
}

export interface ReviseIo {
  stdout?: Writable;
  stderr?: Writable;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  cwd?: string;
}

const NOTE_PREVIEW_MAX = 80;

export async function reviseCommand(
  taskId: string,
  opts: ReviseOptions = {},
  io: ReviseIo = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;
  const cwd = io.cwd ?? process.cwd();

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    stderr.write(
      `${pc.red("error: flow revise must be executed inside a git repository")}\n`,
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
  if (status !== "plan-pending-review") {
    stderr.write(
      `${pc.red(
        `error: task ${task.frontmatter.id} is not at plan-pending-review (current: ${status})`,
      )}\n`,
    );
    return 1;
  }

  const argvParts = opts.message ? [opts.message] : [];
  const promptResult = await resolvePromptSource(argvParts, { stdin, stderr });
  if (!promptResult.ok) {
    stderr.write(`${pc.red(promptResult.message)}\n`);
    return promptResult.exitCode;
  }
  const message = promptResult.prompt;

  const ts = new Date().toISOString();
  const block = formatRevisionEntry(ts, message);
  appendToBodySection(task, "## Revision notes", block);
  const preview = message.split("\n", 1)[0]?.slice(0, NOTE_PREVIEW_MAX) ?? "";
  // `transitionStatus` also calls `writeTask`, which persists both the
  // revision-notes append above and the Phase-log line in a single atomic
  // rename. No explicit pre-write is needed — `writeAtomicSync` is
  // all-or-nothing.
  await transitionStatus(task, "worktree-ready", `revise: ${preview}`);

  stdout.write(
    `revised ${task.frontmatter.id}: appended to ## Revision notes, status now worktree-ready\n`,
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

function formatRevisionEntry(ts: string, message: string): string {
  const lines = message.split("\n");
  const head = lines[0] ?? "";
  if (lines.length === 1) {
    return `- ${ts}: ${head}`;
  }
  const continuation = lines.slice(1).map((l) => `  ${l}`).join("\n");
  return `- ${ts}: ${head}\n${continuation}`;
}
