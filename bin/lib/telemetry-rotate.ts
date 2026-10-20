/**
 * Size/age rotation for `~/.flow/telemetry/events.jsonl`, pruning WHOLE
 * slug blocks rather than raw oldest lines so a `run.terminal` event is
 * never stranded without its `phase.transition` lines.
 *
 * Ported wholesale from `bin/lib/proc-registry.ts`'s `compact()`: a unique
 * tmp file (`${target}.tmp.${pid}.${now}`) plus snapshot-byte-length TAIL
 * RECONCILIATION (re-reading from the snapshot's byte offset immediately
 * before the rename, to recover any append that landed mid-compaction) and
 * a final `renameSync`. Deliberately NOT `withFileLockSync`-guarded: a lock
 * only serializes compactor-vs-compactor, while the append path
 * (`recordEvent` in `./telemetry.ts`) stays lock-free by design — leaving
 * the compactor free to erase a concurrent append outright.
 * `proc-registry.ts` (lines ~218-242) documents this exact failure and
 * closes it with the same reconciliation this module ports; see that
 * module's `compact()` doc comment for the full race writeup.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const TELEMETRY_MAX_BYTES = 32 * 1024 * 1024;
export const TELEMETRY_MAX_AGE_DAYS = 180;

export type CompactResult = {
  compacted: boolean;
  linesKept: number;
  linesDropped: number;
  slugsDropped: (string | null)[];
};

export type CompactDeps = {
  /**
   * Test-only hook fired immediately after the snapshot read (before the
   * rewrite is built) — lets a test simulate a concurrent `recordEvent`
   * append landing inside the window the offset-reread reconciliation
   * below covers. Never set in production.
   */
  afterSnapshot?: () => void;
  /** Test-only seam for injecting a `renameSync` failure. Defaults to the real `fs.renameSync`. */
  rename?: (src: string, dest: string) => void;
};

const ALL_ZERO: CompactResult = {
  compacted: false,
  linesKept: 0,
  linesDropped: 0,
  slugsDropped: [],
};

/**
 * Stat-ONLY probe (no lock, no read) for whether `compactLogIfNeeded` is
 * worth calling. Deliberately cheap: it is meant to run on every
 * `recordEvent` append. Age-based pruning is evaluated only once the
 * heavier `compactLogIfNeeded` actually runs — this probe has no way to
 * see per-line ages from a `stat` call alone.
 */
export function shouldAttemptCompaction(
  logPath: string,
  maxBytes: number = TELEMETRY_MAX_BYTES,
): boolean {
  try {
    const stat = fs.statSync(logPath);
    return stat.size > maxBytes;
  } catch {
    return false;
  }
}

type ParsedLine = { raw: string; slug: string | null; ts: number | null };

function parseLines(text: string): { parsed: ParsedLine[]; malformed: number } {
  const rawLines = text.split("\n").filter((l) => l.length > 0);
  const parsed: ParsedLine[] = [];
  let malformed = 0;
  for (const raw of rawLines) {
    try {
      const obj = JSON.parse(raw) as { slug?: unknown; ts?: unknown };
      const slug = typeof obj.slug === "string" ? obj.slug : null;
      const tsMs = typeof obj.ts === "string" ? Date.parse(obj.ts) : NaN;
      parsed.push({ raw, slug, ts: Number.isNaN(tsMs) ? null : tsMs });
    } catch {
      malformed++;
    }
  }
  return { parsed, malformed };
}

/**
 * Rewrites the log to only its surviving lines, whole-slug-block pruned.
 * Never throws — any IO failure (including a genuinely absent file)
 * returns the all-zero result without ever calling `writeFileSync`, so a
 * read failure can never turn into a data-losing rename over a file this
 * call merely failed to read.
 *
 * Ordering: (1) any slug block whose newest line is older than
 * `maxAgeDays` is dropped in full; (2) if the log is still over
 * `maxBytes`, the oldest remaining blocks (by first-appearance order,
 * which is chronological order in an append-only log) are dropped in
 * full, one at a time, until under cap — the null-slug block is pruned
 * last. A line that fails to parse is dropped (counted in `linesDropped`)
 * rather than treated as fatal.
 */
