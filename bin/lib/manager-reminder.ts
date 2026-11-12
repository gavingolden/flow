/**
 * The once-a-day nudge for pipelines that have waited on the owner for more
 * than 24 hours. One `flow-notify --status waiting` per local day, deduped
 * through a `reminder` line in the manager decision log.
 */

import * as fs from "node:fs";
import { OWNER_NEEDED_PHASES } from "./epic-manage-board";
import { withFileLockSync } from "./lock";
import {
  appendManagerLog,
  logLockPath,
  logPath,
  parseLogLines,
} from "./manager-log";
import { managerHome } from "./manager-home";
import { enteredAt } from "./manager-wait";
import { FINISHED_PHASE_SET, type PipelineState } from "./state";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

const localDay = (d: Date): string =>
  `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

export function reminderDue(
  states: PipelineState[],
  now: Date,
): { due: boolean; count: number; oldest?: { slug: string; ageMs: number } } {
  let count = 0;
  let oldest: { slug: string; ageMs: number } | undefined;
  for (const s of states) {
    if (FINISHED_PHASE_SET.has(s.phase) || !OWNER_NEEDED_PHASES.has(s.phase)) {
      continue;
    }
    const ageMs = now.getTime() - Date.parse(enteredAt(s));
    if (!Number.isFinite(ageMs) || ageMs <= DAY_MS) continue;
    count++;
    if (!oldest || ageMs > oldest.ageMs) oldest = { slug: s.slug, ageMs };
  }
  return { due: count > 0, count, ...(oldest ? { oldest } : {}) };
}

function reminderText(count: number, slug: string, ageMs: number): string {
  const days = Math.floor(ageMs / DAY_MS);
  const wait = ageMs >= WEEK_MS ? "waited 7+ days on you" : `waiting ${days}d`;
  return `${count} ${count === 1 ? "item has" : "items have"} waited over a day on you; oldest: ${slug} (${wait})`;
}

/** True only for the call that sent it. The check and the log append share the log lock. */
export function sendDailyReminder(
  now: Date,
  states: PipelineState[],
  notify: (args: string[]) => void,
  home: string = managerHome(),
): boolean {
  const r = reminderDue(states, now);
  if (!r.due || !r.oldest) return false;
  const reason = reminderText(r.count, r.oldest.slug, r.oldest.ageMs);
  fs.mkdirSync(home, { recursive: true });
  const sent = withFileLockSync(logLockPath(home), () => {
    let raw = "";
    try {
      raw = fs.readFileSync(logPath(home), "utf8");
    } catch {
      // no log yet
    }
    const done = parseLogLines(raw).some(
      (e) =>
        e.kind === "reminder" && localDay(new Date(e.ts)) === localDay(now),
    );
    if (done) return false;
    fs.appendFileSync(
      logPath(home),
      `${JSON.stringify({ ts: now.toISOString(), kind: "reminder", repo: "all", reason })}\n`,
    );
    return true;
  });
  if (sent)
    notify(["--status", "waiting", "--slug", "manager", "--reason", reason]);
  return sent;
}
