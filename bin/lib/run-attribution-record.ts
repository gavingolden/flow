/**
 * Durable `~/.flow/telemetry/run-attribution.jsonl`: one row per terminal
 * render, latest row per slug wins. Fail-open like `recordEvent` — a write or
 * read error never changes a caller's control flow.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { flowRunAttributionLogPath } from "./paths";
import {
  RUN_ATTRIBUTION_VERSION,
  type DelegatedCall,
  type RunAttribution,
} from "./run-attribution-types";
import { computeTotals } from "./run-attribution-unit";

export type RunAttributionRow = RunAttribution & { ts: string; status: string };

export function appendRunAttribution(
  row: RunAttributionRow,
  opts: { logPath?: string } = {},
): void {
  try {
    const target = opts.logPath ?? flowRunAttributionLogPath();
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.appendFileSync(target, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch {
    // Best-effort: telemetry must never fail the caller's operation.
  }
}

function asRow(line: string): RunAttributionRow | null {
  try {
    const r = JSON.parse(line) as Partial<RunAttributionRow> | null;
    if (
      !r ||
      r.version !== RUN_ATTRIBUTION_VERSION ||
      typeof r.slug !== "string" ||
      !Array.isArray(r.sessions) ||
      !Array.isArray(r.spawns)
    ) {
      return null;
    }
    return {
      ...(r as RunAttributionRow),
      delegated: Array.isArray(r.delegated) ? r.delegated : [],
    };
  } catch {
    return null;
  }
}

/** One read of the log; the last well-formed row per slug. Never throws. */
export function readLatestRunAttributions(
  opts: { logPath?: string } = {},
): Map<string, RunAttributionRow> {
  const out = new Map<string, RunAttributionRow>();
  let text: string;
  try {
    text = fs.readFileSync(opts.logPath ?? flowRunAttributionLogPath(), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    const row = asRow(line);
    if (row) out.set(row.slug, row);
  }
  return out;
}

const delegatedKey = (d: DelegatedCall) => `${d.event}|${d.ts}|${d.task}`;

/**
 * A late terminal render must not lose sessions Claude Code has since pruned:
 * carry over prior sessions (with their spawns) and delegated calls absent
 * from the fresh collection, then recompute the totals from the union.
 */
export function mergeWithPrior(
  fresh: RunAttribution,
  prior: RunAttribution | null,
): RunAttribution {
  if (!prior) return fresh;
  const have = new Set(fresh.sessions.map((s) => s.session_id));
  const carried = prior.sessions.filter((s) => !have.has(s.session_id));
  const carriedIds = new Set(carried.map((s) => s.session_id));
  const haveSpawns = new Set(fresh.spawns.map((s) => s.session_id));
  const spawns = [
    ...fresh.spawns,
    ...prior.spawns.filter(
      (s) =>
        carriedIds.has(s.parent_session_id) && !haveSpawns.has(s.session_id),
    ),
  ];
  const haveDelegated = new Set(fresh.delegated.map(delegatedKey));
  const delegated = [
    ...fresh.delegated,
    ...prior.delegated.filter((d) => !haveDelegated.has(delegatedKey(d))),
  ];
  const sessions = [...carried, ...fresh.sessions];
  return {
    ...fresh,
    sessions,
    spawns,
    delegated,
    totals: computeTotals(
      [...sessions, ...spawns],
      delegated,
      fresh.totals.skipped_files,
    ),
  };
}
