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
  repo: string;
  ready: number;
  running: number;
  blocked: number;
  merged: number;
  total: number;
  status: EpicStatus;
};

/**
 * The `flow epic ls` table: one row per epic with per-state counts + status.
 * `hiddenDone` is the count of `done` epics the caller already filtered out
 * before calling this renderer; `hiddenOtherRepos` is the count of epics
 * from other repos filtered out. Both drive footer lines only, never the
 * row set itself.
 */
export function renderEpicList(
  rows: EpicListRow[],
  hiddenDone = 0,
  hiddenOtherRepos = 0,
): string {
  if (rows.length === 0) {
    if (hiddenDone === 0 && hiddenOtherRepos === 0) return "no epics";
    const parts: string[] = [];
    if (hiddenDone !== 0) {
      parts.push(`${hiddenDone} done — show them with 'flow epic ls --done'`);
    }
    if (hiddenOtherRepos !== 0) {
      parts.push(
        `${hiddenOtherRepos} in other repos — show them with 'flow epic ls --all-repos'`,
      );
    }
    return `no active epics (${parts.join("; ")})`;
  }
  const table = renderTable(
    [
      { header: "EPIC", get: (r) => r.slug },
      { header: "REPO", get: (r) => r.repo || DASH },
      { header: "READY", get: (r) => String(r.ready) },
      { header: "RUNNING", get: (r) => String(r.running) },
      { header: "BLOCKED", get: (r) => String(r.blocked) },
      { header: "MERGED", get: (r) => `${r.merged} / ${r.total}` },
      { header: "STATUS", get: (r) => r.status },
    ],
    rows,
  );
  const footerLines: string[] = [];
  if (hiddenDone !== 0) {
    const noun = hiddenDone === 1 ? "epic" : "epics";
    footerLines.push(
      `${hiddenDone} done ${noun} hidden — show them with 'flow epic ls --done'`,
    );
  }
  if (hiddenOtherRepos !== 0) {
    const noun = hiddenOtherRepos === 1 ? "epic" : "epics";
    footerLines.push(
      `${hiddenOtherRepos} ${noun} in other repos hidden — show them with 'flow epic ls --all-repos'`,
    );
  }
  if (footerLines.length === 0) return table;
  return `${table}\n\n${footerLines.join("\n")}`;
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
