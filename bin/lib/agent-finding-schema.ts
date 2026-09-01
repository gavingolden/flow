#!/usr/bin/env bun
/**
 * Schema validators for per-agent review findings and the
 * Consolidator-Validator subagent's output artifact.
 *
 * Two exports:
 *
 * - `validateAgentFindings(parsed)` — validates a single per-agent JSON
 *   output written to `<worktree>/.flow-tmp/agent-output-<lens>.json` by
 *   one of the six review agents (bug-detection, security,
 *   pattern-consistency, performance, supply-chain, test-coverage). The
 *   input must be a JSON object with shape `{findings: Array<Finding>}`
 *   where each finding has the documented shape from
 *   `skills/pipeline/flow-pr-review/references/agent-prompts.md` (`file`,
 *   `line`, optional `end_line`, `label`, `decoration`, `confidence`,
 *   `subject`, `body`).
 *
 * - `validateConsolidatorResult(parsed)` — validates the Consolidator-
 *   Validator subagent's output artifact at
 *   `<worktree>/.flow-tmp/consolidator-result.json`. The input must be a
 *   JSON object with five REQUIRED top-level keys: `consolidated_findings`,
 *   `dropped_by_validation`, `rejected_alternatives`,
 *   `anti_patterns_found`, `summary` — plus three OPTIONAL pass-through
 *   keys carrying the per-lens negative findings the consolidator collects
 *   from the six review agents (and the optional cross-model Gemini lens):
 *   `lens_rejected_alternatives`, `lens_anti_patterns_found`,
 *   `lens_negatives_missing`. An absent optional key is valid; a present
 *   one is validated per-entry.
 *
 * Strict on shape, permissive on string content. Labels and decorations
 * are enumerated per the agent-prompts.md spec; the body string content
 * is not enumerated (it's prose). Cross-field rules are generally not
 * enforced here — that's the prose contract in flow-pr-review/SKILL.md's job
 * — with one deliberate exception now enforced: per conventional-
 * comments.md Rule 2, praise findings may omit `decoration` (an absent
 * key or `null`), while every other label still requires a valid enum
 * decoration. Like the label/decoration coerce-then-validate pre-pass,
 * `normalizeFinding` also recovers an absent `file`/`line` from a leading
 * `<path>:<line>` prefix in `subject` (then `body`), aliases an absent
 * `subject` to a present `title`, and defaults a missing `line` to `1`
 * when `file` is present but no prose location is recoverable.
 *
 * CLI mode: `bun bin/lib/agent-finding-schema.ts --validate <path>` —
 * reads the file, parses JSON, and decides which validator to use based
 * on the JSON shape (presence of `findings` key → agent findings;
 * presence of `consolidated_findings` key → consolidator result). Exits
 * 0 with `{ok: true}` on stdout for shape-valid input; exits 1 with
 * `{ok: false, reason, path}` on stderr for shape-invalid input.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  type LensRejectedAlternative,
  type LensAntiPattern,
  isRejectedAlternativeBase,
  isAntiPatternBase,
  normalizeNegativeEntry,
} from "./negative-findings-schema";

export type Finding = {
  file: string;
  line: number;
  end_line?: number;
  label: string;
  decoration?: string | null;
  confidence: number;
  subject: string;
  body: string;
};

export type AgentFindings = {
  findings: Finding[];
  rejected_alternatives?: LensRejectedAlternative[];
  anti_patterns_found?: LensAntiPattern[];
};

// The lens negative-findings vocabulary (LensRejectedAlternative /
// LensAntiPattern) now lives in bin/lib/negative-findings-schema.ts, the
// single shared definition every artifact schema composes from; imported
// above and re-exported here as TYPES for future consumers.
export type { LensRejectedAlternative, LensAntiPattern };

// Tri-state read of a per-lens negative-findings slot from a parsed
// artifact: the key is absent (or present but not an array), present as an
// empty array, or present as a non-empty array.
export type NegativeSlotState = "populated" | "empty" | "absent";

// A per-lens negative entry once the consolidator tags it with its source
// lens (the six kebab-case review-agent names, or "gemini").
export type LensNegativeEntry<T> = T & { lens: string };

export type DroppedFinding = {
  finding_id: string;
  original_finding: Record<string, unknown>;
  reason: string;
};

export type ConsolidatorResult = {
  consolidated_findings: Record<string, unknown>[];
  dropped_by_validation: DroppedFinding[];
  rejected_alternatives: string[];
  anti_patterns_found: string[];
  summary: string;
  // Pass-through, code-scoped lens negatives. ALL OPTIONAL: the consolidator
  // never authors these itself (it collects/tags them from the per-lens
  // artifacts), so an absent key must stay valid rather than degrading the
  // whole artifact.
  lens_rejected_alternatives?: LensNegativeEntry<LensRejectedAlternative>[];
  lens_anti_patterns_found?: LensNegativeEntry<LensAntiPattern>[];
  lens_negatives_missing?: string[];
};

export type ValidationOk<T> = { ok: true; value: T };
export type ValidationErr = { ok: false; reason: string; path?: string };
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

export const VALID_LABELS: ReadonlySet<string> = new Set([
  "praise",
  "nitpick",
  "suggestion",
  "issue",
  "todo",
  "question",
]);

export const VALID_DECORATIONS: ReadonlySet<string> = new Set([
  "blocking",
  "non-blocking",
  "if-minor",
]);

// Off-enum labels that agents trivially emit instead of a real label: the
// six long-form lens names, the two short forms, and two literal phrases.
// `normalizeFinding` maps any of these to `suggestion` before validation;
// genuinely-unknown labels (e.g. "xyzzy") are left untouched and still
// hard-fail. Not a widening of VALID_LABELS — this is a coerce-then-validate
// pre-pass, never an enum relaxation.
const LENS_NAME_LABELS: ReadonlySet<string> = new Set([
  "bug-detection",
  "security",
  "pattern-consistency",
  "performance",
  "supply-chain",
  "test-coverage",
  "consistency",
  "testing",
  "add-a-test",
  "doc-fix",
]);

// Strip exactly ONE matched leading '(' + trailing ')' pair after trimming,
// so "(blocking)" -> "blocking" but "((blocking))" -> "(blocking)" (still
// fails) and "(critical)" -> "critical" (still fails the enum). One pass only.
function stripOneParenPair(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith("(") && t.endsWith(")")) {
    return t.slice(1, -1);
  }
  return t;
}

// Recover a location from a leading '<path>:<line>' token in a prose string
// (a finding's subject/body) when the structured `file` field is absent. The
// path must look like a path (contain '/' or '.') so a bare 'TODO:42' prose
// lead is not mistaken for a location. One leading token only; `end_line`
// (a '<path>:<start>-<end>' tail) is intentionally not parsed.
function extractLeadingFileLine(
  s: string,
): { file: string; line: number } | null {
  const m = /^([^\s:]+):(\d+)\b/.exec(s.trim());
  if (!m) return null;
  const file = m[1];
  if (!file.includes("/") && !file.includes(".")) return null;
  return { file, line: Number(m[2]) };
}

/**
 * Coerce trivially-fixable label/decoration drift on a single finding-shaped
 * object BEFORE validation. Returns a shallow copy — never mutates the input,
 * so re-running is idempotent. Recovers `file`/`line` from a prose prefix,
 * aliases `title`→`subject`, and defaults a missing `line` to `1` when a
 * `file` is present; label coercion (a lens-name label becomes `suggestion`,
 * preserving praise's decoration-optionality only when the label was
 * already/becomes a real one) then decoration paren-stripping run last. A
 * present field is never clobbered, so real malformation still fails validation.
 */
