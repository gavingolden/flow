/**
 * Shape owner for the committed epic status board at
 * `.flow/epics/<slug>/status.json`.
 *
 * This is the one file in the `.flow/epics/<slug>/` path contract (see
 * `bin/lib/epic-manifest-schema.ts`) that is machine-owned and re-derived —
 * it exists so `flow epic status`/`flow epic run` can see "what has actually
 * landed on the base branch" from a fresh machine with no per-machine
 * `run.json` cache, and so concurrent sibling epic PRs converge on the same
 * board regardless of merge order.
 *
 * Validation policy: fail-fast (first error wins) and strict-on-shape /
 * permissive-on-content — unknown top-level and unknown per-row keys are
 * tolerated for forward-compat.
 *
 * Deliberately no `--validate` CLI here (unlike the sibling manifest
 * schema): there is no consumer for a status-schema CLI mode, and adding one
 * would also need a `bin/lib/sources.ts` VALIDATOR_MODULES entry and a
 * `modules.ts` validators line.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { EPIC_STATUS_FILENAME } from "./epic-manifest-schema";

export { EPIC_STATUS_FILENAME };

/**
 * BINARY BY DESIGN — there is no `in-review` value. The committed board is a
 * statement about the base branch, so "has this landed" is its only
 * meaningful predicate; an in-flight state would duplicate what GitHub
 * already publishes and churn every epic PR's diff on unrelated sibling
 * activity.
 */
export type CommittedFeatureStatus = "merged" | "not-started";

/** `pr` is the PR that landed the feature, set on `merged` rows. */
export interface CommittedFeatureRow {
  status: CommittedFeatureStatus;
  pr?: number;
}

export interface EpicStatusFile {
  version: 1;
  epicId: string;
  features: Record<string, CommittedFeatureRow>;
}

export type ValidationOk = { ok: true; value: EpicStatusFile };
export type ValidationErr = { ok: false; reason: string; path?: string };
export type ValidationResult = ValidationOk | ValidationErr;

function ok(value: EpicStatusFile): ValidationOk {
  return { ok: true, value };
}

function err(reason: string, path?: string): ValidationErr {
  return { ok: false, reason, path };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

const STATUS_VALUES = ["merged", "not-started"] as const;

function validateRow(row: unknown, path: string): ValidationErr | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return err(`${path} must be an object`);
  }
  const r = row as Record<string, unknown>;
  if (!STATUS_VALUES.includes(r.status as never)) {
    return err(`${path}.status must be one of merged|not-started`);
  }
  if (r.pr !== undefined && typeof r.pr !== "number") {
    return err(`${path}.pr must be a number when present`);
  }
  // Unknown extra keys are accepted permissively for forward-compat.
  return null;
}

export function validateEpicStatus(parsed: unknown): ValidationResult {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err("status file must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  if (o.version !== 1) {
    return err("version must be 1");
  }
  if (!isNonEmptyString(o.epicId)) {
    return err("epicId must be a non-empty string");
  }
  if (
    typeof o.features !== "object" ||
    o.features === null ||
    Array.isArray(o.features)
  ) {
    return err("features must be an object");
  }
  for (const [id, row] of Object.entries(
    o.features as Record<string, unknown>,
  )) {
    const e = validateRow(row, `features.${id}`);
    if (e) return e;
  }
  return ok(parsed as EpicStatusFile);
}

export function isEpicStatus(x: unknown): x is EpicStatusFile {
  return validateEpicStatus(x).ok;
}

/**
 * CANONICAL serialization: feature keys emitted in lexicographic order,
 * 2-space indent, trailing newline. LOAD-BEARING for the concurrent-PR
 * conflict story — without an explicit sort, JS object key-insertion order
 * can reorder untouched rows and manufacture false merge conflicts. The file
 * deliberately carries no `updatedAt`/`updatedBy` field so unchanged rows
 * serialize byte-identically across concurrent PRs.
 */
export function serializeEpicStatus(file: EpicStatusFile): string {
  const sortedIds = Object.keys(file.features).sort();
  const sortedFeatures: Record<string, CommittedFeatureRow> = {};
  for (const id of sortedIds) {
    sortedFeatures[id] = file.features[id];
  }
  const ordered: EpicStatusFile = {
    version: file.version,
    epicId: file.epicId,
    features: sortedFeatures,
  };
  return JSON.stringify(ordered, null, 2) + "\n";
}

/**
 * Read `<epicDirAbs>/status.json`, tolerant — a missing file or malformed
 * content resolves to `null`, never throws.
 */
export function readCommittedStatus(epicDirAbs: string): EpicStatusFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(epicDirAbs, EPIC_STATUS_FILENAME), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = validateEpicStatus(parsed);
  return result.ok ? result.value : null;
}

/**
 * THE ONE-WAY LATCH and the SOLE mutator for a committed row. A row moves
 * `not-started -> merged` and NEVER back. Idempotent and monotone: once a
 * row is `merged` it stays `merged` (preserving its `pr` if the derived row
 * lacks one). This is the single place the rule lives, and the same
 * function a merge-conflict resolver applies ("merged wins"). There is no
 * `STATUS_ORDER` array and no downgrade path — a closed-unmerged reset is
 * unreachable by design and must not be implemented.
 */
export function advanceStatus(
  committed: CommittedFeatureRow | undefined,
  derived: CommittedFeatureRow,
): CommittedFeatureRow {
  if (committed?.status === "merged") {
    return { status: "merged", pr: committed.pr ?? derived.pr };
  }
  return derived;
}
