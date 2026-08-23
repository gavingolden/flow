/**
 * The stable seam of `flow-eval`: `EvalReport` v1 plus its validator, the
 * score fold, a markdown summary renderer, and `compareReports` /
 * `renderComparison` for baseline-vs-candidate deltas. Additive fields only
 * once `docs/eval/baseline/*.report.json` is committed — bump
 * `schemaVersion` for anything else.
 */

import type { GraderKind, SuiteSpec } from "./eval-suite";
import type { ValidationErr, ValidationResult } from "./eval-suite";

export const EVAL_REPORT_SCHEMA_VERSION = 1;

export type GradeResult = {
  id: string;
  kind: GraderKind;
  gate: boolean;
  pass: boolean;
  expected?: unknown;
  actual?: unknown;
  detail?: string;
};

export type MetricValue = { value: number; direction: "lower" | "higher" };

export type RunStatus = "pass" | "fail" | "error" | "skipped";

export type RunRecord = {
  run: number;
  status: RunStatus;
  score: number;
  grades: GradeResult[];
  metrics: Record<string, MetricValue>;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  error?: string;
};

export type MetricSummary = {
  median: number;
  min: number;
  max: number;
  direction: "lower" | "higher";
  values: number[];
};

export type ScenarioRecord = {
  id: string;
  title: string;
  status: RunStatus;
  score: number;
  runs: RunRecord[];
  metrics: Record<string, MetricSummary>;
};

export type EvalReport = {
  schemaVersion: 1;
  runner: {
    name: "flow-eval-headless";
    claudeVersion?: string;
    model?: string;
    effort?: string;
    notes?: string[];
  };
  tree: { gitHead: string; dirty: boolean };
  suite: string;
  candidate: string;
  startedAt: string;
  finishedAt: string;
  scenarios: ScenarioRecord[];
  summary: {
    score: number;
    scenarios: number;
    passed: number;
    failed: number;
    errored: number;
    costUsd: number;
  };
  skipped?: {
    reason:
      | "claude-not-on-path"
      | "claude-not-authenticated"
      | "flow-not-installed"
      | "dry-run";
    notice: string;
  };
};

function err(reason: string, path?: string): ValidationErr {
  return { ok: false, reason, path };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

const RUN_STATUSES: ReadonlySet<string> = new Set([
  "pass",
  "fail",
  "error",
  "skipped",
]);

function isMetricValue(v: unknown): v is MetricValue {
  return (
    isPlainObject(v) &&
    isNumber(v.value) &&
    (v.direction === "lower" || v.direction === "higher")
  );
}

function isMetricsRecord(v: unknown): v is Record<string, MetricValue> {
  if (!isPlainObject(v)) return false;
  return Object.values(v).every(isMetricValue);
}

function isGradeResult(v: unknown): v is GradeResult {
  if (!isPlainObject(v)) return false;
  return (
    isNonEmptyString(v.id) &&
    isString(v.kind) &&
    isBoolean(v.gate) &&
    isBoolean(v.pass)
  );
}

function isRunRecord(v: unknown): v is RunRecord {
  if (!isPlainObject(v)) return false;
  if (!isNumber(v.run)) return false;
  if (!isString(v.status) || !RUN_STATUSES.has(v.status)) return false;
  if (!isNumber(v.score)) return false;
  if (!Array.isArray(v.grades) || !v.grades.every(isGradeResult)) return false;
  if (!isMetricsRecord(v.metrics)) return false;
  return true;
}

function isMetricSummary(v: unknown): v is MetricSummary {
  if (!isPlainObject(v)) return false;
  return (
    isNumber(v.median) &&
    isNumber(v.min) &&
    isNumber(v.max) &&
    (v.direction === "lower" || v.direction === "higher") &&
    Array.isArray(v.values) &&
    v.values.every(isNumber)
  );
}

function isScenarioRecord(v: unknown): v is ScenarioRecord {
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.id)) return false;
  if (!isNonEmptyString(v.title)) return false;
  if (!isString(v.status) || !RUN_STATUSES.has(v.status)) return false;
  if (!isNumber(v.score)) return false;
  if (!Array.isArray(v.runs) || !v.runs.every(isRunRecord)) return false;
  if (
    !isPlainObject(v.metrics) ||
    !Object.values(v.metrics).every(isMetricSummary)
  ) {
    return false;
  }
  return true;
}

