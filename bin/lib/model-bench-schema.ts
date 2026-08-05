/**
 * Typed case/truth/result contract shared by `flow-model-bench`'s fixtures,
 * runner, and scorer. Follows `bin/lib/design-spec-schema.ts` VERBATIM for
 * both the result shape and the module-level precedent: a single `reason`
 * string (never an `errors: string[]` array — every other `bin/lib/*-schema.ts`
 * in the tree uses this shape, and drift here would just be a second
 * convention to learn), and this module is an INTERNAL import of
 * `flow-model-bench` only — it is deliberately NOT added to
 * `bin/lib/sources.ts`'s `VALIDATOR_MODULES` allowlist, because no pipeline
 * skill invokes it by bare name (the harness is a maintainer-only Bash tool,
 * same reasoning `design-spec-schema.ts`'s header documents for
 * `flow-design-spec validate`).
 *
 * `BenchSurface` deliberately excludes `fix-applier` and `verify-loop`: both
 * are multi-turn, tool-using surfaces (edit / run / re-read) that a
 * single-shot prompt-in-response-out harness cannot measure honestly — a
 * one-prompt score would grade the wrong skill. Measuring their real
 * agentic-execution loop is out of scope for this harness.
 */

export type BenchSurface =
  | "scout"
  | "log-triage"
  | "intent-guess"
  | "commit-msg"
  | "plan-review"
  | "review-lens"
  | "research-refute"
  | "critique"
  | "gatekeeper";

export const BENCH_SURFACES: readonly BenchSurface[] = [
  "scout",
  "log-triage",
  "intent-guess",
  "commit-msg",
  "plan-review",
  "review-lens",
  "research-refute",
  "critique",
  "gatekeeper",
];

export type BenchArm = "schema" | "free-form" | "n/a";

export type BenchCaseKind =
  | "multi-file"
  | "planted-defect"
  | "real-defect"
  | "long-context"
  | "structured"
  | "free-text"
  | "pushback";

const BENCH_CASE_KINDS: ReadonlySet<string> = new Set([
  "multi-file",
  "planted-defect",
  "real-defect",
  "long-context",
  "structured",
  "free-text",
  "pushback",
]);

export type BenchCase = {
  id: string;
  surface: BenchSurface;
  kind: BenchCaseKind;
  promptFile: string;
  inputFiles: string[];
  jsonSchemaFile?: string;
  schemaAb?: boolean;
  sizes?: number[];
  repeats?: number;
  // Staleness annotation — the commit SHA the case was authored against, so
  // a later drift in the surface's prompt/schema is detectable. REQUIRED
  // non-empty: a case with no authoredAtCommit cannot be checked for rot.
  authoredAtCommit: string;
  routable: boolean;
};

// A criterion is either a plain string (the legacy short-key form: the
// string itself is the case-insensitive substring match key — use this when
// the ground truth IS already a short, literal-matchable token) or an
// object carrying a human-readable `desc` (the full prose ground truth, kept
// for report readability) plus `anyOf` — a set of short, distinctive
// substrings, any ONE of which appearing in the model output satisfies the
// criterion. Prose ground truth can never be substring-matched whole (no
// model output reproduces a full authored sentence verbatim), so `anyOf` is
// the mechanism for those entries.
export type TruthCriterion = string | { desc: string; anyOf: string[] };

// A tuple-subset criterion for cases whose ground truth is a CONJUNCTION
// over structured output (e.g. "PR 204 carries decision=proceed AND
// rule=no-skip-rule-matched") — substring matching (TruthCriterion) cannot
// express this: in a multi-item answer every individual token appears
// somewhere regardless of correctness, so a conjunction needs a real
// object-shaped match, not string search. `match`'s values are primitives
// only — this is a leaf equality check, not a nested-pattern matcher.
export type StructuredTuple = {
  desc: string;
  match: Record<string, string | number | boolean>;
};

export type BenchTruth = {
  caseId: string;
  // Non-empty: a truth file with no ground truth cannot score anything.
  required: TruthCriterion[];
  forbidden?: TruthCriterion[];
  defects?: Array<{ file: string; line: number; kind: string }>;
  emptinessPredicates?: string[];
  pushback?: { mustName: string[]; mustNotObject?: boolean };
  // A tuple is met when ANY object anywhere inside the attempt's
  // structuredOutput (searched recursively through arrays and objects)
  // carries every key/value pair in `match` — see StructuredTuple above.
  structuredTuples?: StructuredTuple[];
};

