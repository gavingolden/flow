/**
 * Synchronous reader for Claude Code's per-session JSONL transcripts: one
 * entry per assistant message (deduped by `message.id`, last line wins, since
 * only the last line of a message carries its final `output_tokens`).
 *
 * Field names (`message.model`, top-level `effort` / `perTurnEffort`,
 * top-level `timestamp`) are undocumented Claude Code internals: every field
 * degrades to `null` / `"unknown"` rather than a guess.
 */

import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

export type TranscriptTurn = {
  /** `message.id`; empty when the line carries none. */
  id: string;
  model: string | null;
  effort: string;
  ts: string | null;
  usage: Record<string, unknown>;
};

export type EffortRun = [effort: string, turns: number];
export type ModelEffortRun = [
  model: string | null,
  effort: string,
  turns: number,
];

export const DEFAULT_MAX_TRANSCRIPT_BYTES = 1024 * 1024 * 1024;
const CHUNK_BYTES = 1 << 20;
const MAX_EFFORT_CHARS = 16;

/** Opaque effort level: any non-empty string of at most 16 characters. */
export function normalizeEffort(v: unknown): string | null {
  return typeof v === "string" && v !== "" && v.length <= MAX_EFFORT_CHARS
    ? v
    : null;
}

/**
 * Records `value` as the line for message `id`, replacing any earlier line
 * with the same id (the last one carries the final usage) while keeping the
 * message's first-seen position. Id-less lines each count individually.
 * Callers pass only usage-bearing lines, so a usage-less last line never
 * erases an earlier one's usage.
 */
export function recordLastLine<T>(
  messages: Map<string, T>,
  id: unknown,
  value: T,
): void {
  const key = typeof id === "string" && id ? id : `\0line${messages.size}`;
  messages.set(key, value);
}

/**
 * Returns the turns in first-seen order, or null when the file is unreadable
 * or larger than `maxBytes` (never partially read). `<synthetic>` turns
 * (Claude Code's own error/placeholder messages) are skipped.
 */
export function readTranscriptTurns(
  jsonlPath: string,
  opts: { maxBytes?: number } = {},
): TranscriptTurn[] | null {
  const turns = new Map<string, TranscriptTurn>();
  const take = (line: string) => {
    if (!line) return;
    const turn = parseTurn(line);
    if (turn) recordLastLine(turns, turn.id, turn);
  };
  let fd: number | null = null;
  try {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
    if (fs.statSync(jsonlPath).size > maxBytes) return null;
    fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    let carry = "";
    for (let pos = 0; ; ) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      pos += n;
      const text = carry + decoder.write(buf.subarray(0, n));
      const cut = text.lastIndexOf("\n");
      if (cut < 0) {
        carry = text;
        continue;
      }
      carry = text.slice(cut + 1);
      for (const line of text.slice(0, cut).split("\n")) take(line);
    }
    take(carry + decoder.end());
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return [...turns.values()];
}

function parseTurn(line: string): TranscriptTurn | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!event || event.type !== "assistant") return null;
  const message = event.message as Record<string, unknown> | undefined;
  const usage = message?.usage;
  if (!message || !usage || typeof usage !== "object") return null;
  const model =
    typeof message.model === "string" && message.model ? message.model : null;
  if (model === "<synthetic>") return null;
  return {
    id: typeof message.id === "string" ? message.id : "",
    model,
    effort:
      normalizeEffort(event.effort) ??
      normalizeEffort(event.perTurnEffort) ??
      "unknown",
    ts: typeof event.timestamp === "string" ? event.timestamp : null,
    usage: usage as Record<string, unknown>,
  };
}

export function effortRunsOf(turns: readonly TranscriptTurn[]): EffortRun[] {
  const runs: EffortRun[] = [];
  for (const t of turns) {
    const last = runs[runs.length - 1];
    if (last && last[0] === t.effort) last[1]++;
    else runs.push([t.effort, 1]);
  }
  return runs;
}

export function modelEffortRunsOf(
  turns: readonly TranscriptTurn[],
): ModelEffortRun[] {
  const runs: ModelEffortRun[] = [];
  for (const t of turns) {
    const last = runs[runs.length - 1];
    if (last && last[0] === t.model && last[1] === t.effort) last[2]++;
    else runs.push([t.model, t.effort, 1]);
  }
  return runs;
}
