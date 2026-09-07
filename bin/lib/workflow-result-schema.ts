#!/usr/bin/env bun
/**
 * Schema validator for the two `Workflow`-tool stage result artifacts:
 * `<worktree>/.flow-tmp/stage-a-result.json` (`flow-stage-a.workflow.js`)
 * and `<worktree>/.flow-tmp/stage-b-result.json`
 * (`flow-stage-b.workflow.js`). Modelled byte-for-byte in shape on
 * `pr-review-result-schema.ts` — same `ValidationOk`/`ValidationErr`/
 * `ValidationResult` types, same `--validate <path>` CLI mode (including
 * `/dev/stdin`), same shape-only-no-cross-field-rules validation stance.
 *
 * `validateWorkflowResult` discriminates on the required `stage` field
 * ("A" | "B") before applying the matching per-stage shape check, so a
 * caller that doesn't yet know which stage produced an artifact can still
 * validate it in one call.
 *
 * The `--validate` CLI mode is also the chokepoint every stage exit passes
 * through, so it emits one best-effort `workflow.result` telemetry event per
 * invocation that gets as far as a parsed JSON object — see
 * `buildWorkflowResultAttrs` below and `docs/configuration.md`'s telemetry
 * contract. Emission never changes this module's stdout, stderr, or exit
 * codes.
 */

import { createHash } from "node:crypto";
import { recordEvent } from "./telemetry";

export type StageAResult = {
  stage: "A";
  outcome: "gate-ready" | "needs-human" | "needs-stage-b";
  decision?:
    | "auto-merge"
    | "gated"
    | "merged-externally"
    | "closed-no-merge"
    | "escalate-heading-missing"
    | "escalate-gh-error";
  reason?: string;
  pr: number;
  prUrl: string;
  ran: Record<
    "implement" | "resymlink" | "verify" | "ciWait" | "review" | "gateRead",
    boolean
  >;
  loops: { ciFix: number; reviewFix: number };
  artifacts: string[];
  summary: string;
};

export type StageBResult = {
  stage: "B";
  outcome:
    | "merged"
    | "guard-blocked"
    | "merge-failed"
    | "resolver-missing-artifact"
    | "resolver-push-failed";
  reason?: string;
  pr: number;
  prUrl: string;
  resolver?: {
    ran: boolean;
    push_status?: "succeeded" | "failed" | "skipped";
  };
  sweep: { filed: string[]; unfiled: string[]; rejected: string[] };
  summary: string;
};

export type WorkflowResult = StageAResult | StageBResult;

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

const STAGE_A_OUTCOMES: ReadonlySet<string> = new Set([
  "gate-ready",
  "needs-human",
  "needs-stage-b",
]);

const STAGE_A_DECISIONS: ReadonlySet<string> = new Set([
  "auto-merge",
  "gated",
  "merged-externally",
  "closed-no-merge",
  "escalate-heading-missing",
  "escalate-gh-error",
]);

const STAGE_A_RAN_KEYS = [
  "implement",
  "resymlink",
  "verify",
  "ciWait",
  "review",
  "gateRead",
] as const;

const STAGE_B_OUTCOMES: ReadonlySet<string> = new Set([
  "merged",
  "guard-blocked",
  "merge-failed",
  "resolver-missing-artifact",
  "resolver-push-failed",
]);

const STAGE_B_PUSH_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "skipped",
]);

