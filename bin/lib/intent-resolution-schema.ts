#!/usr/bin/env bun
/**
 * Schema validator for the `/flow-pr-review` Step 3.6 intent-mismatch
 * resolution artifact at `<worktree>/.flow-tmp/intent-resolution.json`.
 *
 * The schema is documented prose-only in
 * `skills/pipeline/flow-pr-review/references/intent-mismatch-resolution.md`
 * (the "Write the resolution artifact" section) — this module is the
 * runtime counterpart, modeled near-literally on `fix-applier-schema.ts`.
 *
 * Required-keys-strict, extra-keys-permissive: `verdict`, `guessed_purpose`,
 * and `resolution` are required and type-checked; every other key an
 * observed writer legitimately emits (`ran`, `actual_intent_source`,
 * `blind_guess`, `drift_candidates`, `escalated`, `test_steps_item_added`,
 * `summary`, etc.) is passed through without failing validation.
 *
 * SELF-CORRECTING REASON STRINGS (load-bearing — the AGY D2 pre-mortem
 * mitigation): when a required key is missing and a known drift alias for
 * it is present on the object, the reason names BOTH the alias found and
 * the required key it is not — e.g. `missing required key "resolution"
 * (found "action" — the required key is "resolution", not an alias)`. The
 * alias table below is used ONLY for these diagnostics; it is the
 * writer-side inverse of tolerance, not reader-side alias acceptance —
 * the artifact is still REJECTED either way. Off-enum `verdict` values get
 * the same treatment (nearest-enum hint).
 *
 * CLI mode: `flow-intent-resolution-schema --validate <path>` reads the
 * file, parses JSON, and runs `validateIntentResolution` — exit 0 (valid) /
 * 1 (off-shape, read/parse failure) / 2 (usage).
 */

export type IntentVerdict =
  | "match"
  | "benign-divergence"
  | "scope-drift"
  | "fundamental";

export type IntentResolution = {
  verdict: IntentVerdict;
  guessed_purpose: string;
  resolution: string;
  cross_model?: { ran: boolean; agreement: "agree" | "disagree" | null };
};

export type ValidationOk = { ok: true; value: IntentResolution };
export type ValidationErr = { ok: false; reason: string; path?: string };
export type ValidationResult = ValidationOk | ValidationErr;

const VALID_VERDICTS: readonly IntentVerdict[] = [
  "match",
  "benign-divergence",
  "scope-drift",
  "fundamental",
];

/**
 * Diagnostics-only alias table: observed drift shapes map a key onto the
 * required key it was (incorrectly) written in place of. NEVER consulted
 * by a reader to accept the alias — only to name it in a rejection reason.
 */
const KEY_ALIASES: Record<string, string> = {
  rung: "verdict",
  action: "resolution",
  action_taken: "resolution",
  note: "resolution",
  rationale: "resolution",
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function err(reason: string, path?: string): ValidationErr {
  return { ok: false, reason, path };
}

/**
 * Builds the "missing required key" reason, naming a known drift alias
 * found on the object (if any) alongside the required key.
 */
function missingKeyReason(
  requiredKey: string,
  o: Record<string, unknown>,
): string {
  const aliasFound = Object.keys(KEY_ALIASES).find(
    (alias) => KEY_ALIASES[alias] === requiredKey && alias in o,
  );
  if (aliasFound) {
    return `missing required key "${requiredKey}" (found "${aliasFound}" — the required key is "${requiredKey}", not an alias)`;
  }
  return `missing required key "${requiredKey}"`;
}

function nearestVerdictHint(value: string): string {
  const match = VALID_VERDICTS.find(
    (v) => v.startsWith(value) || value.startsWith(v.split("-")[0]),
  );
  if (match) {
    return `"${value}" is not a valid verdict; did you mean "${match}"?`;
  }
  return `"${value}" is not a valid verdict; must be one of ${VALID_VERDICTS.map((v) => `"${v}"`).join(", ")}`;
}

export function validateIntentResolution(parsed: unknown): ValidationResult {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err("artifact must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;

  if (!("verdict" in o)) {
    return err(missingKeyReason("verdict", o));
  }
  if (typeof o.verdict !== "string") {
    return err(`'verdict' must be a string`);
  }
  if (!VALID_VERDICTS.includes(o.verdict as IntentVerdict)) {
    return err(nearestVerdictHint(o.verdict));
  }

  if (!("guessed_purpose" in o)) {
    return err(missingKeyReason("guessed_purpose", o));
  }
  if (!isNonEmptyString(o.guessed_purpose)) {
    return err(`'guessed_purpose' must be a non-empty string`);
  }

  if (!("resolution" in o)) {
    return err(missingKeyReason("resolution", o));
  }
  if (!isNonEmptyString(o.resolution)) {
    return err(`'resolution' must be a non-empty string`);
  }

  if ("cross_model" in o && o.cross_model !== undefined) {
    const cm = o.cross_model;
    if (typeof cm !== "object" || cm === null || Array.isArray(cm)) {
      return err(`'cross_model' must be an object when present`);
    }
    const c = cm as Record<string, unknown>;
    if (typeof c.ran !== "boolean") {
      return err(`'cross_model.ran' must be a boolean`);
    }
    if (
      c.agreement !== "agree" &&
      c.agreement !== "disagree" &&
      c.agreement !== null
    ) {
      return err(
        `'cross_model.agreement' must be "agree", "disagree", or null`,
      );
    }
  }

  return { ok: true, value: parsed as IntentResolution };
}

async function cliMain(argv: string[]): Promise<number> {
  const flagIdx = argv.indexOf("--validate");
  if (flagIdx === -1 || flagIdx === argv.length - 1) {
    process.stderr.write(
      "usage: intent-resolution-schema --validate <path-to-intent-resolution.json>\n",
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

  const result = validateIntentResolution(parsed);
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
