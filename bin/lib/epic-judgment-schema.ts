/**
 * Validator for the `/epic-run` judgment-decision contract — the typed shape
 * the in-process supervisor emits for a halted feature or a deadlock, and that
 * `epic.ts`'s actuation seams consume before acting on it.
 *
 * Follows `bin/lib/coder-schema.ts`'s `ValidationOk | ValidationErr`
 * discriminated-result shape. This is an INTERNAL `bin/lib` type: it is NOT
 * PATH-symlinked (no `bin/lib/sources.ts` `VALIDATOR_MODULES` entry, no
 * `setup.test.ts` count coupling) — the decision is emitted by the in-process
 * LLM and validated by the actuation seam in-process, never by a bare CLI.
 *
 * Contract:
 *   { action: "retry" | "redirect" | "escalate";
 *     reason: string;            // non-empty
 *     probableCause?: string;    // optional (deadlock diagnosis)
 *     suggestedRedirect?: string } // optional (v1 redirect = escalate-with-suggestion)
 */

export type EpicJudgmentAction = "retry" | "redirect" | "escalate";

export type EpicJudgment = {
  action: EpicJudgmentAction;
  reason: string;
  probableCause?: string;
  suggestedRedirect?: string;
};

export type ValidationOk = { ok: true; value: EpicJudgment };
export type ValidationErr = { ok: false; reason: string };
export type ValidationResult = ValidationOk | ValidationErr;

const ACTIONS = ["retry", "redirect", "escalate"] as const;

function err(reason: string): ValidationErr {
  return { ok: false, reason };
}

export function validateEpicJudgment(value: unknown): ValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("judgment must be a JSON object");
  }
  const o = value as Record<string, unknown>;

  if (
    typeof o.action !== "string" ||
    !(ACTIONS as readonly string[]).includes(o.action)
  ) {
    return err("'action' must be one of retry|redirect|escalate");
  }
  if (typeof o.reason !== "string" || o.reason.length === 0) {
    return err("'reason' must be a non-empty string");
  }
  if (o.probableCause !== undefined && typeof o.probableCause !== "string") {
    return err("'probableCause' must be a string when present");
  }
  if (
    o.suggestedRedirect !== undefined &&
    typeof o.suggestedRedirect !== "string"
  ) {
    return err("'suggestedRedirect' must be a string when present");
  }

  return { ok: true, value: value as EpicJudgment };
}
