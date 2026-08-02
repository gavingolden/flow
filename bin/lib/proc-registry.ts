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

/**
 * Drops argv elements from the tail, always keeping argv[0] and argv[1] —
 * for a `node <script> ...` / `bun <script> ...` invocation the
 * distinguishing token is argv[1]; keeping only argv[0] would yield
 * indistinguishable rows. `argvTruncated` is set only when an element was
 * actually dropped — NOT merely when the row started over budget, since
 * the row can stay over `MAX_ROW_BYTES` even after dropping everything
 * droppable (a single oversized token living in argv[0]/argv[1], or bulk
 * from the row's non-argv fields) and that residual overage is a real
 * invariant gap this function does not claim to close.
 *
 * The size check is monotonic in the retained-argv length (removing an
 * element never grows the serialized size), so the largest retained length
 * that still fits the budget is found with a binary search rather than a
 * linear drop-one-at-a-time scan.
 */
function serializeRow(row: ProcRegistryRow): string {
  const initial = `${JSON.stringify(row)}\n`;
  if (Buffer.byteLength(initial, "utf8") <= MAX_ROW_BYTES) return initial;

  const minKeep = Math.min(2, row.argv.length);
  const build = (cut: number): string =>
    `${JSON.stringify({ ...row, argv: row.argv.slice(0, cut), argvTruncated: true })}\n`;

  let lo = minKeep;
  let hi = row.argv.length;
  let best = lo;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (Buffer.byteLength(build(mid), "utf8") <= MAX_ROW_BYTES) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const truncated = best < row.argv.length;
  return `${JSON.stringify({
    ...row,
    argv: row.argv.slice(0, best),
    ...(truncated ? { argvTruncated: true } : {}),
  })}\n`;
}

export function appendRow(
  row: ProcRegistryRow,
  baseDir = FLOW_STATE_DIR,
  /**
   * When the caller has already resolved and created the target path
   * (e.g. `flow-spawn.ts`'s `runLaunch`, which does both before spawning
   * so the post-spawn append sits closer to a bare `write(2)`), pass it
   * here to skip the redundant `registryPath` resolution + `mkdirSync`.
   * Omitted, this resolves and creates the path itself exactly as before.
   */
  precomputedTarget?: string,
): { written: boolean; error?: string } {
  try {
    const target = precomputedTarget ?? registryPath(row.slug, baseDir);
    // 0o700 / 0o600: argv is persisted verbatim and routinely carries
    // secrets passed as flags, so the dir and file default away from the
    // process umask (0755/0644) toward owner-only access.
    if (precomputedTarget === undefined) {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    }
    fs.appendFileSync(target, serializeRow(row), { mode: 0o600 });
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

function parseRegistryLines(text: string): {
  rows: ProcRegistryRow[];
  malformed: number;
} {
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
}

export function readRows(slug: string, baseDir = FLOW_STATE_DIR): ReadResult {
  try {
    const target = registryPath(slug, baseDir);
    if (!fs.existsSync(target)) return { rows: [], malformed: 0 };
    const text = fs.readFileSync(target, "utf8");
    return parseRegistryLines(text);
  } catch {
    return { rows: [], malformed: 0 };
  }
}

export type CompactDeps = {
  isLive?: (row: ProcRegistryRow) => boolean;
  nowMs?: () => number;
  /**
   * Test-only hook fired immediately after the snapshot read (before the
   * rewrite is built) — lets a test simulate a concurrent `appendRow`
   * landing inside the window the offset-reread reconciliation below
   * covers. Never set in production.
   */
  afterSnapshot?: () => void;
  /** Test-only seam for injecting a `renameSync` failure. Defaults to the real `fs.renameSync`. */
  rename?: (src: string, dest: string) => void;
};

export function defaultIsLive(row: ProcRegistryRow): boolean {
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
 *
 * append-vs-compact race: the survivor set is decided from a snapshot read
 * at the top of this function. An `appendRow` landing between that read and
 * the rename below would otherwise be silently erased by the rewrite — and
 * a lost row describes a LIVE process a future reaper would then leak.
 * Closed by recording the snapshot's byte length and, immediately before
 * the rename, re-reading from that offset to append any bytes that arrived
 * after the snapshot verbatim onto the survivors. This is snapshot-vs-live
 * reconciliation scoped to this one call, not a lock file — the append path
 * stays lock-free by design (see the module doc comment).
 *
 * A read failure (as opposed to a legitimately absent/empty file) bails out
 * without rewriting: `ENOENT` is the only case treated as "nothing to
 * compact"; any other read error propagates to the outer catch below, which
 * returns `{kept: 0, dropped: 0}` WITHOUT ever calling `writeFileSync` —
 * renaming an empty rewrite over a registry this call merely failed to read
 * would be data loss, not compaction.
 */
export function compact(
  slug: string,
  baseDir = FLOW_STATE_DIR,
  deps: CompactDeps = {},
): { kept: number; dropped: number } {
  const isLive = deps.isLive ?? defaultIsLive;
  const nowMs = deps.nowMs ?? (() => Date.now());
  let tmpTarget: string | undefined;
  try {
    const target = registryPath(slug, baseDir);

    let originalBuf: Buffer;
    try {
      originalBuf = fs.readFileSync(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { kept: 0, dropped: 0 };
      }
      throw e;
    }
    const snapshotByteLen = originalBuf.byteLength;
    const { rows } = parseRegistryLines(originalBuf.toString("utf8"));
    deps.afterSnapshot?.();

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

    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    tmpTarget = `${target}.tmp.${process.pid}.${nowMs()}`;
    let content = survivors.map((r) => `${JSON.stringify(r)}\n`).join("");

    let currentSize = snapshotByteLen;
    try {
      currentSize = fs.statSync(target).size;
    } catch {
      // target vanished between the snapshot read and here — nothing to
      // reconcile; fall through with the snapshot's own length.
    }
    if (currentSize > snapshotByteLen) {
      const fd = fs.openSync(target, "r");
      try {
        const tailLen = currentSize - snapshotByteLen;
        const tailBuf = Buffer.alloc(tailLen);
        fs.readSync(fd, tailBuf, 0, tailLen, snapshotByteLen);
        content += tailBuf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    }

    fs.writeFileSync(tmpTarget, content, { mode: 0o600 });
    const rename = deps.rename ?? fs.renameSync;
    rename(tmpTarget, target);
    tmpTarget = undefined;
    return { kept: survivors.length, dropped };
  } catch {
    return { kept: 0, dropped: 0 };
  } finally {
    if (tmpTarget !== undefined) {
      try {
        fs.unlinkSync(tmpTarget);
      } catch {
        // never created, or already renamed/gone — fine either way.
      }
    }
  }
}