export function validateReport(o: unknown): ValidationResult<EvalReport> {
  if (!isPlainObject(o)) return err("report must be a JSON object");
  if (o.schemaVersion !== 1) return err("'schemaVersion' must be 1");
  if (!isPlainObject(o.runner) || o.runner.name !== "flow-eval-headless") {
    return err("'runner.name' must be 'flow-eval-headless'");
  }
  if (
    !isPlainObject(o.tree) ||
    !isNonEmptyString(o.tree.gitHead) ||
    !isBoolean(o.tree.dirty)
  ) {
    return err("'tree' must carry a non-empty 'gitHead' and boolean 'dirty'");
  }
  if (!isNonEmptyString(o.suite))
    return err("'suite' must be a non-empty string");
  if (!isNonEmptyString(o.candidate))
    return err("'candidate' must be a non-empty string");
  if (!isNonEmptyString(o.startedAt))
    return err("'startedAt' must be a non-empty string");
  if (!isNonEmptyString(o.finishedAt))
    return err("'finishedAt' must be a non-empty string");
  if (!Array.isArray(o.scenarios) || !o.scenarios.every(isScenarioRecord)) {
    return err("'scenarios' must be an array of ScenarioRecord");
  }
  const s = o.summary;
  if (
    !isPlainObject(s) ||
    !isNumber(s.score) ||
    !isNumber(s.scenarios) ||
    !isNumber(s.passed) ||
    !isNumber(s.failed) ||
    !isNumber(s.errored) ||
    !isNumber(s.costUsd)
  ) {
    return err(
      "'summary' must carry score/scenarios/passed/failed/errored/costUsd numbers",
    );
  }
  if (o.skipped !== undefined) {
    const skip = o.skipped;
    const validReasons = new Set([
      "claude-not-on-path",
      "claude-not-authenticated",
      "flow-not-installed",
      "dry-run",
    ]);
    if (
      !isPlainObject(skip) ||
      !validReasons.has(skip.reason as string) ||
      !isString(skip.notice)
    ) {
      return err("'skipped' must carry a valid reason and notice");
    }
  }
  return { ok: true, value: o as unknown as EvalReport };
}

/**
 * `passed gates / total gates`. Informational (`gate: false`) graders are
 * excluded from both numerator and denominator. A scenario with zero gate
 * graders scores 1 (vacuously satisfied, never a divide-by-zero fail).
 */
