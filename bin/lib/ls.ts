/**
 * `flow ls` — join state files (~/.flow/state/<slug>.json) with tmux
 * windows from the flow session and print a status table.
 *
 * Phase + LAST ACTIVITY source preference:
 *   1. <worktree>/.flow-status (live, atomic; written by PR 2's supervisor
 *      at every transition once the worktree exists).
 *   2. ~/.flow/state/<slug>.json fields (phase + updatedAt) as fallback —
 *      covers the pre-worktree window: cold-start, triage, and the
 *      moments between flow new and flow-new-worktree finishing. Without
 *      this fallback, `flow ls` would render "—" for the entire phase-1
 *      window of every fresh pipeline.
 *   3. "—" only when neither surface has data.
 *
 * Drift handling:
 *   - state file but no window → "(no window)" (likely a crashed session)
 *   - window but no state file → "(no state)" (manual creation)
 *   - both                     → no annotation
 */

import { readFlowStatus, relativeTime, type FlowStatus } from "./flow-status";
import { listStates, type PipelineState } from "./state";
import { listWindows, type TmuxWindow } from "./tmux";

export type Row = {
  name: string;
  phase: string;
  pr: string;
  lastActivity: string;
  annotation: "" | "(no window)" | "(no state)";
};

export type StatusReader = (worktree: string) => FlowStatus | null;

export function runLs(): number {
  const states = listStates();
  const windows = listWindows();
  const rows = buildRows(states, windows, Date.now());

  if (rows.length === 0) {
    console.log("no active pipelines.");
    return 0;
  }

  printTable(rows);
  return 0;
}

export function buildRows(
  states: PipelineState[],
  windows: TmuxWindow[],
  nowMs: number,
  statusReader: StatusReader = readFlowStatus,
): Row[] {
  const windowByName = new Map(windows.map((w) => [w.name, w] as const));
  const stateBySlug = new Map(states.map((s) => [s.slug, s] as const));

  const rows: Row[] = [];

  for (const state of states) {
    const window = windowByName.get(state.slug);
    const status = state.worktree ? statusReader(state.worktree) : null;
    rows.push({
      name: state.slug,
      phase: status?.phase ?? state.phase ?? "—",
      pr: state.pr ? `#${state.pr}` : "—",
      lastActivity: lastActivityFrom(status, state.updatedAt, nowMs),
      annotation: window ? "" : "(no window)",
    });
  }

  // Surface windows that lack a state file. They're not pipelines flow
  // owns, so there's no worktree path to read .flow-status from — fall
  // back to the tmux-reported activity so the user still sees something.
  for (const window of windows) {
    if (stateBySlug.has(window.name)) continue;
    rows.push({
      name: window.name,
      phase: "—",
      pr: "—",
      lastActivity:
        window.activity > 0 ? relativeTime(window.activity * 1000, nowMs) : "—",
      annotation: "(no state)",
    });
  }

  return rows;
}

function lastActivityFrom(
  status: FlowStatus | null,
  stateUpdatedAt: string | undefined,
  nowMs: number,
): string {
  // Prefer the live .flow-status timestamp (atomic per-transition write).
  // Fall back to state.updatedAt for the pre-worktree window — covers the
  // cold-start + triage gap before flow-new-worktree finishes.
  const candidate = status?.lastTransitionAt ?? stateUpdatedAt;
  if (!candidate) return "—";
  const ms = Date.parse(candidate);
  if (!Number.isFinite(ms)) return "—";
  return relativeTime(ms, nowMs);
}

function printTable(rows: Row[]): void {
  const cols = [
    { header: "NAME", get: (r: Row) => (r.annotation ? `${r.name} ${r.annotation}` : r.name) },
    { header: "PHASE", get: (r: Row) => r.phase },
    { header: "PR", get: (r: Row) => r.pr },
    { header: "LAST ACTIVITY", get: (r: Row) => r.lastActivity },
  ];

  const widths = cols.map((c) => Math.max(c.header.length, ...rows.map((r) => c.get(r).length)));

  const line = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();

  console.log(line(cols.map((c) => c.header)));
  for (const row of rows) console.log(line(cols.map((c) => c.get(row))));
}
