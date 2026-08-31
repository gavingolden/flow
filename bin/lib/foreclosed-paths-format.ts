/**
 * Shared formatter for the `## Foreclosed Paths` / `FORECLOSED PATHS`
 * surfaces. One core flattens THREE review-artifact sources —
 * `rejected_alternatives[]` + `anti_patterns_found[]` from the fix-applier,
 * the per-lens pass-through (`lens_rejected_alternatives[]` +
 * `lens_anti_patterns_found[]` + `lens_negatives_missing[]`, sourced from
 * the same consolidator artifact), and the consolidator's own
 * process-scoped `rejected_alternatives[]` / `anti_patterns_found[]` —
 * into an ordered, normalized entry list. Three surfaces derive from that
 * same core — `formatMarkdown` (PR body), `formatPlainText` (terminal
 * snapshot), and `formatPlainTextEntries` over a caller-filtered entry
 * subset (the PR-comment DECISIONS section) — so they cannot drift.
 *
 * The two surfaces differ ONLY in output mode: the entry set and its order
 * are identical. A genuinely-broken fix-applier or consolidator artifact
 * (non-JSON, non-object, or a missing/wrong-typed required top-level key)
 * degrades to an `(unreadable)` marker for that WHOLE source rather than
 * throwing (a broken consolidator artifact takes the lens entries down with
 * it, since they are pass-through keys ON that same artifact); a partially-
 * broken one renders its per-entry-valid entries and appends a trailing
 * `(N unreadable)` residual marker for the dropped off-shape entries; an
 * absent/empty artifact — or an absent optional lens key on an otherwise-
 * valid consolidator artifact — contributes nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import { collectFixApplierTolerant } from "./fix-applier-tolerant";
import {
  ALL_LENS_NAMES,
  collectLensNegativesFromDirSync,
  normalizeParsedFindings,
  validateConsolidatorResult,
} from "./agent-finding-schema";
import {
  isAntiPatternBase,
  isRejectedAlternativeBase,
  normalizeNegativeEntry,
} from "./negative-findings-schema";

export const FORECLOSED_HEADING = "## Foreclosed Paths";

export type Source = "fix-applier" | "lens" | "consolidator";
export type Category = "rejected-alternative" | "anti-pattern";

export type ForeclosedEntry = {
  source: Source;
  category: Category;
  /** Pre-rendered prose lines for this entry (mode-agnostic content). */
  considered_approach?: string;
  why_rejected?: string;
  finding_id?: string;
  location?: string;
  pattern?: string;
  recommendation?: string;
  introduced_by_this_pr?: boolean;
  /** Set on a `source: "lens"` entry to the tagging lens name (e.g. "security", "gemini"). */
  lens?: string;
  /** For consolidator string[] entries: the raw string. */
  raw?: string;
  /** Set when a source artifact was present but shape-invalid. */
  unreadable?: boolean;
  /**
   * Residual marker: when > 0, some per-entry-invalid entries from this source
   * were dropped while valid ones still rendered. Surfaced as `(N unreadable)`
   * so the partial degradation is not silent.
   */
  skipped?: number;
  /**
   * Set on the lens-missing marker entry to the list of lens names whose
   * per-agent envelope reported an "absent" negatives state. Excluded from
   * every count, like `unreadable`/`skipped`.
   */
  missing_lenses?: string[];
  /**
   * Set on a `source: "lens"` entry that survived neither the nominal
   * aliases nor the positional fallback in `normalizeNegativeEntry` — the
   * compact JSON of the original, unmappable entry. Deliberately a
   * SEPARATE field from `raw` (the consolidator's own process-scoped
   * string[] entries): `raw` renders as `- consolidation: ...` and counts
   * as a reviewer note in `summarizeEntries`, which would mis-attribute
   * and mis-count a lens entry. Excluded from every count, like
   * `unreadable`/`skipped`/`missing_lenses`.
   */
  rawEntry?: string;
};

function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

type RawLensEntry = { lens: string; raw: string };

