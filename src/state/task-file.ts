import fs from "node:fs/promises";
import matter from "gray-matter";
import {
  PhaseName,
  TaskStatus,
  renderProgressSection,
} from "./phases.js";

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

export async function writeTask(task: Task): Promise<void> {
  task.frontmatter.updated = new Date().toISOString();
  task.body = replaceSection(
    task.body,
    "## Progress",
    renderProgressSection(task.frontmatter.status),
  );
  const out = matter.stringify(task.body, task.frontmatter as object);
  await fs.writeFile(task.path, out, "utf8");
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