// Plain string -> itself is the sole match key; object -> its anyOf list.
export function criterionKeys(c: TruthCriterion): string[] {
  return typeof c === "string" ? [c] : c.anyOf;
}

// Plain string -> itself is also the human-readable label; object -> desc.
export function criterionLabel(c: TruthCriterion): string {
  return typeof c === "string" ? c : c.desc;
}

export type BenchResult = {
  caseId: string;
  arm: BenchArm;
  model: string;
  repeat: number;
  warmup: boolean;
  ran: boolean;
  skipReason?: string;
  durationSeconds?: number;
  usage?: Record<string, number>;
  response?: string;
  structuredOutput?: unknown;
  parseRetries?: number;
  size?: number;
};

export type ValidationOk<T> = { ok: true; value: T };
export type ValidationErr = { ok: false; reason: string; path?: string };
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);
}

function isTruthCriterion(v: unknown): boolean {
  if (isString(v)) return true;
  if (!isPlainObject(v)) return false;
  return isNonEmptyString(v.desc) && isNonEmptyStringArray(v.anyOf);
}

function isTruthCriterionArray(v: unknown): boolean {
  return Array.isArray(v) && v.every(isTruthCriterion);
}

function err(reason: string, path?: string): ValidationErr {
  return { ok: false, reason, path };
}

export function validateCase(o: unknown): ValidationResult<BenchCase> {
  if (!isPlainObject(o)) {
    return err("bench case must be a JSON object");
  }
  if (!isNonEmptyString(o.id)) {
    return err("'id' must be a non-empty string");
  }
  if (
    !isString(o.surface) ||
    !BENCH_SURFACES.includes(o.surface as BenchSurface)
  ) {
    return err(
      `'surface' must be one of ${BENCH_SURFACES.join("|")} (got ${JSON.stringify(o.surface)})`,
    );
  }
  if (!isString(o.kind) || !BENCH_CASE_KINDS.has(o.kind)) {
    return err(
      `'kind' must be one of ${[...BENCH_CASE_KINDS].join("|")} (got ${JSON.stringify(o.kind)})`,
    );
  }
  if (!isNonEmptyString(o.promptFile)) {
    return err("'promptFile' must be a non-empty string");
  }
  if (!isStringArray(o.inputFiles)) {
    return err("'inputFiles' must be an array of strings");
  }
  if (o.jsonSchemaFile !== undefined && !isNonEmptyString(o.jsonSchemaFile)) {
    return err("'jsonSchemaFile' must be a non-empty string when present");
  }
  if (o.schemaAb !== undefined && !isBoolean(o.schemaAb)) {
    return err("'schemaAb' must be a boolean when present");
  }
  // schemaAb:true implies a schema file is actually named to run the A arm.
  if (o.schemaAb === true && o.jsonSchemaFile === undefined) {
    return err("'schemaAb' is true but 'jsonSchemaFile' is absent");
  }
  if (o.sizes !== undefined) {
    if (!Array.isArray(o.sizes) || !o.sizes.every(isNumber)) {
      return err("'sizes' must be an array of numbers when present");
    }
  }
  if (o.repeats !== undefined && !isNumber(o.repeats)) {
    return err("'repeats' must be a number when present");
  }
  if (!isNonEmptyString(o.authoredAtCommit)) {
    return err("'authoredAtCommit' must be a non-empty string");
  }
  if (!isBoolean(o.routable)) {
    return err("'routable' must be a boolean");
  }
  return { ok: true, value: o as unknown as BenchCase };
}

