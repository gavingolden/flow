/**
 * Result shapes and on-disk bookkeeping for the worktree sweep: the throttle
 * stamp, the lock path and the last-result file. They live under
 * `<stateDir>/worktree-sweep/`, never as a `*.json` at the state root (the
 * record lister would read that as a phantom pipeline named `last`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ReadConfigFile } from "./models-config";
import { FLOW_STATE_DIR } from "./paths";
import type { FactDeps } from "./worktree-sweep-facts";
import type { HuskCause } from "./worktree-sweep-rules";

export const WORKTREE_SWEEP_THROTTLE_MS = 3_600_000;
export const WORKTREE_SWEEP_DEADLINE_MS = 300_000;
export const WORKTREE_SWEEP_GH_BACKOFF_MS = 300_000;

export type SweepItem = {
  kind: "worktree" | "husk";
  path: string;
  repo: string;
  branch?: string;
  pr?: number;
  headOid?: string;
  outcome: "removed" | "would-remove" | "held" | "failed";
  reason: string;
  cause?: HuskCause;
  bytes?: number;
  detail?: string;
};

export type SweepResult = {
  mode: "worktrees";
  at: string;
  acted: boolean;
  skipped?: "disabled" | "throttled" | "locked";
  items: SweepItem[];
  danglingMounts: Array<{ container: string; source: string }>;
  dockerSkipped?: string;
  processesSkipped?: string;
  ghUnreachable?: boolean;
  deadlineHit: boolean;
  totals: { removed: number; held: number; failed: number; bytesFreed: number };
};

export type SweepDeps = FactDeps & {
  removeWorktree: (
    path: string,
    primary: string,
    deleteBranch: boolean,
  ) => { ok: boolean; message: string };
  removeDir: (path: string) => void;
  sizeBytes: (path: string) => number;
  readConfig: ReadConfigFile;
  stateDir: string;
  logPath: string;
  pid: number;
  exists?: (p: string) => boolean;
};

export const sweepDir = (stateDir: string = FLOW_STATE_DIR): string =>
  path.join(stateDir, "worktree-sweep");
export const stampPath = (stateDir?: string): string =>
  path.join(sweepDir(stateDir), "stamp");
export const lockPath = (stateDir?: string): string =>
  path.join(sweepDir(stateDir), "lock");
export const lastPath = (stateDir?: string): string =>
  path.join(sweepDir(stateDir), "last.json");

/** `false` only for a strict boolean `false` at `cleanup.worktrees`. */
export function isAutoSweepEnabled(read: ReadConfigFile): boolean {
  try {
    const raw = read() as { cleanup?: { worktrees?: unknown } } | undefined;
    return raw?.cleanup?.worktrees !== false;
  } catch {
    return true;
  }
}

/** Milliseconds since the stamp was written, or `null` when there is none. */
export function stampAgeMs(nowMs: number, stateDir?: string): number | null {
  try {
    return nowMs - fs.statSync(stampPath(stateDir)).mtimeMs;
  } catch {
    return null;
  }
}

/** Marks a sweep as started now; `retryInMs` makes the next eligible run that much later. */
export function writeStamp(
  nowMs: number,
  stateDir?: string,
  retryInMs: number = WORKTREE_SWEEP_THROTTLE_MS,
): void {
  const file = stampPath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(nowMs));
  const t = new Date(nowMs - (WORKTREE_SWEEP_THROTTLE_MS - retryInMs));
  fs.utimesSync(file, t, t);
}

export function writeLastSweep(result: SweepResult, stateDir?: string): void {
  const file = lastPath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
  fs.renameSync(tmp, file);
}

export function readLastSweep(
  stateDir: string = FLOW_STATE_DIR,
): SweepResult | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lastPath(stateDir), "utf8"));
    return parsed?.mode === "worktrees" && Array.isArray(parsed.items)
      ? (parsed as SweepResult)
      : null;
  } catch {
    return null;
  }
}
