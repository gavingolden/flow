/**
 * `flow ls` — join state files (~/.flow/state/<slug>.json) with tmux
 * windows from the flow session and print a status table.
 *
 * Drift handling:
 *   - state file but no window → "(no window)" (likely a crashed session)
 *   - window but no state file → "(no state)" (manual creation)
 *   - both                     → no annotation
 */

import { listStates, type PipelineState } from "./state";
import { listWindows, type TmuxWindow } from "./tmux";

export type Row = {
  name: string;
  phase: string;
  pr: string;
  lastActivity: string;
  annotation: "" | "(no window)" | "(no state)";
};

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
): Row[] {
  const windowByName = new Map(windows.map((w) => [w.name, w] as const));
  const stateBySlug = new Map(states.map((s) => [s.slug, s] as const));

  const rows: Row[] = [];

  for (const state of states) {
    const window = windowByName.get(state.slug);
    rows.push({
      name: state.slug,
      phase: state.phase || "—",
      pr: state.pr ? `#${state.pr}` : "—",
      lastActivity: lastActivityFor(window, state, nowMs),
      annotation: window ? "" : "(no window)",
    });
  }

  // Surface windows that lack a state file. They're not pipelines flow
  // owns, but listing them as "(no state)" prevents silent gaps when the
  // user wonders why a window they see in tmux doesn't show up here.
  for (const window of windows) {
    if (stateBySlug.has(window.name)) continue;
    rows.push({
      name: window.name,
      phase: "—",
      pr: "—",
      lastActivity: humanizeActivity(window.activity * 1000, nowMs),
      annotation: "(no state)",
    });
  }

  return rows;
}

function lastActivityFor(window: TmuxWindow | undefined, state: PipelineState, nowMs: number): string {
  if (window && window.activity > 0) {
    return humanizeActivity(window.activity * 1000, nowMs);
  }
  const updatedMs = Date.parse(state.updatedAt);
  if (Number.isFinite(updatedMs)) return humanizeActivity(updatedMs, nowMs);
  return "—";
}

export function humanizeActivity(thenMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
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
