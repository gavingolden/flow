/**
 * Event emission for the `flow epic manage` loop: one `log.jsonl` line and at
 * most one `flow-notify` per event key. The seen-set is rebuilt from the log on
 * restart, so a restart never re-notifies an open pause. Sequencer-level blocks
 * (drift halt, failed launch, GitHub pause, done) notify under the manage
 * window; owner-needed pipeline pauses notify under the feature's own window —
 * and only for phases the pipeline does not already announce (`notify` flag).
 */

import { appendManagerLog, type ManagerLogKind } from "./epic-manager-log";
import type { GuardResult } from "./epic-manage-guard";
import type { OwnerNeededLine } from "./epic-manage-board";

export type EventCtx = {
  epic: string;
  /** The running manager's `startedAt`: scopes launch-failed keys to one sequencer run. */
  runId: string;
  notified: Set<string>;
  activeHolds: Set<string>;
};

export type EventDeps = {
  now: () => number;
  notify: (args: string[]) => void;
  stateDir?: string;
};

export const iso = (ms: number): string => new Date(ms).toISOString();

/** A lock timeout or full disk must never take the sequencer down. */
export function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // swallowed by design
  }
}

type Emit = {
  kind: ManagerLogKind;
  key: string;
  window: string;
  reason: string;
  notify: boolean;
  featureId?: string;
  slug?: string;
  pr?: number;
  phase?: string;
};

export function emit(ctx: EventCtx, deps: EventDeps, e: Emit): void {
  if (ctx.notified.has(e.key)) return;
  ctx.notified.add(e.key);
  const { notify, ...fields } = e;
  safely(() =>
    appendManagerLog(
      ctx.epic,
      { ts: iso(deps.now()), ...fields },
      deps.stateDir,
    ),
  );
  if (notify) {
    safely(() =>
      deps.notify([
        "--status",
        "waiting",
        "--slug",
        e.window,
        "--reason",
        e.reason,
      ]),
    );
  }
}

export type AnnounceView = {
  ownerNeeded: OwnerNeededLine[];
  guard: GuardResult;
  /** The latest GitHub fetch failed AND no fresh snapshot exists, so launches are paused. */
  githubPaused: string | null;
  /** Set once the epic is done (the total feature count). */
  doneTotal: number | null;
};

/** Emit every newly-true event; clear the keys of conditions that went away so a recurrence notifies again. */
export function announce(
  ctx: EventCtx,
  deps: EventDeps,
  view: AnnounceView,
): void {
  const win = `manage-${ctx.epic}`;
  const live = new Set<string>();
  for (const o of view.ownerNeeded) {
    emit(ctx, deps, {
      kind: "owner-needed",
      key: o.key,
      window: o.window,
      reason: `${o.reason} (${o.phase})`,
      notify: o.notify,
      featureId: o.id,
      slug: o.slug,
      phase: o.phase,
      ...(o.pr !== undefined ? { pr: o.pr } : {}),
    });
  }
  const globals = new Set(view.guard.globalDrift);
  const drifts = [
    ...view.guard.globalDrift.map((reason) => ({ id: "global", reason })),
    ...view.guard.boundDrift,
    ...view.guard.verdicts.flatMap((v) =>
      v.action === "drift" && !globals.has(v.reason)
        ? [{ id: v.id, reason: v.reason }]
        : [],
    ),
  ];
  for (const d of drifts) {
    const key = `drift-halt:${d.id}:${d.reason}`;
    live.add(key);
    emit(ctx, deps, {
      kind: "drift-halt",
      key,
      window: win,
      reason: `drift on ${d.id}: ${d.reason} — run /flow-epic-run reconcile-drift`,
      notify: true,
      ...(d.id === "global" ? {} : { featureId: d.id }),
    });
  }
  for (const v of view.guard.verdicts) {
    if (v.action === "failed") {
      emit(ctx, deps, {
        kind: "launch-failed",
        key: `launch-failed:${v.id}:${ctx.runId}`,
        window: win,
        reason: `launch of ${v.id} failed: ${v.reason}`,
        notify: true,
        featureId: v.id,
      });
    } else if (v.action === "capacity" || v.action === "launching") {
      const key = `hold:${v.id}:${v.action}`;
      live.add(key);
      if (!ctx.activeHolds.has(key)) {
        ctx.activeHolds.add(key);
        safely(() =>
          appendManagerLog(
            ctx.epic,
            {
              ts: iso(deps.now()),
              kind: "hold",
              featureId: v.id,
              window: win,
              reason: v.action,
              key: `${key}@${deps.now()}`,
            },
            deps.stateDir,
          ),
        );
      }
    }
  }
  if (view.githubPaused !== null) {
    const key = `github-paused:${view.githubPaused}`;
    live.add(key);
    emit(ctx, deps, {
      kind: "hold",
      key,
      window: win,
      reason: `GitHub unreachable — launches paused (${view.githubPaused})`,
      notify: true,
    });
  }
  if (view.doneTotal !== null) {
    emit(ctx, deps, {
      kind: "owner-needed",
      key: "done",
      window: win,
      phase: "done",
      reason: `epic ${ctx.epic} is done — all ${view.doneTotal} features merged`,
      notify: true,
    });
  }
  for (const k of [...ctx.activeHolds])
    if (!live.has(k)) ctx.activeHolds.delete(k);
  for (const k of [...ctx.notified]) {
    if (
      (k.startsWith("drift-halt:") || k.startsWith("github-paused:")) &&
      !live.has(k)
    ) {
      ctx.notified.delete(k);
    }
  }
}
