/**
 * Process-lifecycle registry: an append-only JSONL log of processes launched
 * under a given pipeline slug, at `~/.flow/state/procs/<slug>.jsonl`. One
 * row per launch. Modeled on `launch-log.ts`'s `appendLaunchRecord`
 * (mkdirSync recursive, then one `appendFileSync` of the serialized row) —
 * fail-open the same way: a write failure never throws, it just reports
 * `{written: false}` so a caller can decide whether to warn.
 *
 * This module is read/write plumbing only. It does not spawn processes, and
 * it sends no signals of any kind — that is `flow-spawn.ts`'s job (launch)
 * and a later epic feature's job (reap).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FLOW_STATE_DIR } from "./paths";
import { isValidSlug } from "./slug";
import { pidStartEpoch } from "./liveness";

export type ProcClass = "default" | "mcp-server";

export type ProcRegistryRow = {
  pgid: number;
  pid: number;
  startEpoch: number | null;
  slug: string;
  class: ProcClass;
  argv: string[];
  argvTruncated?: true;
  recordedAt: number;
  sessionPid: number | null;
  sessionStartEpoch: number | null;
};

/**
 * A single `appendFileSync` on a regular file relies on POSIX `O_APPEND`'s
 * atomic offset-update guarantee (each append moves the file offset to EOF
 * and writes in one kernel operation, so two concurrent appenders never
 * interleave their bytes) — NOT `PIPE_BUF`, which bounds atomic writes to a
 * *pipe* (512 bytes on macOS), not a regular file. 4096 is a reasonable cap
 * either way: comfortably larger than a typical row, small enough to bound
 * one malformed/adversarial line's blast radius on a reader.
 */
export const MAX_ROW_BYTES = 4096;

/**
 * A row with `startEpoch: null` (the pid's start time couldn't be read at
 * record time) can never satisfy the default liveness check's `!== null`
 * test, so without a separate age-based retirement path such a row would
 * never be compacted away and the file would grow forever. One hour is
 * long enough to outlive any transient `ps` hiccup at launch time.
 */
export const NULL_EPOCH_TTL_MS = 3_600_000;

/** Mirrors `state.ts`'s `statePath(slug, dir = FLOW_STATE_DIR)` parameter shape. */
export function procsDir(baseDir = FLOW_STATE_DIR): string {
  return path.join(baseDir, "procs");
}

/**
 * The slug is a filesystem path component, so — unlike `statePath`, which
 * trusts its caller — this throws on an invalid slug rather than silently
 * building a traversal-prone path.
 */
export function registryPath(slug: string, baseDir = FLOW_STATE_DIR): string {
  if (!isValidSlug(slug)) {
    throw new Error(`proc-registry: invalid slug "${slug}"`);
  }
  return path.join(procsDir(baseDir), `${slug}.jsonl`);
}

function serializeRow(row: ProcRegistryRow): string {
  const initial = `${JSON.stringify(row)}\n`;
  if (Buffer.byteLength(initial, "utf8") <= MAX_ROW_BYTES) return initial;

  // Drop argv elements from the tail, always keeping argv[0] and argv[1] —
  // for a `node <script> ...` / `bun <script> ...` invocation the
  // distinguishing token is argv[1]; keeping only argv[0] would yield
  // indistinguishable rows.
  let argv = row.argv;
  let candidate = `${JSON.stringify({ ...row, argv, argvTruncated: true })}\n`;
  while (
    argv.length > 2 &&
    Buffer.byteLength(candidate, "utf8") > MAX_ROW_BYTES
  ) {
    argv = argv.slice(0, -1);
    candidate = `${JSON.stringify({ ...row, argv, argvTruncated: true })}\n`;
  }
  return candidate;
}

export function appendRow(
  row: ProcRegistryRow,
  baseDir = FLOW_STATE_DIR,
): { written: boolean; error?: string } {
  try {
    const target = registryPath(row.slug, baseDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, serializeRow(row));
    return { written: true };
  } catch (e) {
    return {
      written: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export type ReadResult = { rows: ProcRegistryRow[]; malformed: number };

function isValidRow(x: unknown): x is ProcRegistryRow {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.pgid !== "number") return false;
  if (typeof o.pid !== "number") return false;
  if (o.startEpoch !== null && typeof o.startEpoch !== "number") return false;
  if (typeof o.slug !== "string") return false;
  if (o.class !== "default" && o.class !== "mcp-server") return false;
  if (!Array.isArray(o.argv) || !o.argv.every((a) => typeof a === "string")) {
    return false;
  }
  if (o.argvTruncated !== undefined && o.argvTruncated !== true) return false;
  if (typeof o.recordedAt !== "number") return false;
  if (o.sessionPid !== null && typeof o.sessionPid !== "number") return false;
  if (o.sessionStartEpoch !== null && typeof o.sessionStartEpoch !== "number") {
    return false;
  }
  return true;
}

export function readRows(slug: string, baseDir = FLOW_STATE_DIR): ReadResult {
  try {
    const target = registryPath(slug, baseDir);
    if (!fs.existsSync(target)) return { rows: [], malformed: 0 };
    const text = fs.readFileSync(target, "utf8");
    const rows: ProcRegistryRow[] = [];
    let malformed = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue; // blank lines skipped silently
      try {
        const parsed: unknown = JSON.parse(line);
        if (isValidRow(parsed)) rows.push(parsed);
        else malformed++;
      } catch {
        malformed++;
      }
    }
    return { rows, malformed };
  } catch {
    return { rows: [], malformed: 0 };
  }
}

export type CompactDeps = {
  isLive?: (row: ProcRegistryRow) => boolean;
  nowMs?: () => number;
};

function defaultIsLive(row: ProcRegistryRow): boolean {
  if (row.startEpoch === null) return false;
  const currentEpoch = pidStartEpoch(row.pid);
  return currentEpoch !== null && currentEpoch === row.startEpoch;
}

/**
 * Rewrites the registry to only its surviving rows. Writes to a
 * process/timestamp-unique temp file and `renameSync`s it over the
 * original — atomic, never a truncate-in-place. The unique suffix closes a
 * concurrent-compact tmp collision; the rewrite itself stays last-writer-wins,
 * which is safe because compact only ever drops rows both writers would
 * agree are dead.
 */
export function compact(
  slug: string,
  baseDir = FLOW_STATE_DIR,
  deps: CompactDeps = {},
): { kept: number; dropped: number } {
  const isLive = deps.isLive ?? defaultIsLive;
  const nowMs = deps.nowMs ?? (() => Date.now());
  try {
    const { rows } = readRows(slug, baseDir);
    const survivors: ProcRegistryRow[] = [];
    let dropped = 0;
    for (const row of rows) {
      if (row.startEpoch === null) {
        if (nowMs() - row.recordedAt > NULL_EPOCH_TTL_MS) {
          dropped++;
        } else {
          survivors.push(row);
        }
        continue;
      }
      if (isLive(row)) {
        survivors.push(row);
      } else {
        dropped++;
      }
    }

    const target = registryPath(slug, baseDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmpTarget = `${target}.tmp.${process.pid}.${nowMs()}`;
    const content = survivors.map((r) => `${JSON.stringify(r)}\n`).join("");
    fs.writeFileSync(tmpTarget, content);
    fs.renameSync(tmpTarget, target);
    return { kept: survivors.length, dropped };
  } catch {
    return { kept: 0, dropped: 0 };
  }
}
