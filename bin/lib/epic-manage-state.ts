/**
 * `~/.flow/state/managers/<epic>/manager.json` — the liveness record of one
 * `flow epic manage` sequencer. The directory itself (and `log.jsonl`) belong
 * to `epic-manager-log.ts`; this module owns only the state file: typed
 * read/write/remove/list, the singleton claim, and health classification.
 *
 * Writes are atomic (tmp + rename) under a short-timeout lock so the loop's
 * heartbeat never blocks Ctrl-C and a reader never sees a torn file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { managerDir } from "./epic-manager-log";
import { livenessOf, type LivenessDeps } from "./liveness";
import { withFileLockSync } from "./lock";
import { relativeTime } from "./time";
import { EFFORT_LEVELS, MODEL_ALIASES } from "./state";
import type { EffortLevel, ModelAlias } from "./state";

export const MANAGER_STATE_FILENAME = "manager.json";

const LOCK_OPTS = { timeoutMs: 500, pollMs: 25 } as const;

export type ManagerState = {
  version: 1;
  epicSlug: string;
  repo: string;
  window: string;
  pid: number;
  /** `pidStartEpoch` of this process; null when `ps` could not read it. */
  procStartedAt: number | null;
  startedAt: string;
  heartbeatAt: string;
  pollMs: number;
  autonomy: "observe";
  model: ModelAlias;
  effort: EffortLevel;
  featureFallback: { model?: ModelAlias; effort?: EffortLevel };
  status: "running" | "done";
  launching: { featureId: string; startedAt: string } | null;
};

export function managerWindowName(epicSlug: string): string {
  return `manage-${epicSlug}`;
}

function statePath(epicSlug: string, stateDir?: string): string {
  return path.join(managerDir(epicSlug, stateDir), MANAGER_STATE_FILENAME);
}

function lockPath(epicSlug: string, stateDir?: string): string {
  return path.join(managerDir(epicSlug, stateDir), "manager.lock");
}

function isManagerState(x: unknown): x is ManagerState {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o.version === 1 &&
    typeof o.epicSlug === "string" &&
    typeof o.repo === "string" &&
    typeof o.window === "string" &&
    typeof o.pid === "number" &&
    (o.procStartedAt === null || typeof o.procStartedAt === "number") &&
    typeof o.startedAt === "string" &&
    typeof o.heartbeatAt === "string" &&
    typeof o.pollMs === "number" &&
    o.autonomy === "observe" &&
    (MODEL_ALIASES as readonly string[]).includes(o.model as string) &&
    (EFFORT_LEVELS as readonly string[]).includes(o.effort as string) &&
    typeof o.featureFallback === "object" &&
    o.featureFallback !== null &&
    (o.status === "running" || o.status === "done")
  );
}

export function readManager(
  epicSlug: string,
  stateDir?: string,
): ManagerState | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(statePath(epicSlug, stateDir), "utf8"),
    );
    return isManagerState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeAtomic(state: ManagerState, stateDir?: string): void {
  const target = statePath(state.epicSlug, stateDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, target);
}

export function writeManager(state: ManagerState, stateDir?: string): void {
  fs.mkdirSync(managerDir(state.epicSlug, stateDir), { recursive: true });
  withFileLockSync(
    lockPath(state.epicSlug, stateDir),
    () => writeAtomic(state, stateDir),
    LOCK_OPTS,
  );
}

export function removeManager(epicSlug: string, stateDir?: string): void {
  fs.mkdirSync(managerDir(epicSlug, stateDir), { recursive: true });
  withFileLockSync(
    lockPath(epicSlug, stateDir),
    () => fs.rmSync(statePath(epicSlug, stateDir), { force: true }),
    LOCK_OPTS,
  );
}

/**
 * Atomically claim the singleton: under the manager lock, refuse when a LIVE
 * (or stalled-but-running) manager already holds the record, else write
 * `state`. A record whose process is gone is a crash leftover and is replaced.
 */
export function claimManager(
  state: ManagerState,
  nowMs: number,
  deps: LivenessDeps = {},
  stateDir?: string,
): { ok: true } | { ok: false; existing: ManagerState } {
  fs.mkdirSync(managerDir(state.epicSlug, stateDir), { recursive: true });
  return withFileLockSync(
    lockPath(state.epicSlug, stateDir),
    () => {
      const existing = readManager(state.epicSlug, stateDir);
      if (existing && managerHealth(existing, nowMs, deps).kind !== "stopped") {
        return { ok: false as const, existing };
      }
      writeAtomic(state, stateDir);
      return { ok: true as const };
    },
    LOCK_OPTS,
  );
}

export function listManagers(stateDir?: string): ManagerState[] {
  const root = path.join(managerDir("", stateDir));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ManagerState[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = readManager(e.name, stateDir);
    if (m) out.push(m);
  }
  return out;
}

export type ManagerHealth =
  | { kind: "live" | "stalled"; heartbeatAgeMs: number }
  | { kind: "stopped" };

/**
 * `stopped` when the recorded process is gone (or its pid was recycled);
 * `stalled` when it is alive but its heartbeat is older than 3 × `pollMs`
 * (a `done` manager parked on its final board never stalls); else `live`. A
 * null `procStartedAt` (`ps` failed at start) degrades to a bare pid-alive
 * check.
 */
export function managerHealth(
  state: ManagerState,
  nowMs: number,
  deps: LivenessDeps = {},
): ManagerHealth {
  const verdict =
    state.procStartedAt === null
      ? livenessOf(
          { pid: state.pid, procStartedAt: 0 },
          { ...deps, pidStartEpoch: () => 0 },
        )
      : livenessOf(
          { pid: state.pid, procStartedAt: state.procStartedAt },
          deps,
        );
  if (verdict !== "alive") return { kind: "stopped" };
  const heartbeatAgeMs = Math.max(0, nowMs - Date.parse(state.heartbeatAt));
  if (state.status !== "done" && heartbeatAgeMs > 3 * state.pollMs) {
    return { kind: "stalled", heartbeatAgeMs };
  }
  return { kind: "live", heartbeatAgeMs };
}

export type SequencerView = {
  window: string;
  health: "live" | "stalled" | "stopped";
  heartbeatAgeMs?: number;
  model: ModelAlias;
  effort: EffortLevel;
  autonomy: "observe";
};

/** The `flow epic status --json` `sequencer` field: null when no record exists. */
export function sequencerView(
  epicSlug: string,
  nowMs: number,
  stateDir?: string,
  deps?: LivenessDeps,
): SequencerView | null {
  const m = readManager(epicSlug, stateDir);
  if (!m) return null;
  const h = managerHealth(m, nowMs, deps);
  return {
    window: m.window,
    health: h.kind,
    ...(h.kind === "stopped" ? {} : { heartbeatAgeMs: h.heartbeatAgeMs }),
    model: m.model,
    effort: m.effort,
    autonomy: m.autonomy,
  };
}

/** The one trailing `sequencer:` line of `flow epic status`. */
export function sequencerLine(
  epicSlug: string,
  view: SequencerView | null,
): string {
  if (!view || view.health === "stopped") {
    return `sequencer: none — start one with flow epic manage ${epicSlug}`;
  }
  const age = relativeTime(0, view.heartbeatAgeMs ?? 0);
  return view.health === "live"
    ? `sequencer: live in window ${view.window} · heartbeat ${age} · ${view.model}/${view.effort} · ${view.autonomy}`
    : `sequencer: stalled — last heartbeat ${age} (window ${view.window})`;
}
