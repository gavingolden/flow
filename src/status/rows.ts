import fsp from "node:fs/promises";
import path from "node:path";
import { aggregateTaskCost, type PhaseAggregate } from "../cost.js";
import { taskDirFor } from "../log/discover.js";
import {
  TASK_STATUSES,
  type TaskStatus,
  phaseLabelFor,
} from "../state/phases.js";
import { readTask } from "../state/task-file.js";

export interface StatusRow {
  id: string;
  path: string;
  archived: boolean;
  status: TaskStatus;
  phase: string;
  pr: number | null;
  branch: string | null;
  worktree: string | null;
  created: string;
  updated: string;
  cost_total_usd: number;
  cost_partial: boolean;
  phases: PhaseAggregate[];
}

export interface BuildStatusRowsOptions {
  includeArchived?: boolean;
}

const VALID_STATUSES: ReadonlySet<string> = new Set(TASK_STATUSES);

export async function buildStatusRows(
  repoRoot: string,
  opts: BuildStatusRowsOptions = {},
): Promise<StatusRow[]> {
  const tasksDir = path.join(repoRoot, ".orchestrator", "tasks");
  const active = await listMdFiles(tasksDir, false);
  const archived = opts.includeArchived
    ? await listMdFiles(path.join(tasksDir, "archive"), true)
    : [];
  const all = [...active, ...archived];
  // Bounded concurrency keeps `--all` runs against a long-lived archive
  // from spawning hundreds of concurrent fd opens (each row reads the
  // task .md plus every per-phase jsonl under its logs/ dir). 8 is well
  // under the macOS default `EMFILE` ceiling of 256 even when each row
  // opens 5–10 logs in parallel.
  const rows = await mapWithLimit(all, 8, ({ filePath, archived }) =>
    buildRow(repoRoot, filePath, archived),
  );

  // Most-recent-`updated` first; ties broken by id ascending so the order
  // is stable across runs even when two tasks share an `updated` stamp
  // (e.g. both edited within the same millisecond by a script).
  rows.sort((a, b) => {
    if (a.updated !== b.updated) return a.updated < b.updated ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows;
}

export async function buildRowForId(
  repoRoot: string,
  taskFilePath: string,
): Promise<StatusRow> {
  const archived = isArchivedPath(repoRoot, taskFilePath);
  return buildRow(repoRoot, taskFilePath, archived);
}

async function buildRow(
  repoRoot: string,
  filePath: string,
  archived: boolean,
): Promise<StatusRow> {
  const task = await readTask(filePath);
  const fm = task.frontmatter;
  // `readTask` casts frontmatter without runtime validation. A hand-edited
  // or partial task file with a missing/non-string `id` would otherwise
  // throw inside `taskDirFor` and — because `buildStatusRows` runs every
  // row inside a single `Promise.all` — break the entire roster for one
  // bad file. Fall back to the markdown filename's stem so the row still
  // renders (cost will be `$0` because the derived id won't match the
  // logs directory layout, but the user can see the malformed task and
  // act on it).
  const id =
    typeof fm.id === "string" && fm.id.length > 0
      ? fm.id
      : path.basename(filePath, ".md");
  const cost = await aggregateTaskCost(taskDirFor(repoRoot, id));
  const phase = phaseLabelFor(fm.status, () =>
    priorStatusFromPhaseLog(task.body),
  );
  return {
    id,
    path: filePath,
    archived,
    status: fm.status,
    phase,
    pr: fm.pr ?? null,
    branch: fm.branch ?? null,
    worktree: fm.worktree ?? null,
    // YAML parses unquoted ISO-8601 timestamps as Date objects, not
    // strings. The TaskFrontmatter type claims `string` but in practice
    // we get a mix depending on whether the writer quoted the value
    // (`writeTask` does, hand-edited files often don't). Coerce here so
    // downstream consumers — JSON output, table renderer, age formatter —
    // see a stable ISO string.
    created: toIsoString(fm.created),
    updated: toIsoString(fm.updated),
    cost_total_usd: cost.total,
    cost_partial: cost.partial,
    phases: cost.phases,
  };
}

function toIsoString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return "";
}

// Pull the most recent `<from> → <to>` line out of the body's `## Phase
// log` section and return the `<from>` status — but only if it itself is
// a known TaskStatus and not `needs-human`. We want to answer "what phase
// were we in when we bailed?", which is the *source* status of the most
// recent transition into `needs-human`. If the log doesn't contain a
// usable arrow, return null and let the caller fall back to the literal
// `needs-human` label.
export function priorStatusFromPhaseLog(body: string): TaskStatus | null {
  const section = body.match(/^## Phase log\b[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/m);
  if (!section) return null;
  const block = section[1] ?? "";
  // Walk lines bottom-up so the most-recent transition wins; works for
  // both ASCII `->` and the unicode arrow used by `transitionStatus`.
  const lines = block.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const m = line.match(/\b([a-z][a-z0-9-]*)\s*(?:→|->)\s*needs-human\b/);
    if (m && m[1] && VALID_STATUSES.has(m[1]) && m[1] !== "needs-human") {
      return m[1] as TaskStatus;
    }
  }
  return null;
}

interface MdEntry {
  filePath: string;
  archived: boolean;
}

async function listMdFiles(dir: string, archived: boolean): Promise<MdEntry[]> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const out: MdEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const full = path.join(dir, name);
    try {
      const st = await fsp.stat(full);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    out.push({ filePath: full, archived });
  }
  return out;
}

function isArchivedPath(repoRoot: string, filePath: string): boolean {
  const rel = path.relative(
    path.join(repoRoot, ".orchestrator", "tasks"),
    filePath,
  );
  return rel.split(path.sep)[0] === "archive";
}

function isNotFound(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    (err as { code?: string }).code === "ENOENT"
  );
}

// Bounded-concurrency `Promise.all` with stable input-order results.
// Tiny inline helper rather than a dependency — the only call site is
// `buildStatusRows`, and the contract is narrow.
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
