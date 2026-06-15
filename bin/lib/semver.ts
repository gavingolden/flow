/**
 * Pure semver utilities — no dependencies. Used by the staleness check in
 * `update-check.ts` to compare a remote `package.json` version against the
 * local one. Tolerant by design: anything unparseable compares as "not newer".
 */

export function parseSemver(v: string): [number, number, number] | null {
  const segments = v.replace(/^v/, "").split(".");
  if (segments.length < 3) return null;
  const nums = segments.slice(0, 3).map((s) => Number(s));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return [nums[0], nums[1], nums[2]];
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  // Unparseable on either side ⇒ callers treat as "not newer".
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export function isNewerVersion(candidate: string, base: string): boolean {
  return compareSemver(candidate, base) > 0;
}
