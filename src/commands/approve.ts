import fsp from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import pc from "picocolors";
import { findGitRoot, resolveTaskInput } from "../util/git.js";
import { readTask, transitionStatus } from "../state/task-file.js";
import { respawnDetached } from "../util/respawn.js";

export interface ApproveOptions {
  resume?: boolean;
}

export interface ApproveIo {
  stdout?: Writable;
  stderr?: Writable;
  cwd?: string;
}

const PRD_SUMMARY_LINES = 10;

export async function approveCommand(
  taskId: string,
  opts: ApproveOptions = {},
  io: ApproveIo = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    stderr.write(
      `${pc.red("error: flow approve must be executed inside a git repository")}\n`,
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

  await transitionStatus(task, "planned", "approved by user");

  const summary = await readPrdSummary(task.frontmatter.target_repo, task.frontmatter.id);
  if (summary) {
    stdout.write(`${summary}\n`);
  } else {
    stdout.write(`approved ${task.frontmatter.id}: status now planned\n`);
  }

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

// Reads the first ~10 non-blank lines of the plan dir's prd.md so the
// approve confirmation is a positive ack rather than blind. Falls back
// to null when prd.md is missing — the CLI then prints a generic
// "approved" line. We deliberately do not reach for renderStatusDetail
// (different shape) and we do not embed the full PRD body, which would
// drown the chat.
async function readPrdSummary(
  targetRepo: string,
  taskId: string,
): Promise<string | null> {
  const prdPath = path.join(
    targetRepo,
    ".orchestrator",
    "tasks",
    `${taskId}-plan`,
    "prd.md",
  );
  let content: string;
  try {
    content = await fsp.readFile(prdPath, "utf8");
  } catch {
    return null;
  }
  const lines: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (lines.length === 0 && line.length === 0) continue;
    lines.push(line);
    if (lines.length >= PRD_SUMMARY_LINES) break;
  }
  if (lines.length === 0) return null;
  return [
    `approved ${taskId} — PRD summary (first ${lines.length} lines of prd.md):`,
    "",
    ...lines,
  ].join("\n");
}
