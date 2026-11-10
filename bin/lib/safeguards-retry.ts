/**
 * Pure planning helpers for the bounded safeguards-stop retry: the stripped
 * coder retry edit-set, lens retry routing, copy-path mapping and idempotent
 * DECISION items for lenses that stayed skipped.
 */
import { testStepsSectionBounds } from "../flow-gate-decide";

export type EditEntry = {
  file: string;
  intent: string;
  expected_outcome: string;
  contract?: string;
  acceptance?: string;
  skill_docs?: string[];
};

type EditDisposition = { file: string; intent?: string; applied?: boolean };
export type CoderResultLike = {
  edits?: EditDisposition[];
  [key: string]: unknown;
};

export const RETRY_INTENT_SUFFIX =
  " (Retry after a safeguards stop: some changes may already be on disk — skip any change already present.)";

const editKey = (e: { file: string; intent?: string }) =>
  JSON.stringify([e.file, e.intent ?? ""]);

export function buildRetryEditSet(
  editSet: EditEntry[],
  partial: { edits?: EditDisposition[] } | null,
): { remaining: EditEntry[]; droppedGuidance: string[] } {
  const done = new Set(
    (partial?.edits ?? []).filter((e) => e.applied === true).map(editKey),
  );
  const dropped = new Set<string>();
  const remaining = editSet
    .filter((e) => !done.has(editKey(e)))
    .map((e) => {
      const { skill_docs: docs, ...rest } = e;
      for (const d of docs ?? []) dropped.add(d);
      return { ...rest, intent: e.intent + RETRY_INTENT_SUFFIX };
    });
  return { remaining, droppedGuidance: [...dropped] };
}

export function mergeCoderResults(
  first: CoderResultLike | null,
  second: CoderResultLike,
): CoderResultLike {
  const kept = (first?.edits ?? []).filter((e) => e.applied === true);
  const merged = new Map<string, EditDisposition>();
  for (const e of [...kept, ...(second.edits ?? [])]) {
    merged.set(editKey(e), e);
  }
  return { ...second, edits: [...merged.values()] };
}

export function planLensRetry(input: {
  inputsChanged: boolean;
  agyAvailable: boolean;
}): "respawn" | "delegated" | "skip" {
  if (input.inputsChanged) return "respawn";
  return input.agyAvailable ? "delegated" : "skip";
}

export function mapCopyPaths(
  text: string,
  copies: Record<string, string>,
): string {
  return Object.entries(copies)
    .filter(
      (e): e is [string, string] =>
        typeof e[0] === "string" && typeof e[1] === "string" && e[1].length > 0,
    )
    .sort((a, b) => b[1].length - a[1].length)
    .reduce((acc, [orig, copy]) => acc.split(copy).join(orig), text);
}

const SKIP_MARKER = /<!-- flow-safeguards-skip:(.+?) -->/;

type SkippedLens = { lens: string; requestIds: string[]; stops?: number };

// The marker carries the request IDs, so a tick accepts one specific stop: a
// later round's new stop of the same lens gets a fresh unchecked item.
const markerKey = (s: SkippedLens) => `${s.lens}:${s.requestIds.join(",")}`;

function decisionLine(s: SkippedLens): string {
  const ids = s.requestIds.filter(Boolean);
  const count = s.stops ?? (ids.length >= 2 ? 2 : 1);
  const stops = count >= 2 ? "two safeguards stops" : "a safeguards stop";
  const reqs =
    ids.length === 0
      ? ""
      : ` (request${ids.length > 1 ? "s" : ""} ${ids.join(", ")})`;
  return `- [ ] DECISION: accept that the ${s.lens} reviewer was skipped after ${stops}${reqs} <!-- flow-safeguards-skip:${markerKey(s)} -->`;
}

export function upsertDecisionItems(
  body: string,
  skipped: SkippedLens[],
): string {
  const wanted = new Map(skipped.map((s) => [markerKey(s), s]));
  const lines = body.split("\n");
  const present = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const key = SKIP_MARKER.exec(line)?.[1];
    if (key === undefined) {
      kept.push(line);
    } else if (wanted.has(key)) {
      present.add(key);
      kept.push(
        /^\s*- \[x\]/i.test(line) ? line : decisionLine(wanted.get(key)!),
      );
    }
  }
  const missing = skipped.filter((s) => !present.has(markerKey(s)));
  if (missing.length === 0) return kept.join("\n");
  const items = missing.map(decisionLine);
  const bounds = testStepsSectionBounds(kept);
  if (bounds === null) {
    const trimmed = kept.join("\n").replace(/\n+$/, "");
    return `${trimmed}\n\n## Test Steps\n\n${items.join("\n")}\n`;
  }
  let at = bounds.end;
  while (at > bounds.start + 1 && kept[at - 1].trim() === "") at--;
  // A list item straight after `</details>` renders as raw text, not a checkbox.
  if (/<\/details>\s*$/.test(kept[at - 1] ?? "")) items.unshift("");
  kept.splice(at, 0, ...items);
  return kept.join("\n");
}
