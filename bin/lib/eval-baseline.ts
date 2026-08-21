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

function readExistingReport(
  baselineDir: string,
  suite: string,
  deps: Deps,
): EvalReport | undefined {
  const p = path.join(baselineDir, `${suite}.report.json`);
  if (!deps.exists(p)) return undefined;
  try {
    return JSON.parse(deps.readFile(p)) as EvalReport;
  } catch {
    return undefined;
  }
}

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

  // A `skipped` report (flow-not-installed / claude-not-on-path / not
  // authenticated) carries no real scoring data — committing it over a
  // real recorded baseline would silently erase it. Skip the write, warn
  // on stderr, and keep whatever baseline already exists on disk for
  // this suite so the README merge below still has a real row to show.
  const recorded: EvalReport[] = [];
  for (const report of reports) {
    if (report.skipped) {
      deps.progress(
        `flow-eval: --record-baseline skipped ${report.suite} — ${report.skipped.notice} (existing baseline, if any, left untouched)\n`,
      );
      continue;
    }
    deps.writeFile(
      path.join(args.baselineDir, `${report.suite}.report.json`),
      JSON.stringify(report, null, 2) + "\n",
    );
    deps.writeFile(
      path.join(args.baselineDir, `${report.suite}.summary.md`),
      renderSummary(report) + "\n",
    );
    recorded.push(report);
  }

  // The README table must reflect every suite with an on-disk baseline,
  // not just the suites this invocation ran — a `--suite` run must not
  // drop every other suite's row. Merge this run's freshly-recorded
  // reports over whatever `<suite>.report.json` files already sit in
  // `baselineDir`, keyed by suite.
  const bySuite = new Map<string, EvalReport>();
  for (const name of deps.readdir(args.baselineDir)) {
    const m = /^(.*)\.report\.json$/.exec(name);
    if (!m) continue;
    const suite = m[1]!;
    const existingReport = readExistingReport(args.baselineDir, suite, deps);
    if (existingReport) bySuite.set(suite, existingReport);
  }
  for (const report of recorded) {
    bySuite.set(report.suite, report);
  }
  const mergedReports = [...bySuite.values()].sort((a, b) =>
    a.suite.localeCompare(b.suite),
  );

  const readmePath = path.join(args.baselineDir, "README.md");
  const existing = deps.exists(readmePath)
    ? deps.readFile(readmePath)
    : `${BASELINE_START}\n${BASELINE_END}\n`;
  const table = `${BASELINE_START}\n${baselineTable(mergedReports)}\n${BASELINE_END}`;
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
