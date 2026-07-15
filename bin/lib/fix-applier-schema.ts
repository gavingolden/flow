#!/usr/bin/env bun
/**
 * Schema validator for the Fix-Applier Subagent's artifact at
 * `<worktree>/.flow-tmp/fix-applier-result.json`.
 *
 * The schema is documented prose-only in
 * `skills/pipeline/flow-pr-review/references/fix-applier-instructions.md` step 9
 * and `skills/pipeline/flow-pr-review/references/fix-applier-spawn-prompt.md`'s
 * spawn-prompt template, with a top-level-keys lint at
 * `bin/skill-md-lint.test.ts`. This module is the
 * runtime counterpart: a wrapper that has just received the artifact can
 * call `validateFixApplierResult(parsed)` to confirm shape before
 * consuming `commits[]`, `deferred[]`, etc.
 *
 * CLI mode: `flow-fix-applier-schema --validate <path>` reads the file,
 * parses JSON, and runs `validateFixApplierResult` — exit 0 (valid) /
 * 1 (off-shape, read/parse failure) / 2 (usage) — so the spawned
 * subagent can self-check its artifact just before atomically writing
 * it to disk.
 *
 * The validator is permissive in two specific ways and the rest is strict:
 *
 * 1. `verify_status` is a string — the literal `"pass"` or a bounded
 *    failure excerpt. We don't enumerate failure shapes here; the wrapper
 *    treats any non-`"pass"` value as a verify failure to surface.
 * 2. `tracker_entry_url` may be the empty string when the worktree has
 *    no in-repo tracker. Per the user clarification at PR #100 approval,
 *    flow has no `gh issue create` pathway today, so empty is the
 *    expected default.
 *
 * Negative-findings slots (`rejected_alternatives`, `anti_patterns_found`)
 * are required keys with array values; empty arrays are permitted only
 * when the subagent genuinely encountered no alternatives or anti-patterns
 * (the spawn prompt warns the subagent that silence is not the default,
 * but the validator can't enforce subjective populated-ness).
 */

export type FixApplierCommit = {
  sha: string;
  files: string[];
  finding_id: string;
  reasoning: string;
  verify_status: string;
  comment_ids?: string[];
  tool_error?: string;
};

export type FixApplierDeferred = {
  finding_id: string;
  tracker_entry_url: string;
  reason: string;
};

export type FixApplierRejectedAlternative = {
  finding_id: string;
  considered_approach: string;
  why_rejected: string;
};

export type FixApplierAntiPattern = {
  location: string;
  pattern: string;
  recommendation: string;
  introduced_by_this_pr: boolean;
};

export type FixApplierResult = {
  commits: FixApplierCommit[];
  deferred: FixApplierDeferred[];
  rejected_alternatives: FixApplierRejectedAlternative[];
  anti_patterns_found: FixApplierAntiPattern[];
  summary: string;
  ui_screenshots?: string[];
};

export type ValidationOk = { ok: true; value: FixApplierResult };
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

export function validateCommitEntry(
  entry: unknown,
  path: string,
): ValidationErr | null {
  if (typeof entry !== "object" || entry === null) {
    return err(`expected object`, path);
  }
  const o = entry as Record<string, unknown>;
  if (!isNonEmptyString(o.sha))
    return err(`'sha' must be a non-empty string`, path);
  if (!Array.isArray(o.files)) return err(`'files' must be an array`, path);
  if (!o.files.every(isString))
    return err(`'files' must contain only strings`, path);
  if (!isNonEmptyString(o.finding_id)) {
    return err(`'finding_id' must be a non-empty string`, path);
  }
  if (!isNonEmptyString(o.reasoning)) {
    return err(`'reasoning' must be a non-empty string`, path);
  }
  if (!isNonEmptyString(o.verify_status)) {
    return err(
      `'verify_status' must be a non-empty string ('pass' or a failure excerpt)`,
      path,
    );
  }
  if (o.comment_ids !== undefined) {
    if (!Array.isArray(o.comment_ids) || !o.comment_ids.every(isString)) {
      return err(
        `'comment_ids' must be an array of strings when present`,
        path,
      );
    }
  }
  if (o.tool_error !== undefined && !isString(o.tool_error)) {
    return err(`'tool_error' must be a string when present`, path);
  }
  return null;
}

export function validateDeferredEntry(
  entry: unknown,
  path: string,
): ValidationErr | null {
  if (typeof entry !== "object" || entry === null) {
    return err(`expected object`, path);
  }
  const o = entry as Record<string, unknown>;
  if (!isNonEmptyString(o.finding_id)) {
    return err(`'finding_id' must be a non-empty string`, path);
  }
  if (!isString(o.tracker_entry_url)) {
    return err(
      `'tracker_entry_url' must be a string (empty string permitted when no in-repo tracker exists)`,
      path,
    );
  }
  if (!isNonEmptyString(o.reason)) {
    return err(`'reason' must be a non-empty string`, path);
  }
  return null;
}

export function validateRejectedAlternativeEntry(
  entry: unknown,
  path: string,
): ValidationErr | null {
  if (typeof entry !== "object" || entry === null) {
    return err(`expected object`, path);
  }
  const o = entry as Record<string, unknown>;
  if (!isNonEmptyString(o.finding_id)) {
    return err(`'finding_id' must be a non-empty string`, path);
  }
  if (!isNonEmptyString(o.considered_approach)) {
    return err(`'considered_approach' must be a non-empty string`, path);
  }
  if (!isNonEmptyString(o.why_rejected)) {
    return err(`'why_rejected' must be a non-empty string`, path);
  }
  return null;
}

export function validateAntiPatternEntry(
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

export function validateFixApplierResult(parsed: unknown): ValidationResult {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err("artifact must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;

  for (const key of [
    "commits",
    "deferred",
    "rejected_alternatives",
    "anti_patterns_found",
  ]) {
    if (!(key in o)) {
      return err(
        `missing required top-level key '${key}' (negative-findings slots are required; empty arrays are acceptable)`,
      );
    }
    if (!Array.isArray(o[key])) {
      return err(`'${key}' must be an array`);
    }
  }

  if (!("summary" in o)) {
    return err(`missing required top-level key 'summary'`);
  }
  if (!isNonEmptyString(o.summary)) {
    return err(`'summary' must be a non-empty string`);
  }

  if ("ui_screenshots" in o) {
    if (
      !Array.isArray(o.ui_screenshots) ||
      !o.ui_screenshots.every(isNonEmptyString)
    ) {
      return err(
        `'ui_screenshots' must be an array of non-empty strings when present`,
      );
    }
  }

  const commits = o.commits as unknown[];
  for (let i = 0; i < commits.length; i++) {
    const e = validateCommitEntry(commits[i], `commits[${i}]`);
    if (e) return e;
  }

  const deferred = o.deferred as unknown[];
  for (let i = 0; i < deferred.length; i++) {
    const e = validateDeferredEntry(deferred[i], `deferred[${i}]`);
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

  return { ok: true, value: parsed as FixApplierResult };
}

async function cliMain(argv: string[]): Promise<number> {
  const flagIdx = argv.indexOf("--validate");
  if (flagIdx === -1 || flagIdx === argv.length - 1) {
    process.stderr.write(
      "usage: fix-applier-schema --validate <path-to-fix-applier-result.json>\n",
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

  const result = validateFixApplierResult(parsed);
  if (result.ok) {
    process.stdout.write(JSON.stringify({ ok: true }) + "\n");
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
