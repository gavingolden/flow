#!/usr/bin/env bun
/**
 * Schema validator for the pipeline-ephemeral design-fidelity artifacts under
 * `.flow-tmp/design/` — the frozen `spec.json` discovery authors when a
 * request references a design artifact, and the per-surface capture files the
 * UI-smoke / review passes write after driving `flow-design-spec probe-script`
 * in a browser page.
 *
 * Spec shape: `{ surfaces: [{ name, route, assertions: [{ id, selector,
 * tier: "mechanical"|"judged", method?: "computed-style"|"source-read",
 * properties?: { <css-prop>: <expected-value> }, tolerancePx?, note? }] }] }`.
 * Capture shape: `{ surface, captured: [{ selector,
 * properties: { <css-prop>: <actual> } }] }`.
 *
 * Mirrors `bin/lib/ui-validation-schema.ts`'s `validate*()` /
 * `ValidationResult<T>` shape: strict on the required shape, permissive on
 * extra keys (a spec may carry `_comment`-style documentation keys; a capture
 * may carry `found` flags or rect extras the probe emits). Validation is
 * tolerant — a loud `reason`, never a crash. This module is an INTERNAL
 * import of `bin/flow-design-spec.ts` only; it is deliberately NOT registered
 * in `bin/lib/sources.ts`'s `VALIDATOR_MODULES` allowlist because no pipeline
 * skill invokes it by bare name (`flow-design-spec validate` is the CLI
 * surface).
 */

export type DesignAssertionTier = "mechanical" | "judged";
export type DesignAssertionMethod = "computed-style" | "source-read";

export type DesignAssertion = {
  id: string;
  selector: string;
  tier: DesignAssertionTier;
  method?: DesignAssertionMethod;
  properties?: Record<string, string>;
  /** Per-assertion override of the ±1px default px comparison tolerance. */
  tolerancePx?: number;
  note?: string;
};

export type DesignSurface = {
  name: string;
  route: string;
  assertions: DesignAssertion[];
};

export type DesignSpec = {
  surfaces: DesignSurface[];
};

export type DesignCaptureEntry = {
  selector: string;
  properties: Record<string, string>;
};

export type DesignCapture = {
  surface: string;
  captured: DesignCaptureEntry[];
};

export type ValidationOk<T> = { ok: true; value: T };
export type ValidationErr = { ok: false; reason: string; path?: string };
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function err(reason: string): ValidationErr {
  return { ok: false, reason };
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return (
    isPlainObject(v) && Object.values(v).every((x) => typeof x === "string")
  );
}

function validateAssertion(
  a: unknown,
  where: string,
): ValidationResult<DesignAssertion> {
  if (!isPlainObject(a)) return err(`${where} must be an object`);
  if (!isNonEmptyString(a.id)) {
    return err(`${where}.id must be a non-empty string`);
  }
  if (!isNonEmptyString(a.selector)) {
    return err(`${where}.selector must be a non-empty string`);
  }
  if (a.tier !== "mechanical" && a.tier !== "judged") {
    return err(`${where}.tier must be "mechanical" or "judged"`);
  }
  if (
    a.method !== undefined &&
    a.method !== "computed-style" &&
    a.method !== "source-read"
  ) {
    return err(
      `${where}.method must be "computed-style" or "source-read" when present`,
    );
  }
  if (a.properties !== undefined && !isStringRecord(a.properties)) {
    return err(
      `${where}.properties must be an object of string values when present`,
    );
  }
  if (a.tier === "mechanical" && a.properties === undefined) {
    return err(
      `${where} is tier "mechanical" but has no properties to assert — mechanical assertions need expected values`,
    );
  }
  if (
    a.tolerancePx !== undefined &&
    (typeof a.tolerancePx !== "number" ||
      !Number.isFinite(a.tolerancePx) ||
      a.tolerancePx < 0)
  ) {
    return err(`${where}.tolerancePx must be a non-negative number`);
  }
  if (a.note !== undefined && typeof a.note !== "string") {
    return err(`${where}.note must be a string when present`);
  }
  return { ok: true, value: a as unknown as DesignAssertion };
}

export function validateDesignSpec(
  parsed: unknown,
): ValidationResult<DesignSpec> {
  if (!isPlainObject(parsed)) {
    return err("design spec must be a JSON object");
  }
  if (!Array.isArray(parsed.surfaces) || parsed.surfaces.length === 0) {
    return err("'surfaces' must be a non-empty array");
  }
  for (let i = 0; i < parsed.surfaces.length; i++) {
    const s = parsed.surfaces[i];
    if (!isPlainObject(s)) return err(`surfaces[${i}] must be an object`);
    if (!isNonEmptyString(s.name)) {
      return err(`surfaces[${i}].name must be a non-empty string`);
    }
    if (!isNonEmptyString(s.route)) {
      return err(`surfaces[${i}].route must be a non-empty string`);
    }
    if (!Array.isArray(s.assertions)) {
      return err(`surfaces[${i}].assertions must be an array`);
    }
    for (let j = 0; j < s.assertions.length; j++) {
      const a = validateAssertion(
        s.assertions[j],
        `surfaces[${i}].assertions[${j}]`,
      );
      if (!a.ok) return a;
    }
  }
  const ids = (parsed.surfaces as DesignSurface[]).flatMap((s) =>
    s.assertions.map((a) => a.id),
  );
  const dup = ids.find((id, idx) => ids.indexOf(id) !== idx);
  if (dup !== undefined) {
    return err(
      `assertion id "${dup}" appears more than once — ids must be unique across the spec`,
    );
  }
  return { ok: true, value: parsed as unknown as DesignSpec };
}

export function validateDesignCapture(
  parsed: unknown,
): ValidationResult<DesignCapture> {
  if (!isPlainObject(parsed)) {
    return err("design capture must be a JSON object");
  }
  if (!isNonEmptyString(parsed.surface)) {
    return err("'surface' must be a non-empty string naming the spec surface");
  }
  if (!Array.isArray(parsed.captured)) {
    return err("'captured' must be an array");
  }
  for (let i = 0; i < parsed.captured.length; i++) {
    const c = parsed.captured[i];
    if (!isPlainObject(c)) return err(`captured[${i}] must be an object`);
    if (!isNonEmptyString(c.selector)) {
      return err(`captured[${i}].selector must be a non-empty string`);
    }
    if (!isStringRecord(c.properties)) {
      return err(
        `captured[${i}].properties must be an object of string values`,
      );
    }
  }
  return { ok: true, value: parsed as unknown as DesignCapture };
}