export function scoreRun(grades: GradeResult[]): number {
  const gates = grades.filter((g) => g.gate);
  if (gates.length === 0) return 1;
  const passed = gates.filter((g) => g.pass).length;
  return passed / gates.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function foldMetrics(runs: RunRecord[]): Record<string, MetricSummary> {
  const byMetric: Record<
    string,
    { direction: "lower" | "higher"; values: number[] }
  > = {};
  for (const run of runs) {
    for (const [name, m] of Object.entries(run.metrics)) {
      const bucket = (byMetric[name] ??= {
        direction: m.direction,
        values: [],
      });
      bucket.values.push(m.value);
    }
  }
  const out: Record<string, MetricSummary> = {};
  for (const [name, bucket] of Object.entries(byMetric)) {
    out[name] = {
      median: median(bucket.values),
      min: Math.min(...bucket.values),
      max: Math.max(...bucket.values),
      direction: bucket.direction,
      values: bucket.values,
    };
  }
  return out;
}

/**
 * Scenario status: all runs `pass` -> `pass`; any run `error` -> `error`
 * UNLESS at least one run also `pass`ed, in which case it's `fail` (a mixed
 * error+pass result is not a clean error, but it isn't a clean pass
 * either); any run `skipped` and none ran for real -> `skipped`; otherwise
 * `fail`. Scenario score is the mean of run scores.
 */
export function foldScenario(
  id: string,
  title: string,
  runs: RunRecord[],
): ScenarioRecord {
  let status: RunStatus;
  if (runs.length > 0 && runs.every((r) => r.status === "skipped")) {
    status = "skipped";
  } else if (runs.length > 0 && runs.every((r) => r.status === "pass")) {
    status = "pass";
  } else if (runs.some((r) => r.status === "error")) {
    status = runs.some((r) => r.status === "pass") ? "fail" : "error";
  } else {
    status = "fail";
  }

  const score =
    runs.length === 0
      ? 0
      : runs.reduce((sum, r) => sum + r.score, 0) / runs.length;

  return {
    id,
    title,
    status,
    score,
    runs,
    metrics: foldMetrics(runs),
  };
}

export function buildReport(args: {
  suite: SuiteSpec;
  scenarios: ScenarioRecord[];
  runner: EvalReport["runner"];
  tree: EvalReport["tree"];
  startedAt: string;
  finishedAt: string;
  skipped?: EvalReport["skipped"];
}): EvalReport {
  const passed = args.scenarios.filter((s) => s.status === "pass").length;
  const failed = args.scenarios.filter((s) => s.status === "fail").length;
  const errored = args.scenarios.filter((s) => s.status === "error").length;
  const scored = args.scenarios.filter((s) => s.status !== "skipped");
  const score =
    scored.length === 0
      ? 0
      : scored.reduce((sum, s) => sum + s.score, 0) / scored.length;
  const costUsd = args.scenarios.reduce(
    (sum, s) => sum + s.runs.reduce((rs, r) => rs + (r.costUsd ?? 0), 0),
    0,
  );

  return {
    schemaVersion: EVAL_REPORT_SCHEMA_VERSION,
    runner: args.runner,
    tree: args.tree,
    suite: args.suite.id,
    candidate: args.suite.candidate,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    scenarios: args.scenarios,
    summary: {
      score,
      scenarios: args.scenarios.length,
      passed,
      failed,
      errored,
      costUsd,
    },
    ...(args.skipped ? { skipped: args.skipped } : {}),
  };
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}

export function renderSummary(r: EvalReport): string {
  if (r.skipped) {
    return [
      `# flow-eval — ${r.suite}`,
      "",
      `**Skipped** — ${r.skipped.notice}`,
      "",
      `Reason: \`${r.skipped.reason}\``,
    ].join("\n");
  }

  const lines: string[] = [
    `# flow-eval — ${r.suite}`,
    "",
    `Candidate: \`${r.candidate}\` · Tree: \`${r.tree.gitHead.slice(0, 12)}\`${r.tree.dirty ? " (dirty)" : ""} · Model: \`${r.runner.model ?? "n/a"}\` · Effort: \`${r.runner.effort ?? "n/a"}\``,
    "",
    "| Scenario | Status | Score | Runs | finalContextTokens | costUsd | numTurns | subagentsSpawned | durationMs |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const s of r.scenarios) {
    const fmtMetric = (name: string) => {
      const m = s.metrics[name];
      return m ? fmtNum(m.median) : "n/a";
    };
    const costs = s.runs.map((run) => run.costUsd ?? 0);
    const avgCost =
      costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;
    lines.push(
      `| ${s.id} | ${s.status} | ${fmtNum(s.score)} | ${s.runs.length} | ${fmtMetric("transcript.finalContextTokens")} | ${fmtNum(avgCost)} | ${fmtMetric("result.num_turns")} | ${fmtMetric("transcript.subagentsSpawned")} | ${fmtMetric("result.duration_ms")} |`,
    );
  }
  lines.push(
    "",
    `Suite score: **${fmtNum(r.summary.score)}** (${r.summary.passed}/${r.summary.scenarios} passed, ${r.summary.failed} failed, ${r.summary.errored} errored, $${fmtNum(r.summary.costUsd)})`,
  );
  return lines.join("\n");
}

export type MetricDelta = {
  name: string;
  base: number;
  candidate: number;
  delta: number;
  pct: number | null;
  verdict: "better" | "worse" | "same" | "noisy";
};

export type Comparison = {
  suite: string;
  base: { gitHead: string; model?: string; effort?: string };
  candidate: { gitHead: string; model?: string; effort?: string };
  scenarios: Array<{
    id: string;
    baseScore: number;
    candidateScore: number;
    scoreDelta: number;
    metrics: MetricDelta[];
  }>;
  regressions: string[];
  warnings: string[];
  environmentMismatch: boolean;
};

function verdictFor(
  baseSummary: MetricSummary,
  candMedian: number,
  tolerance: number,
): "better" | "worse" | "same" | "noisy" {
  const base = baseSummary.median;
  const pct =
    base === 0
      ? candMedian === 0
        ? 0
        : Infinity
      : (candMedian - base) / Math.abs(base);
  const spread =
    base === 0 ? 0 : (baseSummary.max - baseSummary.min) / Math.abs(base);
  const beyondTolerance = Math.abs(pct) > tolerance;
  if (!beyondTolerance) return "same";
  // A direction-signed relative change: for "lower is better" metrics a
  // positive pct (candidate went up) is worse; for "higher is better" a
  // negative pct is worse.
  const worse = baseSummary.direction === "lower" ? pct > 0 : pct < 0;
  if (worse && spread > tolerance) return "noisy";
  return worse ? "worse" : "better";
}

export function compareReports(
  base: EvalReport,
  cand: EvalReport,
  opts: { tolerance?: number } = {},
): Comparison {
  const tolerance = opts.tolerance ?? 0.1;
  const warnings: string[] = [];
  const regressions: string[] = [];

  const environmentMismatch =
    base.runner.model !== cand.runner.model ||
    base.runner.effort !== cand.runner.effort ||
    base.runner.claudeVersion !== cand.runner.claudeVersion;
  if (environmentMismatch) {
    warnings.push(
      `runner mismatch: model ${base.runner.model ?? "n/a"} -> ${cand.runner.model ?? "n/a"}, effort ${base.runner.effort ?? "n/a"} -> ${cand.runner.effort ?? "n/a"}, claudeVersion ${base.runner.claudeVersion ?? "n/a"} -> ${cand.runner.claudeVersion ?? "n/a"}`,
    );
  }

  const baseById = new Map(base.scenarios.map((s) => [s.id, s]));
  const candById = new Map(cand.scenarios.map((s) => [s.id, s]));
  const allIds = new Set([...baseById.keys(), ...candById.keys()]);

  const scenarios: Comparison["scenarios"] = [];
  for (const id of allIds) {
    const b = baseById.get(id);
    const c = candById.get(id);
    if (!b || !c) {
      warnings.push(`scenario '${id}' present in only one report`);
      continue;
    }
    const scoreDelta = c.score - b.score;
    if (c.score < b.score) {
      regressions.push(`${id}: score`);
    }

    const metricNames = new Set([
      ...Object.keys(b.metrics),
      ...Object.keys(c.metrics),
    ]);
    const metrics: MetricDelta[] = [];
    for (const name of metricNames) {
      const bm = b.metrics[name];
      const cm = c.metrics[name];
      if (!bm || !cm) continue;
      const delta = cm.median - bm.median;
      const pct = bm.median === 0 ? null : delta / Math.abs(bm.median);
      const verdict = verdictFor(bm, cm.median, tolerance);
      if (verdict === "worse") regressions.push(`${id}: ${name}`);
      metrics.push({
        name,
        base: bm.median,
        candidate: cm.median,
        delta,
        pct,
        verdict,
      });
    }

    scenarios.push({
      id,
      baseScore: b.score,
      candidateScore: c.score,
      scoreDelta,
      metrics,
    });
  }

  return {
    suite: cand.suite,
    base: {
      gitHead: base.tree.gitHead,
      model: base.runner.model,
      effort: base.runner.effort,
    },
    candidate: {
      gitHead: cand.tree.gitHead,
      model: cand.runner.model,
      effort: cand.runner.effort,
    },
    scenarios,
    regressions,
    warnings,
    environmentMismatch,
  };
}

export function renderComparison(c: Comparison): string {
  const lines: string[] = [`# flow-eval compare — ${c.suite}`, ""];
  lines.push(
    `Base: \`${c.base.gitHead.slice(0, 12)}\` (${c.base.model ?? "n/a"}/${c.base.effort ?? "n/a"}) vs Candidate: \`${c.candidate.gitHead.slice(0, 12)}\` (${c.candidate.model ?? "n/a"}/${c.candidate.effort ?? "n/a"})`,
  );
  lines.push("");
  for (const s of c.scenarios) {
    lines.push(
      `## ${s.id} (score ${fmtNum(s.baseScore)} -> ${fmtNum(s.candidateScore)}, delta ${fmtNum(s.scoreDelta)})`,
    );
    lines.push("");
    lines.push("| Metric | Base | Candidate | Delta | % | Verdict |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const m of s.metrics) {
      const pctStr = m.pct === null ? "n/a" : `${(m.pct * 100).toFixed(1)}%`;
      lines.push(
        `| ${m.name} | ${fmtNum(m.base)} | ${fmtNum(m.candidate)} | ${fmtNum(m.delta)} | ${pctStr} | ${m.verdict} |`,
      );
    }
    lines.push("");
  }
  lines.push(`## Regressions (${c.regressions.length})`);
  lines.push(
    c.regressions.length === 0
      ? "None."
      : c.regressions.map((r) => `- ${r}`).join("\n"),
  );
  lines.push("");
  lines.push(`## Warnings (${c.warnings.length})`);
  lines.push(
    c.warnings.length === 0
      ? "None."
      : c.warnings.map((w) => `- ${w}`).join("\n"),
  );
  return lines.join("\n");
}
