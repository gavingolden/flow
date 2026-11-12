/**
 * One `flow-notify` per in-scope pause the pipeline does not announce itself
 * (everything in `NOTIFY_PHASES`). Dedup rides the epic sequencer's own
 * `owner-needed` log key, so whichever of the two writers sees a pause first
 * notifies and the other stays quiet.
 */

import { NOTIFY_PHASES, REASON_BY_PHASE } from "./epic-manage-board";
import { appendManagerLog, readManagerLog } from "./manager-log";
import type { WakeEvent } from "./manager-wait";
import { ownerNeededKey } from "./owner-needed-key";
import type { PipelineState } from "./state";

/** Returns how many notifications were sent. */
export function notifyOwnerNeeded(
  events: WakeEvent[],
  states: PipelineState[],
  notify: (args: string[]) => void,
  now: Date,
  home?: string,
): number {
  const bySlug = new Map(states.map((s) => [s.slug, s]));
  let logged: Set<string> | null = null;
  let sent = 0;
  for (const e of events) {
    if (e.kind !== "transition" && e.kind !== "new") continue;
    const s = e.slug ? bySlug.get(e.slug) : undefined;
    if (!s || !NOTIFY_PHASES.has(s.phase)) continue;
    const key = ownerNeededKey(s);
    logged ??= new Set(
      readManagerLog({}, home).flatMap((x) => (x.key ? [x.key] : [])),
    );
    if (logged.has(key)) continue;
    logged.add(key);
    const reason = `${REASON_BY_PHASE[s.phase] ?? s.phase} (${s.phase})`;
    appendManagerLog(
      {
        ts: now.toISOString(),
        kind: "owner-needed",
        repo: e.repo ?? "unknown",
        ...(s.epic ? { epic: s.epic.slug } : {}),
        slug: s.slug,
        phase: s.phase,
        key,
        window: s.slug,
        reason,
      },
      { home },
    );
    notify(["--status", "waiting", "--slug", s.slug, "--reason", reason]);
    sent++;
  }
  return sent;
}
