/**
 * Recompute the safeguards-stop / padding contingency table from Claude Code
 * subagent transcripts. Pure: callers pass transcript text. Counts only — no
 * file contents and no request IDs leave this module.
 */
import { findPaddingRuns } from "./guidance-padding";
import { parseSafeguardsStop } from "./safeguards-stop";

export const DEFAULT_SPLIT_AT = new Date("2026-11-04T00:00:00Z");

export type TranscriptFile = { name: string; text: string; mtime: Date };

export type WindowRow = {
  window: "before" | "after";
  runs: number;
  padded: number;
  stopped: number;
  stoppedPadded: number;
  stoppedViaRead: number;
  stoppedViaInjection: number;
};

export type AgentRow = {
  agentType: string;
  runs: number;
  padded: number;
  stopped: number;
  stoppedPadded: number;
};

export type AuditResult = { windows: WindowRow[]; agents: AgentRow[] };

type Route = "injection" | "read" | "other" | null;

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

type BlockText = { text: string; toolResult: boolean };

function blockTexts(content: unknown): BlockText[] {
  if (typeof content === "string")
    return [{ text: content, toolResult: false }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b: unknown): BlockText[] => {
    if (typeof b !== "object" || b === null) return [];
    const blk = b as { type?: string; text?: unknown; content?: unknown };
    if (blk.type === "tool_result") {
      return blockTexts(blk.content).map((t) => ({ ...t, toolResult: true }));
    }
    return typeof blk.text === "string"
      ? [{ text: blk.text, toolResult: false }]
      : [];
  });
}

function classifyBlock(text: string, toolResult: boolean): Route {
  if (findPaddingRuns(text).length === 0) return null;
  const outside = text.replace(REMINDER, "");
  if (findPaddingRuns(outside).length === 0) return "injection";
  return toolResult ? "read" : "other";
}

/**
 * Index of the line where this agent itself was stopped: the harness writes an
 * entry with `isApiErrorMessage: true` carrying the safeguards text. A
 * transcript that merely quotes the error (a supervisor relaying it, a doc
 * citing it) is not a stop. Returns -1 when the run was not stopped.
 */
export function stopLineIndex(lines: string[]): number {
  return lines.findIndex((line) => {
    if (!line.includes('"isApiErrorMessage":true')) return false;
    return parseSafeguardsStop(line).stopped;
  });
}

function firstPaddingRoute(lines: string[]): Route {
  for (const line of lines) {
    let obj: { message?: { content?: unknown } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    for (const b of blockTexts(obj?.message?.content)) {
      const route = classifyBlock(b.text, b.toolResult);
      if (route !== null) return route;
    }
  }
  return null;
}

function runDate(f: TranscriptFile): Date {
  const first = f.text.slice(0, f.text.indexOf("\n") + 1 || undefined);
  const ts = /"timestamp":"([^"]+)"/.exec(first)?.[1];
  const d = ts ? new Date(ts) : f.mtime;
  return Number.isNaN(d.getTime()) ? f.mtime : d;
}

function agentTypeOf(f: TranscriptFile, meta: Map<string, string>): string {
  const base = f.name.replace(/\.jsonl$/, "");
  const fromMeta = meta.get(base);
  if (fromMeta) return fromMeta;
  const first = f.text.slice(0, f.text.indexOf("\n") + 1 || undefined);
  return (
    /"(?:agentType|subagent_type)":"([^"]+)"/.exec(first)?.[1] ?? "unknown"
  );
}

export function auditTranscripts(
  files: TranscriptFile[],
  opts: { since?: Date; splitAt?: Date },
): AuditResult {
  const splitAt = opts.splitAt ?? DEFAULT_SPLIT_AT;
  const meta = new Map<string, string>();
  for (const f of files) {
    if (!f.name.endsWith(".meta.json")) continue;
    try {
      const t = (JSON.parse(f.text) as { agentType?: unknown }).agentType;
      if (typeof t === "string")
        meta.set(f.name.replace(/\.meta\.json$/, ""), t);
    } catch {
      // unreadable meta: the run falls back to "unknown"
    }
  }
  const empty = (window: "before" | "after"): WindowRow => ({
    window,
    runs: 0,
    padded: 0,
    stopped: 0,
    stoppedPadded: 0,
    stoppedViaRead: 0,
    stoppedViaInjection: 0,
  });
  const windows = { before: empty("before"), after: empty("after") };
  const agents = new Map<string, AgentRow>();
  for (const f of files) {
    if (!f.name.endsWith(".jsonl")) continue;
    const when = runDate(f);
    if (opts.since && when < opts.since) continue;
    const w = windows[when < splitAt ? "before" : "after"];
    const lines = f.text.split("\n");
    const stopAt = stopLineIndex(lines);
    const stopped = stopAt !== -1;
    // A stopped agent's context is everything before its stop entry.
    const context = stopped ? lines.slice(0, stopAt) : lines;
    const route = firstPaddingRoute(context);
    const padded =
      route !== null || findPaddingRuns(context.join("\n")).length > 0;
    const type = agentTypeOf(f, meta);
    const a = agents.get(type) ?? {
      agentType: type,
      runs: 0,
      padded: 0,
      stopped: 0,
      stoppedPadded: 0,
    };
    agents.set(type, a);
    for (const row of [w, a]) {
      row.runs++;
      if (padded) row.padded++;
      if (stopped) row.stopped++;
      if (stopped && padded) row.stoppedPadded++;
    }
    if (stopped && route === "read") w.stoppedViaRead++;
    if (stopped && route === "injection") w.stoppedViaInjection++;
  }
  return {
    windows: [windows.before, windows.after],
    agents: [...agents.values()].sort((x, y) => y.runs - x.runs),
  };
}
