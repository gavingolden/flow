/**
 * Render the eval delta report and decide the exit code.
 *
 * Layout: one row per fixture with `defaults` and `pr7` columns side-by-side,
 * an aggregate footer, and an appendix listing every failed soft criterion
 * with the judge's reason.
 *
 * Exit code:
 *   - 0 when only one config ran (no comparison possible).
 *   - 0 when pr7 passes ≥ defaults_passes − 1 (i.e. regression of ≤ 1 fixture).
 *   - 1 when pr7 regresses by > 1 fixture.
 */

import type { RunResult } from "./eval-runner";
import type { Verdict } from "./eval-judge";
import { formatUsd } from "./eval-cost";

export const REGRESSION_TOLERANCE = 1;

export type RenderInput = {
  results: RunResult[];
  fixtures: string[];
};

export function renderReport(input: RenderInput): string {
  const { fixtures, results } = input;
  const byFixture = new Map<string, Map<"defaults" | "pr7", RunResult>>();
  for (const r of results) {
    let inner = byFixture.get(r.fixture);
    if (!inner) {
      inner = new Map();
      byFixture.set(r.fixture, inner);
    }
    inner.set(r.config, r);
  }

  const haveDefaults = results.some((r) => r.config === "defaults");
  const havePr7 = results.some((r) => r.config === "pr7");

  const lines: string[] = [];
  const headerCols = ["Fixture"];
  if (haveDefaults) headerCols.push("defaults pass", "defaults impl $");
  if (havePr7) headerCols.push("pr7 pass", "pr7 impl $");
  if (haveDefaults && havePr7) headerCols.push("impl Δ");
  const cols = padColumns([
    headerCols,
    ...fixtures.map((f) => fixtureRow(f, byFixture.get(f), haveDefaults, havePr7)),
  ]);
  lines.push(...cols);

  // Aggregate footer.
  lines.push("");
  const totalDefaults = aggregate(results.filter((r) => r.config === "defaults"));
  const totalPr7 = aggregate(results.filter((r) => r.config === "pr7"));
  const totalCols = ["TOTAL"];
  if (haveDefaults) totalCols.push(`${totalDefaults.pass}/${totalDefaults.runs}`, formatUsd(totalDefaults.implUsd));
  if (havePr7) totalCols.push(`${totalPr7.pass}/${totalPr7.runs}`, formatUsd(totalPr7.implUsd));
  if (haveDefaults && havePr7) totalCols.push(deltaUsd(totalDefaults.implUsd, totalPr7.implUsd));
  lines.push(padColumns([totalCols])[0]);

  // Judge cost — same across configs by design, report once.
  const judgeUsd = results.reduce((sum, r) => sum + r.soft.judgeCost.usd, 0);
  lines.push("");
  lines.push(`JUDGE COST: ${formatUsd(judgeUsd)} (${results.length} calls)`);

  // Verdict line.
  if (haveDefaults && havePr7) {
    const regression = totalDefaults.pass - totalPr7.pass;
    if (regression > REGRESSION_TOLERANCE) {
      lines.push("");
      lines.push(`REGRESSION: pr7 passes ${regression} fewer fixtures than defaults (tolerance: ${REGRESSION_TOLERANCE})`);
    } else if (regression < 0) {
      lines.push("");
      lines.push(`PR 7 IMPROVES: ${-regression} more fixture(s) pass; impl cost delta ${deltaUsd(totalDefaults.implUsd, totalPr7.implUsd)}/run`);
    } else {
      lines.push("");
      lines.push(`OK: pr7 within tolerance (regression of ${regression} ≤ ${REGRESSION_TOLERANCE})`);
    }
  }

  // Failed soft-criterion appendix.
  const failedSoft = collectFailedSoft(results);
  if (failedSoft.length > 0) {
    lines.push("");
    lines.push("Failed soft criteria:");
    for (const f of failedSoft) {
      lines.push(`  ${f.fixture} (${f.config}): ${f.verdict.criterion}`);
      lines.push(`    → ${f.verdict.reason}`);
    }
  }

  return lines.join("\n") + "\n";
}

export function decideExitCode(results: RunResult[]): number {
  const haveDefaults = results.some((r) => r.config === "defaults");
  const havePr7 = results.some((r) => r.config === "pr7");
  if (!haveDefaults || !havePr7) return 0;
  const totalDefaults = aggregate(results.filter((r) => r.config === "defaults"));
  const totalPr7 = aggregate(results.filter((r) => r.config === "pr7"));
  const regression = totalDefaults.pass - totalPr7.pass;
  return regression > REGRESSION_TOLERANCE ? 1 : 0;
}

function fixtureRow(
  fixture: string,
  configs: Map<"defaults" | "pr7", RunResult> | undefined,
  haveDefaults: boolean,
  havePr7: boolean,
): string[] {
  const out: string[] = [fixture];
  const def = configs?.get("defaults");
  const pr7 = configs?.get("pr7");
  if (haveDefaults) out.push(passMark(def), def ? formatUsd(def.implCost.usd) : "—");
  if (havePr7) out.push(passMark(pr7), pr7 ? formatUsd(pr7.implCost.usd) : "—");
  if (haveDefaults && havePr7) {
    out.push(def && pr7 ? deltaUsd(def.implCost.usd, pr7.implCost.usd) : "—");
  }
  return out;
}

function passMark(r: RunResult | undefined): string {
  if (!r) return "—";
  return r.pass ? "PASS" : "FAIL";
}

function aggregate(results: RunResult[]): { pass: number; runs: number; implUsd: number } {
  return {
    pass: results.filter((r) => r.pass).length,
    runs: results.length,
    implUsd: results.reduce((s, r) => s + r.implCost.usd, 0),
  };
}

function deltaUsd(defaultsUsd: number, pr7Usd: number): string {
  const delta = pr7Usd - defaultsUsd;
  const sign = delta < 0 ? "-" : "+";
  return `${sign}$${Math.abs(delta).toFixed(4)}`;
}

function collectFailedSoft(
  results: RunResult[],
): { fixture: string; config: string; verdict: Verdict }[] {
  const out: { fixture: string; config: string; verdict: Verdict }[] = [];
  for (const r of results) {
    for (const v of r.soft.verdicts) {
      if (v.verdict === "no") out.push({ fixture: r.fixture, config: r.config, verdict: v });
    }
  }
  return out;
}

function padColumns(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) =>
    r.map((cell, i) => (cell ?? "").padEnd(widths[i])).join("  ").trimEnd(),
  );
}
