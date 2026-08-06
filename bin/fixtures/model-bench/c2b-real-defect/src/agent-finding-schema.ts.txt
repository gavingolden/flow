#!/usr/bin/env bun
/**
 * Schema validators for per-agent review findings and the
 * Consolidator-Validator subagent's output artifact.
 *
 * Two exports:
 *
 * - `validateAgentFindings(parsed)` — validates a single per-agent JSON
 *   output written to `<worktree>/.flow-tmp/agent-output-<lens>.json` by
 *   one of the six review agents (bug-detection, security,
 *   pattern-consistency, performance, supply-chain, test-coverage). The
 *   input must be a JSON object with shape `{findings: Array<Finding>}`
 *   where each finding has the documented shape from
 *   `skills/pipeline/flow-pr-review/references/agent-prompts.md` (`file`,
 *   `line`, optional `end_line`, `label`, `decoration`, `confidence`,
 *   `subject`, `body`).
 *
 * - `validateConsolidatorResult(parsed)` — validates the Consolidator-
 *   Validator subagent's output artifact at
 *   `<worktree>/.flow-tmp/consolidator-result.json`. The input must be a
 *   JSON object with five top-level keys: `consolidated_findings`,
 *   `dropped_by_validation`, `rejected_alternatives`,
 *   `anti_patterns_found`, `summary`.
 *
 * Strict on shape, permissive on string content. Labels and decorations
 * are enumerated per the agent-prompts.md spec; the body string content
 * is not enumerated (it's prose). Cross-field rules are generally not
 * enforced here — that's the prose contract in flow-pr-review/SKILL.md's job
 * — with one deliberate exception now enforced: per conventional-
 * comments.md Rule 2, praise findings may omit `decoration` (an absent
 * key or `null`), while every other label still requires a valid enum
 * decoration. Like the label/decoration coerce-then-validate pre-pass,
 * `normalizeFinding` also recovers an absent `file`/`line` from a leading
 * `<path>:<line>` prefix in `subject` (then `body`), aliases an absent
 * `subject` to a present `title`, and defaults a missing `line` to `1`
 * when `file` is present but no prose location is recoverable.
 *
 * CLI mode: `bun bin/lib/agent-finding-schema.ts --validate <path>` —
 * reads the file, parses JSON, and decides which validator to use based
 * on the JSON shape (presence of `findings` key → agent findings;
 * presence of `consolidated_findings` key → consolidator result). Exits
 * 0 with `{ok: true}` on stdout for shape-valid input; exits 1 with
 * `{ok: false, reason, path}` on stderr for shape-invalid input.
 */

export type Finding = {
  file: string;
  line: number;
  end_line?: number;
  label: string;
  decoration?: string | null;
  confidence: number;
  subject: string;
  body: string;
};

export type AgentFindings = {
  findings: Finding[];
};

export type DroppedFinding = {
  finding_id: string;
  original_finding: Record<string, unknown>;
  reason: string;
};

export type ConsolidatorResult = {
  consolidated_findings: Record<string, unknown>[];
  dropped_by_validation: DroppedFinding[];
  rejected_alternatives: string[];
  anti_patterns_found: string[];
  summary: string;
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

// Off-enum labels that agents trivially emit instead of a real label: the
// six long-form lens names, the two short forms, and two literal phrases.
// `normalizeFinding` maps any of these to `suggestion` before validation;
// genuinely-unknown labels (e.g. "xyzzy") are left untouched and still
// hard-fail. Not a widening of VALID_LABELS — this is a coerce-then-validate
// pre-pass, never an enum relaxation.
const LENS_NAME_LABELS: ReadonlySet<string> = new Set([
  "bug-detection",
  "security",
  "pattern-consistency",
  "performance",
  "supply-chain",
  "test-coverage",
  "consistency",
  "testing",
  "add-a-test",
  "doc-fix",
]);

// Strip exactly ONE matched leading '(' + trailing ')' pair after trimming,
// so "(blocking)" -> "blocking" but "((blocking))" -> "(blocking)" (still
// fails) and "(critical)" -> "critical" (still fails the enum). One pass only.
function stripOneParenPair(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith("(") && t.endsWith(")")) {
    return t.slice(1, -1);
  }
  return t;
}

// Recover a location from a leading '<path>:<line>' token in a prose string
// (a finding's subject/body) when the structured `file` field is absent. The
// path must look like a path (contain '/' or '.') so a bare 'TODO:42' prose
// lead is not mistaken for a location. One leading token only; `end_line`
// (a '<path>:<start>-<end>' tail) is intentionally not parsed.
function extractLeadingFileLine(
  s: string,
): { file: string; line: number } | null {
  const m = /^([^\s:]+):(\d+)\b/.exec(s.trim());
  if (!m) return null;
  const file = m[1];
  if (!file.includes("/") && !file.includes(".")) return null;
  return { file, line: Number(m[2]) };
}

