/**
 * Detect and collapse markdown alignment padding (very long runs of spaces or
 * dashes) while preserving every word. Padded tables are inert noise for a
 * reader but huge for a model: collapsing them is lossless for the guidance.
 */
import { fencedLineMask } from "./md-block-structure";

export const PADDING_THRESHOLD = 1000;
export const PRETTIER_IGNORE = "<!-- prettier-ignore -->";

const TABLE_ROW = /^[+\- ]?\s*\|/;
const LEAD = /^[+\- ]?\s*/;
const SEPARATOR_CELL = /^(\s*:?)-{4,}(:?\s*)$/;
const LONG_RUN = 64;

export type PaddingRun = { line: number; length: number; char: " " | "-" };

export function findPaddingRuns(
  text: string,
  threshold = PADDING_THRESHOLD,
): PaddingRun[] {
  const re = new RegExp(` {${threshold},}|-{${threshold},}`, "g");
  const runs: PaddingRun[] = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(re)) {
      runs.push({
        line: i + 1,
        length: m[0].length,
        char: m[0][0] as " " | "-",
      });
    }
  });
  return runs;
}

function collapseTableRow(line: string): string {
  const lead = LEAD.exec(line)?.[0] ?? "";
  const cells = line
    .slice(lead.length)
    .replace(/ {2,}/g, " ")
    .split("|")
    .map((c) => c.replace(SEPARATOR_CELL, "$1---$2"));
  return lead + cells.join("|");
}

function collapseProseLine(line: string): string {
  return line
    .replace(new RegExp(` {${LONG_RUN},}`, "g"), " ")
    .replace(new RegExp(`-{${LONG_RUN},}`, "g"), "---");
}

export function collapsePadding(
  text: string,
  opts?: { force?: boolean; preserveForPrettier?: boolean },
): { text: string; changed: boolean; tables: number } {
  const threshold = opts?.force === true ? LONG_RUN : PADDING_THRESHOLD;
  if (findPaddingRuns(text, threshold).length === 0) {
    return { text, changed: false, tables: 0 };
  }
  const lines = text.split("\n");
  const fenced = fencedLineMask(lines);
  const out: string[] = [];
  let tables = 0;
  let inTable = false;
  let blockChanged = false;
  let blockStart = 0;
  const closeBlock = () => {
    if (inTable && blockChanged) {
      tables++;
      if (opts?.preserveForPrettier) {
        let k = blockStart - 1;
        while (k >= 0 && out[k].trim() === "") k--;
        if (k < 0 || out[k].trim() !== PRETTIER_IGNORE) {
          out.splice(blockStart, 0, PRETTIER_IGNORE);
        }
      }
    }
    inTable = false;
    blockChanged = false;
  };
  lines.forEach((line, i) => {
    if (fenced[i]) {
      closeBlock();
      out.push(line);
      return;
    }
    if (TABLE_ROW.test(line)) {
      if (!inTable) {
        inTable = true;
        blockStart = out.length;
      }
      const next = collapseTableRow(line);
      if (next !== line) blockChanged = true;
      out.push(next);
      return;
    }
    closeBlock();
    out.push(collapseProseLine(line));
  });
  closeBlock();
  const result = out.join("\n");
  return { text: result, changed: result !== text, tables };
}