export function normalizeFinding(f: unknown): unknown {
  if (!isPlainObject(f)) return f;
  const out: Record<string, unknown> = { ...f };
  // why: agents intermittently key the short description as `title` instead of
  // the required `subject`, hard-failing validation and sinking the whole
  // consolidator review. Alias title->subject before validation; never clobber
  // a present subject.
  if (!isNonEmptyString(out.subject) && isNonEmptyString(out.title)) {
    out.subject = out.title;
  }
  // why: a praise/issue finding that puts its location only in prose (e.g.
  // subject 'src/foo.ts:42 — ...') leaves `file` absent and would hard-fail
  // validation, sinking the whole consolidator review. Recover file/line from
  // a leading prefix in subject (then body); never clobber a present field.
  if (!isNonEmptyString(out.file)) {
    const recovered =
      (isString(out.subject) ? extractLeadingFileLine(out.subject) : null) ??
      (isString(out.body) ? extractLeadingFileLine(out.body) : null);
    if (recovered) {
      out.file = recovered.file;
      if (!isNumber(out.line)) out.line = recovered.line;
    }
  }
  // why: the test-coverage agent names a `file` but omits `line`, which the
  // file-absent recovery above never reaches (it only fires when `file` is also
  // missing). Recover `line` from a prose prefix decoupled from the file guard,
  // and default to 1 when no prose location is recoverable but `file` is present
  // — a non-blocking finding's exact line is cosmetic for routing, and 1 is an
  // always-valid 1-indexed sentinel that keeps the review from aborting.
  if (isNonEmptyString(out.file) && !isNumber(out.line)) {
    const recovered =
      (isString(out.subject) ? extractLeadingFileLine(out.subject) : null) ??
      (isString(out.body) ? extractLeadingFileLine(out.body) : null);
    out.line = recovered ? recovered.line : 1;
  }
  if (
    isString(out.label) &&
    !VALID_LABELS.has(out.label) &&
    LENS_NAME_LABELS.has(out.label)
  ) {
    out.label = "suggestion";
  }
  if (isNonEmptyString(out.decoration)) {
    out.decoration = stripOneParenPair(out.decoration);
  }
  return out;
}

