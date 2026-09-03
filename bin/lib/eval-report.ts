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

/**
 * `"with"` — the plugin-bearing arm, the harness's only arm before
 * `--ablation`. `"without"` — the no-plugin baseline arm `--ablation
 * with-without` adds. Every field this arm introduces is optional/additive
 * so `schemaVersion` stays 1.
 */
export type Arm = "with" | "without";

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
  /** Omitted (not `"with"`) on the single-arm path, so a report recorded
   * without `--ablation` stays byte-identical to today's shape. */
  arm?: Arm;
  /**
   * `childArgvDigest(argv)` for THIS run's composed child argv, mirrored
   * from `eval-runner.ts`'s `RunOutcome.childArgvDigest`. Not named in
   * the plan's field list for `RunRecord` (only `EvalReport.runner`
   * named it) — added here as the natural per-run provenance field
   * (alongside `sessionId`/`costUsd`) so `runSuite` can lift ONE run's
   * digest into the report-level `runner.childArgvDigest` without a
   * separate out-of-band side channel. Optional/additive, so it never
   * touches the single-arm byte-identity requirement.
   */
  childArgvDigest?: string;
};

export type MetricSummary = {
  median: number;
  min: number;
  max: number;
  direction: "lower" | "higher";
  values: number[];
};

/**
 * Per-scenario `--ablation with-without` result. `with`/`without` each
 * carry the same `{score, metrics}` shape as the scenario's own top-level
 * fields, PLUS `avgCostUsd` — an adaptation beyond the plan's literal
 * `{score, metrics}` pair: Task 7's headline rule requires leading with
 * cost/context/turn deltas, and cost lives on `RunRecord.costUsd`, never
 * inside the `metrics` record, so `avgCostUsd` is the only way to carry it
 * through without inventing a synthetic metrics key.
 */
export type ArmSummary = {
  score: number;
  metrics: Record<string, MetricSummary>;
  avgCostUsd: number;
};

export type ScenarioRecord = {
  id: string;
  title: string;
  status: RunStatus;
  score: number;
  runs: RunRecord[];
  metrics: Record<string, MetricSummary>;
  ablation?: {
    with: ArmSummary;
    without: ArmSummary;
    scoreDelta: number;
    metricDeltas: Record<string, number>;
  };
};

