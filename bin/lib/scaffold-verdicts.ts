import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ScaffoldVerdictRow {
  candidate: string;
  outcome: "remove" | "keep" | "TBD";
  scope: "full" | "accuracy-only" | "TBD";
  decisionMetric: string;
  beforeReport: string;
  afterReport: string;
  note: string;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function parseVerdictTable(md: string): ScaffoldVerdictRow[] {
  const lines = md.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === "## Verdicts");
  if (headingIdx === -1) return [];

  const rows: ScaffoldVerdictRow[] = [];
  let sawHeaderRow = false;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) break;
    if (!line.trim().startsWith("|")) continue;
    const cells = splitRow(line);
    if (!sawHeaderRow) {
      sawHeaderRow = true;
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (cells.length < 7) continue;
    const candidateMatch = cells[0].match(/`([^`]+)`/);
    rows.push({
      candidate: candidateMatch ? candidateMatch[1] : cells[0],
      outcome: (cells[1] || "TBD") as ScaffoldVerdictRow["outcome"],
      scope: (cells[2] || "TBD") as ScaffoldVerdictRow["scope"],
      decisionMetric: cells[3],
      beforeReport: cells[4],
      afterReport: cells[5],
      note: cells[6],
    });
  }
  return rows;
}

export function lintVerdicts(
  rows: ScaffoldVerdictRow[],
  repoRoot: string,
): string[] {
  const misses: string[] = [];
  if (rows.length !== 3) {
    misses.push(`expected exactly 3 verdict rows, found ${rows.length}`);
  }
  for (const row of rows) {
    if (row.outcome === "TBD") {
      misses.push(`${row.candidate}: outcome is still TBD`);
    } else if (row.outcome !== "remove" && row.outcome !== "keep") {
      misses.push(
        `${row.candidate}: outcome '${row.outcome}' is not one of remove|keep`,
      );
    }
    if (row.scope !== "full" && row.scope !== "accuracy-only") {
      misses.push(
        `${row.candidate}: scope '${row.scope}' is not one of full|accuracy-only`,
      );
    }
    if (!row.decisionMetric.trim()) {
      misses.push(`${row.candidate}: decision metric is empty`);
    }
    if (row.beforeReport && !existsSync(join(repoRoot, row.beforeReport))) {
      misses.push(
        `${row.candidate}: before report path missing on disk: ${row.beforeReport}`,
      );
    }
    if (row.afterReport && !existsSync(join(repoRoot, row.afterReport))) {
      misses.push(
        `${row.candidate}: after report path missing on disk: ${row.afterReport}`,
      );
    }
  }
  return misses;
}
