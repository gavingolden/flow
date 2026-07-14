/**
 * Schema validator for the Edit-Applier Subagent's artifact at
 * `<worktree>/.flow-tmp/coder-result.json`.
 *
 * The schema is documented prose-only in
 * `skills/pipeline/flow-coder/references/coder-instructions.md` step 4
 * and `skills/pipeline/flow-coder/SKILL.md`'s spawn-prompt template, with a
 * top-level-keys lint at `bin/skill-md-lint.test.ts`. This module is the
 * runtime counterpart: a wrapper that has just received the artifact can
 * call `validateCoderResult(parsed)` to confirm shape before consuming
 * `edits[]`, `verify_status`, etc.
 *
 * The validator is permissive in two specific ways and the rest is strict:
 *
 * 1. `verify_status` is a string — the literal `"pass"` or a bounded
 *    failure excerpt. We don't enumerate failure shapes here; the wrapper
 *    treats any non-`"pass"` value as a verify failure to surface.
 * 2. `edits[].tool_error` is a string and may be empty — the empty string
 *    is the default when no Edit/Write error blocked the edit.
 *
 * Negative-findings slots (`rejected_alternatives`, `anti_patterns_found`)
 * are required keys with array values; empty arrays are permitted only
 * when the subagent genuinely encountered no alternatives or anti-patterns
 * (the spawn prompt warns the subagent that silence is not the default,
 * but the validator can't enforce subjective populated-ness).
 */

export type CoderEdit = {
  file: string;
  intent: string;
  expected_outcome: string;
  applied: boolean;
  tool_error: string;
};

export type CoderRejectedAlternative = {
  file: string;
  considered_approach: string;
  why_rejected: string;
};

export type CoderAntiPattern = {
  location: string;
  pattern: string;
  recommendation: string;
  introduced_by_this_pr: boolean;
};

export type CoderResult = {
  edits: CoderEdit[];
  verify_status: string;
  rejected_alternatives: CoderRejectedAlternative[];
  anti_patterns_found: CoderAntiPattern[];
  summary: string;
};

export type ValidationOk = { ok: true; value: CoderResult };
export type ValidationErr = { ok: false; reason: string; path?: string };
export type ValidationResult = ValidationOk | ValidationErr;

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function err(reason: string, path?: string): ValidationErr {
  return { ok: false, reason, path };
}

function validateEditEntry(entry: unknown, path: string): ValidationErr | null {
  if (typeof entry !== "object" || entry === null) {
    return err(`expected object`, path);
  }
  const o = entry as Record<string, unknown>;
  if (!isNonEmptyString(o.file))
    return err(`'file' must be a non-empty string`, path);
  if (!isNonEmptyString(o.intent))
    return err(`'intent' must be a non-empty string`, path);
  if (!isNonEmptyString(o.expected_outcome)) {
    return err(`'expected_outcome' must be a non-empty string`, path);
  }
  if (typeof o.applied !== "boolean") {
    return err(`'applied' must be a boolean`, path);
  }
  if (!isString(o.tool_error)) {
    return err(
      `'tool_error' must be a string (empty string permitted when no Edit/Write error blocked the edit)`,
      path,
    );
  }
  return null;
}

function validateRejectedAlternativeEntry(
  entry: unknown,
  path: string,
): ValidationErr | null {
  if (typeof entry !== "object" || entry === null) {
    return err(`expected object`, path);
  }
  const o = entry as Record<string, unknown>;
  if (!isNonEmptyString(o.file))
    return err(`'file' must be a non-empty string`, path);
  if (!isNonEmptyString(o.considered_approach)) {
    return err(`'considered_approach' must be a non-empty string`, path);
  }
  if (!isNonEmptyString(o.why_rejected)) {
    return err(`'why_rejected' must be a non-empty string`, path);
  }
  return null;
}

function validateAntiPatternEntry(
  entry: unknown,
  path: string,
): ValidationErr | null {
  if (typeof entry !== "object" || entry === null) {
    return err(`expected object`, path);
  }
  const o = entry as Record<string, unknown>;
  if (!isNonEmptyString(o.location)) {
    return err(`'location' must be a non-empty string`, path);
  }
  if (!isNonEmptyString(o.pattern)) {
    return err(`'pattern' must be a non-empty string`, path);
  }
  if (!isNonEmptyString(o.recommendation)) {
    return err(`'recommendation' must be a non-empty string`, path);
  }
  if (typeof o.introduced_by_this_pr !== "boolean") {
    return err(`'introduced_by_this_pr' must be a boolean`, path);
  }
  return null;
}

export function validateCoderResult(parsed: unknown): ValidationResult {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err("artifact must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;

  for (const key of ["edits", "rejected_alternatives", "anti_patterns_found"]) {
    if (!(key in o)) {
      return err(
        `missing required top-level key '${key}' (negative-findings slots are required; empty arrays are acceptable)`,
      );
    }
    if (!Array.isArray(o[key])) {
      return err(`'${key}' must be an array`);
    }
  }

  if (!("verify_status" in o)) {
    return err(`missing required top-level key 'verify_status'`);
  }
  if (!isNonEmptyString(o.verify_status)) {
    return err(
      `'verify_status' must be a non-empty string ('pass' or a failure excerpt)`,
    );
  }

  if (!("summary" in o)) {
    return err(`missing required top-level key 'summary'`);
  }
  if (!isNonEmptyString(o.summary)) {
    return err(`'summary' must be a non-empty string`);
  }

  const edits = o.edits as unknown[];
  for (let i = 0; i < edits.length; i++) {
    const e = validateEditEntry(edits[i], `edits[${i}]`);
    if (e) return e;
  }

  const rejected = o.rejected_alternatives as unknown[];
  for (let i = 0; i < rejected.length; i++) {
    const e = validateRejectedAlternativeEntry(
      rejected[i],
      `rejected_alternatives[${i}]`,
    );
    if (e) return e;
  }

  const antiPatterns = o.anti_patterns_found as unknown[];
  for (let i = 0; i < antiPatterns.length; i++) {
    const e = validateAntiPatternEntry(
      antiPatterns[i],
      `anti_patterns_found[${i}]`,
    );
    if (e) return e;
  }

  return { ok: true, value: parsed as CoderResult };
}