export function validateTruth(o: unknown): ValidationResult<BenchTruth> {
  if (!isPlainObject(o)) {
    return err("bench truth must be a JSON object");
  }
  if (!isNonEmptyString(o.caseId)) {
    return err("'caseId' must be a non-empty string");
  }
  if (
    !isTruthCriterionArray(o.required) ||
    (o.required as unknown[]).length === 0
  ) {
    return err(
      "'required' must be a non-empty array of strings or {desc, anyOf} objects",
    );
  }
  if (o.forbidden !== undefined && !isTruthCriterionArray(o.forbidden)) {
    return err(
      "'forbidden' must be an array of strings or {desc, anyOf} objects when present",
    );
  }
  if (o.defects !== undefined) {
    if (!Array.isArray(o.defects)) {
      return err("'defects' must be an array when present");
    }
    for (let i = 0; i < o.defects.length; i++) {
      const d = o.defects[i];
      if (!isPlainObject(d)) return err(`defects[${i}] must be an object`);
      if (!isNonEmptyString(d.file)) {
        return err(`defects[${i}].file must be a non-empty string`);
      }
      if (!isNumber(d.line)) {
        return err(`defects[${i}].line must be a number`);
      }
      if (!isNonEmptyString(d.kind)) {
        return err(`defects[${i}].kind must be a non-empty string`);
      }
    }
  }
  if (
    o.emptinessPredicates !== undefined &&
    !isStringArray(o.emptinessPredicates)
  ) {
    return err(
      "'emptinessPredicates' must be an array of strings when present",
    );
  }
  if (o.pushback !== undefined) {
    if (!isPlainObject(o.pushback)) {
      return err("'pushback' must be an object when present");
    }
    if (!isStringArray(o.pushback.mustName)) {
      return err("'pushback.mustName' must be an array of strings");
    }
    if (
      o.pushback.mustNotObject !== undefined &&
      !isBoolean(o.pushback.mustNotObject)
    ) {
      return err("'pushback.mustNotObject' must be a boolean when present");
    }
  }
  if (o.structuredTuples !== undefined) {
    if (!Array.isArray(o.structuredTuples)) {
      return err("'structuredTuples' must be an array when present");
    }
    for (let i = 0; i < o.structuredTuples.length; i++) {
      const t = o.structuredTuples[i];
      if (!isPlainObject(t)) {
        return err(`structuredTuples[${i}] must be an object`);
      }
      if (!isNonEmptyString(t.desc)) {
        return err(`structuredTuples[${i}].desc must be a non-empty string`);
      }
      if (!isPlainObject(t.match) || Object.keys(t.match).length === 0) {
        return err(`structuredTuples[${i}].match must be a non-empty object`);
      }
      for (const [key, value] of Object.entries(t.match)) {
        if (
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean"
        ) {
          return err(
            `structuredTuples[${i}].match.${key} must be a string, number, or boolean`,
          );
        }
      }
    }
  }
  return { ok: true, value: o as unknown as BenchTruth };
}

function validateResult(
  o: unknown,
  idx: number,
): ValidationResult<BenchResult> {
  if (!isPlainObject(o)) {
    return err(`results[${idx}] must be an object`);
  }
  if (!isNonEmptyString(o.caseId)) {
    return err(`results[${idx}].caseId must be a non-empty string`);
  }
  if (o.arm !== "schema" && o.arm !== "free-form" && o.arm !== "n/a") {
    return err(`results[${idx}].arm must be one of "schema"|"free-form"|"n/a"`);
  }
  if (!isNonEmptyString(o.model)) {
    return err(`results[${idx}].model must be a non-empty string`);
  }
  if (!isNumber(o.repeat)) {
    return err(`results[${idx}].repeat must be a number`);
  }
  if (!isBoolean(o.warmup)) {
    return err(`results[${idx}].warmup must be a boolean`);
  }
  if (!isBoolean(o.ran)) {
    return err(`results[${idx}].ran must be a boolean`);
  }
  if (o.skipReason !== undefined && !isString(o.skipReason)) {
    return err(`results[${idx}].skipReason must be a string when present`);
  }
  if (o.durationSeconds !== undefined && !isNumber(o.durationSeconds)) {
    return err(`results[${idx}].durationSeconds must be a number when present`);
  }
  if (
    o.usage !== undefined &&
    (!isPlainObject(o.usage) ||
      !Object.values(o.usage).every((v) => isNumber(v)))
  ) {
    return err(
      `results[${idx}].usage must be an object of numbers when present`,
    );
  }
  if (o.response !== undefined && !isString(o.response)) {
    return err(`results[${idx}].response must be a string when present`);
  }
  if (o.parseRetries !== undefined && !isNumber(o.parseRetries)) {
    return err(`results[${idx}].parseRetries must be a number when present`);
  }
  if (o.size !== undefined && !isNumber(o.size)) {
    return err(`results[${idx}].size must be a number when present`);
  }
  return { ok: true, value: o as unknown as BenchResult };
}

export function validateResults(o: unknown): ValidationResult<BenchResult[]> {
  if (!Array.isArray(o)) {
    return err("bench results must be a JSON array");
  }
  for (let i = 0; i < o.length; i++) {
    const r = validateResult(o[i], i);
    if (!r.ok) return r;
  }
  return { ok: true, value: o as BenchResult[] };
}
