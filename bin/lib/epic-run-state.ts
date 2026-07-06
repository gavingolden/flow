/**
 * Per-machine epic-orchestrator runtime state at `~/.flow/epics/<slug>/run.json`.
 *
 * Mirrors `state.ts`'s typed-state + type-guard + read/write/list idiom, with
 * one structural divergence: the path is NESTED — a per-slug directory under
 * `FLOW_EPICS_DIR` holding `run.json` — not `state.ts`'s flat
 * `<slug>.json`. So `writeEpicRunState` mkdirs the per-slug dir and
 * `listEpicRunStates` enumerates SUBDIRS that contain a `run.json`, not bare
 * `*.json` files.
 *
 * This is the recomputable runtime cache (feature id → launched slug + last
 * seen status). Truth is the committed manifest + each feature's
 * `~/.flow/state/<slug>.json`; this file is never committed and can be removed
 * by hand. The orchestrator records `manifestPath` + `manifestSha` to detect
 * drift against the committed design artifact it reads read-only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FLOW_EPICS_DIR } from "./paths";

export const EPIC_RUN_STATE_FILENAME = "run.json";

/**
 * A single feature's runtime record. A record is one of two shapes, and the
 * type guard requires at least one of them (never neither):
 *
 *   - slug-bound   — `slug` + `launchedAt` set (a launched flow pipeline).
 *   - external     — `external` set (a completed out-of-band PR/issue ref, no
 *                    live slug), typically with `completedAt`.
 *
 * A record is never BOTH slug-bound and external — `flow epic bind --external`
 * on an already-slug-bound record moves the old slug into `priorSlugs` and drops
 * `slug`, so the reconciler's classification stays unambiguous.
 *
 * The judgment-era fields (`retryCount`, `redirectCount`, `lastJudgment`,
 * `runnerPhase`, `modelJudge`) were dropped with the tick loop. Old run.json
 * files carrying them still validate — the guard never checks unknown keys and
 * never strips them, so a read-modify-write preserves them.
 */
export type FeatureRunRecord = {
  /** The authoritative slug `flow feature create` minted; absent on an external record. */
  slug?: string;
  /** ISO timestamp the pipeline was launched; absent on an external record. */
  launchedAt?: string;
  /** Free-form PR/issue ref for a completed out-of-band feature (no live slug). */
  external?: string;
  /** ISO timestamp an external completion was recorded; absent otherwise. */
  completedAt?: string;
  /** Last observed PR number for the feature's pipeline, when known. */
  pr?: number;
  /** Last observed pipeline phase for the feature, when known. */
  lastStatus?: string;
  /** Slugs of pipelines abandoned by prior rebinds (lineage/audit); absent ⇒ none. */
  priorSlugs?: string[];
};

export type EpicRunState = {
  epicSlug: string;
  repo: string;
  /** Absolute path to the committed `.flow/epics/<slug>/manifest.json`. */
  manifestPath: string;
  /** sha256 of the committed manifest at run time (drift detection). */
  manifestSha: string;
  /** Concurrency-capacity hint; absent ⇒ resolve via `readEpicMaxParallel`. */
  maxParallel?: number;
  createdAt: string;
  updatedAt: string;
  features: Record<string, FeatureRunRecord>;
};

export function epicRunStatePath(slug: string, dir = FLOW_EPICS_DIR): string {
  return path.join(dir, slug, EPIC_RUN_STATE_FILENAME);
}

function isFeatureRunRecord(x: unknown): x is FeatureRunRecord {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  // A present-but-wrong-typed known key still rejects; only the absence of a
  // key is tolerated. A record must carry at least a slug OR an external ref.
  if (o.slug !== undefined && typeof o.slug !== "string") return false;
  if (o.launchedAt !== undefined && typeof o.launchedAt !== "string")
    return false;
  if (o.external !== undefined && typeof o.external !== "string") return false;
  if (o.completedAt !== undefined && typeof o.completedAt !== "string")
    return false;
  const hasSlug = typeof o.slug === "string" && o.slug.length > 0;
  const hasExternal = typeof o.external === "string" && o.external.length > 0;
  if (!hasSlug && !hasExternal) return false;
  if (o.pr !== undefined && typeof o.pr !== "number") return false;
  if (o.lastStatus !== undefined && typeof o.lastStatus !== "string")
    return false;
  if (
    o.priorSlugs !== undefined &&
    (!Array.isArray(o.priorSlugs) ||
      !o.priorSlugs.every((s) => typeof s === "string"))
  )
    return false;
  return true;
}

function isFeatureMap(x: unknown): x is Record<string, FeatureRunRecord> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  for (const v of Object.values(x as Record<string, unknown>)) {
    if (!isFeatureRunRecord(v)) return false;
  }
  return true;
}

export function isEpicRunState(x: unknown): x is EpicRunState {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.epicSlug !== "string") return false;
  if (typeof o.repo !== "string") return false;
  if (typeof o.manifestPath !== "string") return false;
  if (typeof o.manifestSha !== "string") return false;
  if (
    o.maxParallel !== undefined &&
    (typeof o.maxParallel !== "number" || !Number.isFinite(o.maxParallel))
  )
    return false;
  if (typeof o.createdAt !== "string") return false;
  if (typeof o.updatedAt !== "string") return false;
  if (!isFeatureMap(o.features)) return false;
  return true;
}

export function readEpicRunState(
  slug: string,
  dir = FLOW_EPICS_DIR,
): EpicRunState | null {
  const file = epicRunStatePath(slug, dir);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isEpicRunState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeEpicRunState(
  state: EpicRunState,
  dir = FLOW_EPICS_DIR,
): void {
  fs.mkdirSync(path.join(dir, state.epicSlug), { recursive: true });
  fs.writeFileSync(
    epicRunStatePath(state.epicSlug, dir),
    JSON.stringify(state, null, 2) + "\n",
  );
}

/**
 * Remove the per-machine `<dir>/<slug>/` run-state directory recursively.
 * Returns `true` when the directory existed and was removed, `false` when it
 * was absent or removal failed. Mirrors `deleteState` in `state.ts`; this is
 * recomputable runtime cache, so a failed/absent removal is a soft `false`,
 * never a throw.
 */
export function deleteEpicRunState(
  slug: string,
  dir = FLOW_EPICS_DIR,
): boolean {
  const target = path.join(dir, slug);
  try {
    if (!fs.existsSync(target)) return false;
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Every epic whose `~/.flow/epics/<slug>/run.json` parses to a valid state. */
export function listEpicRunStates(dir = FLOW_EPICS_DIR): EpicRunState[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const states: EpicRunState[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const state = readEpicRunState(e.name, dir);
    if (state) states.push(state);
  }
  return states;
}
