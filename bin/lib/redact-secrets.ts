/**
 * Hand-rolled, pure secret redaction for text that lands in three persisted
 * surfaces: `.flow-tmp/` scratch, `flow-delegate-fanout`'s aggregate JSON,
 * and the supervisor's chat transcript. No runtime dependency — the
 * pattern set is small and the observed content (agy's stderr) is short,
 * so a general-purpose secret scanner would be an over-general
 * abstraction (see plan.md's `## Cut list`).
 *
 * Exclusions are load-bearing: 40-char hex git SHAs and canonical UUIDs
 * appear routinely in agy stderr (paths, trace ids) and masking them would
 * destroy exactly the diagnostic value this field exists to carry.
 */

const BEARER_TOKEN = /\bBearer\s+\S+/gi;
const KEY_ASSIGNMENT = /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi;
// 32+ char opaque runs of base64url-ish characters — the general
// token-shaped catch-all. Excludes 40-char hex SHAs and canonical UUIDs
// via isExcluded below (a 40-char hex string still matches this pattern,
// so the exclusion check happens per-match, not by narrowing the regex).
const OPAQUE_RUN = /[A-Za-z0-9_-]{32,}/g;

const HEX_SHA_40 = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isExcluded(match: string): boolean {
  return HEX_SHA_40.test(match) || UUID.test(match);
}

/**
 * Masks token-shaped substrings with `[REDACTED]`. Pure, never throws.
 * Leaves 40-char hex git SHAs and canonical UUIDs intact (see module
 * docstring).
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text.replace(BEARER_TOKEN, "[REDACTED]");
  out = out.replace(KEY_ASSIGNMENT, (m) => {
    const parts = m.match(/^(.*?[:=]\s*)/);
    if (!parts) return "[REDACTED]";
    return `${parts[1]}[REDACTED]`;
  });
  out = out.replace(OPAQUE_RUN, (m) => (isExcluded(m) ? m : "[REDACTED]"));
  return out;
}