/**
 * Coerce trivially-fixable label/decoration drift on a single finding-shaped
 * object BEFORE validation. Returns a shallow copy — never mutates the input,
 * so re-running is idempotent. Recovers `file`/`line` from a prose prefix,
 * aliases `title`→`subject`, and defaults a missing `line` to `1` when a
 * `file` is present; label coercion (a lens-name label becomes `suggestion`,
 * preserving praise's decoration-optionality only when the label was
 * already/becomes a real one) then decoration paren-stripping run last. A
 * present field is never clobbered, so real malformation still fails validation.
 */
export function normalizeFinding(f: unknown): unknown {
  if (!isPlainObject(f)) return f;
  const out: Record<string, unknown> = { ...f };
  // why: agents intermittently key the short description as `title` instead of
  // the required `subject`, hard-failing validation and sinking the whole
  // consolidator review. Alias title->subject before validation; never clobber
  // a present subject.
  if (!isNonEmptyString(out.subject) && isNonEmptyString(out.title)) {
    out.subject = out.title;
  }
  // why: a praise/issue finding that puts its location only in prose (e.g.
  // subject 'src/foo.ts:42 — ...') leaves `file` absent and would hard-fail
  // validation, sinking the whole consolidator review. Recover file/line from
  // a leading prefix in subject (then body); never clobber a present field.
  if (!isNonEmptyString(out.file)) {
    const recovered =
      (isString(out.subject) ? extractLeadingFileLine(out.subject) : null) ??
      (isString(out.body) ? extractLeadingFileLine(out.body) : null);
    if (recovered) {
      out.file = recovered.file;
      if (!isNumber(out.line)) out.line = recovered.line;
    }
  }
  // why: the test-coverage agent names a `file` but omits `line`, which the
  // file-absent recovery above never reaches (it only fires when `file` is also
  // missing). Recover `line` from a prose prefix decoupled from the file guard,
  // and default to 1 when no prose location is recoverable but `file` is present
  // — a non-blocking finding's exact line is cosmetic for routing, and 1 is an
  // always-valid 1-indexed sentinel that keeps the review from aborting.
  if (isNonEmptyString(out.file) && !isNumber(out.line)) {
    const recovered =
      (isString(out.subject) ? extractLeadingFileLine(out.subject) : null) ??
      (isString(out.body) ? extractLeadingFileLine(out.body) : null);
    out.line = recovered ? recovered.line : 1;
  }
  if (
    isString(out.label) &&
    !VALID_LABELS.has(out.label) &&
    LENS_NAME_LABELS.has(out.label)
  ) {
    out.label = "suggestion";
  }
  if (isNonEmptyString(out.decoration)) {
    out.decoration = stripOneParenPair(out.decoration);
  }
  return out;
}

