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
import type { EpicStatusFile } from "./epic-status-schema";

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
  /**
   * True when the row's `merged` status came from outside live pipeline
   * state: an external completion record (no live slug) or a committed
   * `merged` row that outranked an `orphan` record (slug still present).
   */
  external?: boolean;
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

/**
 * A `ReconcileResult` summary label, derived purely from the result — NOT a
 * recomputation of the frontier or any change to `reconcile()`. With the tick
 * loop gone this is a **board-summary hypothesis hint** the `flow epic status
 * --json` payload surfaces for the playbook LLM to weigh against GitHub/git
 * truth — a hint, never a control signal:
 *
 *   - `green`    — in-flight/ready work, nothing halted.
 *   - `halt`     — one or more features sit in a `HALT_STATUSES` state.
 *   - `deadlock` — `epicStatus === "blocked"` with NO halted blockers and not
 *                  all merged (the frontier is empty but the epic is not done).
 *   - `done`     — all features merged.
 */
export type EpicEvent =
  | { kind: "green" }
  | { kind: "halt"; haltedIds: string[] }
  | { kind: "deadlock" }
  | { kind: "done" };

/**
 * Classify a tick's `ReconcileResult` into an `EpicEvent`. Precedence:
 * `done` (all merged) ⇒ a halted feature anywhere on the board ⇒ a no-halted-
 * blocker `blocked` deadlock ⇒ otherwise `green`. Halt outranks deadlock so a
 * `blocked` epic whose block IS a halted feature surfaces its ids (the
 * actionable case) rather than a generic deadlock; an independent branch still
 * running alongside a halted feature is still a `halt`, since judgment is owed
 * on the halted id regardless of `epicStatus`.
 */
export function classifyEvent(result: ReconcileResult): EpicEvent {
  if (result.epicStatus === "done") return { kind: "done" };
  const haltedIds = result.board
    .filter((row) => HALT_STATUSES.has(row.status))
    .map((row) => row.id);
  if (haltedIds.length > 0) return { kind: "halt", haltedIds };
  if (result.epicStatus === "blocked") return { kind: "deadlock" };
  return { kind: "green" };
}

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
  /**
   * The committed status board — a `completed` FLOOR, never an override. A
   * feature with NO `run.json` record and a committed `merged` row
   * classifies `merged` (so the frontier math is right on a fresh machine
   * with no per-machine cache); a committed `not-started` row leaves the
   * feature exactly as it is today. A PRESENT `run.json` record always wins
   * — with a single named exception: a record classified `orphan` (launched
   * but no live state file) is outranked by a committed `merged` row, since
   * an orphan carries no live judgment to protect and the committed row is
   * verified-done truth. Any other live classification (`running`, `gated`,
   * `needs-human`, `cancelled`, `merged`) still wins over the committed row.
   */
  committedStatus?: EpicStatusFile | null;
}): ReconcileResult {
  const { manifest, runState, maxParallel } = input;
  // Same identity guard as flow-epic-sync.ts's committed-status read: a
  // PR-authored status.json claiming authority over a different epic than
  // the one being reconciled must never override a live `orphan` record.
  const committedStatus =
    input.committedStatus && input.committedStatus.epicId === manifest.epicId
      ? input.committedStatus
      : null;
  const readFeatureState =
    input.readFeatureState ?? ((slug: string) => readState(slug));

  const features = manifest.features;
  const launchedIds = new Set(Object.keys(runState.features));

  // Pass 1: status of every launched feature (the rest are ready/blocked,
  // resolved after the frontier is known). An external-completion record (an
  // out-of-band PR/issue ref, no live slug) classifies as `merged` without
  // reading any pipeline state — it is verified-done truth recorded in the
  // cache.
  const launchedStatus = new Map<string, FeatureStatus>();
  const liveState = new Map<string, PipelineState | null>();
  const externalIds = new Set<string>();
  // Features whose `orphan` record is outranked by a committed `merged` row
  // (the single named exception to "a present record always wins" above).
  const committedOverrideIds = new Set<string>();
  for (const f of features) {
    const record = runState.features[f.id];
    if (!record) continue;
    if (record.external && !record.slug) {
      externalIds.add(f.id);
      launchedStatus.set(f.id, "merged");
      continue;
    }
    const state = record.slug ? readFeatureState(record.slug) : null;
    liveState.set(f.id, state);
    const classified = classifyLaunched(state);
    if (
      classified === "orphan" &&
      committedStatus?.features[f.id]?.status === "merged"
    ) {
      committedOverrideIds.add(f.id);
      launchedStatus.set(f.id, "merged");
    } else {
      launchedStatus.set(f.id, classified);
    }
  }

  // Committed-board floor: a feature with NO run.json record but a committed
  // `merged` row counts as completed too — a PRESENT record always wins,
  // except an `orphan` record (handled above; committedFloorIds is only
  // consulted for features with no record at all).
  const committedFloorIds = new Set<string>();
  for (const f of features) {
    if (runState.features[f.id]) continue;
    if (committedStatus?.features[f.id]?.status === "merged") {
      committedFloorIds.add(f.id);
    }
  }

  const completed = new Set(
    features
      .filter(
        (f) =>
          launchedStatus.get(f.id) === "merged" || committedFloorIds.has(f.id),
      )
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
      if (externalIds.has(f.id)) {
        return {
          id: f.id,
          status: "merged" as const,
          pr: record.pr,
          dependsOn: f.dependsOn,
          external: true,
        };
      }
      const state = liveState.get(f.id) ?? null;
      const overridden = committedOverrideIds.has(f.id);
      return {
        id: f.id,
        status: launchedStatus.get(f.id)!,
        slug: record.slug,
        pr: overridden
          ? (committedStatus?.features[f.id]?.pr ?? record.pr)
          : (state?.pr ?? record.pr),
        phase: state?.phase,
        dependsOn: f.dependsOn,
        ...(overridden ? { external: true } : {}),
      };
    }
    if (committedFloorIds.has(f.id)) {
      return {
        id: f.id,
        status: "merged" as const,
        pr: committedStatus?.features[f.id]?.pr,
        dependsOn: f.dependsOn,
        external: true,
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