// Per-bullet clamp on `rawEntry` (the JSON.stringify of an arbitrary,
// agent-authored object that survived neither the nominal-alias nor the
// positional-fallback normalizer). Applied at construction — the earliest
// point a single oversized raw entry becomes reachable — so ONE huge entry
// can never alone blow the section past `MARKDOWN_BULLET_CHAR_CAP` and
// silently 422 `gh pr edit` while `capBullets` has nothing to cut at a `- `
// boundary inside a single bullet.
const RAW_ENTRY_CHAR_CAP = 2_000;

function clampRawEntry(raw: string): string {
  if (raw.length <= RAW_ENTRY_CHAR_CAP) return raw;
  return `${raw.slice(0, RAW_ENTRY_CHAR_CAP)}… (truncated, ${raw.length} chars)`;
}

/**
 * Disk-only companion to `collectLensNegativesFromDirSync`: scans the same
 * `agent-output-<lens>.json` files but, instead of discarding an entry that
 * survives neither the nominal aliases nor the positional fallback, keeps
 * its compact JSON so the caller can render it attributed rather than
 * silently dropping it. Only reached from the disk-fallback path below —
 * `artifactDir` is ALWAYS explicitly caller-supplied, never a cwd-relative
 * implicit read.
 */
function scanDiskForRawLensEntries(artifactDir: string): {
  rawRejected: RawLensEntry[];
  rawAntiPatterns: RawLensEntry[];
} {
  const rawRejected: RawLensEntry[] = [];
  const rawAntiPatterns: RawLensEntry[] = [];
  for (const lens of ALL_LENS_NAMES) {
    const filePath = `${artifactDir}/agent-output-${lens}.json`;
    if (!existsSync(filePath)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.rejected_alternatives)) {
      for (const entry of obj.rejected_alternatives) {
        if (
          !isRejectedAlternativeBase(normalizeNegativeEntry(entry, "rejected"))
        ) {
          rawRejected.push({ lens, raw: JSON.stringify(entry) });
        }
      }
    }
    if (Array.isArray(obj.anti_patterns_found)) {
      for (const entry of obj.anti_patterns_found) {
        if (!isAntiPatternBase(normalizeNegativeEntry(entry, "anti-pattern"))) {
          rawAntiPatterns.push({ lens, raw: JSON.stringify(entry) });
        }
      }
    }
  }
  return { rawRejected, rawAntiPatterns };
}

/**
 * Flatten both artifacts into an ordered entry list. Order is stable:
 * fix-applier rejected-alternatives, fix-applier anti-patterns, LENS
 * rejected-alternatives, LENS anti-patterns, lens-missing marker,
 * consolidator rejected-alternatives, consolidator anti-patterns. A
 * present-but-invalid artifact contributes a single `unreadable` entry for
 * its source (a broken consolidator artifact takes the lens entries down
 * with it, since they live on that same artifact).
 *
 * `artifactDir` is OPTIONAL: when the consolidator artifact yields NO lens
 * negatives (the three `lens_*` keys absent, OR all three present but
 * empty) and `artifactDir` is supplied and its `agent-output-<lens>.json`
 * files DO yield entries, this falls back to reading those files directly
 * — disk-yields-entries is the discriminator that keeps a genuinely-quiet
 * lens set from being overridden. One stderr line records that the
 * fallback fired.
 */
