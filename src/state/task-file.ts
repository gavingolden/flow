import fs from "node:fs/promises";
import fsSync from "node:fs";
import matter from "gray-matter";
import {
  PhaseName,
  TaskStatus,
  renderProgressSection,
} from "./phases.js";
import { createNotifier, type Notifier } from "../util/notify.js";

let __notifier: Notifier | null = null;
function getNotifier(): Notifier {
  if (__notifier) return __notifier;
  __notifier = createNotifier();
  return __notifier;
}

// Test seam: swap in a recording fake (or `null` to reset to a freshly
// re-resolved default on the next call). Production code must not call
// this — the underscore prefix flags it. Tests use this instead of
// monkeypatching `process.env.FLOW_NOTIFY` mid-suite because the env-var
// read is cached across `transitionStatus` calls within a process.
export function __setNotifierForTests(n: Notifier | null): void {
  __notifier = n;
}

export interface TaskFrontmatter {
  id: string;
  status: TaskStatus;
  created: string;
  updated: string;
  target_repo: string;
  worktree: string | null;
  branch: string | null;
  pr: number | null;
  manual_validation: boolean | null;
  merge_commit: string | null;
}

export interface Task {
  path: string;
  frontmatter: TaskFrontmatter;
  body: string;
}

export async function readTask(filePath: string): Promise<Task> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = matter(raw);
  return {
    path: filePath,
    frontmatter: parsed.data as TaskFrontmatter,
    body: parsed.content,
  };
}

export function readTaskSync(filePath: string): Task {
  const raw = fsSync.readFileSync(filePath, "utf8");
  const parsed = matter(raw);
  return {
    path: filePath,
    frontmatter: parsed.data as TaskFrontmatter,
    body: parsed.content,
  };
}

// Serialize a task to its on-disk form. No I/O, but **mutates the input**
// in place — bumps `frontmatter.updated` and rewrites the `## Progress`
// section on `task.body`. Both `writeTask` and `writeTaskSync` go through
// this so the two writers can't drift in formatting (Progress block,
// frontmatter shape, etc.). Callers that hold the same `Task` reference
// across writes will observe the updated timestamp and Progress section.
function formatTask(task: Task): string {
  task.frontmatter.updated = new Date().toISOString();
  task.body = replaceSection(
    task.body,
    "## Progress",
    renderProgressSection(task.frontmatter.status),
  );
  return matter.stringify(task.body, task.frontmatter as object);
}

export async function writeTask(task: Task): Promise<void> {
  const out = formatTask(task);
  await writeAtomic(task.path, out);
}

// Sync variant for use inside Node's `'exit'` event handler — async writes
// from inside `'exit'` are silently dropped because Node tears down the
// event loop before the I/O completes. The reaper that handles SIGTERM /
// uncaught-throw paths needs this.
export function writeTaskSync(task: Task): void {
  const out = formatTask(task);
  writeAtomicSync(task.path, out);
}

// Atomic write via tmp+rename. `rename` is atomic on POSIX so a crash
// mid-write (kill -9 between open and write, full disk during write) leaves
// the original task file intact rather than truncated. Future readers of
// `.orchestrator/tasks/<id>.md` will rely on this — a partial frontmatter
// would brick the runner.
async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

