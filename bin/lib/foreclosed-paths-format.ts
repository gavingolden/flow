/**
 * Shared formatter for the `## Foreclosed Paths` / `FORECLOSED PATHS`
 * surfaces. One core flattens the four review-artifact arrays
 * (`rejected_alternatives[]` + `anti_patterns_found[]` from the fix-applier
 * and the consolidator) into an ordered, normalized entry list. Two thin
 * wrappers — `formatMarkdown` (PR body) and `formatPlainText` (terminal
 * snapshot) — derive from that same core so the two surfaces cannot drift.
 *
 * The two surfaces differ ONLY in output mode: the entry set and its order
 * are identical. A genuinely-broken fix-applier artifact (non-JSON,
 * non-object, or a missing/wrong-typed required top-level key) degrades to an
 * `(unreadable)` marker for that source rather than throwing; a partially-
 * broken one renders its per-entry-valid entries and appends a trailing
 * `(N unreadable)` residual marker for the dropped off-shape entries; an
 * absent/empty artifact contributes nothing.
 */

import { collectFixApplierTolerant } from "./fix-applier-tolerant";
import {
  normalizeParsedFindings,
  validateConsolidatorResult,
} from "./agent-finding-schema";

export const FORECLOSED_HEADING = "## Foreclosed Paths";

export type Source = "fix-applier" | "consolidator";
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
 * fix-applier rejected-alternatives, fix-applier anti-patterns, consolidator
 * rejected-alternatives, consolidator anti-patterns. A present-but-invalid
 * artifact contributes a single `unreadable` entry for its source.
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

/** GitHub-markdown lines for the PR-body `## Foreclosed Paths` section. */
export function formatMarkdown(inputs: {
  fixApplierRaw: string;
  consolidatorRaw: string;
}): string[] {
  const entries = collectForeclosedEntries(inputs);
  const lines: string[] = [FORECLOSED_HEADING, ""];
  for (const e of entries) {
    if (e.skipped) {
      lines.push(`- ${e.source}: (${e.skipped} unreadable)`);
      continue;
    }
    if (e.unreadable) {
      lines.push(`- ${e.source}: (unreadable)`);
      continue;
    }
    if (e.raw !== undefined) {
      lines.push(`- ${neutralizeHeading(e.raw)}`);
      continue;
    }
    if (e.category === "rejected-alternative") {
      const fid = e.finding_id ? ` (\`${e.finding_id}\`)` : "";
      lines.push(
        `- **rejected:** ${neutralizeHeading(e.considered_approach ?? "")}${fid}`,
      );
      lines.push(`  - why: ${neutralizeHeading(e.why_rejected ?? "")}`);
    } else {
      lines.push(
        `- **anti-pattern${annotateIntroduced(e.introduced_by_this_pr)}:** ${neutralizeHeading(e.location ?? "")} — ${neutralizeHeading(e.pattern ?? "")}`,
      );
      lines.push(
        `  - recommendation: ${neutralizeHeading(e.recommendation ?? "")}`,
      );
    }
  }
  return lines;
}

/** Indented plain-text lines for the terminal snapshot (no markdown). */
export function formatPlainText(inputs: {
  fixApplierRaw: string;
  consolidatorRaw: string;
}): string[] {
  const entries = collectForeclosedEntries(inputs);
  const lines: string[] = [];
  for (const e of entries) {
    if (e.skipped) {
      lines.push(`${e.source}: (${e.skipped} unreadable)`);
      continue;
    }
    if (e.unreadable) {
      lines.push(`${e.source}: (unreadable)`);
      continue;
    }
    if (e.raw !== undefined) {
      lines.push(e.raw);
      continue;
    }
    if (e.category === "rejected-alternative") {
      const fid = e.finding_id ? ` (${e.finding_id})` : "";
      lines.push(`rejected: ${e.considered_approach}${fid}`);
      lines.push(`  why: ${e.why_rejected}`);
    } else {
      lines.push(
        `anti-pattern${annotateIntroduced(e.introduced_by_this_pr)}: ${e.location} — ${e.pattern}`,
      );
      lines.push(`  recommendation: ${e.recommendation}`);
    }
  }
  return lines;
}
