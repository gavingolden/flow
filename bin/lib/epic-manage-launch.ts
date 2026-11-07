/**
 * The detached `flow epic launch` child of `flow epic manage`: start one,
 * settle it when it exits, and remember a mid-launch node across a restart.
 * The child is NEVER killed on timeout — `flow feature create` can wait 300 s
 * on the host launch semaphore, and a killed child leaves a half-created
 * pipeline (state file, no binding) that reads as drift. `launching` holds the
 * node until the child exits or a binding appears.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { managerDir } from "./epic-manager-log";
import { iso } from "./epic-manage-events";
import { slugify } from "./slug";

/** A restart holds a mid-launch node this long: the launch semaphore alone can wait 300 s. */
export const RESTART_HOLD_MS = 420_000;

export type InFlight = {
  id: string;
  startedAt: number;
  outPath: string;
  exitCode: number | null;
};

export type LaunchState = {
  epic: string;
  failed: Map<string, string>;
  launching: Map<string, number>;
  inFlight: InFlight | null;
};

export type LaunchDeps = {
  now: () => number;
  spawnLaunch: (
    args: string[],
    outPath: string,
  ) => Promise<{ exitCode: number }>;
  stateDir?: string;
};

const markerPath = (epic: string, stateDir?: string): string =>
  path.join(managerDir(epic, stateDir), "launching.json");

export function launchArgs(
  epic: string,
  id: string,
  overrides: { model?: string; effort?: string },
): string[] {
  const args = ["epic", "launch", epic, id];
  if (overrides.model) args.push("--model", overrides.model);
  if (overrides.effort) args.push("--effort", overrides.effort);
  return args;
}

/** Start the child without awaiting it: ticks keep running (and Ctrl-C stays instant) while it works. */
export function startLaunch(
  s: LaunchState,
  deps: LaunchDeps,
  id: string,
  args: string[],
): void {
  const outPath = path.join(
    managerDir(s.epic, deps.stateDir),
    `launch-${slugify(id)}.log`,
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const flight: InFlight = {
    id,
    startedAt: deps.now(),
    outPath,
    exitCode: null,
  };
  s.inFlight = flight;
  s.launching.set(id, flight.startedAt);
  deps.spawnLaunch(args, outPath).then(
    (r) => void (flight.exitCode = r.exitCode),
    () => void (flight.exitCode = -1),
  );
}

/** Fold a finished child into the state: clear `launching`, record a failure reason from its output. */
export function settleInFlight(s: LaunchState): void {
  const f = s.inFlight;
  if (!f || f.exitCode === null) return;
  s.inFlight = null;
  s.launching.delete(f.id);
  if (f.exitCode === 0) return;
  let reason = `flow epic launch exited ${f.exitCode}`;
  try {
    const last = fs
      .readFileSync(f.outPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .at(-1);
    if (last) reason = last;
  } catch {
    // no output file — keep the exit-code reason
  }
  s.failed.set(f.id, reason);
}

/** Drop a held node once its binding appears, or an orphaned restart-hold outlives its bound. */
export function expireHolds(
  s: LaunchState,
  now: number,
  bound: (id: string) => boolean,
): void {
  for (const [id, at] of [...s.launching]) {
    if (s.inFlight?.id === id) continue;
    if (bound(id) || now - at >= RESTART_HOLD_MS) s.launching.delete(id);
  }
}

/** Seed `launching` from the previous run's record and marker (restart mid-launch). */
export function seedLaunching(
  s: LaunchState,
  now: number,
  prior: { featureId: string; startedAt: string } | null,
  stateDir?: string,
): void {
  const marker = readMarker(s.epic, stateDir);
  for (const l of [prior, marker]) {
    const at = l ? Date.parse(l.startedAt) : NaN;
    if (l && Number.isFinite(at) && now - at < RESTART_HOLD_MS)
      s.launching.set(l.featureId, at);
  }
  fs.rmSync(markerPath(s.epic, stateDir), { force: true });
}

function readMarker(
  epic: string,
  stateDir?: string,
): { featureId: string; startedAt: string } | null {
  try {
    const v = JSON.parse(fs.readFileSync(markerPath(epic, stateDir), "utf8"));
    return typeof v?.featureId === "string" && typeof v?.startedAt === "string"
      ? v
      : null;
  } catch {
    return null;
  }
}

/** A graceful stop with a launch still running leaves a marker so the next start holds that node. */
export function persistMarker(s: LaunchState, stateDir?: string): void {
  const first = [...s.launching][0];
  if (!first) return;
  try {
    fs.mkdirSync(managerDir(s.epic, stateDir), { recursive: true });
    fs.writeFileSync(
      markerPath(s.epic, stateDir),
      JSON.stringify({ featureId: first[0], startedAt: iso(first[1]) }),
    );
  } catch {
    // best effort
  }
}