export function collectForeclosedEntries(inputs: {
  fixApplierRaw: string;
  consolidatorRaw: string;
  artifactDir?: string;
}): ForeclosedEntry[] {
  const entries: ForeclosedEntry[] = [];

  if (inputs.fixApplierRaw.trim()) {
    const parsed = parseJson(inputs.fixApplierRaw);
    const v = parsed === undefined ? null : collectFixApplierTolerant(parsed);
    if (!v) {
      // Genuinely-broken artifact (non-JSON/non-object/missing top-level key):
      // degrade the whole source to a single (unreadable) marker, as before.
      entries.push({
        source: "fix-applier",
        category: "rejected-alternative",
        unreadable: true,
      });
    } else {
      for (const r of v.rejected_alternatives) {
        entries.push({
          source: "fix-applier",
          category: "rejected-alternative",
          considered_approach: r.considered_approach,
          why_rejected: r.why_rejected,
          finding_id: r.finding_id,
        });
      }
      for (const a of v.anti_patterns_found) {
        entries.push({
          source: "fix-applier",
          category: "anti-pattern",
          location: a.location,
          pattern: a.pattern,
          recommendation: a.recommendation,
          introduced_by_this_pr: a.introduced_by_this_pr,
        });
      }
      if (v.skipped > 0) {
        entries.push({
          source: "fix-applier",
          category: "anti-pattern",
          skipped: v.skipped,
        });
      }
    }
  }

  if (inputs.consolidatorRaw.trim()) {
    const parsed = parseJson(inputs.consolidatorRaw);
    const v =
      parsed === undefined
        ? undefined
        : validateConsolidatorResult(normalizeParsedFindings(parsed));
    if (!v || !v.ok) {
      entries.push({
        source: "consolidator",
        category: "rejected-alternative",
        unreadable: true,
      });
    } else {
      // LENS pass-through, sourced from the SAME consolidator artifact. All
      // three keys are OPTIONAL on ConsolidatorResult; an absent key
      // defaults to [] here and contributes nothing to the entry list.
      let lensRejected = v.value.lens_rejected_alternatives ?? [];
      let lensAntiPatterns = v.value.lens_anti_patterns_found ?? [];
      let lensMissing = v.value.lens_negatives_missing ?? [];
      let rawRejected: RawLensEntry[] = [];
      let rawAntiPatterns: RawLensEntry[] = [];

      const artifactHasNoLensNegatives =
        lensRejected.length === 0 && lensAntiPatterns.length === 0;
      if (artifactHasNoLensNegatives && inputs.artifactDir) {
        const disk = collectLensNegativesFromDirSync(inputs.artifactDir);
        const diskRaw = scanDiskForRawLensEntries(inputs.artifactDir);
        // "Disk yields entries" counts BOTH normalizer-valid entries and
        // raw/unmappable ones — an all-unmappable lens file is exactly the
        // case the raw-entry rendering below exists to surface, so it must
        // still trip the fallback rather than being silently skipped.
        const diskYieldsEntries =
          disk.lens_rejected_alternatives.length > 0 ||
          disk.lens_anti_patterns_found.length > 0 ||
          diskRaw.rawRejected.length > 0 ||
          diskRaw.rawAntiPatterns.length > 0;
        if (diskYieldsEntries) {
          process.stderr.write(
            `foreclosed-paths: disk fallback fired for artifactDir=${inputs.artifactDir}\n`,
          );
          lensRejected = disk.lens_rejected_alternatives;
          lensAntiPatterns = disk.lens_anti_patterns_found;
          lensMissing = disk.lens_negatives_missing;
          rawRejected = diskRaw.rawRejected;
          rawAntiPatterns = diskRaw.rawAntiPatterns;
        }
      }

      for (const r of lensRejected) {
        entries.push({
          source: "lens",
          category: "rejected-alternative",
          considered_approach: r.considered_approach,
          why_rejected: r.why_rejected,
          lens: r.lens,
        });
      }
      for (const raw of rawRejected) {
        entries.push({
          source: "lens",
          category: "rejected-alternative",
          lens: raw.lens,
          rawEntry: clampRawEntry(raw.raw),
        });
      }
      for (const a of lensAntiPatterns) {
        entries.push({
          source: "lens",
          category: "anti-pattern",
          location: a.location,
          pattern: a.pattern,
          recommendation: a.recommendation,
          lens: a.lens,
        });
      }
      for (const raw of rawAntiPatterns) {
        entries.push({
          source: "lens",
          category: "anti-pattern",
          lens: raw.lens,
          rawEntry: clampRawEntry(raw.raw),
        });
      }
      if (lensMissing.length > 0) {
        entries.push({
          source: "lens",
          category: "anti-pattern",
          missing_lenses: lensMissing,
        });
      }

      for (const s of v.value.rejected_alternatives) {
        entries.push({
          source: "consolidator",
          category: "rejected-alternative",
          raw: s,
        });
      }
      for (const s of v.value.anti_patterns_found) {
        entries.push({
          source: "consolidator",
          category: "anti-pattern",
          raw: s,
        });
      }
    }
  }

  return entries;
}

