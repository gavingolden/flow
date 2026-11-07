/**
 * Reads `events.jsonl` for the run-attribution collector: the session ids an
 * event ties to a pipeline slug (recovers post-`/clear` sessions whose first
 * message lacks the slug marker) and the headless/delegated model calls.
 */

import * as fs from "node:fs";
import type { DelegatedCall } from "./run-attribution-types";

const DELEGATED_EVENTS = ["delegate.call", "deliberate.call", "explain.judge"];

type EventLine = {
  ts?: unknown;
  event?: unknown;
  slug?: unknown;
  session_id?: unknown;
  attrs?: Record<string, unknown>;
};

function parse(line: string): EventLine | null {
  try {
    const e = JSON.parse(line) as EventLine;
    return e && typeof e === "object" ? e : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

// `flow ls --cost` collects once per pipeline from the same multi-MB log:
// remember the last read, keyed on the file's identity and size.
let memo: { key: string; lines: string[] } | null = null;

export function readEventLines(eventsLogPath: string): string[] {
  try {
    const st = fs.statSync(eventsLogPath);
    const key = `${eventsLogPath}|${st.mtimeMs}|${st.size}`;
    if (memo?.key === key) return memo.lines;
    const lines = fs.readFileSync(eventsLogPath, "utf8").split("\n");
    memo = { key, lines };
    return lines;
  } catch {
    return [];
  }
}

/** Session ids of events carrying `slug` directly or as `attrs.unmatched_slug`. */
export function sessionIdsForSlug(
  lines: readonly string[],
  slug: string,
): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
    if (!line.includes(slug)) continue;
    const e = parse(line);
    const sid = str(e?.session_id);
    if (sid && (e?.slug === slug || e?.attrs?.unmatched_slug === slug)) {
      out.add(sid);
    }
  }
  return out;
}

export function delegatedCalls(
  lines: readonly string[],
  slug: string,
  sessionIds: ReadonlySet<string>,
  notBefore: number | null,
): DelegatedCall[] {
  const out: DelegatedCall[] = [];
  for (const line of lines) {
    if (!DELEGATED_EVENTS.some((name) => line.includes(`"${name}"`))) continue;
    const e = parse(line);
    const event = str(e?.event);
    const ts = str(e?.ts);
    if (!e || !event || !ts || !DELEGATED_EVENTS.includes(event)) continue;
    const sid = str(e.session_id);
    if (e.slug !== slug && !(sid && sessionIds.has(sid))) continue;
    if (notBefore !== null && Date.parse(ts) < notBefore) continue;
    const a = e.attrs ?? {};
    const cost = a.total_cost_usd;
    out.push({
      event,
      task: str(a.task) ?? str(a.site),
      model: str(a.model),
      effort: str(a.effort),
      ran: typeof a.ran === "boolean" ? a.ran : null,
      skip_reason: str(a.skip_reason),
      ts,
      cost_usd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    });
  }
  return out;
}