function validateStageA(
  o: Record<string, unknown>,
): ValidationResult<StageAResult> {
  for (const key of [
    "stage",
    "outcome",
    "pr",
    "prUrl",
    "ran",
    "loops",
    "artifacts",
    "summary",
  ]) {
    if (!(key in o)) {
      return err(`missing required top-level key '${key}' for stage A`);
    }
  }
  if (!isString(o.outcome) || !STAGE_A_OUTCOMES.has(o.outcome)) {
    return err(
      `'outcome' must be one of "gate-ready" | "needs-human" | "needs-stage-b" (got ${JSON.stringify(o.outcome)})`,
    );
  }
  if (o.decision !== undefined) {
    if (!isString(o.decision) || !STAGE_A_DECISIONS.has(o.decision)) {
      return err(`'decision' must be a valid stage-A decision string`);
    }
  }
  if (o.reason !== undefined && !isString(o.reason)) {
    return err(`'reason' must be a string when present`);
  }
  if (typeof o.pr !== "number") {
    return err(`'pr' must be a number`);
  }
  // A "needs-human" outcome can fire before the Implement phase ever opens a
  // PR (e.g. implement-failed) — prUrl legitimately has nothing to hold yet.
  // Every other outcome always has a real PR by the time it finishes.
  if (o.outcome !== "needs-human") {
    if (!isNonEmptyString(o.prUrl)) {
      return err(`'prUrl' must be a non-empty string`);
    }
  } else if (!isString(o.prUrl)) {
    return err(`'prUrl' must be a string`);
  }
  if (typeof o.ran !== "object" || o.ran === null || Array.isArray(o.ran)) {
    return err(`'ran' must be an object`);
  }
  const ran = o.ran as Record<string, unknown>;
  for (const key of STAGE_A_RAN_KEYS) {
    if (typeof ran[key] !== "boolean") {
      return err(`'ran.${key}' must be a boolean`);
    }
  }
  if (
    typeof o.loops !== "object" ||
    o.loops === null ||
    Array.isArray(o.loops)
  ) {
    return err(`'loops' must be an object`);
  }
  const loops = o.loops as Record<string, unknown>;
  if (typeof loops.ciFix !== "number" || typeof loops.reviewFix !== "number") {
    return err(`'loops.ciFix' and 'loops.reviewFix' must be numbers`);
  }
  if (!isStringArray(o.artifacts)) {
    return err(`'artifacts' must be an array of strings`);
  }
  // A "needs-human" summary can legitimately be empty (e.g. the implement
  // agent returned an empty excerpt/join). Every other outcome must carry a
  // real, non-empty summary.
  if (o.outcome !== "needs-human") {
    if (!isNonEmptyString(o.summary)) {
      return err(`'summary' must be a non-empty string`);
    }
  } else if (!isString(o.summary)) {
    return err(`'summary' must be a string`);
  }
  return { ok: true, value: o as unknown as StageAResult };
}

function validateStageB(
  o: Record<string, unknown>,
): ValidationResult<StageBResult> {
  for (const key of ["stage", "outcome", "pr", "prUrl", "sweep", "summary"]) {
    if (!(key in o)) {
      return err(`missing required top-level key '${key}' for stage B`);
    }
  }
  if (!isString(o.outcome) || !STAGE_B_OUTCOMES.has(o.outcome)) {
    return err(
      `'outcome' must be one of "merged" | "guard-blocked" | "merge-failed" | "resolver-missing-artifact" | "resolver-push-failed" (got ${JSON.stringify(o.outcome)})`,
    );
  }
  if (o.reason !== undefined && !isString(o.reason)) {
    return err(`'reason' must be a string when present`);
  }
  if (typeof o.pr !== "number") {
    return err(`'pr' must be a number`);
  }
  if (!isNonEmptyString(o.prUrl)) {
    return err(`'prUrl' must be a non-empty string`);
  }
  if (o.resolver !== undefined) {
    if (
      typeof o.resolver !== "object" ||
      o.resolver === null ||
      Array.isArray(o.resolver)
    ) {
      return err(`'resolver' must be an object when present`);
    }
    const resolver = o.resolver as Record<string, unknown>;
    if (typeof resolver.ran !== "boolean") {
      return err(`'resolver.ran' must be a boolean`);
    }
    if (
      resolver.push_status !== undefined &&
      (!isString(resolver.push_status) ||
        !STAGE_B_PUSH_STATUSES.has(resolver.push_status))
    ) {
      return err(
        `'resolver.push_status' must be one of "succeeded" | "failed" | "skipped"`,
      );
    }
  }
  if (
    typeof o.sweep !== "object" ||
    o.sweep === null ||
    Array.isArray(o.sweep)
  ) {
    return err(`'sweep' must be an object`);
  }
  const sweep = o.sweep as Record<string, unknown>;
  for (const key of ["filed", "unfiled", "rejected"]) {
    if (!isStringArray(sweep[key])) {
      return err(`'sweep.${key}' must be an array of strings`);
    }
  }
  if (!isNonEmptyString(o.summary)) {
    return err(`'summary' must be a non-empty string`);
  }
  return { ok: true, value: o as unknown as StageBResult };
}

