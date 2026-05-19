#!/usr/bin/env bun
/**
 * Schema validator for a single review agent's JSON output array.
 *
 * The four `/pr-review` review agents (Bug Detection, Security, Pattern &
 * Consistency, Test Coverage) each return a JSON array of findings shaped per
 * `skills/pipeline/pr-review/references/agent-prompts.md`'s Output Format
 * section. The Consolidator + Validator Subagent reads those arrays from disk
 * and needs a shape check before consuming them; this module is that runtime
 * counterpart. It also exposes a CLI mode (`--validate <path>`) so the
 * consolidator subagent can pipe each agent's output through this validator
 * and escalate on the first schema failure rather than silently dropping a
 * mis-shaped array.
 *
 * The validator is strict on the documented per-finding shape and permissive
 * on string content (no enumeration of subject/body length, no URL parsing).
 * The `label` and `decoration` enums are the only enumerated fields. The
 * top-level shape is a JSON array — an empty array is a valid no-findings
 * return per the agent-prompts.md contract.
 */

export type AgentFindingLabel =
  | "praise"
  | "nitpick"
  | "suggestion"
  | "issue"
  | "todo"
  | "question";

export type AgentFindingDecoration = "blocking" | "non-blocking" | "if-minor";

export type AgentFinding = {
  file: string;
  line: number;
  end_line?: number;
  label: AgentFindingLabel;
  decoration: AgentFindingDecoration;
  confidence: number;
  subject: string;
  body: string;
};

export type ValidationOk<T> = { ok: true; value: T };
export type ValidationErr = { ok: false; reason: string; path?: string };
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

const VALID_LABELS: ReadonlySet<string> = new Set([
  "praise",
  "nitpick",
  "suggestion",
  "issue",
  "todo",
  "question",
]);

const VALID_DECORATIONS: ReadonlySet<string> = new Set([
  "blocking",
  "non-blocking",
  "if-minor",
]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPositiveInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function err(reason: string, path?: string): ValidationErr {
  return { ok: false, reason, path };
}

function validateFinding(entry: unknown, path: string): ValidationErr | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return err(`expected object`, path);
  }
  const o = entry as Record<string, unknown>;

  if (!isNonEmptyString(o.file)) {
    return err(`'file' must be a non-empty string`, path);
  }
  if (!("line" in o)) {
    return err(`missing required key 'line'`, path);
  }
  if (!isPositiveInteger(o.line)) {
    return err(`'line' must be a positive integer`, path);
  }
  if (o.end_line !== undefined) {
    if (!isPositiveInteger(o.end_line)) {
      return err(
        `'end_line' must be a positive integer when present`,
        path,
      );
    }
  }
  if (!("label" in o)) {
    return err(`missing required key 'label'`, path);
  }
  if (typeof o.label !== "string" || !VALID_LABELS.has(o.label)) {
    return err(
      `'label' must be one of praise|nitpick|suggestion|issue|todo|question (got ${JSON.stringify(o.label)})`,
      path,
    );
  }
  if (!("decoration" in o)) {
    return err(`missing required key 'decoration'`, path);
  }
  if (typeof o.decoration !== "string" || !VALID_DECORATIONS.has(o.decoration)) {
    return err(
      `'decoration' must be one of blocking|non-blocking|if-minor (got ${JSON.stringify(o.decoration)})`,
      path,
    );
  }
  if (!("confidence" in o)) {
    return err(`missing required key 'confidence'`, path);
  }
  if (typeof o.confidence !== "number") {
    return err(`'confidence' must be a number`, path);
  }
  if (
    !Number.isInteger(o.confidence) ||
    o.confidence < 0 ||
    o.confidence > 100
  ) {
    return err(
      `'confidence' must be an integer in [0, 100] (got ${o.confidence})`,
      path,
    );
  }
  if (!isNonEmptyString(o.subject)) {
    return err(`'subject' must be a non-empty string`, path);
  }
  if (typeof o.body !== "string") {
    return err(`'body' must be a string`, path);
  }
  return null;
}

export function validateAgentFindings(
  parsed: unknown,
): ValidationResult<AgentFinding[]> {
  if (!Array.isArray(parsed)) {
    return err("agent output must be a JSON array of findings");
  }
  for (let i = 0; i < parsed.length; i++) {
    const e = validateFinding(parsed[i], `[${i}]`);
    if (e) return e;
  }
  return { ok: true, value: parsed as AgentFinding[] };
}

async function cliMain(argv: string[]): Promise<number> {
  const flagIdx = argv.indexOf("--validate");
  if (flagIdx === -1 || flagIdx === argv.length - 1) {
    process.stderr.write(
      "usage: agent-finding-schema --validate <path-to-agent-output.json>\n",
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
  const result = validateAgentFindings(parsed);
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
