/**
 * Schema-free structured-response helper: tolerantly recovers a single JSON
 * object from a model's free-text response, then validates it fail-closed
 * against a JSON-Schema-shaped `schema` argument.
 *
 * Extraction is tried in order, first candidate that parses to a JSON object
 * wins: (1) the whole trimmed text, (2) a fenced ```json / ``` block, (3) the
 * first balanced `{...}` span in the text (string-literal aware, so a brace
 * inside a JSON string value never desyncs the depth count). This is a more
 * robust sibling of the naive first-`{`-to-last-`}` `extractJsonObject` still
 * used in `bin/flow-gemini-lens.ts`. `bin/flow-gemini-intent-guess.ts` has
 * migrated to `parseStructured` (this module) instead of its former naive
 * decoder. `bin/flow-gemini-lens.ts` deliberately retains its own naive copy:
 * its `findings[]` output quality is a recall concern, not a strict-parse
 * concern, so swapping its decoder risks trading a loud rare parse-skip for a
 * silent constant recall loss — a known, deliberately unconsolidated gap, not
 * an oversight.
 *
 * Validation follows the `ValidationResult` prose conventions of
 * `bin/lib/design-spec-schema.ts`: a single `reason` string naming the
 * offending key, tolerant on shape, loud on mismatch, NEVER throws. Only
 * `schema.required` (string array) and `schema.properties` (object of
 * `{type}`) are consulted — this is a schema-FREE helper, not a full
 * JSON-Schema implementation. A non-object schema, or one with no `required`,
 * validates shape-only (an object was recovered) and returns ok.
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
