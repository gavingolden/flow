/**
 * Shared flow-ownership predicate for a symlink: whether `linkPath`'s
 * resolved target lives under one of `flowRoots`. Extracted verbatim from
 * `setup.ts`'s `removeIfFlowOwnedSymlink` (the raw-OR-realpath ownership
 * check) and its private `isPathUnder` helper, so `plugin-root-audit.ts`
 * can reuse the exact same rule without duplicating it.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** True when `child` is `parent` itself or nested beneath it. */
export function isPathUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * True iff `linkPath` is a symlink whose resolved target lives under one of
 * `flowRoots` (flow-owned by construction). A symlink pointing outside every
 * root — a user's own, or a foreign executable — is not owned. A non-symlink
 * or unreadable path is not owned either.
 *
 * The entire body is wrapped in ONE outer try/catch returning `false` —
 * deliberately not a catch scoped to `readlinkSync` alone. `path.resolve` /
 * `realpathSync` / `path.relative` can throw on a malformed path (e.g. an
 * embedded null byte), and this predicate is consumed by
 * `plugin-root-audit.ts`, whose module contract is MUST NEVER THROW; a
 * readlink-scoped catch would leak that throw into the audit.
 */
export function isFlowOwnedSymlink(
  linkPath: string,
  flowRoots: readonly string[],
): boolean {
  try {
    const link = fs.readlinkSync(linkPath);
    const raw = path.resolve(path.dirname(linkPath), link);
    let resolved = raw;
    try {
      resolved = fs.realpathSync(raw);
    } catch {
      // Dangling link — keep `raw` for the ownership check below.
    }
    return flowRoots.some((root) => {
      const resolvedRoot = path.resolve(root);
      return (
        isPathUnder(resolved, resolvedRoot) || isPathUnder(raw, resolvedRoot)
      );
    });
  } catch {
    return false; // not a symlink / unreadable
  }
}
