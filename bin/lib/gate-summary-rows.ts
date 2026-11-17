/**
 * Pure `pm`-lens row builders for `flow-gate-summary.ts`. Extracted so the
 * helper (already 3.6× the 200-line target before this feature) doesn't
 * grow further — every function here takes already-derived scalars/arrays,
 * never reads files or config.
 */

import { linkUrl, type LinkMode } from "./link";

export const TLDR_MAX_WORDS = 35;

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
 * no items (the caller skips the whole section). Items in `needsInstall`
 * (unmarked steps that name something only an installed branch provides)
 * carry a label naming the fix.
 */
export function buildNeedsAttention(
  validationItems: string[],
  prUrl: string | undefined,
  mode: LinkMode = "plain",
  needsInstall: string[] = [],
): string[] {
  const items = validationItems
    .map((i) => i.trim())
    .filter((i) => i.length > 0);
  if (items.length === 0) return [];
  const install = new Set(needsInstall.map((i) => stripBullet(i.trim())));
  const lines = ["NEEDS ATTENTION:"];
  for (const item of items) {
    const stripped = stripBullet(item);
    const label = install.has(stripped) ? needsInstallLabel(stripped) : "";
    const suffix = prUrl ? ` → ${linkUrl(prUrl, mode)}` : "";
    lines.push(`  - ${stripped}${label}${suffix}`);
  }
  return lines;
}

const NEEDS_INSTALL_LABEL =
  " — needs this branch installed: mark it `After merge:` or run it from the branch";

/** Names the runnable form (`bun bin/…` in the worktree) when the step quotes a flow verb or helper. */
export function needsInstallLabel(item: string): string {
  const verb = /`flow ([a-z][\w-]*)/.exec(item);
  if (verb)
    return ` — needs this branch installed: run \`bun bin/flow ${verb[1]}\` in the worktree, or mark the step \`After merge:\``;
  const helper = /`(flow-[a-z][\w-]*)/.exec(item);
  if (helper)
    return ` — needs this branch installed: run \`bun bin/${helper[1]}.ts\` in the worktree, or mark the step \`After merge:\``;
  return NEEDS_INSTALL_LABEL;
}
const GITHUB_MERGE_LINE =
  "  if you merge on GitHub instead: run flow install --upgrade, then these";
const STALE_INSTALL_LINE =
  "run flow install --upgrade first — the post-merge install did not refresh";

const stripBullet = (s: string): string =>
  s.replace(/^[-*]\s+(\[[ x]\]\s+)?/, "");

/** True when the follow-ups block shows `flow install` failed or skipped its content refresh. */
export function installStaleFrom(followupsBlock: string | undefined): boolean {
  return (followupsBlock ?? "")
    .split("\n")
    .some(
      (l) =>
        l.includes("NOT refreshed") ||
        (/^\s*FAIL\b/.test(l) && l.includes("flow install")),
    );
}

/**
 * `MANUAL ACTION:` — `after merge:` lists the verified `After merge:` steps
 * (prefix stripped; handed back once the merged code is installed), with a
 * leading "run flow install --upgrade first" line when `installStale`.
 * `whenever:` is the follow-ups block with its own header line stripped
 * (that block already carries its own "LOCAL FOLLOW-UPS..." framing).
 * Omit-when-empty at both the sub-bucket and whole-section level.
 */
export function buildManualAction(
  afterMergeItems: string[],
  followupsBlock: string | undefined,
  opts: { installStale?: boolean; githubMergeNote?: boolean } = {},
): string[] {
  const afterMerge = afterMergeItems
    .map((i) => stripBullet(i.trim()).replace(/^After merge: /, ""))
    .filter((i) => i.length > 0);
  const whenever = (followupsBlock ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    // Drop the header row ("LOCAL FOLLOW-UPS..." / "LOCAL FOLLOW-UPS
    // (deferred...)...") — this section owns its own "whenever:" label.
    .filter((l) => !l.startsWith("LOCAL FOLLOW-UPS"))
    // The block's own bullets/checkboxes are re-bulleted by pushManualBucket;
    // strip them so a follow-up never renders as `- - [ ] …`.
    .map((l) => stripBullet(l).replace(/\s{2,}/g, " "));
  if (afterMerge.length === 0 && whenever.length === 0) return [];
  const lines = ["MANUAL ACTION:"];
  if (opts.installStale && afterMerge.length > 0)
    lines.push(`  ${STALE_INSTALL_LINE}`);
  pushManualBucket(lines, "after merge", afterMerge);
  if (opts.githubMergeNote && afterMerge.length > 0)
    lines.push(GITHUB_MERGE_LINE);
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
