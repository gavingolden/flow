/**
 * Pure `pm`-lens row builders for `flow-gate-summary.ts`. Extracted so the
 * helper (already 3.6× the 200-line target before this feature) doesn't
 * grow further — every function here takes already-derived scalars/arrays,
 * never reads files or config.
 */

import { linkUrl, type LinkMode } from "./link";
import type { InstallOnlyName } from "./install-only-names";

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
 * carry a label naming the matched helper, verb or skill.
 */
export function buildNeedsAttention(
  validationItems: string[],
  prUrl: string | undefined,
  mode: LinkMode = "plain",
  needsInstall: NeedsInstallEntry[] = [],
): string[] {
  const items = validationItems
    .map((i) => i.trim())
    .filter((i) => i.length > 0);
  if (items.length === 0) return [];
  const install = needsInstallIndex(needsInstall);
  const lines = ["NEEDS ATTENTION:"];
  for (const item of items) {
    const stripped = stripBullet(item);
    const entry = install.get(stripped);
    const label = entry ? needsInstallLabel(entry) : "";
    const suffix = prUrl ? ` → ${linkUrl(prUrl, mode)}` : "";
    lines.push(`  - ${stripped}${label}${suffix}`);
  }
  return lines;
}

const NEEDS_INSTALL_LABEL =
  " — needs this branch installed: mark it `After merge:` or run it from the branch";

const INSTALL_KINDS: readonly string[] = ["helper", "verb", "skill"];

export type NeedsInstallEntry = {
  item: string;
  name?: string;
  kind?: InstallOnlyName["kind"];
};

/** Parses the gate verdict's `.needsInstall` JSON list; a malformed file degrades to no labels. */
export function parseNeedsInstall(
  raw: string,
  warn: (msg: string) => void = () => {},
): NeedsInstallEntry[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) {
    warn(
      "flow-gate-summary: --needs-install-file is not a JSON list; needs-install labels skipped",
    );
    return [];
  }
  const out: NeedsInstallEntry[] = [];
  for (const el of parsed) {
    if (typeof el === "string") {
      out.push({ item: el });
    } else if (
      el !== null &&
      typeof el === "object" &&
      typeof (el as { item?: unknown }).item === "string"
    ) {
      const { item, name, kind } = el as Record<string, unknown>;
      const entry: NeedsInstallEntry = { item: item as string };
      if (typeof name === "string" && name !== "") entry.name = name;
      if (typeof kind === "string" && INSTALL_KINDS.includes(kind))
        entry.kind = kind as InstallOnlyName["kind"];
      out.push(entry);
    }
  }
  return out;
}

/** Looks a gated item up by its bullet-stripped text. */
export function needsInstallIndex(
  entries: NeedsInstallEntry[],
): Map<string, NeedsInstallEntry> {
  return new Map(entries.map((e) => [stripBullet(e.item.trim()), e]));
}

/** Names the exact runnable form of the matched helper, verb or skill. */
export function needsInstallLabel(
  entry: Pick<NeedsInstallEntry, "name" | "kind">,
): string {
  const { name, kind } = entry;
  if (!name) return NEEDS_INSTALL_LABEL;
  if (kind === "helper")
    return ` — needs this branch installed: run \`bun bin/${name}.ts\` in the worktree, or mark the step \`After merge:\``;
  if (kind === "verb")
    return ` — needs this branch installed: run \`bun bin/flow ${name}\` in the worktree, or mark the step \`After merge:\``;
  if (kind === "skill")
    return ` — needs this branch installed: a session loads \`/${name}\` from the installed skills, so mark the step \`After merge:\``;
  return NEEDS_INSTALL_LABEL;
}
const GITHUB_MERGE_LINE =
  "  if you merge on GitHub instead: run flow install --upgrade, then these";
const STALE_INSTALL_LINE =
  "run flow install --upgrade first — the post-merge install did not refresh";

export const stripBullet = (s: string): string =>
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
