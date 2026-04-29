import fsp from "node:fs/promises";
import path from "node:path";
import { taskDirFor } from "../pipeline/runner.js";

export interface LogFile {
  phase: string;
  // The on-disk stamp segment, e.g. `2026-04-29T17-30-15-531Z`. Sortable
  // lexicographically (ISO-8601 with hyphens substituted for `:` and `.`).
  stamp: string;
  path: string;
}

// Filename layout from `jsonl-sink.ts`:
//   `<phase>-<ISO-stamp>.jsonl` where stamp = ISO-8601 with `:` and `.`
//   replaced by `-`. `<phase>` itself is sanitized to `[A-Za-z0-9._-]` so
//   the only `-` between phase and stamp lives at position 1+phase.length.
//   We split on the *first* dash followed by a 4-digit year so stamps
//   like `2026-04-29T...` cleanly separate from phase names that may
//   themselves contain hyphens (e.g. `verify-retry`).
const LOG_FILE_RE = /^(?<phase>.+?)-(?<stamp>\d{4}-\d{2}-\d{2}T[^.]+)\.jsonl$/;

export async function listLogFiles(taskDir: string): Promise<LogFile[]> {
  const logsDir = path.join(taskDir, "logs");
  let entries: string[];
  try {
    entries = await fsp.readdir(logsDir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const files: LogFile[] = [];
  for (const name of entries) {
    const m = LOG_FILE_RE.exec(name);
    if (!m?.groups) continue;
    files.push({
      phase: m.groups["phase"]!,
      stamp: m.groups["stamp"]!,
      path: path.join(logsDir, name),
    });
  }
  files.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
  return files;
}

export function filterByPhase(
  files: LogFile[],
  phaseName: string,
): LogFile[] {
  return files.filter((f) => f.phase === phaseName);
}

export function latestFile(files: LogFile[]): LogFile | null {
  return files.length === 0 ? null : files[files.length - 1]!;
}

export { taskDirFor };

export async function listTaskIds(repoRoot: string): Promise<string[]> {
  const tasksDir = path.join(repoRoot, ".orchestrator", "tasks");
  let entries: string[];
  try {
    entries = await fsp.readdir(tasksDir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const candidates: { id: string; mtimeMs: number }[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const full = path.join(tasksDir, name);
    try {
      const stat = await fsp.stat(full);
      if (!stat.isFile()) continue;
      candidates.push({
        id: name.slice(0, -".md".length),
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // Race: file disappeared between readdir and stat. Skip.
      continue;
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.map((c) => c.id);
}

function isNotFound(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    (err as { code?: string }).code === "ENOENT"
  );
}
