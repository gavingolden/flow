#!/usr/bin/env bun
/**
 * Schema validator for the `/flow-verify` UI-Driver Subagent's artifact at
 * `<worktree>/.flow-tmp/ui-driver-result.json`.
 *
 * The shape mirrors `bin/lib/fix-applier-schema.ts` (validator + CLI mode)
 * but is deliberately its own module rather than a reuse: the driver's
 * `rejected_alternatives` is a flat `string[]` (single-shot browser-drive
 * choices — a noise-filter addition, a login-path pick), not the
 * `negative-findings-schema.ts` object shape the review-lens family and
 * fix-applier share, and per D-p the driver artifact carries no
 * `anti_patterns_found` or `manifest_commit` field at all.
 *
 * CLI mode: `flow-ui-driver-schema --validate <path>` reads the file,
 * parses JSON, and runs `validateUiDriverResult` — exit 0 (valid) / 1
 * (off-shape, read/parse failure) / 2 (usage) — so the spawned subagent
 * can self-check its artifact just before atomically writing it to disk.
 *
 * `fix_context` is capped at 10 entries; every string field within an
 * entry (`route` and each string in `consoleErrors` / `failedRequests` /
 * `missingSelectors`) is capped at 300 characters. These caps ARE the
 * contract (D-p) — the validator must reject artifacts that exceed
 * either, not merely truncate them.
 */

const SKIPPED_REASONS = [
  "mcp-not-available",
  "browser-profile-busy",
  "app-launch-failed",
  "login-failed",
  "screenshots-unwritable",
  "driver-no-artifact",
] as const;

export type UiDriverSkippedReason = (typeof SKIPPED_REASONS)[number];

export type UiDriverFixContextEntry = {
  route: string;
  consoleErrors: string[];
  failedRequests: string[];
  missingSelectors: string[];
};

export type UiDriverResult = {
  ran: boolean;
  ok: boolean;
  skipped_reason?: UiDriverSkippedReason;
  captures_path: string;
  ui_screenshots: string[];
  fix_context: UiDriverFixContextEntry[];
  rejected_alternatives: string[];
  summary: string;
};

export type ValidationOk = { ok: true; value: UiDriverResult };
export type ValidationErr = { ok: false; errors: string[] };
export type ValidationResult = ValidationOk | ValidationErr;

const FIX_CONTEXT_MAX_ENTRIES = 10;
const FIX_CONTEXT_STRING_MAX_CHARS = 300;

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

function validateFixContextEntry(entry: unknown, path: string): string[] {
  const errors: string[] = [];
  if (typeof entry !== "object" || entry === null) {
    return [`'${path}' must be an object`];
  }
  const o = entry as Record<string, unknown>;
  if (!isString(o.route)) {
    errors.push(`'${path}.route' must be a string`);
  } else if (o.route.length > FIX_CONTEXT_STRING_MAX_CHARS) {
    errors.push(
      `'${path}.route' exceeds the ${FIX_CONTEXT_STRING_MAX_CHARS}-char cap`,
    );
  }
  for (const field of [
    "consoleErrors",
    "failedRequests",
    "missingSelectors",
  ] as const) {
    const arr = o[field];
    if (!isStringArray(arr)) {
      errors.push(`'${path}.${field}' must be an array of strings`);
      continue;
    }
    arr.forEach((s, i) => {
      if (s.length > FIX_CONTEXT_STRING_MAX_CHARS) {
        errors.push(
          `'${path}.${field}[${i}]' exceeds the ${FIX_CONTEXT_STRING_MAX_CHARS}-char cap`,
        );
      }
    });
  }
  return errors;
}

export function validateUiDriverResult(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["artifact must be a JSON object"] };
  }
  const o = raw as Record<string, unknown>;

  if (!isBoolean(o.ran)) errors.push("'ran' must be a boolean");
  if (!isBoolean(o.ok)) errors.push("'ok' must be a boolean");

  if (o.skipped_reason !== undefined) {
    if (
      !isString(o.skipped_reason) ||
      !(SKIPPED_REASONS as readonly string[]).includes(o.skipped_reason)
    ) {
      errors.push(
        `'skipped_reason' must be one of ${SKIPPED_REASONS.join(", ")} when present`,
      );
    }
  }

  if (!isString(o.captures_path)) {
    errors.push("'captures_path' must be a string");
  }

  if (!isStringArray(o.ui_screenshots)) {
    errors.push("'ui_screenshots' must be an array of strings");
  }

  if (!isStringArray(o.rejected_alternatives)) {
    errors.push("'rejected_alternatives' must be an array of strings");
  }

  if (!isString(o.summary) || o.summary.length === 0) {
    errors.push("'summary' must be a non-empty string");
  }

  if (!Array.isArray(o.fix_context)) {
    errors.push("'fix_context' must be an array");
  } else {
    if (o.fix_context.length > FIX_CONTEXT_MAX_ENTRIES) {
      errors.push(
        `'fix_context' exceeds the ${FIX_CONTEXT_MAX_ENTRIES}-entry cap`,
      );
    }
    o.fix_context.forEach((entry, i) => {
      errors.push(...validateFixContextEntry(entry, `fix_context[${i}]`));
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as UiDriverResult };
}

async function cliMain(argv: string[]): Promise<number> {
  const flagIdx = argv.indexOf("--validate");
  if (flagIdx === -1 || flagIdx === argv.length - 1) {
    process.stderr.write(
      "usage: ui-driver-schema --validate <path-to-ui-driver-result.json>\n",
    );
    return 2;
  }
  const filePath = argv[flagIdx + 1];
  let rawText: string;
  try {
    rawText = await Bun.file(filePath).text();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      JSON.stringify({
        ok: false,
        errors: [`read failed: ${reason}`],
        path: filePath,
      }) + "\n",
    );
    return 1;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      JSON.stringify({
        ok: false,
        errors: [`JSON parse failed: ${reason}`],
        path: filePath,
      }) + "\n",
    );
    return 1;
  }

  const result = validateUiDriverResult(parsed);
  if (result.ok) {
    process.stdout.write(JSON.stringify({ ok: true }) + "\n");
    return 0;
  }
  process.stderr.write(
    JSON.stringify({ ok: false, errors: result.errors, path: filePath }) + "\n",
  );
  return 1;
}

if (import.meta.main) {
  cliMain(process.argv.slice(2)).then((code) => process.exit(code));
}
