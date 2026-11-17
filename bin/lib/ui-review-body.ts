/**
 * Upserts the `## UI review` section and its two human-only DECISION items
 * (unresolved defects, review did not run) into a PR body without touching any
 * other Test Step. The two items are independent slots: ticking one never
 * waives the other.
 */
import { testStepsSectionBounds } from "../flow-gate-decide";
import {
  fencedLineMask,
  findUnterminatedHtmlBlockLines,
} from "./md-block-structure";
import {
  UI_REVIEW_CLOSE,
  UI_REVIEW_DECISION_MARKER,
  UI_REVIEW_NOT_RUN_MARKER,
  UI_REVIEW_OPEN,
} from "./ui-critique-render";

const CHECKBOX = /^(\s*[-*] )\[[ xX]\] /;
const HTML_COMMENT = /<!--.*?-->/g;
const TICKED = /^\s*[-*] \[[xX]\] /;

function findLine(
  lines: string[],
  fenced: boolean[],
  pred: (l: string) => boolean,
): number {
  return lines.findIndex((l, i) => !fenced[i] && pred(l));
}

function replaceBlock(lines: string[], block: string[]): string[] | null {
  const fenced = fencedLineMask(lines);
  const from = findLine(lines, fenced, (l) => l === UI_REVIEW_OPEN);
  if (from < 0) return null;
  let close = lines.findIndex(
    (l, i) => i > from && !fenced[i] && l === UI_REVIEW_CLOSE,
  );
  if (close < 0) close = from;
  lines.splice(from, close - from + 1, ...block);
  return lines;
}

function insertBlock(lines: string[], block: string[]): void {
  const bounds = testStepsSectionBounds(lines);
  if (bounds) {
    const lead =
      bounds.start > 0 && lines[bounds.start - 1].trim() !== "" ? [""] : [];
    lines.splice(bounds.start, 0, ...lead, ...block, "");
  } else lines.push("", ...block, "");
}

/** A human-ticked DECISION stays ticked while its text is unchanged. */
function isSameTickedDecision(existing: string, next: string): boolean {
  return (
    TICKED.test(existing) &&
    existing.replace(CHECKBOX, "").trim() === next.replace(CHECKBOX, "").trim()
  );
}

const plainText = (l: string): string =>
  l.replace(CHECKBOX, "").replace(HTML_COMMENT, "").replace(/\s+/g, " ").trim();

/** Index of the live (not fenced, not trapped in raw HTML) not-run line. */
function findNotRunLine(lines: string[]): number {
  const bounds = testStepsSectionBounds(lines);
  if (bounds === null) return -1;
  const fenced = fencedLineMask(lines);
  const trapped = findUnterminatedHtmlBlockLines(
    lines.slice(bounds.start + 1, bounds.end).join("\n"),
  );
  for (let i = bounds.start + 1; i < bounds.end; i++) {
    if (
      !fenced[i] &&
      !trapped.has(i - bounds.start - 1) &&
      lines[i].includes(UI_REVIEW_NOT_RUN_MARKER)
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Adds, replaces or (with `item === null`) removes the one not-run line. A
 * human tick survives a re-render whose visible text is unchanged, including
 * a legacy line that also carried the defects marker.
 */
export function upsertNotRunItem(body: string, item: string | null): string {
  const lines = body.split("\n");
  const at = findNotRunLine(lines);
  if (at >= 0) {
    if (item === null) lines.splice(at, 1);
    else if (TICKED.test(lines[at]) && plainText(lines[at]) === plainText(item))
      lines[at] = item.replace(CHECKBOX, "$1[x] ");
    else lines[at] = item;
    return lines.join("\n");
  }
  if (item === null) return body;
  const bounds = testStepsSectionBounds(lines);
  if (!bounds) return body;
  let last = bounds.end - 1;
  while (last > bounds.start && lines[last].trim() === "") last--;
  const trapped = findUnterminatedHtmlBlockLines(
    lines.slice(bounds.start + 1, bounds.end).join("\n"),
  );
  const inHtml =
    trapped.has(last - bounds.start - 1) ||
    /<\/(details|summary)>\s*$/.test(lines[last]);
  lines.splice(last + 1, 0, ...(inHtml ? [""] : []), item);
  return lines.join("\n");
}

/**
 * Inserts the section before `## Test Steps` only when no block exists yet;
 * a block that is just the `Off: ...` stub is replaced, any other is kept.
 */
export function insertSectionIfAbsent(body: string, section: string): string {
  const lines = body.split("\n");
  const fenced = fencedLineMask(lines);
  const from = findLine(lines, fenced, (l) => l === UI_REVIEW_OPEN);
  if (from < 0) {
    insertBlock(lines, section.split("\n"));
    return lines.join("\n");
  }
  const close = lines.findIndex(
    (l, i) => i > from && !fenced[i] && l === UI_REVIEW_CLOSE,
  );
  if (close < 0) return body;
  const content = lines
    .slice(from + 1, close)
    .filter((l) => l.trim() !== "" && l !== "## UI review");
  if (content.length === 1 && content[0].startsWith("Off:")) {
    return (replaceBlock(lines, section.split("\n")) ?? lines).join("\n");
  }
  return body;
}

/**
 * Replaces the marked block, or inserts it before `## Test Steps`; then
 * writes the defects slot (the decision-marked line that is not the not-run
 * line) and the not-run slot independently.
 */
export function upsertUiReview(
  body: string,
  section: string,
  items: { defects: string | null; notRun: string | null },
): string {
  const lines = body.split("\n");
  const block = section.split("\n");
  if (!replaceBlock(lines, block)) insertBlock(lines, block);

  const fenced = fencedLineMask(lines);
  const at = findLine(
    lines,
    fenced,
    (l) =>
      l.includes(UI_REVIEW_DECISION_MARKER) &&
      !l.includes(UI_REVIEW_NOT_RUN_MARKER),
  );
  const marked =
    items.defects === null
      ? null
      : `${items.defects.trimEnd()} ${UI_REVIEW_DECISION_MARKER}`;
  if (at >= 0) {
    if (marked === null) lines.splice(at, 1);
    else if (!isSameTickedDecision(lines[at], marked)) lines[at] = marked;
  } else if (marked !== null) {
    const bounds = testStepsSectionBounds(lines);
    if (bounds) {
      let last = bounds.end - 1;
      while (last > bounds.start && lines[last].trim() === "") last--;
      lines.splice(last + 1, 0, marked);
    }
  }
  return upsertNotRunItem(lines.join("\n"), items.notRun);
}