export function compactLogIfNeeded(
  logPath: string,
  now: number,
  maxBytes: number = TELEMETRY_MAX_BYTES,
  maxAgeDays: number = TELEMETRY_MAX_AGE_DAYS,
  deps: CompactDeps = {},
): CompactResult {
  let tmpTarget: string | undefined;
  try {
    let originalBuf: Buffer;
    try {
      originalBuf = fs.readFileSync(logPath);
    } catch {
      return { ...ALL_ZERO };
    }
    const snapshotByteLen = originalBuf.byteLength;
    const { parsed, malformed } = parseLines(originalBuf.toString("utf8"));
    deps.afterSnapshot?.();

    // Group by slug, preserving first-appearance order — an append-only
    // log is chronological, so Map insertion order is oldest-slug-first.
    const blocks = new Map<string | null, ParsedLine[]>();
    for (const line of parsed) {
      const arr = blocks.get(line.slug);
      if (arr) arr.push(line);
      else blocks.set(line.slug, [line]);
    }

    const slugsDropped: (string | null)[] = [];
    const ageCutoffMs = now - maxAgeDays * 24 * 60 * 60 * 1000;

    // 1. Whole-block age pruning: drop only when the NEWEST line in the
    //    block is past the cutoff, so a block with any recent activity
    //    survives intact.
    for (const [slug, lines] of blocks) {
      const newest = lines.reduce(
        (max, l) => (l.ts !== null && l.ts > max ? l.ts : max),
        -Infinity,
      );
      if (newest !== -Infinity && newest < ageCutoffMs) {
        blocks.delete(slug);
        slugsDropped.push(slug);
      }
    }

    // 2. Whole-block size pruning, oldest-remaining-block first, null
    //    slug last.
    // Byte-accurate (UTF-8 bytes, matching the `statSync` check in
    // `shouldAttemptCompaction`) — NOT `l.raw.length`, which is UTF-16
    // code units and undercounts any multi-byte character, letting a
    // genuinely-oversized file skip eviction entirely.
    const totalBytes = () =>
      Array.from(blocks.values())
        .flat()
        .reduce((sum, l) => sum + Buffer.byteLength(l.raw, "utf8") + 1, 0);

    // Prune down to a low watermark meaningfully under the cap (80%),
    // not just back under it, so compaction is amortized across many
    // subsequent appends rather than re-arming ~10 appends later.
    const lowWatermarkBytes = Math.floor(maxBytes * 0.8);

    if (totalBytes() > maxBytes) {
      const remainingKeys = Array.from(blocks.keys());
      const orderedForEviction = [
        ...remainingKeys.filter((k) => k !== null),
        ...remainingKeys.filter((k) => k === null),
      ];
      for (const slug of orderedForEviction) {
        if (totalBytes() <= lowWatermarkBytes) break;
        blocks.delete(slug);
        slugsDropped.push(slug);
      }
    }

    const survivors: ParsedLine[] = [];
    for (const lines of blocks.values()) survivors.push(...lines);

    const anyChange = malformed > 0 || slugsDropped.length > 0;
    if (!anyChange) {
      return {
        compacted: false,
        linesKept: parsed.length,
        linesDropped: 0,
        slugsDropped: [],
      };
    }

    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    tmpTarget = `${logPath}.tmp.${process.pid}.${now}`;
    let content = survivors.map((l) => `${l.raw}\n`).join("");

    let currentSize = snapshotByteLen;
    try {
      currentSize = fs.statSync(logPath).size;
    } catch {
      // Target vanished between the snapshot read and here — nothing to
      // reconcile; fall through with the snapshot's own length.
    }
    if (currentSize > snapshotByteLen) {
      const fd = fs.openSync(logPath, "r");
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
    rename(tmpTarget, logPath);
    tmpTarget = undefined;

    return {
      compacted: true,
      linesKept: survivors.length,
      linesDropped: parsed.length - survivors.length + malformed,
      slugsDropped,
    };
  } catch {
    return { ...ALL_ZERO };
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
