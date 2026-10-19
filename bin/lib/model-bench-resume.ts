/**
 * Resume / merge / quota-halt logic for `flow-model-bench`, kept out of the
 * runner so its chunk loop stays thin. A run split across quota windows
 * writes `results.json` after every chunk; `--resume` then dispatches only the
 * slots with no successful row.
 */

import type { ManifestEntry } from "./model-bench-manifest";
import type { BenchResult } from "./model-bench-schema";

type SlotLike = {
  caseId: string;
  arm: string;
  model: string;
  repeat: number;
  warmup: boolean;
  size?: number;
};

export function slotKey(e: SlotLike): string {
  return [
    e.caseId,
    e.arm,
    e.model,
    e.warmup ? "warmup" : `r${e.repeat}`,
    e.size ?? "",
  ].join("|");
}

// A slot is done once it has a row that ran. Selected BEFORE --max-calls is
// applied: capping first would re-select the same already-done slots on every
// tranche and a second tranche would dispatch nothing new.
export function pendingSlots(
  manifest: ManifestEntry[],
  prior: BenchResult[],
): ManifestEntry[] {
  const done = new Set(prior.filter((r) => r.ran).map(slotKey));
  return manifest.filter((e) => !done.has(slotKey(e)));
}

// Prior rows stay where they are, so the blinded ids of earlier successes (an
// index among the ran, non-warm-up rows) never move. A fresh outcome replaces a
// same-key prior FAILURE by dropping that failure and appending the fresh row:
// failures are not in the judge packet, so dropping one shifts no id. A fresh
// row for a key that already has a prior success is ignored.
export function mergeResults(
  prior: BenchResult[],
  fresh: BenchResult[],
): BenchResult[] {
  const succeeded = new Set(prior.filter((r) => r.ran).map(slotKey));
  const freshKeys = new Set(fresh.map(slotKey));
  const kept = prior.filter((r) => r.ran || !freshKeys.has(slotKey(r)));
  return [...kept, ...fresh.filter((r) => !succeeded.has(slotKey(r)))];
}

export function quotaHalt(chunk: BenchResult[]): {
  halted: boolean;
  resetsIn?: string;
} {
  const refused = chunk.filter((r) => r.failureClass === "quota-exhausted");
  if (refused.length === 0) return { halted: false };
  const resetsIn = refused.find((r) => r.resetsIn)?.resetsIn;
  return resetsIn ? { halted: true, resetsIn } : { halted: true };
}

// "... Resets in 92h31m22s" -> "92h31m22s"
export function parseResetsIn(text: string | undefined): string | undefined {
  return /resets?\s+in\s+((?:\d+(?:\.\d+)?[hms])+)/i.exec(text ?? "")?.[1];
}

export function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}