export type EvalReport = {
  schemaVersion: 1;
  runner: {
    name: "flow-eval-headless";
    claudeVersion?: string;
    model?: string;
    effort?: string;
    notes?: string[];
    /**
     * A hash of the composed child argv's flag NAMES plus the fixed
     * values of the permission/setting-sources/tools flags and a
     * `--plugin-dir` count — never the prompt, session id, or fixture
     * paths (see `childArgvDigest` in `./eval-runner`). `compare` warns
     * when base and candidate carry different digests: the two reports
     * were produced by differently-shaped children, not just different
     * trees.
     */
    childArgvDigest?: string;
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
    /** Mean of every scenario's `ablation.scoreDelta`, present only when
     * at least one scenario carries an `ablation` field. */
    scoreDelta?: number;
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

function isArm(v: unknown): v is Arm {
  return v === "with" || v === "without";
}

function isRunRecord(v: unknown): v is RunRecord {
  if (!isPlainObject(v)) return false;
  if (!isNumber(v.run)) return false;
  if (!isString(v.status) || !RUN_STATUSES.has(v.status)) return false;
  if (!isNumber(v.score)) return false;
  if (!Array.isArray(v.grades) || !v.grades.every(isGradeResult)) return false;
  if (!isMetricsRecord(v.metrics)) return false;
  if (v.arm !== undefined && !isArm(v.arm)) return false;
  if (v.childArgvDigest !== undefined && !isString(v.childArgvDigest)) {
    return false;
  }
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

function isArmSummary(v: unknown): v is ArmSummary {
  if (!isPlainObject(v)) return false;
  return (
    isNumber(v.score) &&
    isPlainObject(v.metrics) &&
    Object.values(v.metrics).every(isMetricSummary) &&
    isNumber(v.avgCostUsd)
  );
}

function isMetricDeltas(v: unknown): v is Record<string, number> {
  return isPlainObject(v) && Object.values(v).every(isNumber);
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
  if (v.ablation !== undefined) {
    const a = v.ablation;
    if (
      !isPlainObject(a) ||
      !isArmSummary(a.with) ||
      !isArmSummary(a.without) ||
      !isNumber(a.scoreDelta) ||
      !isMetricDeltas(a.metricDeltas)
    ) {
      return false;
    }
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
    o.runner.childArgvDigest !== undefined &&
    !isString(o.runner.childArgvDigest)
  ) {
    return err("'runner.childArgvDigest' must be a string");
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
  if (s.scoreDelta !== undefined && !isNumber(s.scoreDelta)) {
    return err("'summary.scoreDelta' must be a number when present");
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
 *
 * `arm`/`withOnlyIds` are additive (both default to the single-arm
 * behaviour, so an un-widened call site is byte-identical to before):
 * when `arm` is `"without"`, any grade whose `id` is in `withOnlyIds` is
 * ALSO excluded from both numerator and denominator — a `withOnly` grader
 * (e.g. `plugin-loaded`) can never pass in the no-plugin baseline arm, so
 * counting it there would make every scenario's `scoreDelta` a fixed,
 * information-free constant rather than a real measurement. `withOnlyIds`
 * is deliberately an id set rather than a field on `GradeResult` itself —
 * the caller already holds the scenario's `GraderSpec[]` (which carries
 * `withOnly`) at the point it calls this, so no new field needs to round
 * -trip through the grading pipeline.
 */
export function scoreRun(
  grades: GradeResult[],
  arm: Arm = "with",
  withOnlyIds: ReadonlySet<string> = new Set(),
): number {
  const gates = grades.filter(
    (g) => g.gate && !(arm === "without" && withOnlyIds.has(g.id)),
  );
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
  /** Mean of every scenario's `ablation.scoreDelta`, computed by the
   * caller (which owns the per-arm job list) and threaded straight into
   * `summary.scoreDelta`. Absent whenever no scenario ran an ablation
   * arm — the `--threshold` gate then reads the same `summary.score`
   * shape it always has. */
  summaryScoreDelta?: number;
}): EvalReport {
  const passed = args.scenarios.filter((s) => s.status === "pass").length;
  const failed = args.scenarios.filter((s) => s.status === "fail").length;
  const errored = args.scenarios.filter((s) => s.status === "error").length;
  const scored = args.scenarios.filter((s) => s.status !== "skipped");
  const score =
    scored.length === 0
      ? 0
      : scored.reduce((sum, s) => sum + s.score, 0) / scored.length;
  // Explicit with-arm restriction: `s.runs` is the caller's contract to
  // hold only with-arm RunRecords (the without-arm's own runs are folded
  // separately into `s.ablation.without`, never appended here) — this
  // filter is a defensive backstop, not a no-op left to chance, so a
  // future caller that DID start appending without-arm runs into `.runs`
  // could never silently double the reported cost or skew the threshold
  // gate's score.
  const costUsd = args.scenarios.reduce(
    (sum, s) =>
      sum +
      s.runs
        .filter((r) => r.arm !== "without")
        .reduce((rs, r) => rs + (r.costUsd ?? 0), 0),
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
      ...(args.summaryScoreDelta !== undefined
        ? { scoreDelta: args.summaryScoreDelta }
        : {}),
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

  // OFF-LIMITS invariant (docs/eval/baseline/README.md:14-19 forbids a
  // feature PR regenerating the committed *.summary.md files): every line
  // above this point is unconditional, so a report with no scenario
  // carrying `ablation` produces BYTE-IDENTICAL output to before this
  // function existed — asserted directly in eval-report.test.ts. This
  // section is additive ONLY, gated behind `hasAblation`.
  const hasAblation = r.scenarios.some((s) => s.ablation);
  if (hasAblation) {
    // Task 7's headline rule: lead with the per-metric cost/context/turn
    // deltas (absolute AND as a % of the without arm), with scoreDelta
    // shown alongside — never as the sole or primary number.
    lines.push(
      "",
      "## Plugin ablation (with vs without)",
      "",
      "Leading deltas — cost/context/turns, with vs without the plugin (Δ and Δ% of the without arm):",
      "",
      "| Scenario | Metric | With | Without | Δ | Δ% (of without) |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    const pctOfWithout = (delta: number, without: number): string =>
      without === 0
        ? "n/a"
        : `${((delta / Math.abs(without)) * 100).toFixed(1)}%`;
    for (const s of r.scenarios) {
      if (!s.ablation) continue;
      const rows: Array<[string, number, number]> = [
        ["costUsd", s.ablation.with.avgCostUsd, s.ablation.without.avgCostUsd],
        [
          "transcript.finalContextTokens",
          s.ablation.with.metrics["transcript.finalContextTokens"]?.median ??
            NaN,
          s.ablation.without.metrics["transcript.finalContextTokens"]?.median ??
            NaN,
        ],
        [
          "result.num_turns",
          s.ablation.with.metrics["result.num_turns"]?.median ?? NaN,
          s.ablation.without.metrics["result.num_turns"]?.median ?? NaN,
        ],
      ];
      for (const [name, withVal, withoutVal] of rows) {
        if (Number.isNaN(withVal) || Number.isNaN(withoutVal)) continue;
        const delta = withVal - withoutVal;
        lines.push(
          `| ${s.id} | ${name} | ${fmtNum(withVal)} | ${fmtNum(withoutVal)} | ${fmtNum(delta)} | ${pctOfWithout(delta, withoutVal)} |`,
        );
      }
    }
    lines.push(
      "",
      `Suite scoreDelta: **${fmtNum(r.summary.scoreDelta ?? 0)}** (with-arm score vs without-arm score — secondary to the deltas above, never the plugin's sole signal)`,
    );
  }

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

  const childArgvDigestDrift =
    base.runner.childArgvDigest !== undefined &&
    cand.runner.childArgvDigest !== undefined &&
    base.runner.childArgvDigest !== cand.runner.childArgvDigest;
  const environmentMismatch =
    base.runner.model !== cand.runner.model ||
    base.runner.effort !== cand.runner.effort ||
    base.runner.claudeVersion !== cand.runner.claudeVersion ||
    childArgvDigestDrift;
  if (environmentMismatch) {
    warnings.push(
      `runner mismatch: model ${base.runner.model ?? "n/a"} -> ${cand.runner.model ?? "n/a"}, effort ${base.runner.effort ?? "n/a"} -> ${cand.runner.effort ?? "n/a"}, claudeVersion ${base.runner.claudeVersion ?? "n/a"} -> ${cand.runner.claudeVersion ?? "n/a"}${childArgvDigestDrift ? `, childArgvDigest ${base.runner.childArgvDigest} -> ${cand.runner.childArgvDigest} (the composed child argv/env shape itself differs)` : ""}`,
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