// Shape-aware walker: normalize each entry of `findings[]` (per-agent) or
// `consolidated_findings[]` (consolidator). Returns a shallow copy of the
// container with the normalized array; non-array/absent keys pass through.
export function normalizeParsedFindings(parsed: unknown): unknown {
  if (!isPlainObject(parsed)) return parsed;
  const out: Record<string, unknown> = { ...parsed };
  if (Array.isArray(out.consolidated_findings)) {
    out.consolidated_findings = out.consolidated_findings.map(normalizeFinding);
  }
  if (Array.isArray(out.findings)) {
    out.findings = out.findings.map(normalizeFinding);
  }
  return out;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function err(reason: string, path?: string): ValidationErr {
  return { ok: false, reason, path };
}

// Two-string-field checker for `LensRejectedAlternative`, delegated to the
// shared base predicate in negative-findings-schema.ts. Do NOT reach for
// fix-applier-schema.ts's `validateRejectedAlternativeEntry` here — it
// requires a `finding_id` the lens shape deliberately omits.
function isLensRejectedAlternative(v: unknown): v is LensRejectedAlternative {
  return isRejectedAlternativeBase(v);
}

// Three-string-field checker for `LensAntiPattern`, delegated to the shared
// base predicate in negative-findings-schema.ts. Do NOT reach for
// fix-applier-schema.ts's `validateAntiPatternEntry` here — it hard-requires
// an `introduced_by_this_pr` boolean the lens shape deliberately omits, and
// would reject every lens entry.
function isLensAntiPattern(v: unknown): v is LensAntiPattern {
  return isAntiPatternBase(v);
}

/**
 * Tri-state read of the two negative-findings slots on a parsed per-lens
 * artifact. Never throws: a present-but-non-array value (string, number,
 * null, object) classifies as "absent", same as a missing key.
 */
export function classifyLensNegatives(parsed: unknown): {
  rejected_alternatives: NegativeSlotState;
  anti_patterns_found: NegativeSlotState;
} {
  const classify = (v: unknown): NegativeSlotState => {
    if (!Array.isArray(v)) return "absent";
    return v.length === 0 ? "empty" : "populated";
  };
  if (!isPlainObject(parsed)) {
    return { rejected_alternatives: "absent", anti_patterns_found: "absent" };
  }
  return {
    rejected_alternatives: classify(parsed.rejected_alternatives),
    anti_patterns_found: classify(parsed.anti_patterns_found),
  };
}

/**
 * Tolerant collector for a per-lens artifact's two negative-findings arrays,
 * mirroring the shape of `fix-applier-tolerant.ts`'s `collectFixApplierTolerant`
 * / `collectValid` (that helper is module-private, so this copies the shape
 * rather than importing it). Runs each entry through
 * `normalizeNegativeEntry` before its shape check — same coerce-then-
 * validate placement `normalizeFinding` uses above for labels — so a
 * recoverable off-contract shape survives into the pass-through channel.
 * Drops per-entry-unrecoverable entries and counts them in `skipped`;
 * never fabricates or defaults a missing field beyond what the normalizer
 * itself recovers.
 *
 * `lens` is OPTIONAL and purely cosmetic: this call depth has no lens name
 * of its own, but the `--collect-lens-negatives` CLI layer
 * (`collectLensNegativesFromDir`) does, and threads it through so the
 * normalizer's positional-map stderr audit line is prefixed with it.
 * Omitted, behaviour is byte-identical to before this parameter existed.
 */
export function collectLensNegatives(
  parsed: unknown,
  lens?: string,
): {
  rejected_alternatives: LensRejectedAlternative[];
  anti_patterns_found: LensAntiPattern[];
  skipped: number;
} {
  const rejected_alternatives: LensRejectedAlternative[] = [];
  const anti_patterns_found: LensAntiPattern[] = [];
  let skipped = 0;
  if (!isPlainObject(parsed)) {
    return { rejected_alternatives, anti_patterns_found, skipped };
  }
  if (Array.isArray(parsed.rejected_alternatives)) {
    for (const entry of parsed.rejected_alternatives) {
      const normalized = normalizeNegativeEntry(entry, "rejected", lens);
      if (isLensRejectedAlternative(normalized)) {
        rejected_alternatives.push(normalized);
      } else {
        skipped++;
      }
    }
  }
  if (Array.isArray(parsed.anti_patterns_found)) {
    for (const entry of parsed.anti_patterns_found) {
      const normalized = normalizeNegativeEntry(entry, "anti-pattern", lens);
      if (isLensAntiPattern(normalized)) {
        anti_patterns_found.push(normalized);
      } else {
        skipped++;
      }
    }
  }
  return { rejected_alternatives, anti_patterns_found, skipped };
}

function validateFinding(f: unknown, idx: number): ValidationResult<Finding> {
  if (!isPlainObject(f)) {
    return err(`findings[${idx}] must be an object`);
  }
  if (!isNonEmptyString(f.file)) {
    return err(`findings[${idx}].file must be a non-empty string`);
  }
  if (!isNumber(f.line)) {
    return err(`findings[${idx}].line must be a number`);
  }
  if (f.end_line !== undefined && !isNumber(f.end_line)) {
    return err(`findings[${idx}].end_line must be a number when present`);
  }
  if (!isString(f.label)) {
    return err(`findings[${idx}].label must be a string`);
  }
  if (!VALID_LABELS.has(f.label)) {
    return err(
      `findings[${idx}].label must be one of praise|nitpick|suggestion|issue|todo|question (got ${JSON.stringify(f.label)})`,
    );
  }
  if (f.label === "praise") {
    // why: conventional-comments.md Rule 2 — every finding except praise
    // MUST have a decoration; praise may omit it (absent key or null).
    if (f.decoration !== undefined && f.decoration !== null) {
      if (!isString(f.decoration)) {
        return err(`findings[${idx}].decoration must be a string`);
      }
      if (!VALID_DECORATIONS.has(f.decoration)) {
        return err(
          `findings[${idx}].decoration must be one of blocking|non-blocking|if-minor (got ${JSON.stringify(f.decoration)})`,
        );
      }
    }
  } else {
    if (!isString(f.decoration)) {
      return err(`findings[${idx}].decoration must be a string`);
    }
    if (!VALID_DECORATIONS.has(f.decoration)) {
      return err(
        `findings[${idx}].decoration must be one of blocking|non-blocking|if-minor (got ${JSON.stringify(f.decoration)})`,
      );
    }
  }
  if (!isNumber(f.confidence)) {
    return err(`findings[${idx}].confidence must be a number`);
  }
  if (!isString(f.subject)) {
    return err(`findings[${idx}].subject must be a string`);
  }
  if (!isString(f.body)) {
    return err(`findings[${idx}].body must be a string`);
  }
  return { ok: true, value: f as unknown as Finding };
}

export function validateAgentFindings(
  parsed: unknown,
): ValidationResult<AgentFindings> {
  if (!isPlainObject(parsed)) {
    return err("agent-findings artifact must be a JSON object");
  }
  if (!("findings" in parsed)) {
    return err(
      "missing required top-level key 'findings' (per-agent output must be {findings: Array<Finding>})",
    );
  }
  if (!Array.isArray(parsed.findings)) {
    return err("'findings' must be an array");
  }
  for (let i = 0; i < parsed.findings.length; i++) {
    const r = validateFinding(parsed.findings[i], i);
    if (!r.ok) return r;
  }
  return { ok: true, value: parsed as AgentFindings };
}

function validateDroppedFinding(
  d: unknown,
  idx: number,
): ValidationResult<DroppedFinding> {
  if (!isPlainObject(d)) {
    return err(`dropped_by_validation[${idx}] must be an object`);
  }
  if (!isNonEmptyString(d.finding_id)) {
    return err(
      `dropped_by_validation[${idx}].finding_id must be a non-empty string`,
    );
  }
  if (!isPlainObject(d.original_finding)) {
    return err(
      `dropped_by_validation[${idx}].original_finding must be an object`,
    );
  }
  if (!isNonEmptyString(d.reason)) {
    return err(
      `dropped_by_validation[${idx}].reason must be a non-empty string`,
    );
  }
  return { ok: true, value: d as unknown as DroppedFinding };
}

export function validateConsolidatorResult(
  parsed: unknown,
): ValidationResult<ConsolidatorResult> {
  if (!isPlainObject(parsed)) {
    return err("consolidator artifact must be a JSON object");
  }

  for (const key of [
    "consolidated_findings",
    "dropped_by_validation",
    "rejected_alternatives",
    "anti_patterns_found",
    "summary",
  ]) {
    if (!(key in parsed)) {
      return err(
        `missing required top-level key '${key}' (every consolidator artifact field is required; pass [] for empty arrays)`,
      );
    }
  }

  if (!Array.isArray(parsed.consolidated_findings)) {
    return err("'consolidated_findings' must be an array");
  }
  for (let i = 0; i < parsed.consolidated_findings.length; i++) {
    const f = parsed.consolidated_findings[i];
    if (!isPlainObject(f)) {
      return err(`consolidated_findings[${i}] must be an object`);
    }
    // Consolidated findings carry the per-agent finding fields plus
    // extra slots (finding_id, agent_source). Be strict on the
    // baseline shape but permissive on the extras.
    const r = validateFinding(f, i);
    if (!r.ok) {
      return err(
        `consolidated_findings[${i}]: ${r.reason.replace(`findings[${i}]`, `consolidated_findings[${i}]`)}`,
      );
    }
  }

  if (!Array.isArray(parsed.dropped_by_validation)) {
    return err("'dropped_by_validation' must be an array");
  }
  for (let i = 0; i < parsed.dropped_by_validation.length; i++) {
    const r = validateDroppedFinding(parsed.dropped_by_validation[i], i);
    if (!r.ok) return r;
  }

  if (!Array.isArray(parsed.rejected_alternatives)) {
    return err("'rejected_alternatives' must be an array");
  }
  if (!isStringArray(parsed.rejected_alternatives)) {
    return err("'rejected_alternatives' must contain only strings");
  }

  if (!Array.isArray(parsed.anti_patterns_found)) {
    return err("'anti_patterns_found' must be an array");
  }
  if (!isStringArray(parsed.anti_patterns_found)) {
    return err("'anti_patterns_found' must contain only strings");
  }

  if (!isNonEmptyString(parsed.summary)) {
    return err("'summary' must be a non-empty string");
  }

  // The three lens pass-through keys are OPTIONAL: the consolidator never
  // authors them itself, so an absent key is valid. Validate per-entry only
  // when the key is present, so one omission never degrades the artifact.
  if (parsed.lens_rejected_alternatives !== undefined) {
    if (!Array.isArray(parsed.lens_rejected_alternatives)) {
      return err("'lens_rejected_alternatives' must be an array when present");
    }
    for (let i = 0; i < parsed.lens_rejected_alternatives.length; i++) {
      const entry = parsed.lens_rejected_alternatives[i];
      if (
        !isLensRejectedAlternative(entry) ||
        !isNonEmptyString((entry as Record<string, unknown>).lens)
      ) {
        return err(
          `lens_rejected_alternatives[${i}] must be {considered_approach, why_rejected, lens} with all non-empty strings`,
        );
      }
    }
  }

  if (parsed.lens_anti_patterns_found !== undefined) {
    if (!Array.isArray(parsed.lens_anti_patterns_found)) {
      return err("'lens_anti_patterns_found' must be an array when present");
    }
    for (let i = 0; i < parsed.lens_anti_patterns_found.length; i++) {
      const entry = parsed.lens_anti_patterns_found[i];
      if (
        !isLensAntiPattern(entry) ||
        !isNonEmptyString((entry as Record<string, unknown>).lens)
      ) {
        return err(
          `lens_anti_patterns_found[${i}] must be {location, pattern, recommendation, lens} with all non-empty strings`,
        );
      }
    }
  }

  if (parsed.lens_negatives_missing !== undefined) {
    if (
      !Array.isArray(parsed.lens_negatives_missing) ||
      !isStringArray(parsed.lens_negatives_missing)
    ) {
      return err(
        "'lens_negatives_missing' must be an array of strings when present",
      );
    }
  }

  return { ok: true, value: parsed as ConsolidatorResult };
}

// The six canonical kebab-case review-agent names plus the optional
// cross-model Gemini lens, matching agent-prompts.md and
// consolidator-instructions.md.
const CANONICAL_LENSES = [
  "bug-detection",
  "security",
  "pattern-consistency",
  "performance",
  "supply-chain",
  "test-coverage",
] as const;
const OPTIONAL_LENSES = ["gemini"] as const;

export type CollectedLensNegatives = {
  lens_rejected_alternatives: LensNegativeEntry<LensRejectedAlternative>[];
  lens_anti_patterns_found: LensNegativeEntry<LensAntiPattern>[];
  lens_negatives_missing: string[];
};

// The list this module scans for, shared by the async (Bun.file) and sync
// (node:fs) directory scanners below.
export const ALL_LENS_NAMES: readonly string[] = [
  ...CANONICAL_LENSES,
  ...OPTIONAL_LENSES,
];

function accumulateLensFile(
  lens: string,
  parsed: unknown,
  acc: CollectedLensNegatives,
): void {
  const state = classifyLensNegatives(parsed);
  const collected = collectLensNegatives(parsed, lens);

  for (const entry of collected.rejected_alternatives) {
    acc.lens_rejected_alternatives.push({ ...entry, lens });
  }
  for (const entry of collected.anti_patterns_found) {
    acc.lens_anti_patterns_found.push({ ...entry, lens });
  }

  const anyEntries =
    collected.rejected_alternatives.length > 0 ||
    collected.anti_patterns_found.length > 0;
  const anyAbsent =
    state.rejected_alternatives === "absent" ||
    state.anti_patterns_found === "absent";

  if (anyAbsent) {
    acc.lens_negatives_missing.push(lens);
  } else if (!anyEntries && collected.skipped > 0) {
    acc.lens_negatives_missing.push(
      `${lens} (${collected.skipped} unreadable)`,
    );
  }
}

/**
 * Deterministic replacement for the consolidator's hand-copy step (b):
 * scans `dir` for `agent-output-<lens>.json` over the six canonical lenses
 * plus the optional `gemini` lens, normalizes and lens-tags each entry via
 * `collectLensNegatives`, and returns the three lens_* arrays ready to
 * embed verbatim into the consolidator's artifact.
 *
 * A missing file is skipped SILENTLY — the six-lens missing-artifact
 * escalation stays consolidator step (a)'s job, not this helper's. A file
 * that reads and parses but has an absent negative-findings slot (neither
 * `rejected_alternatives` nor `anti_patterns_found` present) appends the
 * bare lens name to `lens_negatives_missing`, mirroring
 * consolidator-instructions.md's existing "absent state" prose. A lens
 * whose slot was non-absent but yielded zero valid entries appends
 * `"<lens> (N unreadable)"`, matching the `"<lens> (N unreadable)"`
 * residual-marker precedent documented in consolidator-instructions.md's
 * per-agent-envelope section (the paragraph on reading the `skipped`
 * count). A file that exists but fails to parse
 * as JSON is treated the same as a missing file (skipped silently) — this
 * helper only reports on shape drift within a readable artifact, not on
 * malformed JSON, which the six-lens missing-artifact escalation already
 * covers via the underlying findings-shape validation.
 */
export async function collectLensNegativesFromDir(
  dir: string,
): Promise<CollectedLensNegatives> {
  const acc: CollectedLensNegatives = {
    lens_rejected_alternatives: [],
    lens_anti_patterns_found: [],
    lens_negatives_missing: [],
  };

  for (const lens of ALL_LENS_NAMES) {
    const file = Bun.file(`${dir}/agent-output-${lens}.json`);
    let exists: boolean;
    try {
      exists = await file.exists();
    } catch {
      exists = false;
    }
    if (!exists) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      continue;
    }

    accumulateLensFile(lens, parsed, acc);
  }

  return acc;
}