/** True when the formatter has nothing to surface. */
export function isEmpty(entries: ForeclosedEntry[]): boolean {
  return entries.length === 0;
}

export type ForeclosedSummary = {
  rejected: number;
  antiPatterns: number;
  notes: number;
};

/**
 * Counts for the `<details><summary>N rejected alternatives, M
 * anti-patterns, K reviewer notes</summary>` header. `notes` = consolidator
 * string[] entries (`raw !== undefined`) — the free-form reviewer bullets
 * that don't decompose into the structured rejected/anti-pattern shape.
 * `unreadable`/`skipped` residual markers are excluded from every count
 * (they are not findings) but still render as bullets inside the wrapper.
 */
export function summarizeEntries(
  entries: ForeclosedEntry[],
): ForeclosedSummary {
  let rejected = 0;
  let antiPatterns = 0;
  let notes = 0;
  for (const e of entries) {
    if (
      e.unreadable ||
      e.skipped ||
      e.missing_lenses ||
      e.rawEntry !== undefined
    )
      continue;
    if (e.raw !== undefined) {
      notes++;
    } else if (e.category === "rejected-alternative") {
      rejected++;
    } else {
      antiPatterns++;
    }
  }
  return { rejected, antiPatterns, notes };
}

/**
 * True when at least one entry carries `missing_lenses` AND zero entries
 * have `source: "lens"` with a populated `considered_approach`, `pattern`,
 * OR `rawEntry` — a genuine total drop: every lens that reported anything
 * came up empty. A raw/unmappable bullet is NOT a total drop; it is a
 * (visible, attributed) entry.
 */
export function isTotalLensDrop(entries: ForeclosedEntry[]): boolean {
  const hasMissing = entries.some((e) => e.missing_lenses !== undefined);
  if (!hasMissing) return false;
  const hasLiveLensEntry = entries.some(
    (e) =>
      e.source === "lens" &&
      ((e.considered_approach !== undefined && e.considered_approach !== "") ||
        (e.pattern !== undefined && e.pattern !== "") ||
        e.rawEntry !== undefined),
  );
  return !hasLiveLensEntry;
}

/**
 * Unprefixed warning body lines (no `[!WARNING]`/`>` markdown decoration) —
 * the single source both `formatMarkdown` and `formatPlainTextEntries`
 * render from, so they cannot drift (the module's own stated invariant
 * above). Returns `null` when `isTotalLensDrop` is false — nothing to warn
 * about. Never counted by `summarizeEntries`; it is not a finding.
 */
function totalLensDropWarningLines(
  entries: ForeclosedEntry[],
): string[] | null {
  if (!isTotalLensDrop(entries)) return null;
  const names = new Set<string>();
  for (const e of entries) {
    if (e.missing_lenses) for (const name of e.missing_lenses) names.add(name);
  }
  const sortedNames = Array.from(names).sort();
  return [
    "[!WARNING]",
    `Lens negative findings: 0 entries reached this report; ${sortedNames.length} lens(es) unreadable or absent (${sortedNames.join(", ")}). See bin/lib/negative-findings-schema.ts for the canonical entry shape.`,
  ];
}

/**
 * Neutralize markdown heading markers in a free-form string so they can never
 * be misread as a section boundary by the idempotent upsert's `^## ` re-parse.
 * A `#`-run is escaped with a backslash. The match anchors at the start of the
 * string OR after any embedded newline — a multi-line prose field with an
 * interior `\n## ` line would otherwise survive a leading-only anchor and break
 * `upsertPrBodySection`'s splice on the next upsert. Escaping keeps the text
 * readable while breaking the `^## ` anchor.
 */
