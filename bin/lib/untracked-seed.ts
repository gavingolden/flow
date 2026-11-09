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
  for (const a of Array.isArray(antiPatterns) ? antiPatterns : []) {
    if (!isRec(a)) continue;
    const pattern = str(a.pattern);
    if (!pattern) continue;
    const why = str(a.why_not_fixed).trim();
    const hit = residue.get(`${str(a.location)}\0${pattern}`);
    if (hit) {
      const reason = why || "no reason given";
      out.push({
        title:
          hit.adjacency === "blocked"
            ? `${pattern} — blocked this PR's fix (${str(hit.blockedFindingId)}), left unfixed: ${reason}`
            : `${pattern} — flagged fixable in this PR but left unfixed: ${reason}`,
      });
    } else if (a.introduced_by_this_pr === false) {
      out.push({ title: why ? `${pattern} — ${why}` : pattern });
    }
  }
  return out;
}