function writeAtomicSync(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`;
  fsSync.writeFileSync(tmp, content, "utf8");
  fsSync.renameSync(tmp, filePath);
}

export async function transitionStatus(
  task: Task,
  next: TaskStatus,
  note?: string,
): Promise<void> {
  const from = task.frontmatter.status;
  if (from === next) return;
  const ts = new Date().toISOString();
  const suffix = note ? ` (${note})` : "";
  appendToSectionInPlace(task, "## Phase log", `- ${ts} ${from} → ${next}${suffix}`);
  task.frontmatter.status = next;
  await writeTask(task);
  try {
    await getNotifier().notify({ task, status: next, reason: note });
  } catch {
    // Swallow: a failing notification (missing backend, sandbox, gh
    // outage) must never poison a status transition. The disk write
    // already succeeded; the user has the truth in the task file.
  }
}

// Sync variant for the exit-handler reaper. Same Phase-log append as the
// async path so a `signaled`/`runner-crashed`/`immediate-exit` row is
// recorded exactly once — and visibly to PR 10's `/flow status`.
export function transitionStatusSync(
  task: Task,
  next: TaskStatus,
  note?: string,
): void {
  const from = task.frontmatter.status;
  if (from === next) return;
  const ts = new Date().toISOString();
  const suffix = note ? ` (${note})` : "";
  appendToSectionInPlace(task, "## Phase log", `- ${ts} ${from} → ${next}${suffix}`);
  task.frontmatter.status = next;
  writeTaskSync(task);
  try {
    // Intentionally NOT awaited. This path runs from Node's `'exit'`
    // event handler (the reaper) where there is no live event loop to
    // resolve a Promise. The notifier already spawned the backend with
    // `detached + unref` so the OS keeps the banner alive after we
    // exit; the orphaned Promise is the price of fire-and-forget across
    // teardown. A future maintainer who "fixes" this missing await will
    // reintroduce a hang during `'exit'` — leave it alone.
    void getNotifier().notify({ task, status: next, reason: note });
  } catch {
    // Swallow synchronous throws (rare — `spawn` argv validation only).
    // Promise rejections from the un-awaited call go to
    // unhandledRejection; we explicitly do not chain a `.catch` here
    // because doing so would create another floating Promise.
  }
}

export async function updateTaskFrontmatter(
  task: Task,
  patch: Partial<TaskFrontmatter>,
): Promise<void> {
  Object.assign(task.frontmatter, patch);
  await writeTask(task);
}

export async function appendPhaseLog(task: Task, line: string): Promise<void> {
  appendToSectionInPlace(task, "## Phase log", line);
  await writeTask(task);
}

export async function appendPhaseOutput(
  task: Task,
  phase: PhaseName,
  content: string,
): Promise<void> {
  const ts = new Date().toISOString();
  const subsection = [`### ${phase} (latest: ${ts})`, "", content.trim(), ""].join("\n");
  task.body = upsertPhaseOutputSubsection(task.body, phase, subsection);
  await writeTask(task);
}

// --- internal helpers ----------------------------------------------------

// Section heading anchored at column 0; matches "## Heading\n" through the
// next "## " heading or end-of-input. Capture group 0 is the full block
// including the heading line. Uses `(?![\s\S])` for end-of-input rather
// than `$` because multiline `$` matches every line ending.
function sectionRegex(heading: string): RegExp {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escaped}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n## |(?![\\s\\S]))`,
    "m",
  );
}

function replaceSection(body: string, heading: string, replacement: string): string {
  const re = sectionRegex(heading);
  if (!re.test(body)) {
    // Section missing — append at end. Triage emits all sections, so this
    // should only fire on hand-edited or partial files.
    const trimmed = body.replace(/\s+$/, "");
    return `${trimmed}\n\n${replacement}\n`;
  }
  return body.replace(re, () => replacement);
}

function appendToSectionInPlace(task: Task, heading: string, line: string): void {
  const re = sectionRegex(heading);
  const match = task.body.match(re);
  if (!match) {
    const trimmed = task.body.replace(/\s+$/, "");
    task.body = `${trimmed}\n\n${heading}\n\n${line}\n`;
    return;
  }
  const block = match[0];
  // Strip trailing whitespace inside the section, then append the line.
  const trimmedBlock = block.replace(/\s+$/, "");
  task.body = task.body.replace(block, `${trimmedBlock}\n${line}\n`);
}

function upsertPhaseOutputSubsection(
  body: string,
  phase: PhaseName,
  subsection: string,
): string {
  const re = sectionRegex("## Phase outputs");
  const match = body.match(re);
  const subRe = new RegExp(
    `^### ${phase}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n### |\\n## |(?![\\s\\S]))`,
    "m",
  );
  if (!match) {
    return `${body.replace(/\s+$/, "")}\n\n## Phase outputs\n\n${subsection}\n`;
  }
  const block = match[0];
  if (subRe.test(block)) {
    const updated = block.replace(subRe, () => subsection.replace(/\s+$/, ""));
    return body.replace(block, updated);
  }
  // Append the new subsection at the end of Phase outputs.
  const trimmed = block.replace(/\s+$/, "");
  return body.replace(block, `${trimmed}\n\n${subsection}`);
}
