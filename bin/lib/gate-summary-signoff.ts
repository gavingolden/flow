/**
 * Pure row builders for the GATED block's UI sign-off evidence: one line under
 * each open `SUBJECTIVE:` item and one `UI review:` line. Display only — the
 * lines never tick anything and the item text itself is never altered.
 */
import { fileUri, linkLabel, type LinkMode } from "./link";
import type {
  ItemEvidence,
  UiReviewSummary,
  UiSignoff,
} from "./ui-signoff-evidence";

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

function isItem(v: unknown): v is ItemEvidence {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.item === "string" &&
    isStrings(o.required) &&
    isStrings(o.missing) &&
    typeof o.unlabelled === "number" &&
    Array.isArray(o.shots) &&
    o.shots.every(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as { ref?: unknown }).ref === "string" &&
        ((s as { view?: unknown }).view === null ||
          typeof (s as { view?: unknown }).view === "string"),
    )
  );
}

/** Tolerant parse of `uiSignoff` JSON; anything unreadable is `null`. */
export function readSignoff(raw: string): UiSignoff | null {
  if (!raw.trim()) return null;
  try {
    const v = JSON.parse(raw) as Partial<UiSignoff> | null;
    if (!v || !Array.isArray(v.items) || !v.items.every(isItem)) return null;
    const r = v.uiReview;
    if (!r || typeof r !== "object" || typeof r.passed !== "boolean") {
      return null;
    }
    return v as UiSignoff;
  } catch {
    return null;
  }
}

function shotLink(label: string, ref: string, mode: LinkMode): string {
  if (/^https?:\/\//i.test(ref)) return linkLabel(label, ref, mode);
  if (ref.startsWith("/")) return linkLabel(label, fileUri(ref) ?? "", mode);
  return label;
}

export function itemEvidenceLine(item: ItemEvidence, mode: LinkMode): string {
  if (item.noScreenshot !== undefined) {
    return `no screenshot: ${item.noScreenshot}`;
  }
  const links = item.shots.map((s) => shotLink(s.view ?? "shot", s.ref, mode));
  let line = `shots: ${links.length > 0 ? links.join(" · ") : "none"}`;
  if (item.missing.length > 0) line += ` — missing: ${item.missing.join(", ")}`;
  else if (item.unlabelled > 0)
    line += ` — unlabelled: ${item.unlabelled} shot${item.unlabelled === 1 ? "" : "s"}`;
  if (item.partial !== undefined) line += ` — partial: ${item.partial}`;
  return line;
}

const OUTCOME_PHRASE: Record<string, string> = {
  clean: "passed, nothing to fix",
  kept: "passed, its fixes kept",
  reverted: "passed, its fixes undone",
  "list-only": "passed, findings listed only",
};

export function uiReviewLine(s: UiReviewSummary): string | null {
  if (!s.passed) return null;
  const outcome = (s.outcome && OUTCOME_PHRASE[s.outcome]) ?? "passed";
  const defects = `${s.gatingDefect} ${s.gatingDefect === 1 ? "defect" : "defects"}`;
  return `UI review: ${outcome}; ${s.gatingMajor} major, ${defects} open`;
}

const itemKey = (text: string): string =>
  text
    .trim()
    .replace(/^[-*]\s+(?:\[ \]\s+)?/, "")
    .trim();

/** The evidence line for a gated validation item, or `null` when none matches. */
export function evidenceForItem(
  signoff: UiSignoff | undefined,
  itemText: string,
  mode: LinkMode,
): string | null {
  if (!signoff) return null;
  const key = itemKey(itemText);
  const hit = signoff.items.find((i) => i.item.trim() === key);
  return hit ? itemEvidenceLine(hit, mode) : null;
}

/**
 * Inserts an indented evidence line under each item row. `rows[offset + i]`
 * must be the row of `items[i]` (blank items already dropped by the caller).
 */
export function withEvidenceLines(
  rows: string[],
  offset: number,
  items: string[],
  signoff: UiSignoff | undefined,
  mode: LinkMode,
): string[] {
  if (!signoff) return rows;
  const out = rows.slice(0, offset);
  for (let i = offset; i < rows.length; i++) {
    out.push(rows[i]);
    const ev = evidenceForItem(signoff, items[i - offset] ?? "", mode);
    if (ev !== null) out.push(`    ${ev}`);
  }
  return out;
}
