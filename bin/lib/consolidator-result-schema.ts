#!/usr/bin/env bun
/**
 * Schema validator for the Consolidator + Validator Subagent's artifact at
 * `<worktree>/.flow-tmp/consolidator-result.json`.
 *
 * The schema is documented prose-only in
 * `skills/pipeline/pr-review/references/consolidator-instructions.md` and
 * `skills/pipeline/pr-review/SKILL.md`'s `# Consolidator + Validator
 * Subagent` section, with a top-level-keys lint at
 * `bin/skill-md-lint.test.ts`. This module is the runtime counterpart:
 * `/pr-review` step 4 (`Consume Consolidated Findings`) reads the artifact
 * from disk and calls `validateConsolidatorResult(parsed)` before consuming
 * `consolidated_findings[]`. The CLI mode (`--validate <path>`) lets the
 * consolidator subagent pipe its candidate artifact through the validator
 * before atomically writing to disk.
 *
 * The per-finding shape inside `consolidated_findings[]` and
 * `dropped_by_validation[].finding` is delegated to
 * `validateAgentFindings()` from `./agent-finding-schema` — same shape the
 * four review agents emit, kept in lockstep so the consolidator can pass a
 * finding through without remunging it.
 *
 * Negative-findings slots (`rejected_alternatives`, `anti_patterns_found`)
 * carry over the fix-applier-schema.ts convention: required keys, empty
 * arrays permitted only when the subagent genuinely encountered none (the
 * spawn prompt warns that silence is not the default, but the validator
 * can't enforce subjective populated-ness).
 */

import {
  type AgentFinding,
  validateAgentFindings,
} from "./agent-finding-schema";

export type DroppedFinding = {
  finding: AgentFinding;
  reason: string;
};

export type ConsolidatorResult = {
  consolidated_findings: AgentFinding[];
  dropped_by_validation: DroppedFinding[];
  rejected_alternatives: string[];
  anti_patterns_found: string[];
  summary: string;
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

function err(reason: string, path?: string): ValidationErr {
  return { ok: false, reason, path };
}

function validateDroppedEntry(entry: unknown, path: string): ValidationErr | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return err(`expected object`, path);
  }
  const o = entry as Record<string, unknown>;
  if (!("finding" in o)) {
    return err(`missing required key 'finding'`, path);
  }
  // Validate the nested finding via the agent-finding validator. We wrap the
  // single finding in a single-element array because validateAgentFindings
  // expects an array; on failure, reformat the inner path.
  const findingResult = validateAgentFindings([o.finding]);
  if (!findingResult.ok) {
    return err(
      `'finding' failed AgentFinding validation: ${findingResult.reason}`,
      path,
    );
  }
  if (!("reason" in o)) {
    return err(`missing required key 'reason'`, path);
  }
  if (!isNonEmptyString(o.reason)) {
    return err(`'reason' must be a non-empty string`, path);
  }
  return null;
}

export function validateConsolidatorResult(
  parsed: unknown,
): ValidationResult<ConsolidatorResult> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err("artifact must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;

  for (const key of [
    "consolidated_findings",
    "dropped_by_validation",
    "rejected_alternatives",
    "anti_patterns_found",
    "summary",
  ]) {
    if (!(key in o)) {
      return err(
        `missing required top-level key '${key}' (negative-findings slots are required; empty arrays are acceptable)`,
      );
    }
  }

  if (!Array.isArray(o.consolidated_findings)) {
    return err(`'consolidated_findings' must be an array`);
  }
  const findingsResult = validateAgentFindings(o.consolidated_findings);
  if (!findingsResult.ok) {
    return err(
      `'consolidated_findings' entry failed AgentFinding validation: ${findingsResult.reason}`,
      findingsResult.path
        ? `consolidated_findings${findingsResult.path}`
        : "consolidated_findings",
    );
  }

  if (!Array.isArray(o.dropped_by_validation)) {
    return err(`'dropped_by_validation' must be an array`);
  }
  const dropped = o.dropped_by_validation as unknown[];
  for (let i = 0; i < dropped.length; i++) {
    const e = validateDroppedEntry(dropped[i], `dropped_by_validation[${i}]`);
    if (e) return e;
  }

  if (!Array.isArray(o.rejected_alternatives)) {
    return err(`'rejected_alternatives' must be an array`);
  }
  if (!(o.rejected_alternatives as unknown[]).every(isString)) {
    return err(`'rejected_alternatives' must be an array of strings`);
  }

  if (!Array.isArray(o.anti_patterns_found)) {
    return err(`'anti_patterns_found' must be an array`);
  }
  if (!(o.anti_patterns_found as unknown[]).every(isString)) {
    return err(`'anti_patterns_found' must be an array of strings`);
  }

  if (!isNonEmptyString(o.summary)) {
    return err(`'summary' must be a non-empty string`);
  }

  return { ok: true, value: parsed as ConsolidatorResult };
}

async function cliMain(argv: string[]): Promise<number> {
  const flagIdx = argv.indexOf("--validate");
  if (flagIdx === -1 || flagIdx === argv.length - 1) {
    process.stderr.write(
      "usage: consolidator-result-schema --validate <path-to-consolidator-result.json>\n",
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
      JSON.stringify({ ok: false, reason: `JSON parse failed: ${reason}`, path }) +
        "\n",
    );
    return 1;
  }
  const result = validateConsolidatorResult(parsed);
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
