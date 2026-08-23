/**
 * Pure `pm`-lens row builders for `flow-gate-summary.ts`. Extracted so the
 * helper (already 3.6× the 200-line target before this feature) doesn't
 * grow further — every function here takes already-derived scalars/arrays,
 * never reads files or config.
 */

export const TLDR_MAX_WORDS = 25;

export type ClampedTldr = { text: string; truncated: boolean; words: number };

/**
 * Word-boundary truncation to `TLDR_MAX_WORDS` words with a trailing `…`.
 * Never rejects — Q2 (cross-model review): a terminal render must never
 * fail on a word count. The caller (CLI `run()`) is responsible for
 * printing the paired stderr warning; this function stays pure.
 */
export function clampTldr(s: string): ClampedTldr {
  const words = s
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length <= TLDR_MAX_WORDS) {
    return { text: s.trim(), truncated: false, words: words.length };
  }
  return {
    text: words.slice(0, TLDR_MAX_WORDS).join(" ") + "…",
    truncated: true,
    words: words.length,
  };
}

/**
 * `NEEDS ATTENTION:` — every gated validation item, each suffixed with the
 * PR URL as its click target. Omit-when-empty: returns `[]` when there are
 * no items (the caller skips the whole section).
 */
export function buildNeedsAttention(
  validationItems: string[],
  prUrl: string | undefined,
): string[] {
  const items = validationItems
    .map((i) => i.trim())
    .filter((i) => i.length > 0);
  if (items.length === 0) return [];
  const lines = ["NEEDS ATTENTION:"];
  for (const item of items) {
    const stripped = item.replace(/^[-*]\s+/, "");
    const suffix = prUrl ? ` → ${prUrl}` : "";
    lines.push(`  - ${stripped}${suffix}`);
  }
  return lines;
}

/**
 * `MANUAL ACTION:` — `whenever:` is the follow-ups block with its own
 * header line stripped (that block already carries its own "LOCAL
 * FOLLOW-UPS..." framing, which is redundant under this section's own
 * label). `before merge:` is intentionally NOT populated from
 * `validationItems`: every gated validation item — `SUBJECTIVE:`-prefixed
 * or not — already renders once under `NEEDS ATTENTION:` with its PR-URL
 * click target (`buildNeedsAttention`); re-listing the same items here
 * would duplicate content and blow the ~12-line ceiling (calibration
 * sample 7, PR #640's two `SUBJECTIVE:` items, never repeats them under
 * `MANUAL ACTION:`). `beforeMerge` is accepted as a parameter for a
 * future non-validation-item manual-action source (none exists yet), kept
 * empty today so the signature doesn't need to change when one lands.
 * Omit-when-empty at both the sub-bucket and whole-section level.
 */
export function buildManualAction(
  _validationItems: string[],
  followupsBlock: string | undefined,
): string[] {
  const beforeMerge: string[] = [];
  const whenever = (followupsBlock ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    // Drop the header row ("LOCAL FOLLOW-UPS..." / "LOCAL FOLLOW-UPS
    // (deferred...)...") — this section owns its own "whenever:" label.
    .filter((l) => !l.startsWith("LOCAL FOLLOW-UPS"))
    // The block's own bullets/checkboxes are re-bulleted by pushManualBucket;
    // strip them so a follow-up never renders as `- - [ ] …`.
    .map((l) => l.replace(/^[-*]\s+(\[[ x]\]\s+)?/, "").replace(/\s{2,}/g, " "));
  if (beforeMerge.length === 0 && whenever.length === 0) return [];
  const lines = ["MANUAL ACTION:"];
  pushManualBucket(lines, "before merge", beforeMerge);
  pushManualBucket(lines, "whenever", whenever);
  return lines;
}

/**
 * A single item collapses onto one line (`  <label>: <item>`, the
 * calibration-sample-7 shape); 2+ items expand to a header + bullets so
 * multiple items stay individually readable within the ceiling.
 */
function pushManualBucket(
  lines: string[],
  label: string,
  items: string[],
): void {
  if (items.length === 0) return;
  if (items.length === 1) {
    lines.push(`  ${label}: ${items[0]}`);
    return;
  }
  lines.push(`  ${label}:`);
  for (const item of items) lines.push(`    - ${item}`);
}

/**
 * `UNTRACKED:` — pre-rendered gate lines from `flow-untracked render
 * --format gate --unfiled-only` (already capped at `UNTRACKED_RENDER_CAP`).
 * `none` when the block is empty/absent — explicit-none discipline, same
 * as `pipeline-summary-sources`'s NONE rows.
 */
export function buildUntracked(untrackedBlock: string | undefined): string[] {
  const body = (untrackedBlock ?? "").replace(/\n+$/, "");
  if (body.trim() === "") return ["UNTRACKED: none"];
  const rendered = body.split("\n");
  // A single item with no overflow tail collapses onto the header line —
  // same one-line-when-singular shape as `pushManualBucket`.
  if (rendered.length === 1) {
    return [`UNTRACKED: ${rendered[0].replace(/^\s*-\s*/, "")}`];
  }
  return ["UNTRACKED:", ...rendered];
}