/**
 * Synchronous sibling of `collectLensNegativesFromDir`, sharing the same
 * per-lens accumulation logic (`accumulateLensFile`) and lens-name list —
 * only the file-existence/read primitives differ (node:fs sync calls
 * instead of `Bun.file`). Exists because `bin/lib/foreclosed-paths-format.ts`'s
 * disk fallback (Task 5) is consumed by callers that are synchronous end
 * to end (`bin/flow-foreclosed-paths.ts`'s `runUpsert`,
 * `bin/lib/pipeline-summary-sources.ts`) and cannot be made async without
 * a much larger ripple than an optional caller-supplied `artifactDir`
 * input is meant to cost.
 */
export function collectLensNegativesFromDirSync(
  dir: string,
): CollectedLensNegatives {
  const acc: CollectedLensNegatives = {
    lens_rejected_alternatives: [],
    lens_anti_patterns_found: [],
    lens_negatives_missing: [],
  };

  for (const lens of ALL_LENS_NAMES) {
    const filePath = `${dir}/agent-output-${lens}.json`;
    if (!existsSync(filePath)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }

    accumulateLensFile(lens, parsed, acc);
  }

  return acc;
}

async function cliMain(argv: string[]): Promise<number> {
  const collectIdx = argv.indexOf("--collect-lens-negatives");
  if (collectIdx !== -1) {
    if (collectIdx === argv.length - 1) {
      process.stderr.write(
        "usage: agent-finding-schema --collect-lens-negatives <dir>\n",
      );
      return 2;
    }
    const dir = argv[collectIdx + 1];
    const result = await collectLensNegativesFromDir(dir);
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  }

  const flagIdx = argv.indexOf("--validate");
  if (flagIdx === -1 || flagIdx === argv.length - 1) {
    process.stderr.write(
      "usage: agent-finding-schema --validate <path-to-agent-output-or-consolidator-result.json>\n",
    );
    return 2;
  }
  const path = argv[flagIdx + 1];
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      JSON.stringify({ ok: false, reason: `read failed: ${reason}`, path }) +
        "\n",
    );
    return 1;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      JSON.stringify({
        ok: false,
        reason: `JSON parse failed: ${reason}`,
        path,
      }) + "\n",
    );
    return 1;
  }

  // Coerce trivially-fixable label/decoration drift on both shapes before
  // validating, so consolidator-schema-failure fires only on genuinely-
  // unparseable findings. Invisible to the {ok}/exit-code contract.
  parsed = normalizeParsedFindings(parsed);

  // Decide which validator to use based on JSON shape. Presence of
  // `consolidated_findings` → consolidator artifact; presence of plain
  // `findings` (and absence of `consolidated_findings`) → per-agent
  // output. If neither key is present we fall through to the per-agent
  // validator so the caller gets a "missing required top-level key
  // 'findings'" error rather than an opaque "unknown shape".
  const isConsolidator =
    isPlainObject(parsed) && "consolidated_findings" in parsed;
  const result = isConsolidator
    ? validateConsolidatorResult(parsed)
    : validateAgentFindings(parsed);

  if (result.ok) {
    // Widen the envelope on the PER-AGENT success path only — the
    // consolidator-artifact envelope stays `{ok: true}` unchanged. Safe:
    // every documented consumer branches on exit code, never the stdout
    // body.
    if (isConsolidator) {
      process.stdout.write(JSON.stringify({ ok: true }) + "\n");
    } else {
      const { skipped } = collectLensNegatives(parsed);
      process.stdout.write(
        JSON.stringify({
          ok: true,
          negatives: classifyLensNegatives(parsed),
          skipped,
        }) + "\n",
      );
    }
    return 0;
  }
  process.stderr.write(
    JSON.stringify({ ok: false, reason: result.reason, path }) + "\n",
  );
  return 1;
}

if (import.meta.main) {
  cliMain(process.argv.slice(2)).then((code) => process.exit(code));
}
