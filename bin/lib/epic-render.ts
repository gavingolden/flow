/**
 * Pure renderers for the epic orchestrator's three surfaces — `flow epic
 * status` (board), `flow epic ls` (list), and the per-tick `flow epic run`
 * lines. Pure string returns (no console) so they unit-test as data.
 *
 * Column style mirrors `ls.ts`'s `printTable`: per-column width =
 * `max(header.length, ...cell lengths)`, `cell.padEnd(width)`, columns joined
 * with two spaces, each line `.trimEnd()`.
 */

import type { BoardRow, EpicStatus, ReconcileSummary } from "./epic-reconcile";

const DASH = "—";

/** Render an aligned table (header + rows) the way `ls.ts` does. */
function renderTable<T>(
  cols: { header: string; get: (row: T) => string }[],
  rows: T[],
): string {
  const widths = cols.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => c.get(r).length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  const lines = [line(cols.map((c) => c.header))];
  for (const row of rows) lines.push(line(cols.map((c) => c.get(row))));
  return lines.join("\n");
}

/**
 * The `flow epic status` board: one row per feature, then the
 * `ready/running/blocked/merged X / N` summary line. The WAITS ON column shows
 * a feature's unmet dependencies only while it is `blocked` (a launched or
 * ready feature has nothing left to wait on), matching the worked UX example.
 */
export function renderBoard(
  board: BoardRow[],
  summary: ReconcileSummary,
): string {
  const table = renderTable(
    [
      { header: "FEATURE", get: (r) => r.id },
      { header: "STATUS", get: (r) => r.status },
      {
        header: "SLUG",
        get: (r) => r.slug ?? (r.external ? "(external)" : DASH),
      },
      { header: "PR", get: (r) => (r.pr ? `#${r.pr}` : DASH) },
      { header: "PHASE", get: (r) => r.phase ?? DASH },
      {
        header: "WAITS ON",
        get: (r) =>
          r.status === "blocked" && r.dependsOn.length > 0
            ? r.dependsOn.join(", ")
            : DASH,
      },
    ],
    board,
  );
  const summaryLine = `ready: ${summary.ready}   running: ${summary.running}   blocked: ${summary.blocked}   merged: ${summary.merged} / ${summary.total}`;
  return `${table}\n${summaryLine}`;
}

export type EpicListRow = {
  slug: string;
  ready: number;
  running: number;
  blocked: number;
  merged: number;
  total: number;
  status: EpicStatus;
};

/** The `flow epic ls` table: one row per epic with per-state counts + status. */
export function renderEpicList(rows: EpicListRow[]): string {
  if (rows.length === 0) return "no epics";
  return renderTable(
    [
      { header: "EPIC", get: (r) => r.slug },
      { header: "READY", get: (r) => String(r.ready) },
      { header: "RUNNING", get: (r) => String(r.running) },
      { header: "BLOCKED", get: (r) => String(r.blocked) },
      { header: "MERGED", get: (r) => `${r.merged} / ${r.total}` },
      { header: "STATUS", get: (r) => r.status },
    ],
    rows,
  );
}

/**
 * The per-tick `flow epic run` launch line. Empty when nothing launched this
 * tick. A single launch reads `launched <id> → flow:<slug> [used/max]`; a
 * multi-launch reads `launched <id1>, <id2> (parallel) [used/max]` — the
 * `(parallel) [n/K]` marker that makes fan-out visible.
 */
export function renderTickSummary(
  launched: { id: string; slug: string }[],
  slots: { used: number; max: number },
): string {
  if (launched.length === 0) return "";
  const marker = `[${slots.used}/${slots.max}]`;
  if (launched.length === 1) {
    const { id, slug } = launched[0];
    return `launched ${id} → flow:${slug} ${marker}`;
  }
  const idList = launched.map((l) => l.id).join(", ");
  return `launched ${idList} (parallel) ${marker}`;
}
