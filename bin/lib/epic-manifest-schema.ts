#!/usr/bin/env bun
/**
 * Schema validator + shape owner for the epic-designer layer's manifest at
 * `.flow/epics/<slug>/manifest.json`.
 *
 * Path contract: an epic lives under `.flow/epics/<slug>/` and owns exactly
 * two files — `design.md` (the human-readable design doc) and
 * `manifest.json` (the machine-readable feature DAG this module validates).
 * The filenames and the per-slug directory are exported as constants here so
 * every downstream epic feature (DAG well-formedness in F2, the ready-set
 * scheduler, `flow feature create` fan-out) resolves the same paths.
 *
 * This module OWNS the `EpicManifest` shape: all downstream epic features
 * import `EpicManifest` / `Feature` from here rather than restating the type,
 * so a change to the manifest contract has a single edit site.
 *
 * CLI mode: `flow-epic-manifest-schema --validate <path>` reads the file,
 * parses JSON, and runs `validateEpicManifest` — exit 0 (valid) /
 * 1 (off-shape, read/parse failure) / 2 (usage).
 *
 * Validation policy: fail-fast (first error wins) and strict-on-shape /
 * permissive-on-content. Required strings must be non-empty but are NOT
 * parsed for ISO-8601 / slug structure; `flowNewHints` accepts unknown extra
 * keys for forward-compat while type-checking the keys it knows. DAG
 * well-formedness (cycles, orphans, the ready-set) is explicitly out of scope
 * here — that is F2's job.
 */

import { EFFORT_LEVELS, type EffortLevel } from "./state";

/** A single node in the epic's feature DAG. */
export interface Feature {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  rationale?: string;
  acceptanceCriteria?: string[];
  flowNewHints?: {
    autoMerge?: boolean;
    // Restated inline: state.ts exports this literal union only via the
    // PipelineState.copilotReview field, not as a named exported type.
    copilotReview?: "auto" | "always" | "never";
    effort?: EffortLevel;
  };
  mvp?: boolean;
}

export interface EpicManifest {
  epicId: string;
  prompt: string;
  createdAt: string;
  features: Feature[];
}

export const EPIC_MANIFEST_FILENAME = "manifest.json";
export const EPIC_DESIGN_FILENAME = "design.md";

/** The per-slug epic directory, repo-relative. */
export function epicDirRelative(slug: string): string {
  return `.flow/epics/${slug}`;
}

export type ValidationOk = { ok: true; value: EpicManifest };
export type ValidationErr = { ok: false; reason: string; path?: string };
export type ValidationResult = ValidationOk | ValidationErr;

function ok(value: EpicManifest): ValidationOk {
  return { ok: true, value };
}

function err(reason: string, path?: string): ValidationErr {
  return { ok: false, reason, path };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

const COPILOT_REVIEW_VALUES = ["auto", "always", "never"] as const;

function validateFlowNewHints(
  hints: unknown,
  path: string,
): ValidationErr | null {
  if (typeof hints !== "object" || hints === null || Array.isArray(hints)) {
    return err(`${path} must be an object`);
  }
  const h = hints as Record<string, unknown>;
  if (h.autoMerge !== undefined && typeof h.autoMerge !== "boolean") {
    return err(`${path}.autoMerge must be a boolean`);
  }
  if (
    h.copilotReview !== undefined &&
    !COPILOT_REVIEW_VALUES.includes(h.copilotReview as never)
  ) {
    return err(`${path}.copilotReview must be one of auto|always|never`);
  }
  if (
    h.effort !== undefined &&
    !EFFORT_LEVELS.includes(h.effort as EffortLevel)
  ) {
    return err(`${path}.effort must be one of ${EFFORT_LEVELS.join("|")}`);
  }
  // Unknown extra keys are accepted permissively for forward-compat.
  return null;
}

function validateFeature(feature: unknown, path: string): ValidationErr | null {
  if (
    typeof feature !== "object" ||
    feature === null ||
    Array.isArray(feature)
  ) {
    return err(`${path} must be an object`);
  }
  const f = feature as Record<string, unknown>;
  if (!isNonEmptyString(f.id)) {
    return err(`${path}.id must be a non-empty string`);
  }
  if (!isNonEmptyString(f.title)) {
    return err(`${path}.title must be a non-empty string`);
  }
  if (!isNonEmptyString(f.description)) {
    return err(`${path}.description must be a non-empty string`);
  }
  if (!Array.isArray(f.dependsOn)) {
    return err(`${path}.dependsOn must be an array`);
  }
  for (let i = 0; i < f.dependsOn.length; i++) {
    if (typeof f.dependsOn[i] !== "string") {
      return err(`${path}.dependsOn[${i}] must be a string`);
    }
  }
  if (f.rationale !== undefined && typeof f.rationale !== "string") {
    return err(`${path}.rationale must be a string when present`);
  }
  if (f.acceptanceCriteria !== undefined) {
    if (!Array.isArray(f.acceptanceCriteria)) {
      return err(`${path}.acceptanceCriteria must be an array when present`);
    }
    for (let i = 0; i < f.acceptanceCriteria.length; i++) {
      if (typeof f.acceptanceCriteria[i] !== "string") {
        return err(`${path}.acceptanceCriteria[${i}] must be a string`);
      }
    }
  }
  if (f.mvp !== undefined && typeof f.mvp !== "boolean") {
    return err(`${path}.mvp must be a boolean when present`);
  }
  if (f.flowNewHints !== undefined) {
    const e = validateFlowNewHints(f.flowNewHints, `${path}.flowNewHints`);
    if (e) return e;
  }
  return null;
}

export function validateEpicManifest(parsed: unknown): ValidationResult {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err("manifest must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  if (!isNonEmptyString(o.epicId)) {
    return err("epicId must be a non-empty string");
  }
  if (!isNonEmptyString(o.prompt)) {
    return err("prompt must be a non-empty string");
  }
  if (!isNonEmptyString(o.createdAt)) {
    return err("createdAt must be a non-empty string");
  }
  if (!Array.isArray(o.features)) {
    return err("features must be an array");
  }
  for (let i = 0; i < o.features.length; i++) {
    const e = validateFeature(o.features[i], `features[${i}]`);
    if (e) return e;
  }
  return ok(parsed as EpicManifest);
}

export function isEpicManifest(x: unknown): x is EpicManifest {
  return validateEpicManifest(x).ok;
}

async function cliMain(argv: string[]): Promise<number> {
  const flagIdx = argv.indexOf("--validate");
  if (flagIdx === -1 || flagIdx === argv.length - 1) {
    process.stderr.write(
      "usage: epic-manifest-schema --validate <path-to-manifest.json>\n",
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

  const result = validateEpicManifest(parsed);
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
