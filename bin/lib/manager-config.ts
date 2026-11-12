/**
 * Tolerant boundary reader for `~/.flow/config.json` `manager.heartbeatSec`
 * and `manager.dailyBudgetUsd`, the global manager's two knobs. Same shape as
 * `epic-config.ts`: an injectable `ReadConfigFile` seam, and anything
 * unreadable, malformed or wrong-typed collapses to the built-in default.
 *
 * `config.manager` is a new top-level object, separate from the existing
 * `models.manager` / `efforts.manager` table keys.
 */

import { defaultReadConfigFile, type ReadConfigFile } from "./modules-config";

export const DEFAULT_HEARTBEAT_SEC = 900;
export const MIN_HEARTBEAT_SEC = 60;
export const DEFAULT_DAILY_BUDGET_USD = 20;

function managerKey(raw: unknown, key: string): unknown {
  if (typeof raw !== "object" || raw === null) return undefined;
  const manager = (raw as Record<string, unknown>).manager;
  if (typeof manager !== "object" || manager === null) return undefined;
  return (manager as Record<string, unknown>)[key];
}

/** A configured heartbeat is an integer of at least 60 seconds. */
export function validHeartbeatSec(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_HEARTBEAT_SEC;
}

/** A configured daily budget is a positive finite number of dollars. */
export function validDailyBudgetUsd(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

export function readManagerConfig(
  read: ReadConfigFile = defaultReadConfigFile,
): {
  heartbeatSec: number;
  dailyBudgetUsd: number;
} {
  const raw = read();
  const hb = managerKey(raw, "heartbeatSec");
  const budget = managerKey(raw, "dailyBudgetUsd");
  return {
    heartbeatSec: validHeartbeatSec(hb) ? hb : DEFAULT_HEARTBEAT_SEC,
    dailyBudgetUsd: validDailyBudgetUsd(budget)
      ? budget
      : DEFAULT_DAILY_BUDGET_USD,
  };
}
