/**
 * The executive's daily spend cap. The one ledger is the manager decision log
 * (`exec.costUsd` on every executive line); the one choke point is
 * `runPlanReview` / `runWaveReview`, which ask `budgetReached` before any
 * headless call. The first skip of a local day logs one `budget-alert` line and
 * fires one `flow-notify --status waiting`.
 *
 * Counts executive `exec.costUsd` only: the manager session's own spend is not
 * capped here.
 */

import * as fs from "node:fs";
import { withFileLockSync } from "./lock";
import { readManagerConfig } from "./manager-config";
import { managerHome } from "./manager-home";
import {
  logLockPath,
  logPath,
  parseLogLines,
  type ManagerLogEntry,
} from "./manager-log";
import type { ReadConfigFile } from "./modules-config";

/** The window the alert points the owner to. */
const ALERT_WINDOW = "manager";
const NAMED_SPENDERS = 5;

function localDay(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function readEntries(home: string): ManagerLogEntry[] {
  try {
    return parseLogLines(fs.readFileSync(logPath(home), "utf8"));
  } catch {
    return [];
  }
}

function spendToday(
  entries: ManagerLogEntry[],
  now: Date,
): { total: number; byName: Map<string, number> } {
  const day = localDay(now);
  const byName = new Map<string, number>();
  let total = 0;
  for (const e of entries) {
    const c = e.exec?.costUsd;
    if (typeof c !== "number" || !Number.isFinite(c) || c <= 0) continue;
    const t = new Date(e.ts);
    if (Number.isNaN(t.getTime()) || localDay(t) !== day) continue;
    total += c;
    const who = e.slug ?? e.epic ?? e.repo;
    byName.set(who, (byName.get(who) ?? 0) + c);
  }
  return { total, byName };
}

/** Sum of today's (local date) executive spend in USD. */
export function dailySpendUsd(now: Date, home: string = managerHome()): number {
  return spendToday(readEntries(home), now).total;
}

export function budgetReached(
  now: Date,
  deps: { read?: ReadConfigFile; home?: string } = {},
): { reached: boolean; spentUsd: number; capUsd: number } {
  const capUsd = readManagerConfig(deps.read).dailyBudgetUsd;
  const spentUsd = dailySpendUsd(now, deps.home);
  return { reached: spentUsd >= capUsd, spentUsd, capUsd };
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Logs one `budget-alert` line and notifies, once per local day. Returns true
 * only for the call that sent it. The check and the append share the log lock,
 * so two concurrent first skips cannot both alert.
 */
export function alertBudgetOnce(
  now: Date,
  notify: (args: string[]) => void,
  home: string = managerHome(),
  read?: ReadConfigFile,
): boolean {
  const day = localDay(now);
  const cap = readManagerConfig(read).dailyBudgetUsd;
  let reason = "";
  fs.mkdirSync(home, { recursive: true });
  const sent = withFileLockSync(logLockPath(home), () => {
    const entries = readEntries(home);
    const done = entries.some(
      (e) => e.kind === "budget-alert" && localDay(new Date(e.ts)) === day,
    );
    if (done) return false;
    const { total, byName } = spendToday(entries, now);
    const top = [...byName.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, NAMED_SPENDERS)
      .map(([name, c]) => `${name} ${usd(c)}`)
      .join(", ");
    reason = `executive reviews hit today's ${usd(cap)} limit (${usd(total)} spent: ${top || "no named pipeline"}); further reviews wait for you`;
    const entry: ManagerLogEntry = {
      ts: now.toISOString(),
      kind: "budget-alert",
      repo: "all",
      reason,
    };
    fs.appendFileSync(logPath(home), `${JSON.stringify(entry)}\n`);
    return true;
  });
  if (sent) {
    notify(["--status", "waiting", "--slug", ALERT_WINDOW, "--reason", reason]);
  }
  return sent;
}
