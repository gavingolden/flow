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
 * `missingSelectors`) is capped at 300 characters; and each of those three
 * inner arrays is separately capped at 20 items. These caps ARE the
 * contract (D-p) — the validator must reject artifacts that exceed any of
 * them, not merely truncate.
 */

const SKIPPED_REASONS = [
  "mcp-not-available",
  "browser-profile-busy",
  "app-launch-failed",
  "login-failed",
  "screenshots-unwritable",
  "driver-no-artifact",
  "credentials-unavailable",
  "dependency-unready",
  "headless-binaries-missing",
] as const;

export type UiDriverSkippedReason = (typeof SKIPPED_REASONS)[number];

export type UiDriverFixContextEntry = {
  route: string;
  // Optional: which checklist item this entry maps to when the driver ran
  // under `MODE: items` (the /flow-pr-review 8c.iii caller) with
  // an enumerated item list — absent for the `/flow-verify` default drive,
  // which has no per-item checklist to map against.
  item?: string;
  consoleErrors: string[];
  failedRequests: string[];
  missingSelectors: string[];
  // Per-viewport geometry and page-quality findings. Optional so artifacts
  // written before these existed still validate.
  geometryIssues?: string[];
  heuristicIssues?: string[];
};

export const ITEM_KINDS = ["appearance", "behavior", "capture"] as const;
export const ITEM_VERDICTS = [
  "pass",
  "fail",
  "not-drivable",
  "captured",
  "not-captured",
] as const;

// One entry per checklist item the driver worked under `MODE: items` (the
// /flow-pr-review 8c.iii caller). `capture` items are photographed, never
// judged, so they take only `captured` / `not-captured`; the other two kinds
// take only `pass` / `fail` / `not-drivable`.
//
// `index` is the 1-based Test Steps index across ALL checklist items in parse
// order, echoed from the spawn prompt's tagged list; `flow-gate-decide`
// matches an open Browser item to its verdict by `index` only.
export type UiDriverItemResult = {
  index?: number;
  item: string;
  kind: (typeof ITEM_KINDS)[number];
  verdict: (typeof ITEM_VERDICTS)[number];
  reason?: string;
  snapshot_path?: string;
  screenshots: string[];
};

export const SECTION_VIEWPORTS = ["phone", "desktop", "desktop-dark"] as const;
export const SECTION_PARTS = ["whole", "start", "end"] as const;

// One screenshot of one page section, captured by the driver for the
// critique loop. Capture only: the driver never judges what it photographs.
export type SectionShot = {
  route: string;
  section: string;
  viewport: (typeof SECTION_VIEWPORTS)[number];
  part: (typeof SECTION_PARTS)[number];
  path: string;
};

export type RouteSnapshot = { route: string; path: string };

export const UI_DRIVER_CALLERS = ["verify", "review-8c"] as const;

// `headSha` (local `git rev-parse HEAD` at artifact-write time) and `caller`
// let the gate ignore an artifact from an older commit or from the verify
// stage, which writes the same path.
export type UiDriverResult = {
  headSha?: string;
  caller?: (typeof UI_DRIVER_CALLERS)[number];
  ran: boolean;
  ok: boolean;
  skipped_reason?: UiDriverSkippedReason;
  captures_path: string;
  ui_screenshots: string[];
  fix_context: UiDriverFixContextEntry[];
  item_results?: UiDriverItemResult[];
  heuristic_smells?: string[];
  data_preconditions?: string[];
  section_shots?: SectionShot[];
  route_snapshots?: RouteSnapshot[];
  rejected_alternatives: string[];
  summary: string;
};

export type ValidationOk = { ok: true; value: UiDriverResult };
export type ValidationErr = { ok: false; errors: string[] };
export type ValidationResult = ValidationOk | ValidationErr;

const FIX_CONTEXT_MAX_ENTRIES = 10;
const FIX_CONTEXT_STRING_MAX_CHARS = 300;
// Caps the LENGTH of each inner array independently of the 10-entry outer
// cap and the 300-char per-string cap — without this, a single entry's
// `consoleErrors`/`failedRequests`/`missingSelectors` array could carry an
// unbounded number of 299-char strings (e.g. 5,000 entries ~= 1.5MB) and
// re-introduce exactly the artifact bloat the 10-entry cap was meant to
// foreclose.
const FIX_CONTEXT_INNER_ARRAY_MAX_ITEMS = 20;

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

