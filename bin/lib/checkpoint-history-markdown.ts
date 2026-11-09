/**
 * Pure markdown extraction helpers for the history renderer: pull a section
 * body out of a plan, design or PR document by heading title. A missing
 * section yields `null` so callers render `none` rather than guess.
 */

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

function normTitle(t: string): string {
  return t.replace(/[*_`]/g, "").trim().toLowerCase();
}

/** Lines under the first heading titled `title` (any level), up to the next heading of the same or higher level. */
export function sectionLines(
  doc: string | null,
  title: string,
): string[] | null {
  if (!doc) return null;
  const want = normTitle(title);
  const lines = doc.split(/\r?\n/);
  let level = 0;
  let fenced = false;
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = fenced ? null : HEADING.exec(line);
    if (m) {
      if (inside && m[1].length <= level) break;
      if (!inside && normTitle(m[2]) === want) {
        inside = true;
        level = m[1].length;
        continue;
      }
    }
    if (inside) out.push(line);
  }
  if (!inside) return null;
  while (out.length > 0 && out[0].trim() === "") out.shift();
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out.length > 0 ? out : null;
}

/** The `**Goal:**` line of a plan or design document. */
export function goalLine(doc: string | null): string | null {
  if (!doc) return null;
  const m = /^\*\*Goal:\*\*\s*(.+)$/m.exec(doc);
  return m ? m[1].trim() : null;
}

const VERDICT_LINE = /^\s*[-*]\s+\**Verdict:\**\s*\S/;

export function verdictLines(lines: string[] | null): string[] {
  return (lines ?? []).filter((l) => VERDICT_LINE.test(l)).map((l) => l.trim());
}

/** First non-blank line of a section. */
export function firstLine(lines: string[] | null): string | null {
  const l = (lines ?? []).find((x) => x.trim() !== "");
  return l ? l.trim() : null;
}

/** `### Task N: title` headings of a plan's task breakdown. */
export function taskTitles(doc: string | null): string[] {
  if (!doc) return [];
  const out: string[] = [];
  for (const line of doc.split(/\r?\n/)) {
    const m = /^###\s+(Task\s+\d+\S*:.*)$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/** Unticked `- [ ]` candidates under `# Candidate follow-up issues`. */
export function untickedCandidates(doc: string | null): string[] {
  const lines = sectionLines(doc, "Candidate follow-up issues") ?? [];
  return lines.filter((l) => /^\s*-\s+\[ \]/.test(l)).map((l) => l.trim());
}
