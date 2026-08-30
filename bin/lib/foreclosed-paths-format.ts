/**
 * Shared formatter for the `## Foreclosed Paths` / `FORECLOSED PATHS`
 * surfaces. One core flattens THREE review-artifact sources —
 * `rejected_alternatives[]` + `anti_patterns_found[]` from the fix-applier,
 * the per-lens pass-through (`lens_rejected_alternatives[]` +
 * `lens_anti_patterns_found[]` + `lens_negatives_missing[]`, sourced from
 * the same consolidator artifact), and the consolidator's own
 * process-scoped `rejected_alternatives[]` / `anti_patterns_found[]` —
 * into an ordered, normalized entry list. Two thin wrappers —
 * `formatMarkdown` (PR body) and `formatPlainText` (terminal snapshot) —
 * derive from that same core so the two surfaces cannot drift.
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

import { collectFixApplierTolerant } from "./fix-applier-tolerant";
import {
  normalizeParsedFindings,
  validateConsolidatorResult,
} from "./agent-finding-schema";

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
};

function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Flatten both artifacts into an ordered entry list. Order is stable:
 * fix-applier rejected-alternatives, fix-applier anti-patterns, LENS
 * rejected-alternatives, LENS anti-patterns, lens-missing marker,
 * consolidator rejected-alternatives, consolidator anti-patterns. A
 * present-but-invalid artifact contributes a single `unreadable` entry for
 * its source (a broken consolidator artifact takes the lens entries down
 * with it, since they live on that same artifact).
 */
export function collectForeclosedEntries(inputs: {
  fixApplierRaw: string;
  consolidatorRaw: string;
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
      for (const r of v.value.lens_rejected_alternatives ?? []) {
        entries.push({
          source: "lens",
          category: "rejected-alternative",
          considered_approach: r.considered_approach,
          why_rejected: r.why_rejected,
          lens: r.lens,
        });
      }
      for (const a of v.value.lens_anti_patterns_found ?? []) {
        entries.push({
          source: "lens",
          category: "anti-pattern",
          location: a.location,
          pattern: a.pattern,
          recommendation: a.recommendation,
          lens: a.lens,
        });
      }
      const missing = v.value.lens_negatives_missing ?? [];
      if (missing.length > 0) {
        entries.push({
          source: "lens",
          category: "anti-pattern",
          missing_lenses: missing,
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
    if (e.unreadable || e.skipped || e.missing_lenses) continue;
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
// — the terminal plain-text surface (`formatPlainText`) has no GitHub body
// constraint and stays uncapped.
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
}): string[] {
  const entries = collectForeclosedEntries(inputs);
  const summary = summarizeEntries(entries);
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
  return [
    FORECLOSED_HEADING,
    "",
    `<details><summary>${summary.rejected} rejected alternatives, ${summary.antiPatterns} anti-patterns, ${summary.notes} reviewer notes</summary>`,
    "",
    ...cappedBullets,
    "",
    "</details>",
  ];
}

/** Indented plain-text lines for a given entry set (no markdown). */
export function formatPlainTextEntries(entries: ForeclosedEntry[]): string[] {
  const lines: string[] = [];
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
}): string[] {
  return formatPlainTextEntries(collectForeclosedEntries(inputs));
}