function validateCappedStrings(
  arr: unknown,
  label: string,
  required: boolean,
): string[] {
  if (arr === undefined && !required) return [];
  if (!isStringArray(arr)) {
    return [
      `'${label}' must be an array of strings${required ? "" : " when present"}`,
    ];
  }
  const errors: string[] = [];
  if (arr.length > FIX_CONTEXT_INNER_ARRAY_MAX_ITEMS) {
    errors.push(
      `'${label}' exceeds the ${FIX_CONTEXT_INNER_ARRAY_MAX_ITEMS}-item cap`,
    );
  }
  arr.forEach((s, i) => {
    if (s.length > FIX_CONTEXT_STRING_MAX_CHARS) {
      errors.push(
        `'${label}[${i}]' exceeds the ${FIX_CONTEXT_STRING_MAX_CHARS}-char cap`,
      );
    }
  });
  return errors;
}

const DATA_PRECONDITIONS_MAX_ITEMS = 10;
const SECTION_SHOTS_MAX_ENTRIES = 48;
const ROUTE_SNAPSHOTS_MAX_ENTRIES = 3;
const EVIDENCE_DIR = ".flow-tmp/ui-evidence/";

// Evidence paths must stay inside the worktree's evidence directory: a
// `..` segment or a different directory would let a crafted artifact point
// later readers (the critic, the PR body) at an arbitrary file.
function isEvidencePath(p: string): boolean {
  if (p.split(/[\\/]/).includes("..")) return false;
  const norm = p.replace(/\\/g, "/");
  return norm.startsWith(EVIDENCE_DIR) || norm.includes(`/${EVIDENCE_DIR}`);
}

function validateRouteSnapshot(entry: unknown, path: string): string[] {
  if (typeof entry !== "object" || entry === null) {
    return [`'${path}' must be an object`];
  }
  const o = entry as Record<string, unknown>;
  const errors: string[] = [];
  for (const f of ["route", "path"] as const) {
    const v = o[f];
    if (!isString(v) || v.length === 0) {
      errors.push(`'${path}.${f}' must be a non-empty string`);
    } else if (v.length > FIX_CONTEXT_STRING_MAX_CHARS) {
      errors.push(
        `'${path}.${f}' exceeds the ${FIX_CONTEXT_STRING_MAX_CHARS}-char cap`,
      );
    }
  }
  if (isString(o.path) && !isEvidencePath(o.path)) {
    errors.push(`'${path}.path' must stay under ${EVIDENCE_DIR}`);
  }
  return errors;
}

function validateSectionShot(entry: unknown, path: string): string[] {
  const errors = validateRouteSnapshot(entry, path);
  if (typeof entry !== "object" || entry === null) return errors;
  const o = entry as Record<string, unknown>;
  if (!isString(o.section) || o.section.length === 0) {
    errors.push(`'${path}.section' must be a non-empty string`);
  } else if (o.section.length > FIX_CONTEXT_STRING_MAX_CHARS) {
    errors.push(
      `'${path}.section' exceeds the ${FIX_CONTEXT_STRING_MAX_CHARS}-char cap`,
    );
  }
  if (
    !isString(o.viewport) ||
    !(SECTION_VIEWPORTS as readonly string[]).includes(o.viewport)
  ) {
    errors.push(
      `'${path}.viewport' must be one of ${SECTION_VIEWPORTS.join(", ")}`,
    );
  }
  if (
    !isString(o.part) ||
    !(SECTION_PARTS as readonly string[]).includes(o.part)
  ) {
    errors.push(`'${path}.part' must be one of ${SECTION_PARTS.join(", ")}`);
  }
  return errors;
}

function validateEntryList(
  raw: unknown,
  label: string,
  max: number,
  validate: (entry: unknown, path: string) => string[],
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [`'${label}' must be an array when present`];
  const errors: string[] = [];
  if (raw.length > max) errors.push(`'${label}' exceeds the ${max}-entry cap`);
  raw.forEach((e, i) => errors.push(...validate(e, `${label}[${i}]`)));
  return errors;
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
  if (o.item !== undefined) {
    if (!isString(o.item)) {
      errors.push(`'${path}.item' must be a string when present`);
    } else if (o.item.length > FIX_CONTEXT_STRING_MAX_CHARS) {
      errors.push(
        `'${path}.item' exceeds the ${FIX_CONTEXT_STRING_MAX_CHARS}-char cap`,
      );
    }
  }
  for (const field of [
    "consoleErrors",
    "failedRequests",
    "missingSelectors",
  ] as const) {
    errors.push(...validateCappedStrings(o[field], `${path}.${field}`, true));
  }
  for (const field of ["geometryIssues", "heuristicIssues"] as const) {
    errors.push(...validateCappedStrings(o[field], `${path}.${field}`, false));
  }
  return errors;
}

const ITEM_RESULTS_MAX_ENTRIES = 30;
const ITEM_RESULTS_MAX_SCREENSHOTS = 6;
const ITEM_RESULTS_STRING_MAX_CHARS = 300;

