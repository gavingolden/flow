/**
 * Pure renderer for the `flow epic manage` window, in the pause-output
 * contract's vocabulary (status heading, `**TLDR:**`, `**Unsolved:**`,
 * `**Needs attention:**`, `**Next action:**` last). Every owner-needed,
 * drift, launch-failed, and hold line names the window to look at and a
 * reason. Text in, text out: no clock, no I/O, so boards snapshot-test.
 */

import type { GuardResult, NodeVerdict } from "./epic-manage-guard";
import type { ManagerState } from "./epic-manage-state";
import { renderBoard } from "./epic-render";
import type { BoardRow, ReconcileResult } from "./epic-reconcile";
import type { PipelineState } from "./state";

/** Phases where the owner must act before the feature can advance (OQ3). */
export const OWNER_NEEDED_PHASES: ReadonlySet<string> = new Set([
  "gated",
  "needs-human",
  "plan-pending-review",
  "plan-pending-interview",
  "triage-pending-interview",
  "triage-pending-clarification",
  "approval-pending-clarification",
  "checkpoint-pending-clear",
  "browser-retry-pending",
  "triaged-no-change",
]);

/** Pipelines already announce gated / needs-human / browser-retry themselves; the sequencer notifies only the rest. */
export const NOTIFY_PHASES: ReadonlySet<string> = new Set(
  [...OWNER_NEEDED_PHASES].filter(
    (p) => !["gated", "needs-human", "browser-retry-pending"].includes(p),
  ),
);

const REASON_BY_PHASE: Record<string, string> = {
  gated: "PR is gated — validate its open Test Steps, then merge",
  "needs-human": "needs a human decision",
  "plan-pending-review": "plan is waiting for your approval",
  "plan-pending-interview": "plan interview is waiting for your answers",
  "triage-pending-interview": "triage interview is waiting for your answers",
  "triage-pending-clarification": "triage needs a clarification from you",
  "approval-pending-clarification": "approval needs a clarification from you",
  "checkpoint-pending-clear": "checkpoint is waiting for you to clear it",
  "browser-retry-pending": "browser checks did not run — retry or accept",
  "triaged-no-change": "triage found nothing to change — confirm or redirect",
};

export type OwnerNeededLine = {
  id: string;
  slug: string;
  phase: string;
  window: string;
  pr?: number;
  reason: string;
  key: string;
  notify: boolean;
};

export function ownerNeededFor(
  board: BoardRow[],
  states: ReadonlyMap<string, PipelineState>,
): OwnerNeededLine[] {
  const out: OwnerNeededLine[] = [];
  for (const row of board) {
    const state = row.slug ? states.get(row.slug) : undefined;
    if (!row.slug || !state || !OWNER_NEEDED_PHASES.has(state.phase)) continue;
    out.push({
      id: row.id,
      slug: row.slug,
      phase: state.phase,
      window: row.slug,
      ...(state.pr !== undefined ? { pr: state.pr } : {}),
      reason: REASON_BY_PHASE[state.phase] ?? state.phase,
      key: `${row.slug}:${state.phase}:${state.phaseLog?.length ?? 0}`,
      notify: NOTIFY_PHASES.has(state.phase),
    });
  }
  return out;
}

export type BoardModel = {
  epicSlug: string;
  result: ReconcileResult;
  manager: Pick<
    ManagerState,
    "model" | "effort" | "autonomy" | "featureFallback"
  >;
  headSha: string | null;
  notifyOn: boolean;
  ownerNeeded: OwnerNeededLine[];
  guard: GuardResult;
  github: { ok: boolean; ageMs: number; error?: string } | null;
  updatedAt: string;
  final: boolean;
};

const POINTER = "run /flow-epic-run reconcile-drift";