function neutralizeHeading(s: string): string {
  return s.replace(/(^|\n)(\s*)(#+)(\s)/g, "$1$2\\$3$4");
}

function annotateIntroduced(introduced: boolean | undefined): string {
  if (introduced === undefined) return "";
  return introduced ? " (new)" : " (pre-existing)";
}

// Tag a `source: "lens"` entry with its tagging lens name; empty for every
// other source (fix-applier keeps its untagged rendering, consolidator
// string entries never reach this helper).
function lensTag(e: ForeclosedEntry): string {
  return e.lens ? ` (lens: ${neutralizeHeading(e.lens)})` : "";
}

// Mechanical cap on this section's markdown contribution, mirroring the
// `flow-pr-diff` truncation-marker precedent and `flow-gate-summary`'s
// `clampTldr`: GitHub's PR-body limit is 65,536 chars and this section is
// only one of several `upsertPrBodySection` writes onto that same body, so
// an uncapped section can push a `gh pr edit` call past the limit — reported
// as a plain 422 by the caller, not escalated, so the section silently fails
// to land on exactly the PRs where it's most valuable (lots of findings).
// Bullet-boundary truncation only (never mid-bullet), markdown surface only
// — the terminal snapshot surface (`formatPlainText`) stays uncapped. The
// PR-comment DECISIONS sub-part (`formatPlainTextEntries` over a
// caller-filtered subset) also reaches a GitHub body via `buildCommentBody`,
// but is deliberately left uncapped too, matching the sibling `rejected:`
// sub-part; a single body-level clamp covering all three channels is
// tracked separately rather than added here (see the filed follow-up issue).
export const MARKDOWN_BULLET_CHAR_CAP = 20_000;

/**
 * Head-truncate `bullets` at a top-level `- ` boundary (never mid-entry —
 * a "why:"/"recommendation:" continuation line always stays with its
 * parent bullet) so the joined markdown stays under
 * `MARKDOWN_BULLET_CHAR_CAP` chars. A no-op when already under the cap.
 */
function capBullets(bullets: string[]): string[] {
  const joined = bullets.join("\n");
  if (joined.length <= MARKDOWN_BULLET_CHAR_CAP) return bullets;
  let charCount = 0;
  let cutIndex = bullets.length;
  for (let i = 0; i < bullets.length; i++) {
    if (bullets[i]!.startsWith("- ") && charCount > MARKDOWN_BULLET_CHAR_CAP) {
      cutIndex = i;
      break;
    }
    charCount += bullets[i]!.length + 1;
  }
  const kept = bullets.slice(0, cutIndex);
  const droppedEntries = bullets
    .slice(cutIndex)
    .filter((b) => b.startsWith("- ")).length;
  // Guard against printing "0 more entries truncated" while dropping
  // nothing: the cutIndex loop only advances past `charCount >
  // MARKDOWN_BULLET_CHAR_CAP`, so a run of continuation lines (which never
  // start with `- `) between the cap and the next top-level bullet can
  // leave `droppedEntries` at 0 even though `cutIndex < bullets.length`.
  if (droppedEntries === 0) return bullets;
  return [
    ...kept,
    `- … ${droppedEntries} more entr${droppedEntries === 1 ? "y" : "ies"} truncated (PR-body size cap); see the terminal snapshot for the full list.`,
  ];
}

/**
 * GitHub-markdown lines for the PR-body `## Foreclosed Paths` section.
 * The heading stays a bare `##` line (`upsertPrBodySection` splices on it
 * via `^## ` → the next `^## `); the bullets themselves are collapsed
 * inside a `<details>` wrapper so the section reads as one summary line
 * at the top level of the PR body instead of 14+ reviewer-only bullets.
 */
export function formatMarkdown(inputs: {
  fixApplierRaw: string;
  consolidatorRaw: string;
  artifactDir?: string;
}): string[] {
  const entries = collectForeclosedEntries(inputs);
  const summary = summarizeEntries(entries);
  const warningLines = totalLensDropWarningLines(entries);
  const bullets: string[] = [];
  for (const e of entries) {
    if (e.missing_lenses) {
      bullets.push(
        `- lenses did not populate negative findings: ${neutralizeHeading(e.missing_lenses.join(", "))}`,
      );
      continue;
    }
    if (e.skipped) {
      bullets.push(`- ${e.source}: (${e.skipped} unreadable)`);
      continue;
    }
    if (e.unreadable) {
      bullets.push(`- ${e.source}: (unreadable)`);
      continue;
    }
    if (e.rawEntry !== undefined) {
      const label =
        e.category === "rejected-alternative" ? "rejected" : "anti-pattern";
      bullets.push(
        `- **${label} (lens: ${neutralizeHeading(e.lens ?? "")}, raw):** ${neutralizeHeading(e.rawEntry)}`,
      );
      continue;
    }
    if (e.raw !== undefined) {
      bullets.push(`- consolidation: ${neutralizeHeading(e.raw)}`);
      continue;
    }
    if (e.category === "rejected-alternative") {
      const fid = e.finding_id ? ` (\`${e.finding_id}\`)` : "";
      bullets.push(
        `- **rejected${lensTag(e)}:** ${neutralizeHeading(e.considered_approach ?? "")}${fid}`,
      );
      bullets.push(`  - why: ${neutralizeHeading(e.why_rejected ?? "")}`);
    } else {
      bullets.push(
        `- **anti-pattern${lensTag(e)}${annotateIntroduced(e.introduced_by_this_pr)}:** ${neutralizeHeading(e.location ?? "")} — ${neutralizeHeading(e.pattern ?? "")}`,
      );
      bullets.push(
        `  - recommendation: ${neutralizeHeading(e.recommendation ?? "")}`,
      );
    }
  }
  const cappedBullets = capBullets(bullets);
  const warningBlock = warningLines
    ? [...warningLines.map((l) => `> ${l}`), ""]
    : [];
  return [
    FORECLOSED_HEADING,
    "",
    ...warningBlock,
    `<details><summary>${summary.rejected} rejected alternatives, ${summary.antiPatterns} anti-patterns, ${summary.notes} reviewer notes</summary>`,
    "",
    ...cappedBullets,
    "",
    "</details>",
  ];
}

/**
 * Indented plain-text lines for a given entry set (no markdown). Also the
 * single source of the total-lens-drop warning: `formatPlainText` (below)
 * reaches it via `collectForeclosedEntries`, and `formatMarkdown`'s own
 * warning is the same `totalLensDropWarningLines` text with a `>` prefix
 * — the module's own stated invariant that the two surfaces cannot drift.
 */
export function formatPlainTextEntries(entries: ForeclosedEntry[]): string[] {
  const lines: string[] = [];
  const warningLines = totalLensDropWarningLines(entries);
  if (warningLines) lines.push(...warningLines);
  for (const e of entries) {
    if (e.missing_lenses) {
      lines.push(
        `lenses did not populate negative findings: ${e.missing_lenses.join(", ")}`,
      );
      continue;
    }
    if (e.skipped) {
      lines.push(`${e.source}: (${e.skipped} unreadable)`);
      continue;
    }
    if (e.unreadable) {
      lines.push(`${e.source}: (unreadable)`);
      continue;
    }
    if (e.rawEntry !== undefined) {
      const label =
        e.category === "rejected-alternative" ? "rejected" : "anti-pattern";
      lines.push(`${label} (lens: ${e.lens ?? ""}, raw): ${e.rawEntry}`);
      continue;
    }
    if (e.raw !== undefined) {
      lines.push(`consolidation: ${e.raw}`);
      continue;
    }
    if (e.category === "rejected-alternative") {
      const fid = e.finding_id ? ` (${e.finding_id})` : "";
      lines.push(`rejected${lensTag(e)}: ${e.considered_approach}${fid}`);
      lines.push(`  why: ${e.why_rejected}`);
    } else {
      lines.push(
        `anti-pattern${lensTag(e)}${annotateIntroduced(e.introduced_by_this_pr)}: ${e.location} — ${e.pattern}`,
      );
      lines.push(`  recommendation: ${e.recommendation}`);
    }
  }
  return lines;
}

/** Indented plain-text lines for the terminal snapshot (no markdown). */
export function formatPlainText(inputs: {
  fixApplierRaw: string;
  consolidatorRaw: string;
  artifactDir?: string;
}): string[] {
  return formatPlainTextEntries(collectForeclosedEntries(inputs));
}
