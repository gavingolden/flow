/**
 * `flow ls` — join state files (~/.flow/state/<slug>.json) with tmux
 * windows from the flow session and print a status table.
 *
 * State source: a single global JSON file per pipeline. The supervisor
 * (PR 2) updates `phase` + `updatedAt` (and `pr` after step 5, `worktree`
 * after step 2) at every transition via `flow-state-update`. PR 1 wrote
 * the initial state with `phase: "starting"` from `flow new`.
 *
 * Drift handling:
 *   - state file but no window → "(no window)" (likely a crashed session)
 *   - window but no state file → "(no state)" (manual creation)
 *   - both                     → no annotation
 */

import { listStates, type PipelineState } from "./state";
import { relativeTime } from "./time";
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
      lastActivity: lastActivityFrom(state.updatedAt, nowMs),
      annotation: window ? "" : "(no window)",
    });
  }

  // Surface windows that lack a state file. They're not pipelines flow
  // owns, so fall back to the tmux-reported activity so the user still
  // sees something.
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

function lastActivityFrom(updatedAt: string | undefined, nowMs: number): string {
  if (!updatedAt) return "—";
  const ms = Date.parse(updatedAt);
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
