#!/usr/bin/env bun
/**
 * Schema validator for the `/flow-pr-review` wrapper-level result artifact at
 * `<worktree>/.flow-tmp/pr-review-result.json`.
 *
 * The schema is documented prose-only in
 * `skills/pipeline/flow-pr-review/SKILL.md`'s `# Result artifact` section, with a
 * top-level-keys lint at `bin/skill-md-lint.test.ts`. This module is the
 * runtime counterpart: `/flow-pipeline` step 8 calls
 * `validatePrReviewResult(parsed)` to confirm shape before branching on
 * `.status`. It also exposes a CLI mode (`--validate <path>`) so the
 * `/flow-pr-review` wrapper can pipe the artifact through this validator just
 * before atomically writing to disk — that pre-write check is what keeps
 * a malformed artifact from ever landing where the supervisor expects a
 * well-formed JSON object.
 *
 * The validator is strict on shape and permissive on string content. The
 * three-valued `status` discriminator is the only enumerated field; the
 * arrays carry plain strings (canonical step labels) and the validator
 * checks they are arrays of strings without enumerating the labels here
 * — the labels live in the prose contract in flow-pr-review/SKILL.md, and
 * encoding them here would couple the validator to step-renumbering
 * churn the prose is anchored to absorb.
 *
 * Negative-findings semantics carry over from fix-applier-schema.ts in
 * spirit: `missed_steps[]` is permitted to be empty (a clean run has
 * nothing missed), and `escalation_tag` is `null` whenever `status !==
 * "escalated"` — the prose contract says this, but the validator does
 * not enforce the cross-field rule (mirrors the fix-applier validator's
 * "shape-only validation, NO cross-field rules" stance).
 *
 * `tier` / `tier_reasons` are OPTIONAL pass-through fields sourced from
 * `review-scope.json` (`bin/lib/review-tier.ts`'s `resolveTier`). They stay
 * optional because this module ships as the installed
 * `flow-pr-review-result-schema` validator symlink — making either
 * required would reject every in-flight artifact written before this
 * field existed. `mergeScopeFields` is the one call site that copies them
 * from a parsed `review-scope.json` onto a result object, and `--merge-scope`
 * exposes it on the CLI so Step 12 does the copy via the helper rather than
 * hand-copying two fields in prose.
 */

export type PrReviewStatus = "clean" | "partial" | "escalated";
export type PrReviewTier = "light" | "standard" | "deep";

export type PrReviewResult = {
  status: PrReviewStatus;
  completed_steps: string[];
  missed_steps: string[];
  escalation_tag: string | null;
  summary: string;
  tier?: PrReviewTier;
  tier_reasons?: string[];
};

export type ValidationOk<T> = { ok: true; value: T };
export type ValidationErr = { ok: false; reason: string; path?: string };
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

function err(reason: string, path?: string): ValidationErr {
  return { ok: false, reason, path };
}

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "clean",
  "partial",
  "escalated",
]);

const VALID_TIERS: ReadonlySet<string> = new Set(["light", "standard", "deep"]);

export function validatePrReviewResult(
  parsed: unknown,
): ValidationResult<PrReviewResult> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err("artifact must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;

  for (const key of [
    "status",
    "completed_steps",
    "missed_steps",
    "escalation_tag",
    "summary",
  ]) {
    if (!(key in o)) {
      return err(
        `missing required top-level key '${key}' (every result-artifact field is required; pass null for escalation_tag when not escalated)`,
      );
    }
  }

  if (!isString(o.status)) {
    return err(`'status' must be a string`);
  }
  if (!VALID_STATUSES.has(o.status)) {
    return err(
      `'status' must be one of "clean" | "partial" | "escalated" (got ${JSON.stringify(o.status)})`,
    );
  }

  if (!Array.isArray(o.completed_steps)) {
    return err(`'completed_steps' must be an array`);
  }
  if (!isStringArray(o.completed_steps)) {
    return err(`'completed_steps' must contain only strings`);
  }

  if (!Array.isArray(o.missed_steps)) {
    return err(`'missed_steps' must be an array`);
  }
  if (!isStringArray(o.missed_steps)) {
    return err(`'missed_steps' must contain only strings`);
  }

  if (o.escalation_tag !== null && !isString(o.escalation_tag)) {
    return err(`'escalation_tag' must be a string or null`);
  }

  if (!isNonEmptyString(o.summary)) {
    return err(`'summary' must be a non-empty string`);
  }

  if (o.tier !== undefined) {
    if (!isString(o.tier) || !VALID_TIERS.has(o.tier)) {
      return err(
        `'tier' must be one of "light" | "standard" | "deep" (got ${JSON.stringify(o.tier)})`,
      );
    }
  }

  if (o.tier_reasons !== undefined && !isStringArray(o.tier_reasons)) {
    return err(`'tier_reasons' must be an array of strings`);
  }

  return { ok: true, value: parsed as PrReviewResult };
}

