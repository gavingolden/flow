/**
 * Schema-free structured-response helper: tolerantly recovers a single JSON
 * object from a model's free-text response, then validates it fail-closed
 * against a JSON-Schema-shaped `schema` argument.
 *
 * Extraction is tried in order, first candidate that parses to a JSON object
 * wins: (1) the whole trimmed text, (2) a fenced ```json / ``` block, (3) the
 * first balanced `{...}` span in the text (string-literal aware, so a brace
 * inside a JSON string value never desyncs the depth count).
 *
 * Validation follows the `ValidationResult` prose conventions of
 * `bin/lib/design-spec-schema.ts`: a single `reason` string naming the
 * offending key, tolerant on shape, loud on mismatch, NEVER throws. Only
 * `schema.required` (string array) and `schema.properties` (object of
 * `{type}`) are consulted — this is a schema-FREE helper, not a full
 * JSON-Schema implementation. A non-object schema, or one with no `required`,
 * validates shape-only (an object was recovered) and returns ok.
 *
 * `unwrapAgyEnvelope` / `extractJsonObject` / `decodeDelegateArtifact` below
 * are one rung-ordered decode ladder for a `flow-delegate --output-format
 * json` artifact: rung 1 trusts the envelope's `structured_output` (the
 * wire-level `--json-schema` contract), rung 2 falls back to `parseStructured`
 * over the envelope's `.response` prose, rung 3 is `extractJsonObject` (a
 * naive first-`{`-to-last-`}` slice) as a last-resort salvage. This
 * supersedes the former "deliberately unconsolidated gap" note that lived
 * here: `extractJsonObject` used to be `bin/flow-gemini-lens.ts`'s OWN
 * competing decoder, never called by this module — it is now rung 3 of ONE
 * ladder every wire-schema call site shares.
 *
 * Rung 3 is kept as a deliberate LAST-RESORT rung, not an empirically-earned
 * one: re-running both decoders over all 588 committed
 * `docs/model-bench/results.json` responses found 0 cases where the naive
 * decoder recovered an object `parseStructured` missed, and 2 case-groups
 * where the naive decoder failed (an over-wide span swallowing trailing
 * prose that itself contained a brace) while `parseStructured` still
 * recovered the object. `parseStructured` in fact strictly dominates
 * `extractJsonObject` on parse-success BY CONSTRUCTION: a first-`{`-to-last-
 * `}` slice that itself parses as valid JSON is necessarily brace-balanced,
 * so `findBalancedObjectSpan`'s scanner returns that identical span too —
 * no input parses for the naive decoder but not for `parseStructured`. Rung
 * 3's salvage case (a naive-parseable candidate outside this corpus, e.g.
 * from a future extraction tweak) is unreachable so far, not proven
 * unreachable in general.
 */

export type ParseStructuredResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

function tryParseObject(candidate: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(candidate);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through — caller tries the next extraction strategy
  }
  return null;
}

// The first balanced `{...}` span starting at the first `{` in the text.
// String-literal aware: braces inside a `"..."` value never affect depth, so
// a value like `{"note": "see {ref}"}` still balances correctly.
function findBalancedObjectSpan(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function extractFencedBlock(text: string): string | null {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match ? (match[1] as string).trim() : null;
}

function extractCandidateObject(text: string): Record<string, unknown> | null {
  const whole = tryParseObject(text.trim());
  if (whole) return whole;

  const fenced = extractFencedBlock(text);
  if (fenced !== null) {
    const parsed = tryParseObject(fenced);
    if (parsed) return parsed;
  }

  const balanced = findBalancedObjectSpan(text);
  if (balanced !== null) {
    const parsed = tryParseObject(balanced);
    if (parsed) return parsed;
  }

  return null;
}

type JsonSchemaType = "string" | "number" | "boolean" | "object" | "array";

function matchesType(value: unknown, type: string): boolean {
  switch (type as JsonSchemaType) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    default:
      // An unrecognized declared type is not this helper's concern to police
      // — schema-free means we only enforce the five JSON-Schema primitives.
      return true;
  }
}

function describeActualType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function validateAgainstSchema(
  obj: Record<string, unknown>,
  schema: unknown,
): ParseStructuredResult {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return { ok: true, value: obj };
  }
  const s = schema as Record<string, unknown>;
  const required = Array.isArray(s.required)
    ? s.required.filter((r): r is string => typeof r === "string")
    : [];
  if (required.length === 0) {
    return { ok: true, value: obj };
  }
  const properties =
    typeof s.properties === "object" &&
    s.properties !== null &&
    !Array.isArray(s.properties)
      ? (s.properties as Record<string, unknown>)
      : {};

  for (const key of required) {
    if (!(key in obj) || obj[key] === undefined) {
      return {
        ok: false,
        reason: `required key "${key}" is missing from the parsed object`,
      };
    }
    const propSchema = properties[key];
    if (
      typeof propSchema === "object" &&
      propSchema !== null &&
      !Array.isArray(propSchema)
    ) {
      const expectedType = (propSchema as Record<string, unknown>).type;
      if (
        typeof expectedType === "string" &&
        !matchesType(obj[key], expectedType)
      ) {
        return {
          ok: false,
          reason: `key "${key}" must be type "${expectedType}" but got "${describeActualType(obj[key])}"`,
        };
      }
    }
  }
  return { ok: true, value: obj };
}

