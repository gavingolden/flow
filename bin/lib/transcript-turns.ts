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

export type TranscriptTurn = {
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

export const DEFAULT_MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_EFFORT_CHARS = 16;

/** Opaque effort level: any non-empty string of at most 16 characters. */
export function normalizeEffort(v: unknown): string | null {
  return typeof v === "string" && v !== "" && v.length <= MAX_EFFORT_CHARS
    ? v
    : null;
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
  let text: string;
  try {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
    if (fs.statSync(jsonlPath).size > maxBytes) return null;
    text = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return null;
  }
  const turns = new Map<string, TranscriptTurn>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const turn = parseTurn(line, turns.size);
    if (turn) turns.set(turn.id, turn);
  }
  return [...turns.values()];
}

function parseTurn(line: string, ordinal: number): TranscriptTurn | null {
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
  const id =
    typeof message.id === "string" && message.id
      ? message.id
      : `\0line${ordinal}`;
  return {
    id,
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
