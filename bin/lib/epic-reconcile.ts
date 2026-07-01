/**
 * The deterministic reconcile tick — pure, no side effects (no spawning, no
 * writes; those live in the verb layer). Given the committed manifest, the
 * runtime state (which features were launched + their slugs), and a seam that
 * reads each feature's live pipeline phase, it returns:
 *
 *   - `board`     — one ordered row per manifest feature with its status.
 *   - `summary`   — the ready/running/blocked/merged counts.
 *   - `toLaunch`  — the frontier features to hand to `flow new` this tick,
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
import type { ReadClosedSubIssues } from "./epic-adopt";
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
  /** True when this row's `merged` status came FROM externally-merged adoption
   * (its `flow-epic` sub-issue is closed) rather than a live `merged` pipeline
   * phase — whether or not it also has a run.json record. */
  adopted?: boolean;
  /** The adopted node's GitHub sub-issue number, when resolvable; omitted otherwise. */
  issueNumber?: number;
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
 * The `/epic-run` event taxonomy the LLM-judgment layer branches on, derived
 * purely from a `ReconcileResult` — NOT a recomputation of the frontier or any
 * change to `reconcile()`:
 *
 *   - `green`    — in-flight/ready work, nothing halted (no judgment needed).
 *   - `halt`     — one or more features sit in a `HALT_STATUSES` state; the
 *                  judgment layer interprets each halted id.
 *   - `deadlock` — `epicStatus === "blocked"` with NO halted blockers and not
 *                  all merged (the frontier is empty but the epic is not done —
 *                  today's `blockers.length === 0` blocked branch in epic.ts).
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
  /**
   * Seam that reports which feature ids are already merged externally (their
   * `flow-epic` sub-issue is CLOSED), mapped to their sub-issue number.
   * Defaults to a no-op empty Map so reconcile stays PURE and every existing
   * caller is network-free.
   */
  readClosedSubIssues?: ReadClosedSubIssues;
  maxParallel: number;
}): ReconcileResult {
  const { manifest, runState, maxParallel } = input;
  const readFeatureState =
    input.readFeatureState ?? ((slug: string) => readState(slug));
  const readClosedSubIssues =
    input.readClosedSubIssues ?? (() => new Map<string, number>());

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

  // Adopt externally-merged nodes: a feature whose flow-epic sub-issue is CLOSED
  // counts as merged even when absent from run.json. The Map's KEYS union into
  // `completed` (which dedups), so a node both merged-in-run and closed counts
  // exactly once; the values carry each adopted node's sub-issue number for
  // board provenance. Injected seam only — reconcile fires no gh/fs itself; the
  // default is a no-op empty Map.
  const epicSlug = runState.epicSlug || manifest.epicId;
  const adoptedIds = readClosedSubIssues({
    epicSlug,
    featureIds: features.map((f) => f.id),
  });
  for (const id of adoptedIds.keys()) completed.add(id);

  // Exclude ids that `completed` (via adoption) has promoted to merged: an
  // externally-merged feature is done, not running, even if its own pipeline
  // record still reads a live `running` phase. Counting it as running would
  // both inflate `summary.running` past the merged board row and steal a launch
  // slot for a feature that no longer needs one.
  const runningCount = [...launchedStatus.entries()].filter(
    ([id, s]) => s === "running" && !completed.has(id),
  ).length;

  const frontier = computeFrontier(features, {
    completed,
    launched: launchedIds,
  });
  const frontierIds = new Set(frontier.map((f) => f.id));

  // Build the ordered board. Invariant: any id in `completed` renders `merged`
  // — including a run.json-record row whose live phase is non-merged (e.g. a
  // still-running/orphan pipeline whose sub-issue was closed externally). This
  // keeps `summary.merged` consistent with the count of merged rows. A row
  // whose merged-ness comes from adoption (present in the seam Map) carries
  // `adopted: true` + `issueNumber` for `merged (external #<n>)` provenance.
  const board: BoardRow[] = features.map((f) => {
    const record = runState.features[f.id];
    const adoptionNumber = adoptedIds.get(f.id);
    if (record) {
      const state = liveState.get(f.id) ?? null;
      const liveStatus = launchedStatus.get(f.id)!;
      const merged = completed.has(f.id);
      const row: BoardRow = {
        id: f.id,
        status: merged ? "merged" : liveStatus,
        slug: record.slug,
        pr: state?.pr ?? record.pr,
        phase: state?.phase,
        dependsOn: f.dependsOn,
      };
      // Only mark adopted when the merged status came FROM adoption, not from a
      // live `merged` phase — a genuinely run-merged row keeps its normal
      // render even if its sub-issue also happens to be closed.
      if (merged && liveStatus !== "merged" && adoptionNumber !== undefined) {
        row.adopted = true;
        row.issueNumber = adoptionNumber;
      }
      return row;
    }
    // No run.json record: an id adopted as externally-merged must render
    // `merged` (with adopted provenance) rather than falling through to
    // ready/blocked.
    if (completed.has(f.id)) {
      const row: BoardRow = {
        id: f.id,
        status: "merged",
        adopted: true,
        dependsOn: f.dependsOn,
      };
      if (adoptionNumber !== undefined) row.issueNumber = adoptionNumber;
      return row;
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
    // Count merged ROWS (not `completed.size`) so the summary can never skew
    // from the board — the two are provably equal since every completed id
    // renders a merged row, but deriving from the board makes the invariant
    // self-evident.
    merged: board.filter((r) => r.status === "merged").length,
    total: features.length,
  };

  return { board, summary, toLaunch, epicStatus };
}
