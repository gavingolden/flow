/**
 * Selects the fix-applier `anti_patterns_found` entries `/flow-pr-review`
 * Step 13 registers as untracked follow-ups, and titles each with its reason.
 * Seeded: every `introduced_by_this_pr: false` entry, plus every entry the
 * bundle check (`.flow-tmp/bundle-check.json`) still lists as residue.
 */

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function untrackedSeedEntries(
  antiPatterns: unknown,
  bundleCheck: unknown,
): { title: string }[] {
  const residue = new Map<string, Rec>();
  if (isRec(bundleCheck) && Array.isArray(bundleCheck.candidates)) {
    for (const c of bundleCheck.candidates) {
      if (isRec(c)) residue.set(`${str(c.location)}\0${str(c.pattern)}`, c);
    }
  }
  const out: { title: string }[] = [];
  const residueTitle = (hit: Rec, pattern: string, reason: string): string => {
    if (hit.adjacency === "blocked") {
      return `${pattern} — weakened a test this PR's review asked for; left unfixed (${reason})`;
    }
    const j = str(hit.justification);
    return j === "missing" || j === "out-of-scope"
      ? `${pattern} — flagged fixable in this PR but left unfixed: ${reason}`
      : `${pattern} — ${reason}`;
  };
  for (const a of Array.isArray(antiPatterns) ? antiPatterns : []) {
    if (!isRec(a)) continue;
    const pattern = str(a.pattern);
    if (!pattern) continue;
    const why = str(a.why_not_fixed).trim();
    const key = `${str(a.location)}\0${pattern}`;
    const hit = residue.get(key);
    if (hit) {
      residue.delete(key);
      out.push({ title: residueTitle(hit, pattern, why || "no reason given") });
    } else if (a.introduced_by_this_pr === false) {
      out.push({ title: why ? `${pattern} — ${why}` : pattern });
    }
  }
  for (const hit of residue.values()) {
    const pattern = str(hit.pattern);
    if (!pattern) continue;
    out.push({
      title: `${pattern} — fixed here, but the weakened test was not re-strengthened`,
    });
  }
  return out;
}