// Shape-aware walker: normalize each entry of `findings[]` (per-agent) or
// `consolidated_findings[]` (consolidator). Returns a shallow copy of the
// container with the normalized array; non-array/absent keys pass through.
export function normalizeParsedFindings(parsed: unknown): unknown {
  if (!isPlainObject(parsed)) return parsed;
  const out: Record<string, unknown> = { ...parsed };
  if (Array.isArray(out.consolidated_findings)) {
    out.consolidated_findings = out.consolidated_findings.map(normalizeFinding);
  }
  if (Array.isArray(out.findings)) {
    out.findings = out.findings.map(normalizeFinding);
  }
  return out;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function err(reason: string, path?: string): ValidationErr {
  return { ok: false, reason, path };
}

function validateFinding(f: unknown, idx: number): ValidationResult<Finding> {
  if (!isPlainObject(f)) {
    return err(`findings[${idx}] must be an object`);
  }
  if (!isNonEmptyString(f.file)) {
    return err(`findings[${idx}].file must be a non-empty string`);
  }
  if (!isNumber(f.line)) {
    return err(`findings[${idx}].line must be a number`);
  }
  if (f.end_line !== undefined && !isNumber(f.end_line)) {
    return err(`findings[${idx}].end_line must be a number when present`);
  }
  if (!isString(f.label)) {
    return err(`findings[${idx}].label must be a string`);
  }
  if (!VALID_LABELS.has(f.label)) {
    return err(
      `findings[${idx}].label must be one of praise|nitpick|suggestion|issue|todo|question (got ${JSON.stringify(f.label)})`,
    );
  }
  if (f.label === "praise") {
    // why: conventional-comments.md Rule 2 — every finding except praise
    // MUST have a decoration; praise may omit it (absent key or null).
    if (f.decoration !== undefined && f.decoration !== null) {
      if (!isString(f.decoration)) {
        return err(`findings[${idx}].decoration must be a string`);
      }
      if (!VALID_DECORATIONS.has(f.decoration)) {
        return err(
          `findings[${idx}].decoration must be one of blocking|non-blocking|if-minor (got ${JSON.stringify(f.decoration)})`,
        );
      }
    }
  } else {
    if (!isString(f.decoration)) {
      return err(`findings[${idx}].decoration must be a string`);
    }
    if (!VALID_DECORATIONS.has(f.decoration)) {
      return err(
        `findings[${idx}].decoration must be one of blocking|non-blocking|if-minor (got ${JSON.stringify(f.decoration)})`,
      );
    }
  }
  if (!isNumber(f.confidence)) {
    return err(`findings[${idx}].confidence must be a number`);
  }
  if (!isString(f.subject)) {
    return err(`findings[${idx}].subject must be a string`);
  }
  if (!isString(f.body)) {
    return err(`findings[${idx}].body must be a string`);
  }
  return { ok: true, value: f as unknown as Finding };
}

export function validateAgentFindings(
  parsed: unknown,
): ValidationResult<AgentFindings> {
  if (!isPlainObject(parsed)) {
    return err("agent-findings artifact must be a JSON object");
  }
  if (!("findings" in parsed)) {
    return err(
      "missing required top-level key 'findings' (per-agent output must be {findings: Array<Finding>})",
    );
  }
  if (!Array.isArray(parsed.findings)) {
    return err("'findings' must be an array");
  }
  for (let i = 0; i < parsed.findings.length; i++) {
    const r = validateFinding(parsed.findings[i], i);
    if (!r.ok) return r;
  }
  return { ok: true, value: parsed as AgentFindings };
}

function validateDroppedFinding(
  d: unknown,
  idx: number,
): ValidationResult<DroppedFinding> {
  if (!isPlainObject(d)) {
    return err(`dropped_by_validation[${idx}] must be an object`);
  }
  if (!isNonEmptyString(d.finding_id)) {
    return err(
      `dropped_by_validation[${idx}].finding_id must be a non-empty string`,
    );
  }
  if (!isPlainObject(d.original_finding)) {
    return err(
      `dropped_by_validation[${idx}].original_finding must be an object`,
    );
  }
  if (!isNonEmptyString(d.reason)) {
    return err(
      `dropped_by_validation[${idx}].reason must be a non-empty string`,
    );
  }
  return { ok: true, value: d as unknown as DroppedFinding };
}

export function validateConsolidatorResult(
  parsed: unknown,
): ValidationResult<ConsolidatorResult> {
  if (!isPlainObject(parsed)) {
    return err("consolidator artifact must be a JSON object");
  }

  for (const key of [
    "consolidated_findings",
    "dropped_by_validation",
    "rejected_alternatives",
    "anti_patterns_found",
    "summary",
  ]) {
    if (!(key in parsed)) {
      return err(
        `missing required top-level key '${key}' (every consolidator artifact field is required; pass [] for empty arrays)`,
      );
    }
  }

  if (!Array.isArray(parsed.consolidated_findings)) {
    return err("'consolidated_findings' must be an array");
  }
  for (let i = 0; i < parsed.consolidated_findings.length; i++) {
    const f = parsed.consolidated_findings[i];
    if (!isPlainObject(f)) {
      return err(`consolidated_findings[${i}] must be an object`);
    }
    // Consolidated findings carry the per-agent finding fields plus
    // extra slots (finding_id, agent_source). Be strict on the
    // baseline shape but permissive on the extras.
    const r = validateFinding(f, i);
    if (!r.ok) {
      return err(
        `consolidated_findings[${i}]: ${r.reason.replace(`findings[${i}]`, `consolidated_findings[${i}]`)}`,
      );
    }
  }

  if (!Array.isArray(parsed.dropped_by_validation)) {
    return err("'dropped_by_validation' must be an array");
  }
  for (let i = 0; i < parsed.dropped_by_validation.length; i++) {
    const r = validateDroppedFinding(parsed.dropped_by_validation[i], i);
    if (!r.ok) return r;
  }

  if (!Array.isArray(parsed.rejected_alternatives)) {
    return err("'rejected_alternatives' must be an array");
  }
  if (!isStringArray(parsed.rejected_alternatives)) {
    return err("'rejected_alternatives' must contain only strings");
  }

  if (!Array.isArray(parsed.anti_patterns_found)) {
    return err("'anti_patterns_found' must be an array");
  }
  if (!isStringArray(parsed.anti_patterns_found)) {
    return err("'anti_patterns_found' must contain only strings");
  }

  if (!isNonEmptyString(parsed.summary)) {
    return err("'summary' must be a non-empty string");
  }

  return { ok: true, value: parsed as ConsolidatorResult };
}

async function cliMain(argv: string[]): Promise<number> {
  const flagIdx = argv.indexOf("--validate");
  if (flagIdx === -1 || flagIdx === argv.length - 1) {
    process.stderr.write(
      "usage: agent-finding-schema --validate <path-to-agent-output-or-consolidator-result.json>\n",
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

  // Coerce trivially-fixable label/decoration drift on both shapes before
  // validating, so consolidator-schema-failure fires only on genuinely-
  // unparseable findings. Invisible to the {ok}/exit-code contract.
  parsed = normalizeParsedFindings(parsed);

  // Decide which validator to use based on JSON shape. Presence of
  // `consolidated_findings` → consolidator artifact; presence of plain
  // `findings` (and absence of `consolidated_findings`) → per-agent
  // output. If neither key is present we fall through to the per-agent
  // validator so the caller gets a "missing required top-level key
  // 'findings'" error rather than an opaque "unknown shape".
  const isConsolidator =
    isPlainObject(parsed) && "consolidated_findings" in parsed;
  const result = isConsolidator
    ? validateConsolidatorResult(parsed)
    : validateAgentFindings(parsed);

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
