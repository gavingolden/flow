/**
 * `~/.flow/manager/manager.json`: the live global manager's launch record.
 * Distinct from the epic sequencer's `~/.flow/state/managers/<epic>/manager.json`
 * (a different schema in a different directory) — never read or prune that one.
 * Its presence is the "a manager is live" signal; `flow manage --stop` removes it.
 */

import * as fs from "node:fs";
import { managerFile, managerHome, writeJsonAtomic } from "./manager-home";
import {
  EFFORT_LEVELS,
  MODEL_ALIASES,
  type EffortLevel,
  type ModelAlias,
} from "./state";

export type ManagerRecord = {
  version: 1;
  window: string;
  startedAt: string;
  model: ModelAlias;
  effort: EffortLevel;
  heartbeatSec: number;
  stopWhenIdle: boolean;
  notices: boolean;
  lastSeenAt?: string;
};

export function managerRecordPath(home?: string): string {
  return managerFile("manager.json", home ?? managerHome());
}

/** Tolerant: a missing file or an invalid shape reads as null. */
export function readManagerRecord(home?: string): ManagerRecord | null {
  try {
    const v = JSON.parse(
      fs.readFileSync(managerRecordPath(home), "utf8"),
    ) as ManagerRecord;
    if (
      v?.version === 1 &&
      typeof v.window === "string" &&
      typeof v.startedAt === "string" &&
      (MODEL_ALIASES as readonly string[]).includes(v.model) &&
      (EFFORT_LEVELS as readonly string[]).includes(v.effort) &&
      typeof v.heartbeatSec === "number" &&
      typeof v.stopWhenIdle === "boolean" &&
      typeof v.notices === "boolean" &&
      (v.lastSeenAt === undefined || typeof v.lastSeenAt === "string")
    ) {
      return v;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeManagerRecord(r: ManagerRecord, home?: string): void {
  writeJsonAtomic(managerRecordPath(home), r);
}