/** Coarse on purpose: a seconds counter would redraw the board every tick of an outage. */
function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "under a minute";
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${Math.round(m / 60)}h`;
}

function unhinted(f: ManagerState["featureFallback"]): string {
  return f.model || f.effort
    ? `${f.model ?? "config"}/${f.effort ?? "config"}`
    : "config";
}

function verdictLines(
  v: NodeVerdict,
  epic: string,
  win: string,
): string[] | null {
  switch (v.action) {
    case "drift":
      return [`drift: ${v.id} — ${v.reason} — ${POINTER} (window ${win})`];
    case "waiting":
      return [
        `waiting on: ${v.waitFor} — ${v.id} is never launched; record it with flow epic bind ${epic} ${v.id} --external "<ref>"`,
      ];
    case "failed":
      return [
        `launch failed: ${v.id} — ${v.reason} — fix it, then run flow epic launch ${epic} ${v.id} or restart the sequencer (window ${win})`,
      ];
    case "capacity":
      return [`hold: ${v.id} — waiting for a free slot (window ${win})`];
    case "launching":
      return [
        `launching: ${v.id} — flow epic launch is still running (window ${win})`,
      ];
    default:
      return null;
  }
}

export function renderManageBoard(model: BoardModel): string {
  const { epicSlug: epic, result, guard } = model;
  const win = `manage-${epic}`;
  const { merged, total, running } = result.summary;
  const waiting = model.ownerNeeded.length;
  const failed = guard.verdicts.find((v) => v.action === "failed");
  const lines: string[] = [];

  const status = model.final
    ? "DONE"
    : waiting > 0 || guard.globalDrift.length + guard.boundDrift.length > 0
      ? "NEEDS YOU"
      : "RUNNING";
  lines.push(`### Epic ${epic} — ${merged} / ${total} merged — ${status}`);
  lines.push(
    `manager ${model.manager.model}/${model.manager.effort} · unhinted features: ${unhinted(model.manager.featureFallback)} · autonomy ${model.manager.autonomy} · checkout ${model.headSha ?? "unknown"} · updated ${model.updatedAt}`,
  );
  if (!model.notifyOn) lines.push("notifications off — set FLOW_NOTIFY=1");
  lines.push("");

  const held = guard.verdicts.filter(
    (v) => v.action !== "launch" && v.action !== "waiting",
  ).length;
  lines.push(
    model.final
      ? `**TLDR:** ${epic} is done — all ${total} features merged.`
      : `**TLDR:** ${epic}: ${merged} of ${total} merged, ${running} running${waiting ? `, ${waiting} waiting on you` : ""}${held ? `, ${held} held back` : ""}.`,
  );

  if (waiting > 0) {
    lines.push("**Needs attention:**");
    for (const o of model.ownerNeeded) {
      lines.push(
        `- ${o.id}${o.pr ? ` (PR #${o.pr})` : ""}: ${o.reason} — answer in window ${o.window} (flow attach ${o.window})`,
      );
    }
  }

  const unsolved: string[] = [];
  for (const reason of guard.globalDrift) {
    unsolved.push(
      `drift: every launch halted — ${reason} — ${POINTER} (window ${win})`,
    );
  }
  for (const d of guard.boundDrift) {
    unsolved.push(`drift: ${d.id} — ${d.reason} — ${POINTER} (window ${win})`);
  }
  for (const v of guard.verdicts)
    unsolved.push(...(verdictLines(v, epic, win) ?? []));
  const gh = model.github;
  if (!gh) {
    unsolved.push(
      `GitHub: first snapshot pending — launches paused (window ${win})`,
    );
  } else if (!gh.ok) {
    unsolved.push(
      `GitHub unreachable for ${age(gh.ageMs)} — launches paused (${gh.error ?? "no response"}) (window ${win})`,
    );
  } else if (guard.verdicts.some((v) => v.action === "github-unverified")) {
    unsolved.push(
      `GitHub or git state could not be verified (last GitHub snapshot ${age(gh.ageMs)} old) — launches paused until it can (window ${win})`,
    );
  }
  if (unsolved.length > 0) {
    lines.push("**Unsolved:**", ...unsolved.map((u) => `- ${u}`));
  }

  lines.push("", renderBoard(result.board, result.summary), "");

  let next: string;
  if (model.final) {
    next =
      "press Enter or Ctrl-C to close this window — launched pipelines keep their own windows.";
  } else if (waiting > 0) {
    const first = model.ownerNeeded[0]!;
    next = `answer in window ${first.window} (flow attach ${first.window}); this sequencer keeps launching on its own, and Ctrl-C stops it without touching launched pipelines.`;
  } else if (guard.globalDrift.length + guard.boundDrift.length > 0) {
    next = `${POINTER}, then restart this sequencer.`;
  } else if (failed) {
    next = `fix the failed launch, then run flow epic launch ${epic} ${failed.id} — or restart this sequencer to retry.`;
  } else if (!gh?.ok) {
    next =
      "check GitHub access (gh auth status) — launches resume on their own once GitHub answers.";
  } else {
    next =
      "nothing needed — the next ready feature launches on its own; Ctrl-C stops the sequencer without touching launched pipelines.";
  }
  lines.push(`**Next action:** ${next}`);
  return lines.join("\n");
}
