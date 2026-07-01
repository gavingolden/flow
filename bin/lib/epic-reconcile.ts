/**
 * The deterministic reconcile tick — pure, no side effects (no spawning, no
 * writes; those live in the verb layer). Given the committed manifest, the
 * runtime state (which features were launched + their slugs), and a seam that
 * reads each feature's live pipeline phase, it returns:
 *
 *   - `board`     — one ordered row per manifest feature with its status.
 *   - `summary`   — the ready/running/blocked/merged counts.
 *   - `toLaunch`  — the frontier features to hand to `flow feature create` this tick,
 *                   capped at `maxParallel − runningCount`.
 *   - `epicStatus`— `done` (all merged) / `blocked` (frontier empty, nothing
 *                   running, not all merged — a halted/deadlocked subtree) /
 *                   `running` (otherwise).
 *
 * A `gated` / `needs-human` feature blocks ONLY its downstream subtree: it is
 * not in `completed`, so `computeFrontier` naturally withholds its dependents
 * while independent ready branches still populate `toLaunch`.
 */

import { computeFrontier } from "../flow-epic-dag";
import type { EpicManifest, Feature } from "./epic-manifest-schema";
import type { EpicRunState } from "./epic-run-state";
import { readState, TERMINAL_PHASE_SET, type PipelineState } from "./state";

export type FeatureStatus =
  | "ready"
  | "blocked"
  | "running"
  | "merged"
  | "gated"
  | "needs-human"
  | "cancelled"
  | "orphan";

/** Halt statuses that block their downstream subtree (named when an epic blocks). */
export const HALT_STATUSES: ReadonlySet<FeatureStatus> = new Set<FeatureStatus>(
  ["gated", "needs-human", "cancelled", "orphan"],
);

export type BoardRow = {
  id: string;
  status: FeatureStatus;
  slug?: string;
  pr?: number;
  phase?: string;
  dependsOn: string[];
};

export type ReconcileSummary = {
  ready: number;
  running: number;
  blocked: number;
  merged: number;
  total: number;
};

export type EpicStatus = "running" | "done" | "blocked";

export type ReconcileResult = {
  board: BoardRow[];
  summary: ReconcileSummary;
  toLaunch: Feature[];
  epicStatus: EpicStatus;
};

/** Seam to read a feature's live pipeline state (default: state.ts readState). */
export type ReadFeatureState = (slug: string) => PipelineState | null;

/**
 * Classify a launched feature from its live pipeline phase. `merged` ⇒ done;
 * the other terminal phases (`gated`/`needs-human`/`cancelled`) surface as
 * themselves and halt their subtree; a null state is an `orphan` (launched but
 * no state file yet / lost); anything non-terminal is `running`.
 */
function classifyLaunched(state: PipelineState | null): FeatureStatus {
  if (state === null) return "orphan";
  const phase = state.phase;
  if (phase === "merged") return "merged";
  if (phase === "gated") return "gated";
  if (phase === "needs-human") return "needs-human";
  if (phase === "cancelled") return "cancelled";
  // Any other terminal phase (none today beyond the four above) is treated as a
  // non-advancing halt; non-terminal phases are live work.
  return TERMINAL_PHASE_SET.has(phase) ? "orphan" : "running";
}

export function reconcile(input: {
  manifest: EpicManifest;
  runState: EpicRunState;
  readFeatureState?: ReadFeatureState;
  maxParallel: number;
}): ReconcileResult {
  const { manifest, runState, maxParallel } = input;
  const readFeatureState =
    input.readFeatureState ?? ((slug: string) => readState(slug));

  const features = manifest.features;
  const launchedIds = new Set(Object.keys(runState.features));

  // Pass 1: status of every launched feature (the rest are ready/blocked,
  // resolved after the frontier is known).
  const launchedStatus = new Map<string, FeatureStatus>();
  const liveState = new Map<string, PipelineState | null>();
  for (const f of features) {
    const record = runState.features[f.id];
    if (!record) continue;
    const state = readFeatureState(record.slug);
    liveState.set(f.id, state);
    launchedStatus.set(f.id, classifyLaunched(state));
  }

  const completed = new Set(
    features
      .filter((f) => launchedStatus.get(f.id) === "merged")
      .map((f) => f.id),
  );
  const runningCount = [...launchedStatus.values()].filter(
    (s) => s === "running",
  ).length;

  const frontier = computeFrontier(features, {
    completed,
    launched: launchedIds,
  });
  const frontierIds = new Set(frontier.map((f) => f.id));

  // Build the ordered board.
  const board: BoardRow[] = features.map((f) => {
    const record = runState.features[f.id];
    if (record) {
      const state = liveState.get(f.id) ?? null;
      return {
        id: f.id,
        status: launchedStatus.get(f.id)!,
        slug: record.slug,
        pr: state?.pr ?? record.pr,
        phase: state?.phase,
        dependsOn: f.dependsOn,
      };
    }
    return {
      id: f.id,
      status: frontierIds.has(f.id) ? "ready" : "blocked",
      dependsOn: f.dependsOn,
    };
  });

  const capacity = Math.max(0, maxParallel - runningCount);
  const toLaunch = frontier.slice(0, capacity);

  const done = completed.size === features.length;
  let epicStatus: EpicStatus;
  if (done) {
    epicStatus = "done";
  } else if (runningCount === 0 && frontier.length === 0) {
    epicStatus = "blocked";
  } else {
    epicStatus = "running";
  }

  const summary: ReconcileSummary = {
    ready: board.filter((r) => r.status === "ready").length,
    running: runningCount,
    blocked: board.filter((r) => r.status === "blocked").length,
    merged: completed.size,
    total: features.length,
  };

  return { board, summary, toLaunch, epicStatus };
}
