/**
 * Shared flow-ownership predicate for a symlink: whether `linkPath`'s
 * resolved target lives under one of `flowRoots`. Extracted verbatim from
 * `setup.ts`'s `removeIfFlowOwnedSymlink` (the raw-OR-realpath ownership
 * check) and its private `isPathUnder` helper, so consumers can reuse the
 * exact same rule without duplicating it — currently `plugin-root-audit.ts`
 * (the ownership predicate itself). This module also exports the generic
 * `realpathOrSelf` fs helper (no ownership semantics), reused independently
 * by `settings-merge.ts`'s home-containment guard.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** True when `child` is `parent` itself or nested beneath it. */
export function isPathUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** `fs.realpathSync`, returning the input unchanged instead of throwing. */
export function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** `flowSource`/`installRoot` plus their realpath'd forms, for callers
 * checking `isFlowOwnedSymlink` against a caller-supplied ownership pair
 * (e.g. `plugin-root-audit.ts`). `isFlowOwnedSymlink` takes the roots it's
 * given as-is (verbatim from `setup.ts`, no `path.resolve` widening) while
 * always realpath'ing the LINK — and `ensureSymlink` always realpath's a
 * `bin/` entry's source before writing it. On a host where `flowSource`/
 * `installRoot` themselves sit behind a symlink (macOS's `/var` →
 * `/private/var`, which `os.tmpdir()` routes through), a raw-only root would
 * miss flow's own live symlinks. Widening here is a caller-side adjustment,
 * not a second ownership rule — `isFlowOwnedSymlink` stays untouched. */
export function ownershipRoots(
  flowSource: string,
  installRoot: string,
): string[] {
  return [
    flowSource,
    realpathOrSelf(flowSource),
    installRoot,
    realpathOrSelf(installRoot),
  ];
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
    return flowRoots.some(
      (root) => isPathUnder(resolved, root) || isPathUnder(raw, root),
    );
  } catch {
    return false; // not a symlink / unreadable
  }
}