export function parseStructured(
  text: string,
  schema: unknown,
): ParseStructuredResult {
  const obj = extractCandidateObject(text);
  if (obj === null) {
    return {
      ok: false,
      reason:
        "no JSON object could be extracted from the response text (tried whole-text, fenced-block, and balanced-brace extraction)",
    };
  }
  return validateAgainstSchema(obj, schema);
}

// Unwraps a `flow-delegate --output-format json` artifact: a JSON envelope
// whose `.response` field is the model's raw prose/JSON text, optionally
// alongside a `.structured_output` field the CLI populated when a
// `--json-schema` call actually returned schema-conformant output. NEVER
// throws — on any parse failure or non-envelope shape (text mode, a partial
// write), the raw artifact is returned verbatim as `text` with no
// `structured` field, so callers on a non-json-mode call see no behaviour
// change.
// Wire-contract dependency: this decoder hard-codes the `agy` CLI's
// `--output-format json` envelope field names (`response`, `structured_output`)
// with no version pin. Rung 2 (below) is keyed on `.response` being a string;
// rung 1 is keyed on `.structured_output`. If a future `agy` renames either
// field, this rung degrades silently rather than erroring — verify against
// the currently-installed `agy --version` when either rung stops firing.
export function unwrapAgyEnvelope(rawArtifact: string): {
  text: string;
  structured?: unknown;
} {
  try {
    const envelope = JSON.parse(rawArtifact) as Record<string, unknown>;
    if (typeof envelope === "object" && envelope !== null) {
      const hasResponse = typeof envelope.response === "string";
      const hasStructured =
        envelope.structured_output !== undefined &&
        envelope.structured_output !== null;
      // The two channels are independent — don't gate `structured` on
      // `.response` being a string. An envelope can carry a populated
      // `structured_output` alongside a null/absent `.response`; discarding
      // `structured` there would drop the wire-schema channel this ladder
      // exists to prioritize (see `bin/flow-delegate.ts`'s
      // `attemptStructuredParse`, which checks `structured_output` first).
      if (hasResponse || hasStructured) {
        return {
          text: hasResponse ? (envelope.response as string) : rawArtifact,
          structured: hasStructured ? envelope.structured_output : undefined,
        };
      }
    }
  } catch {
    // not an envelope (text mode / partial write) — fall through below.
  }
  return { text: rawArtifact };
}

// The naive first-`{`-to-last-`}` slice, moved verbatim from
// `bin/flow-gemini-lens.ts` (formerly a second, competing decoder there) —
// see the module header for why it now lives here as rung 3 of one ladder.
// Returns the substring from the first '{' to the matching last '}'
// (inclusive), or null when no brace pair is present. NEVER throws —
// JSON.parse validity is the caller's concern.
export function extractJsonObject(raw: string): string | null {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return null;
  return raw.slice(first, last + 1);
}

export type DecodeVia =
  | "structured-output"
  | "response-parse"
  | "naive-salvage";

// Decodes a `flow-delegate --output-format json` artifact through a
// rung-ordered ladder, returning the first rung whose candidate satisfies
// `validate`: (1) the envelope's `structured_output`, when present; (2)
// `parseStructured` over the envelope's (or raw, on unwrap failure) text;
// (3) `extractJsonObject` + `JSON.parse` over that same text, as a
// last-resort salvage. NEVER throws — any rung's parse/validate failure just
// falls through to the next rung, and exhausting the ladder returns
// `{ok:false}`.
export function decodeDelegateArtifact<T>(
  rawArtifact: string,
  validate: (candidate: unknown) => { ok: true; value: T } | { ok: false },
): { ok: true; value: T; via: DecodeVia } | { ok: false } {
  const { text, structured } = unwrapAgyEnvelope(rawArtifact);

  if (structured !== undefined) {
    const result = validate(structured);
    if (result.ok)
      return { ok: true, value: result.value, via: "structured-output" };
  }

  const parsed = parseStructured(text, undefined);
  if (parsed.ok) {
    const result = validate(parsed.value);
    if (result.ok)
      return { ok: true, value: result.value, via: "response-parse" };
  }

  const naive = extractJsonObject(text);
  if (naive !== null) {
    try {
      const candidate = JSON.parse(naive);
      const result = validate(candidate);
      if (result.ok)
        return { ok: true, value: result.value, via: "naive-salvage" };
    } catch {
      // falls through to {ok:false} below
    }
  }

  return { ok: false };
}
