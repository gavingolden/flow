/**
 * New-file anti-pattern audit: a pure check consumed by `/flow-pr-review`'s
 * Step 9a (documented in `skills/pipeline/flow-pr-review/SKILL.md`).
 *
 * An `anti_patterns_found` entry is meant for a pre-existing pattern in
 * surrounding code. A file the PR newly created has no surrounding code that
 * predates the PR, so a pattern whose `location` points at an added file is
 * suspect — it should have been fixed in-commit, not noted. This function
 * flags those entries so the wrapper can surface them as a warning; the I/O
 * (collecting the added-files list) lives at the call site, keeping this
 * logic hermetically testable.
 */

/** Minimal structural shape this audit needs — accepts both
 * `CoderAntiPattern[]` and `FixApplierAntiPattern[]`. */
export type AntiPatternLocation = {
  location: string;
};

/** Strip a trailing `:line` or `:line:col` suffix, keeping the path. A bare
 * path with no suffix is returned unchanged. */
function stripLineSuffix(location: string): string {
  const colon = location.indexOf(":");
  return colon === -1 ? location : location.slice(0, colon);
}

export function auditNewFileAntiPatterns<T extends AntiPatternLocation>(
  antiPatterns: T[],
  addedFiles: string[],
): T[] {
  const added = new Set(addedFiles);
  return antiPatterns.filter((entry) =>
    added.has(stripLineSuffix(entry.location)),
  );
}
