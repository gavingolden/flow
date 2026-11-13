/**
 * The waiter's two small files under `~/.flow/manager/`: `waiter.json` (who is
 * waiting, and when it last proved it is alive) and `wake.json` (events the
 * manager has not acknowledged yet). Liveness comes from `aliveAt`, which the
 * waiter refreshes every pass; `status.md` is never a liveness stamp.
 */

import * as fs from "node:fs";
import { managerFile, managerHome, writeJsonAtomic } from "./manager-home";
import type { WakeEvent } from "./manager-wait";

export type WaiterRecord = {
  version: 1;
  pid: number;
  startedAt: string;
  aliveAt: string;
  /** Last merged-out-of-band check; the next waiter process resumes from it, so a busy scope that wakes the waiter more often than the heartbeat still gets its check. */
  heartbeatAt?: string;
};

export type WakeFile = { version: 1; at: string; events: WakeEvent[] };

/** A waiter whose last pass is older than this is treated as dead even if its pid answers (pid reuse, a stopped process). */
export const WAITER_FRESH_MS = 120_000;

export const waiterPath = (home: string = managerHome()): string =>
  managerFile("waiter.json", home);
export const wakePath = (home: string = managerHome()): string =>
  managerFile("wake.json", home);

export function readWaiter(home?: string): WaiterRecord | null {
  try {
    const v = JSON.parse(
      fs.readFileSync(waiterPath(home), "utf8"),
    ) as WaiterRecord;
    if (
      v?.version === 1 &&
      Number.isInteger(v.pid) &&
      typeof v.startedAt === "string" &&
      typeof v.aliveAt === "string"
    ) {
      return v;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeWaiter(r: WaiterRecord, home?: string): void {
  writeJsonAtomic(waiterPath(home), r);
}

export function waiterLive(
  r: WaiterRecord | null,
  now: number,
  kill: (pid: number, signal: 0) => void = (pid, sig) => process.kill(pid, sig),
): boolean {
  if (!r) return false;
  const alive = Date.parse(r.aliveAt);
  if (!Number.isFinite(alive) || now - alive > WAITER_FRESH_MS) return false;
  try {
    kill(r.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readWake(home?: string): WakeFile | null {
  try {
    const v = JSON.parse(fs.readFileSync(wakePath(home), "utf8")) as WakeFile;
    return v?.version === 1 && Array.isArray(v.events) ? v : null;
  } catch {
    return null;
  }
}

const eventKey = (e: WakeEvent): string =>
  [e.kind, e.slug ?? "", e.from ?? "", e.to ?? "", e.ruling ?? ""].join("|");

export function mergeEvents(a: WakeEvent[], b: WakeEvent[]): WakeEvent[] {
  const seen = new Set<string>();
  return [...a, ...b].filter((e) => {
    const k = eventKey(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function writeWake(events: WakeEvent[], at: Date, home?: string): void {
  writeJsonAtomic(wakePath(home), {
    version: 1,
    at: at.toISOString(),
    events,
  } satisfies WakeFile);
}

/** The manager has handled the wake: nothing is left to re-emit. */
export function ackWake(home?: string): void {
  try {
    fs.rmSync(wakePath(home), { force: true });
  } catch {
    // already gone
  }
}