/**
 * Copies `tier` / `tier_reasons` off a parsed `review-scope.json` onto
 * `result`, tolerating a missing/malformed scope by returning `result`
 * unchanged — the one call site for this copy, so callers never hand-copy
 * the two fields in prose. Idempotent: re-running against the same scope
 * overwrites with the same values.
 */
export function mergeScopeFields(
  result: PrReviewResult,
  scope: unknown,
): PrReviewResult {
  if (typeof scope !== "object" || scope === null) return result;
  const s = scope as Record<string, unknown>;
  const merged: PrReviewResult = { ...result };
  if (isString(s.tier) && VALID_TIERS.has(s.tier)) {
    merged.tier = s.tier as PrReviewTier;
  }
  if (isStringArray(s.tier_reasons)) {
    merged.tier_reasons = s.tier_reasons;
  }
  return merged;
}

async function readJsonFile(
  path: string,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `read failed: ${reason}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `JSON parse failed: ${reason}` };
  }
}

/**
 * `--merge-scope <review-scope.json> <result.json>`: copies `tier` /
 * `tier_reasons` off the scope artifact onto the result artifact and
 * rewrites the result file in place. Idempotent — re-running against an
 * already-merged result produces the same bytes. Prints `{ok:true,tier}`
 * (`tier` omitted when the scope carried none) on success.
 */
async function mergeScopeCli(
  scopePath: string,
  resultPath: string,
): Promise<number> {
  const scopeRead = await readJsonFile(scopePath);
  const scope = scopeRead.ok ? scopeRead.value : undefined;

  const resultRead = await readJsonFile(resultPath);
  if (!resultRead.ok) {
    process.stderr.write(
      JSON.stringify({
        ok: false,
        reason: resultRead.reason,
        path: resultPath,
      }) + "\n",
    );
    return 1;
  }
  const validated = validatePrReviewResult(resultRead.value);
  if (!validated.ok) {
    process.stderr.write(
      JSON.stringify({
        ok: false,
        reason: validated.reason,
        path: resultPath,
      }) + "\n",
    );
    return 1;
  }

  const merged = mergeScopeFields(validated.value, scope);
  await Bun.write(resultPath, JSON.stringify(merged));
  process.stdout.write(
    JSON.stringify({
      ok: true,
      ...(merged.tier ? { tier: merged.tier } : {}),
    }) + "\n",
  );
  return 0;
}

async function cliMain(argv: string[]): Promise<number> {
  const mergeIdx = argv.indexOf("--merge-scope");
  if (mergeIdx !== -1) {
    const scopePath = argv[mergeIdx + 1];
    const resultPath = argv[mergeIdx + 2];
    if (scopePath === undefined || resultPath === undefined) {
      process.stderr.write(
        "usage: pr-review-result-schema --merge-scope <review-scope.json> <result.json>\n",
      );
      return 2;
    }
    return mergeScopeCli(scopePath, resultPath);
  }

  const flagIdx = argv.indexOf("--validate");
  if (flagIdx === -1 || flagIdx === argv.length - 1) {
    process.stderr.write(
      "usage: pr-review-result-schema --validate <path-to-pr-review-result.json>\n",
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
  const result = validatePrReviewResult(parsed);
  if (result.ok) {
    process.stdout.write(JSON.stringify({ ok: true }) + "\n");
    return 0;
  }
  process.stderr.write(
    JSON.stringify({ ok: false, reason: result.reason, path: result.path }) +
      "\n",
  );
  return 1;
}

if (import.meta.main) {
  cliMain(process.argv.slice(2)).then((code) => process.exit(code));
}
