/**
 * Leaf module: reads the `version` field from a flow source's package.json.
 * Kept dependency-free (only node:fs + node:path) so both `version.ts`'s CLI
 * verb and `update-check.ts` can import it without forming a circular import
 * (version.ts → update-check.ts → version.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Reads the `version` field from `<source>/package.json`. Throws with a
 * caller-actionable message on a missing/unparseable file or absent field —
 * `runVersion` catches and routes to stderr; other consumers (e.g.
 * `flow setup`'s outcome headline) decide their own degradation.
 */
export function readFlowVersion(source: string): string {
  const pkgPath = path.join(source, "package.json");

  let raw: string;
  try {
    raw = fs.readFileSync(pkgPath, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${pkgPath}: ${(err as Error).message}`);
  }

  let version: unknown;
  try {
    version = (JSON.parse(raw) as { version?: unknown }).version;
  } catch (err) {
    throw new Error(`cannot parse ${pkgPath}: ${(err as Error).message}`);
  }

  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${pkgPath} has no 'version' field`);
  }

  return version;
}
