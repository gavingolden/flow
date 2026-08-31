/**
 * Single shared definition of the negative-findings field vocabulary
 * (`rejected_alternatives` / `anti_patterns_found`) that every REVIEW-LENS
 * subagent artifact schema in this repo composes from, instead of holding
 * its own copy. Before this module existed, `bin/lib/agent-finding-schema.ts`
 * (the lens shape) and `bin/lib/fix-applier-schema.ts` (the fix-applier
 * shape) each declared the same two/three-string-field vocabulary
 * independently, which is how PR #724's drift vocabularies (`shape`,
 * `candidate`, `observation`, `reason`, `reason_rejected`, `checked`, and
 * bare strings) slipped past every validator undetected.
 *
 * `bin/lib/coder-schema.ts` (the `/flow-coder` edit-applier shape) is a
 * deliberate exception, NOT composed from this module: it is a different
 * subagent family (edit-applier, not a review lens) with its own contract
 * evolution, and folding it in here is out of scope for this module.
 *
 * This module is the canonical source of truth the six
 * `agents/core/flow-review-*.md` lens definitions cite by path.
 *
 * `RejectedAlternativeBase` / `AntiPatternBase` are the two-field /
 * three-field cores every artifact's negative-findings entries share.
 * Consumers that need extra fields (fix-applier's `finding_id` and
 * `introduced_by_this_pr`) intersect the base with their own extension
 * type rather than repeating the shared fields.
 */

export type RejectedAlternativeBase = {
  considered_approach: string;
  why_rejected: string;
};

export type AntiPatternBase = {
  location: string;
  pattern: string;
  recommendation: string;
};

// A review lens's code-scoped "considered but rejected" note. Deliberately
// two fields only — no `finding_id` (a rejected alternative isn't always
// tied to one specific finding).
export type LensRejectedAlternative = RejectedAlternativeBase;

// A review lens's code-scoped off-pattern observation. THREE string fields
// only — deliberately drops the Fix-Applier artifact's
// `introduced_by_this_pr` boolean (fix-applier-schema.ts's
// `validateAntiPatternEntry` hard-requires it): a review lens has no
// fix-time provenance context to report it accurately.
export type LensAntiPattern = AntiPatternBase;

export type FixApplierRejectedAlternative = RejectedAlternativeBase & {
  finding_id: string;
};