function validateItemResult(entry: unknown, path: string): string[] {
  if (typeof entry !== "object" || entry === null) {
    return [`'${path}' must be an object`];
  }
  const errors: string[] = [];
  const o = entry as Record<string, unknown>;
  const capped = (field: string, v: string): void => {
    if (v.length > ITEM_RESULTS_STRING_MAX_CHARS) {
      errors.push(
        `'${path}.${field}' exceeds the ${ITEM_RESULTS_STRING_MAX_CHARS}-char cap`,
      );
    }
  };
  if (!isString(o.item) || o.item.length === 0) {
    errors.push(`'${path}.item' must be a non-empty string`);
  } else capped("item", o.item);
  if (
    o.index !== undefined &&
    !(typeof o.index === "number" && Number.isInteger(o.index) && o.index > 0)
  ) {
    errors.push(`'${path}.index' must be a positive integer when present`);
  }
  const kindOk =
    isString(o.kind) && (ITEM_KINDS as readonly string[]).includes(o.kind);
  if (!kindOk) {
    errors.push(`'${path}.kind' must be one of ${ITEM_KINDS.join(", ")}`);
  }
  const verdictOk =
    isString(o.verdict) &&
    (ITEM_VERDICTS as readonly string[]).includes(o.verdict);
  if (!verdictOk) {
    errors.push(`'${path}.verdict' must be one of ${ITEM_VERDICTS.join(", ")}`);
  }
  if (kindOk && verdictOk) {
    const captureVerdict =
      o.verdict === "captured" || o.verdict === "not-captured";
    if ((o.kind === "capture") !== captureVerdict) {
      errors.push(
        `'${path}.verdict' '${String(o.verdict)}' is not valid for kind '${String(o.kind)}'`,
      );
    }
  }
  for (const field of ["reason", "snapshot_path"] as const) {
    const v = o[field];
    if (v === undefined) continue;
    if (!isString(v)) {
      errors.push(`'${path}.${field}' must be a string when present`);
    } else capped(field, v);
  }
  if (!isStringArray(o.screenshots)) {
    errors.push(`'${path}.screenshots' must be an array of strings`);
  } else {
    if (o.screenshots.length > ITEM_RESULTS_MAX_SCREENSHOTS) {
      errors.push(
        `'${path}.screenshots' exceeds the ${ITEM_RESULTS_MAX_SCREENSHOTS}-item cap`,
      );
    }
    o.screenshots.forEach((s, i) => capped(`screenshots[${i}]`, s));
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

  if (o.headSha !== undefined && !(isString(o.headSha) && o.headSha !== "")) {
    errors.push("'headSha' must be a non-empty string when present");
  }
  if (
    o.caller !== undefined &&
    !(
      isString(o.caller) &&
      (UI_DRIVER_CALLERS as readonly string[]).includes(o.caller)
    )
  ) {
    errors.push(
      `'caller' must be one of ${UI_DRIVER_CALLERS.join(", ")} when present`,
    );
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

  errors.push(
    ...validateCappedStrings(o.heuristic_smells, "heuristic_smells", false),
  );

  if (o.data_preconditions !== undefined) {
    if (!isStringArray(o.data_preconditions)) {
      errors.push("'data_preconditions' must be an array of strings");
    } else {
      if (o.data_preconditions.length > DATA_PRECONDITIONS_MAX_ITEMS) {
        errors.push(
          `'data_preconditions' exceeds the ${DATA_PRECONDITIONS_MAX_ITEMS}-item cap`,
        );
      }
      o.data_preconditions.forEach((s, i) => {
        if (s.length > FIX_CONTEXT_STRING_MAX_CHARS) {
          errors.push(
            `'data_preconditions[${i}]' exceeds the ${FIX_CONTEXT_STRING_MAX_CHARS}-char cap`,
          );
        }
      });
    }
  }
  errors.push(
    ...validateEntryList(
      o.section_shots,
      "section_shots",
      SECTION_SHOTS_MAX_ENTRIES,
      validateSectionShot,
    ),
    ...validateEntryList(
      o.route_snapshots,
      "route_snapshots",
      ROUTE_SNAPSHOTS_MAX_ENTRIES,
      validateRouteSnapshot,
    ),
  );

  if (o.item_results !== undefined) {
    if (!Array.isArray(o.item_results)) {
      errors.push("'item_results' must be an array when present");
    } else {
      if (o.item_results.length > ITEM_RESULTS_MAX_ENTRIES) {
        errors.push(
          `'item_results' exceeds the ${ITEM_RESULTS_MAX_ENTRIES}-entry cap`,
        );
      }
      o.item_results.forEach((entry, i) => {
        errors.push(...validateItemResult(entry, `item_results[${i}]`));
      });
    }
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
