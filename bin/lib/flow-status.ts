/**
 * `<worktree>/.flow-status` — per-worktree phase + transition timestamp.
 *
 * Format (two key:value lines, no YAML parser needed):
 *
 *   phase: implementing
 *   last_transition_at: 2026-04-30T18:42:11Z
 *
 * `phase` is one of the lifecycle phases (planning, awaiting-approval,
 * implementing, verifying, ci-wait, reviewing, gated, merged, cancelled,
 * needs-human). `last_transition_at` is ISO-8601 UTC with the trailing `Z`,
 * matching the rest of the codebase's timestamp shape.
 *
 * Atomic write contract (responsibility of PR 2's supervisor — this PR
 * only ships the reader): writers MUST rewrite the file atomically on
 * every phase transition (write-tmp + rename(2)) so a concurrent reader
 * never observes a partial file. PR 1 only needs the reader and the
 * format pin so PR 2 has a target to write to.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const FLOW_STATUS_FILENAME = ".flow-status";

export type FlowStatus = {
  phase: string;
  /** ISO-8601 UTC timestamp with trailing Z. */
  lastTransitionAt: string;
};

/**
 * Reads `<worktree>/.flow-status`. Returns null on:
 *   - missing file
 *   - unreadable file
 *   - malformed contents (no `key: value` shape, missing `phase`, missing
 *     `last_transition_at`, unparseable timestamp)
 *
 * Malformed files emit a one-line warning to stderr; missing files do not.
 * Either way, callers render the row and substitute "—" for the columns.
 */
export function readFlowStatus(worktree: string): FlowStatus | null {
  const file = path.join(worktree, FLOW_STATUS_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    process.stderr.write(`flow ls: cannot read ${file}: ${(e as Error).message}\n`);
    return null;
  }

  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }

  const phase = fields.phase;
  const lastTransitionAt = fields.last_transition_at;
  if (!phase || !lastTransitionAt) {
    process.stderr.write(
      `flow ls: malformed ${file} (missing phase or last_transition_at)\n`,
    );
    return null;
  }
  if (!Number.isFinite(Date.parse(lastTransitionAt))) {
    process.stderr.write(
      `flow ls: malformed ${file} (unparseable last_transition_at: ${lastTransitionAt})\n`,
    );
    return null;
  }

  return { phase, lastTransitionAt };
}

/**
 * Renders the difference between two timestamps as the largest non-zero
 * unit ("30s ago", "12m ago", "3h ago", "2d ago"). Mirrors the existing
 * humanizeActivity rounding so columns stay consistent.
 */
export function relativeTime(thenMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