export type FixApplierAntiPattern = AntiPatternBase & {
  introduced_by_this_pr: boolean;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function isRejectedAlternativeBase(
  v: unknown,
): v is RejectedAlternativeBase {
  if (!isPlainObject(v)) return false;
  return (
    isNonEmptyString(v.considered_approach) && isNonEmptyString(v.why_rejected)
  );
}

export function isAntiPatternBase(v: unknown): v is AntiPatternBase {
  if (!isPlainObject(v)) return false;
  return (
    isNonEmptyString(v.location) &&
    isNonEmptyString(v.pattern) &&
    isNonEmptyString(v.recommendation)
  );
}

/**
 * Field-granular companion to `isRejectedAlternativeBase` /
 * `isAntiPatternBase`. Returns the name of the FIRST field in `fields`
 * that is missing, non-string, or empty on `v`, or `null` when every
 * named field is a non-empty string. `fix-applier-schema.ts`'s
 * `validateRejectedAlternativeEntry` / `validateAntiPatternEntry` emit
 * one error message PER failed field (asserted byte-for-byte in tests),
 * which a bare-boolean base predicate cannot reproduce — this helper
 * lets those validators delegate the shared field checks without losing
 * that per-field granularity.
 */
export function firstMissingStringField(
  v: unknown,
  fields: readonly string[],
): string | null {
  if (!isPlainObject(v)) return fields[0] ?? null;
  for (const field of fields) {
    if (!isNonEmptyString(v[field])) return field;
  }
  return null;
}

type AliasRule = {
  source: string;
  target: string;
  guard?: (v: Record<string, unknown>) => boolean;
};

// Nominal alias tables recovering the PR-#724 drift vocabularies. Applied
// in this order; a target field already present (canonical, or filled by
// an earlier alias in the same call) is never clobbered.
const REJECTED_ALIASES: readonly AliasRule[] = [
  { source: "shape", target: "considered_approach" },
  { source: "candidate", target: "considered_approach" },
  { source: "reason", target: "why_rejected" },
  { source: "reason_rejected", target: "why_rejected" },
  {
    source: "checked",
    target: "considered_approach",
    // Only apply `checked` when `candidate` is absent — `candidate` is the
    // higher-fidelity alias for the same target field, and letting both
    // race would make the outcome depend on property order.
    guard: (v) => !("candidate" in v),
  },
];

const ANTI_PATTERN_ALIASES: readonly AliasRule[] = [
  { source: "observation", target: "pattern" },
  { source: "note", target: "recommendation" },
];

const REJECTED_CANONICAL_FIELDS: readonly (keyof RejectedAlternativeBase)[] = [
  "considered_approach",
  "why_rejected",
];
const ANTI_PATTERN_CANONICAL_FIELDS: readonly (keyof AntiPatternBase)[] = [
  "location",
  "pattern",
  "recommendation",
];

function hasAnyKey(
  v: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.some((k) => k in v);
}

function logPositionalMap(
  kind: "rejected" | "anti-pattern",
  observedKeys: readonly string[],
  canonicalKeys: readonly string[],
  auditPrefix?: string,
): void {
  // `auditPrefix` is undefined at this module's own call depth (neither
  // this function nor collectLensNegatives has a lens name in scope); the
  // Task-3 CLI layer (collectLensNegativesFromDir) passes its lens name
  // through collectLensNegatives so the line reads
  // "negative-findings: positional map <lens> <kind> ...". Omitted, the
  // line is byte-identical to before this parameter existed.
  const prefix = auditPrefix ? `${auditPrefix} ` : "";
  // `observedKeys` is agent-authored (arbitrary object keys from an
  // off-contract artifact); a key containing a newline could otherwise
  // forge a second audit line inside this stderr stream. JSON.stringify
  // both key lists so embedded newlines/quotes render escaped, not literal.
  process.stderr.write(
    `negative-findings: positional map ${prefix}${kind} ${JSON.stringify(observedKeys)} -> ${JSON.stringify(canonicalKeys)}\n`,
  );
}

/**
 * Coerce-then-validate pre-pass recovering the six off-contract negative-
 * findings vocabularies PR #724 produced, plus a vocabulary-independent
 * positional fallback so an unnamed shape still survives. Returns a
 * SHALLOW COPY — never mutates `v` — and is idempotent: normalizing an
 * already-canonical entry a second time returns it unchanged, and never
 * clobbers a canonical field already present on the input.
 *
 * Two recovery passes, in order:
 *
 * 1. Nominal aliases (`REJECTED_ALIASES` / `ANTI_PATTERN_ALIASES`) — a
 *    named off-contract key maps to its canonical field. Silent: this is
 *    the expected, documented drift shape.
 * 2. Structural fallback — only when NO nominal alias key was present and
 *    no canonical key is present either, an object whose values are ALL
 *    non-empty strings maps POSITIONALLY, in key-insertion order, when its
 *    property count exactly matches the target shape's arity (2 for
 *    `rejected`, 3 for `anti-pattern`). Any other arity is left unmappable.
 *    Every positional map writes one stderr audit line; nominal aliases do
 *    not log — this line carries no lens name (neither this function nor
 *    `collectLensNegatives` has one in scope; the CLI layer that does
 *    prefixes it).
 *
 * A bare non-empty string entry becomes `{considered_approach: <string>,
 * why_rejected: "(not stated by the lens)"}` for `rejected` (a lens that
 * only names what it considered still gives a recoverable record); for
 * `anti-pattern` a bare string is left unmappable — a location cannot be
 * invented.
 */
export function normalizeNegativeEntry(
  v: unknown,
  kind: "rejected" | "anti-pattern",
  auditPrefix?: string,
): unknown {
  if (isNonEmptyString(v)) {
    if (kind === "rejected") {
      return {
        considered_approach: v,
        why_rejected: "(not stated by the lens)",
      };
    }
    return v;
  }
  if (!isPlainObject(v)) return v;

  const out: Record<string, unknown> = { ...v };
  const aliases = kind === "rejected" ? REJECTED_ALIASES : ANTI_PATTERN_ALIASES;
  const canonicalFields =
    kind === "rejected"
      ? REJECTED_CANONICAL_FIELDS
      : ANTI_PATTERN_CANONICAL_FIELDS;

  let nominalAliasMatched = false;
  for (const alias of aliases) {
    if (!(alias.source in v)) continue;
    nominalAliasMatched = true;
    if (alias.guard && !alias.guard(v)) continue;
    if (isNonEmptyString(out[alias.target])) continue; // never clobber
    const value = v[alias.source];
    if (isNonEmptyString(value)) out[alias.target] = value;
  }

  const canonicalPresent = hasAnyKey(v, canonicalFields);
  if (nominalAliasMatched || canonicalPresent) {
    return out;
  }

  // Structural fallback: an unnamed shape whose values are all non-empty
  // strings, mapped positionally when its arity exactly matches.
  const observedKeys = Object.keys(v);
  const allStrings = observedKeys.every((k) => isNonEmptyString(v[k]));
  if (!allStrings) return out;

  if (kind === "rejected" && observedKeys.length === 2) {
    out.considered_approach = v[observedKeys[0]];
    out.why_rejected = v[observedKeys[1]];
    logPositionalMap(
      kind,
      observedKeys,
      REJECTED_CANONICAL_FIELDS,
      auditPrefix,
    );
    return out;
  }
  if (kind === "anti-pattern" && observedKeys.length === 3) {
    out.location = v[observedKeys[0]];
    out.pattern = v[observedKeys[1]];
    out.recommendation = v[observedKeys[2]];
    logPositionalMap(
      kind,
      observedKeys,
      ANTI_PATTERN_CANONICAL_FIELDS,
      auditPrefix,
    );
    return out;
  }

  return out;
}
