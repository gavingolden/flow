/**
 * Upserts the `## UI review` section and its two human-only DECISION items
 * (unresolved defects, review did not run) into a PR body without touching any
 * other Test Step. The two items are independent slots: ticking one never
 * waives the other.
 */
import {
  fencedLineMask,
  findUnterminatedHtmlBlockLines,
} from "./md-block-structure";
import { testStepsSectionBounds } from "./test-steps-section";
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
  const from = findLine(lines, fenced, (l) => l.trimEnd() === UI_REVIEW_OPEN);
  if (from < 0) return null;
  let close = lines.findIndex(
    (l, i) => i > from && !fenced[i] && l.trimEnd() === UI_REVIEW_CLOSE,
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

/**
 * Index of the first live line in `## Test Steps` (not fenced, not trapped in
 * raw HTML, where a reviewer could not tick it) matching `pred`; -1 if none.
 */
export function findLiveTestStepLine(
  lines: string[],
  pred: (l: string) => boolean,
): number {
  const bounds = testStepsSectionBounds(lines);
  if (bounds === null) return -1;
  const fenced = fencedLineMask(lines);
  const trapped = findUnterminatedHtmlBlockLines(
    lines.slice(bounds.start + 1, bounds.end).join("\n"),
  );
  for (let i = bounds.start + 1; i < bounds.end; i++) {
    if (!fenced[i] && !trapped.has(i - bounds.start - 1) && pred(lines[i])) {
      return i;
    }
  }
  return -1;
}

const findNotRunLine = (lines: string[]): number =>
  findLiveTestStepLine(lines, (l) => l.includes(UI_REVIEW_NOT_RUN_MARKER));

/**
 * The not-run marker is an HTML comment, which the Test Steps parse strips,
 * so it is found in the RAW lines of the section — skipping fenced output and
 * a span GitHub renders as raw HTML, where a reviewer could not have ticked
 * it. It is distinct from the residual-defects marker, so accepting defects
 * never waives a review that did not run.
 */
export const hasLiveNotRunLine = (body: string): boolean =>
  findNotRunLine(body.split("\n")) >= 0;

/**
 * Appends a step to the end of `## Test Steps`. After a closed `</details>` a
 * blank line keeps the step out of that HTML block; when the section ends in
 * an unterminated `<details>`, the step goes before the opener instead,
 * because a blank line after it would end the trap and un-hide the raw-HTML
 * items inside.
 */
function appendTestStep(lines: string[], item: string): void {
  const bounds = testStepsSectionBounds(lines);
  if (!bounds) return;
  let last = bounds.end - 1;
  while (last > bounds.start && lines[last].trim() === "") last--;
  const trapped = findUnterminatedHtmlBlockLines(
    lines.slice(bounds.start + 1, bounds.end).join("\n"),
  );
  const insertAt = trapped.has(last - bounds.start - 1)
    ? bounds.start + 1 + Math.min(...trapped)
    : last + 1;
  const prev = insertAt - 1;
  const needBlank =
    prev > bounds.start && /<\/(details|summary)>\s*$/.test(lines[prev]);
  lines.splice(insertAt, 0, ...(needBlank ? [""] : []), item);
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
  if (testStepsSectionBounds(lines) === null) return body;
  appendTestStep(lines, item);
  return lines.join("\n");
}

/**
 * Inserts the section before `## Test Steps` only when no block exists yet;
 * a block that is just the `Off: ...` stub is replaced, any other is kept.
 */
export function insertSectionIfAbsent(body: string, section: string): string {
  const lines = body.split("\n");
  const fenced = fencedLineMask(lines);
  const from = findLine(lines, fenced, (l) => l.trimEnd() === UI_REVIEW_OPEN);
  if (from < 0) {
    insertBlock(lines, section.split("\n"));
    return lines.join("\n");
  }
  const close = lines.findIndex(
    (l, i) => i > from && !fenced[i] && l.trimEnd() === UI_REVIEW_CLOSE,
  );
  if (close < 0) return body;
  const content = lines
    .slice(from + 1, close)
    .filter((l) => l.trim() !== "" && l.trimEnd() !== "## UI review");
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

  const at = findLiveTestStepLine(
    lines,
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
  } else if (marked !== null) appendTestStep(lines, marked);
  return upsertNotRunItem(lines.join("\n"), items.notRun);
}
