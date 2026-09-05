/**
 * Shared content-hash helper for the `workflows` copy-materialization path
 * (`sources.ts`/`plugin-root.ts` write it, `install-drift.ts`/
 * `plugin-root-audit.ts` read it back to detect a copy whose bytes no
 * longer match its source). One tiny module rather than duplicating
 * `node:crypto` plumbing at each of those four call sites.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";

/** sha256 of a file's bytes, hex-encoded. Returns `undefined` on any read
 * error (missing file, permission) — callers treat that as "unknown", never
 * as a false drift/match signal. */
export function sha256File(filePath: string): string | undefined {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(data).digest("hex");
  } catch {
    return undefined;
  }
}
