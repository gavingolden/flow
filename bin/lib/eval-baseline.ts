/**
 * The `--record-baseline` writer and the `--all` index writer, split out of
 * `bin/lib/eval-cli.ts` to keep that file under its line-count target.
 */

import * as path from "node:path";
import { renderSummary, type EvalReport } from "./eval-report";
import type { RunArgs } from "./eval-args";
// Type-only import — no runtime circular dependency (eval-cli.ts imports
// the functions below as values).
import type { Deps } from "./eval-cli";

const BASELINE_START = "<!-- flow-eval-baseline:start -->";
const BASELINE_END = "<!-- flow-eval-baseline:end -->";

function fmtScore(r: EvalReport): string {
  return r.skipped
    ? `skipped (${r.skipped.reason})`
    : r.summary.score.toFixed(3);
}

function baselineTable(reports: EvalReport[]): string {
  const rows = reports.map(
    (r) =>
      `| ${r.suite} | ${r.candidate} | ${fmtScore(r)} | ${r.tree.gitHead.slice(0, 12)} | ${r.finishedAt} |`,
  );
  return [
    "| Suite | Candidate | Score | Git Head | Recorded At |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export function writeBaselineFiles(
  reports: EvalReport[],
  args: RunArgs,
  deps: Deps,
): void {
  deps.mkdirp(args.baselineDir);
  for (const report of reports) {
    deps.writeFile(
      path.join(args.baselineDir, `${report.suite}.report.json`),
      JSON.stringify(report, null, 2) + "\n",
    );
    deps.writeFile(
      path.join(args.baselineDir, `${report.suite}.summary.md`),
      renderSummary(report) + "\n",
    );
  }

  const readmePath = path.join(args.baselineDir, "README.md");
  const existing = deps.exists(readmePath)
    ? deps.readFile(readmePath)
    : `${BASELINE_START}\n${BASELINE_END}\n`;
  const table = `${BASELINE_START}\n${baselineTable(reports)}\n${BASELINE_END}`;
  const startIdx = existing.indexOf(BASELINE_START);
  const endIdx = existing.indexOf(BASELINE_END);
  const updated =
    startIdx === -1 || endIdx === -1
      ? `${existing}\n\n${table}\n`
      : existing.slice(0, startIdx) +
        table +
        existing.slice(endIdx + BASELINE_END.length);
  deps.writeFile(readmePath, updated);
}

export function writeIndex(
  reports: EvalReport[],
  out: string,
  deps: Deps,
): void {
  const rows = reports.map(
    (r) =>
      `| ${r.suite} | ${fmtScore(r)} | ${r.summary.passed}/${r.summary.scenarios} | $${r.summary.costUsd.toFixed(3)} |`,
  );
  const md = [
    "# flow-eval — all suites",
    "",
    "| Suite | Score | Passed | Cost |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
  deps.writeFile(path.join(out, "index.md"), md + "\n");
}
