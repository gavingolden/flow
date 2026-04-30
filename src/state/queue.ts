import fsp from "node:fs/promises";
import path from "node:path";
import { readTask } from "./task-file.js";

export interface QueuedTask {
  id: string;
  path: string;
  created: string;
}

// Lists every `.orchestrator/tasks/*.md` whose frontmatter status is
// `triaged`, sorted by `created` ascending so older requests run first.
// Archived tasks are deliberately excluded — `archive/` only ever holds
// terminal-state files.
//
// A single malformed task file (unparseable YAML, missing fields) must
// not poison the whole drain; callers see the well-formed remainder. The
// optional `onSkip` hook lets the scheduler surface skipped paths to its
// own log without forcing every consumer to wire a logger.
export async function listTriagedTasks(
  repoRoot: string,
  opts: { onSkip?: (filePath: string, err: unknown) => void } = {},
): Promise<QueuedTask[]> {
  const tasksDir = path.join(repoRoot, ".orchestrator", "tasks");
  const entries = await listMdFiles(tasksDir);
  const out: QueuedTask[] = [];
  for (const filePath of entries) {
    let task;
    try {
      task = await readTask(filePath);
    } catch (err) {
      opts.onSkip?.(filePath, err);
      continue;
    }
    const fm = task.frontmatter;
    if (fm.status !== "triaged") continue;
    if (typeof fm.id !== "string" || fm.id.length === 0) {
      opts.onSkip?.(filePath, new Error("missing id"));
      continue;
    }
    out.push({
      id: fm.id,
      path: filePath,
      created: toIsoString(fm.created),
    });
  }
  out.sort((a, b) => {
    if (a.created !== b.created) return a.created < b.created ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out;
}

async function listMdFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const full = path.join(dir, name);
    try {
      const st = await fsp.stat(full);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    out.push(full);
  }
  return out;
}

function toIsoString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return "";
}