export function validateWorkflowResult(
  parsed: unknown,
): ValidationResult<WorkflowResult> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err("artifact must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  if (!("stage" in o)) {
    return err(`missing required top-level key 'stage'`);
  }
  if (o.stage === "A") return validateStageA(o);
  if (o.stage === "B") return validateStageB(o);
  return err(`'stage' must be "A" or "B" (got ${JSON.stringify(o.stage)})`);
}

/**
 * The class of a `reason`: everything before its first ":", trimmed. Stage
 * reasons are built as `` `agent-unavailable: ${label}` `` in
 * `workflows/core/flow-stage-a.workflow.js`, so the label suffix would force
 * every documented query into a `startswith` against a free-form string.
 * Deriving the class once here keeps those queries plain equalities.
 */
function reasonClass(reason: string): string {
  const idx = reason.indexOf(":");
  return (idx === -1 ? reason : reason.slice(0, idx)).trim();
}

/**
 * Builds the `workflow.result` telemetry attrs for one validated (or
 * rejected) stage-result artifact. Pure — no I/O, no throw — so the emit site
 * in `cliMain` stays a single statement and the shape is unit-testable
 * without spawning a process.
 *
 * Two branches, deliberately: on `result.ok` every field is read off the
 * already-proven `result.value`, so no per-property `unknown` guard is needed;
 * on rejection `parsed` has an unproven shape, so it is strict-object-guarded
 * first and a primitive / `null` / array artifact yields the verdict fields
 * alone with no property access at all.
 *
 * `result_sha` is a short digest of the artifact's raw text. One stage exit
 * passes this chokepoint two or three times (the stage script's own validate,
 * the supervisor's re-validate, and `VALIDATE_CMD`'s `||` fallback on a
 * non-zero first exit), so readers dedupe on it rather than counting lines.
 */
export function buildWorkflowResultAttrs(
  parsed: unknown,
  result: ValidationResult<WorkflowResult>,
  rawText: string,
): Record<string, unknown> {
  const result_sha = createHash("sha256")
    .update(rawText)
    .digest("hex")
    .slice(0, 12);

  if (result.ok) {
    const value = result.value;
    const attrs: Record<string, unknown> = {
      stage: value.stage,
      outcome: value.outcome,
    };
    if (value.stage === "A" && value.decision !== undefined) {
      attrs.decision = value.decision;
    }
    if (value.reason !== undefined) {
      attrs.reason = value.reason;
      attrs.reason_class = reasonClass(value.reason);
    }
    if (value.stage === "A") {
      attrs.loops = {
        ciFix: value.loops.ciFix,
        reviewFix: value.loops.reviewFix,
      };
      const ran: Record<string, boolean> = {};
      for (const key of STAGE_A_RAN_KEYS) ran[key] = value.ran[key];
      attrs.ran = ran;
    }
    attrs.valid = true;
    attrs.result_sha = result_sha;
    return attrs;
  }

  const attrs: Record<string, unknown> = {};
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    if (typeof o.stage === "string") attrs.stage = o.stage;
    if (typeof o.outcome === "string") attrs.outcome = o.outcome;
  }
  attrs.valid = false;
  attrs.schema_error = result.reason;
  attrs.result_sha = result_sha;
  return attrs;
}

async function cliMain(argv: string[]): Promise<number> {
  const flagIdx = argv.indexOf("--validate");
  if (flagIdx === -1 || flagIdx === argv.length - 1) {
    process.stderr.write(
      "usage: workflow-result-schema --validate <path-to-stage-result.json>\n",
    );
    return 2;
  }
  const path = argv[flagIdx + 1];
  let raw: string;
  try {
    // Bun.file("/dev/stdin") does not read a piped stdin on Linux CI;
    // the stage scripts pipe the result object in, so read stdin directly.
    raw =
      path === "/dev/stdin" || path === "-"
        ? await Bun.stdin.text()
        : await Bun.file(path).text();
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
  const result = validateWorkflowResult(parsed);
  // Best-effort and deliberately unguarded: `recordEvent` never throws and
  // never changes a caller's control flow (`bin/lib/telemetry.ts`). Placed
  // before both returns below so a rejected artifact is counted too.
  recordEvent("workflow.result", buildWorkflowResultAttrs(parsed, result, raw));
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
