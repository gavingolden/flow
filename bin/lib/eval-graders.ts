/**
 * Evaluates each of the six `GraderKind`s against a `GraderContext`.
 * `command`/`git-clean` shell out via `node:child_process` through the
 * injectable `ctx.runCommand` — NEVER `Bun.spawn`, which is undefined
 * under vitest's Node-hosted process. `picomatch` (already a runtime
 * dependency) drives `git-clean`'s `allow` globs.
 */

import picomatch from "picomatch";
import type { GraderSpec, Matcher } from "./eval-suite";
import type { GradeResult, MetricValue } from "./eval-report";
import type { ResultEnvelope, TranscriptMetrics } from "./eval-transcript";
import { metricSource } from "./eval-transcript";
import { statePath } from "./state";
import { checkpointDir } from "./checkpoint-freshness";

export type GraderContext = {
  repoDir: string;
  fixtureRoot: string;
  stateSlug: string;
  stateDir: string;
  streamPath: string;
  result: ResultEnvelope | null;
  transcript: TranscriptMetrics;
  runCommand: (
    argv: string[],
    cwd: string,
  ) => { exitCode: number; stdout: string };
  readFile: (p: string) => string | null;
  exists: (p: string) => boolean;
};

/**
 * Expands `$REPO`/`$FIXTURE`/`$STATE`/`$CHECKPOINTS`/`$STREAM` placeholders
 * in `file`/`cwd` grader fields. `$STATE` and `$CHECKPOINTS` resolve
 * through the real `statePath`/`checkpointDir` helpers so a grader can
 * never drift from where the harness itself wrote those files.
 */
export function expandPlaceholders(s: string, ctx: GraderContext): string {
  return s
    .replace(/\$REPO\b/g, ctx.repoDir)
    .replace(/\$FIXTURE\b/g, ctx.fixtureRoot)
    .replace(/\$STATE\b/g, statePath(ctx.stateSlug, ctx.stateDir))
    .replace(/\$CHECKPOINTS\b/g, checkpointDir(ctx.stateSlug, ctx.stateDir))
    .replace(/\$STREAM\b/g, ctx.streamPath);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * `equals` — deep-equal; `oneOf` — deep-equal against any member;
 * `contains` — substring for a string `actual`, `.includes` for an array;
 * `matches`/`notMatches` — regex over `String(actual)`; `exists` —
 * `actual !== undefined` (compared against the expected boolean).
 */
export function matchValue(
  m: Matcher,
  actual: unknown,
): { pass: boolean; expected: unknown } {
  if (m.equals !== undefined) {
    return { pass: deepEqual(actual, m.equals), expected: m.equals };
  }
  if (m.oneOf !== undefined) {
    return {
      pass: m.oneOf.some((v) => deepEqual(actual, v)),
      expected: m.oneOf,
    };
  }
  if (m.contains !== undefined) {
    const pass = Array.isArray(actual)
      ? actual.includes(m.contains)
      : typeof actual === "string" && actual.includes(m.contains);
    return { pass, expected: `contains "${m.contains}"` };
  }
  if (m.matches !== undefined) {
    return {
      pass: new RegExp(m.matches).test(String(actual)),
      expected: `matches /${m.matches}/`,
    };
  }
  if (m.notMatches !== undefined) {
    return {
      pass: !new RegExp(m.notMatches).test(String(actual)),
      expected: `not matches /${m.notMatches}/`,
    };
  }
  if (m.exists !== undefined) {
    return {
      pass: (actual !== undefined) === m.exists,
      expected: `exists === ${m.exists}`,
    };
  }
  return { pass: false, expected: undefined };
}

function dotGet(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const key of path.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function gradeStructured(spec: GraderSpec, ctx: GraderContext): GradeResult {
  const actual = dotGet(ctx.result?.structured_output, spec.path ?? "");
  const { pass, expected } = matchValue(spec, actual);
  return {
    id: spec.id,
    kind: spec.kind,
    gate: spec.gate !== false,
    pass,
    ...(pass ? {} : { expected, actual }),
  };
}

function gradeJsonFile(spec: GraderSpec, ctx: GraderContext): GradeResult {
  const file = expandPlaceholders(spec.file ?? "", ctx);
  const raw = ctx.readFile(file);
  if (raw === null) {
    return {
      id: spec.id,
      kind: spec.kind,
      gate: spec.gate !== false,
      pass: false,
      detail: `file not found: ${file}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      id: spec.id,
      kind: spec.kind,
      gate: spec.gate !== false,
      pass: false,
      detail: `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const actual = dotGet(parsed, spec.path ?? "");
  const { pass, expected } = matchValue(spec, actual);
  return {
    id: spec.id,
    kind: spec.kind,
    gate: spec.gate !== false,
    pass,
    ...(pass ? {} : { expected, actual }),
  };
}

function gradeFile(spec: GraderSpec, ctx: GraderContext): GradeResult {
  const file = expandPlaceholders(spec.file ?? "", ctx);
  if (spec.exists !== undefined) {
    // Deliberately NOT routed through `matchValue`'s generic `exists`
    // matcher (`actual !== undefined`) — `ctx.exists(file)` already
    // returns the filesystem-existence boolean itself, and that boolean
    // value is always `!== undefined` regardless of whether the file
    // exists, which would make this branch pass unconditionally whenever
    // `spec.exists` is true. Compare the two booleans directly instead.
    const fileExists = ctx.exists(file);
    const pass = fileExists === spec.exists;
    return {
      id: spec.id,
      kind: spec.kind,
      gate: spec.gate !== false,
      pass,
      ...(pass ? {} : { expected: spec.exists, actual: fileExists }),
    };
  }
  const raw = ctx.readFile(file);
  if (raw === null) {
    return {
      id: spec.id,
      kind: spec.kind,
      gate: spec.gate !== false,
      pass: false,
      detail: `file not found: ${file}`,
    };
  }
  const { pass, expected } = matchValue(spec, raw);
  return {
    id: spec.id,
    kind: spec.kind,
    gate: spec.gate !== false,
    pass,
    ...(pass ? {} : { expected, actual: capActual(raw) }),
  };
}

const ACTUAL_CAP_CHARS = 500;

// A failed `file` grader over `$STREAM` would otherwise copy the whole
// transcript (often tens of KB) into `grades.json` / `report.json` —
// which `--record-baseline` commits verbatim. Cap it to a bounded excerpt
// plus the real byte count, so the failure is still legible without
// bloating every committed baseline.
function capActual(raw: string): string {
  if (raw.length <= ACTUAL_CAP_CHARS) return raw;
  return `${raw.slice(0, ACTUAL_CAP_CHARS)}… (truncated, ${Buffer.byteLength(raw, "utf8")} bytes total)`;
}

function gradeCommand(spec: GraderSpec, ctx: GraderContext): GradeResult {
  const cwd = expandPlaceholders(spec.cwd ?? ctx.repoDir, ctx);
  const argv = (spec.argv ?? []).map((a) => expandPlaceholders(a, ctx));
  const { exitCode, stdout } = ctx.runCommand(argv, cwd);
  const expectExit = spec.expectExit ?? 0;
  const pass = exitCode === expectExit;
  return {
    id: spec.id,
    kind: spec.kind,
    gate: spec.gate !== false,
    pass,
    ...(pass
      ? {}
      : {
          expected: expectExit,
          actual: exitCode,
          detail: stdout.slice(-2000),
        }),
  };
}

function gradeGitClean(spec: GraderSpec, ctx: GraderContext): GradeResult {
  const cwd = expandPlaceholders(spec.cwd ?? ctx.repoDir, ctx);
  const { exitCode, stdout } = ctx.runCommand(
    ["git", "status", "--porcelain"],
    cwd,
  );
  if (exitCode !== 0) {
    return {
      id: spec.id,
      kind: spec.kind,
      gate: spec.gate !== false,
      pass: false,
      detail: `git status --porcelain exited ${exitCode}`,
    };
  }
  const isMatch =
    spec.allow && spec.allow.length > 0 ? picomatch(spec.allow) : () => false;
  const dirty = stdout
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.slice(3).trim())
    .filter((p) => !isMatch(p));
  const pass = dirty.length === 0;
  return {
    id: spec.id,
    kind: spec.kind,
    gate: spec.gate !== false,
    pass,
    ...(pass ? {} : { expected: "clean", actual: dirty }),
  };
}

/**
 * `metric` graders always record a `{value,direction}` metric; they only
 * GATE (contribute a real pass/fail to `scoreRun`'s denominator) when a
 * `max` or `min` threshold is present — an unbounded metric is purely
 * observational, regardless of what `spec.gate` says.
 */
function gradeMetric(spec: GraderSpec, ctx: GraderContext): GradeResult {
  const value = metricSource(spec.source ?? "", ctx);
  const hasThreshold = spec.max !== undefined || spec.min !== undefined;
  const gate = spec.gate !== false && hasThreshold;
  if (value === undefined) {
    return {
      id: spec.id,
      kind: spec.kind,
      gate,
      pass: false,
      detail: `metric source unresolved: ${spec.source}`,
    };
  }
  let pass = true;
  if (spec.max !== undefined && value > spec.max) pass = false;
  if (spec.min !== undefined && value < spec.min) pass = false;
  return {
    id: spec.id,
    kind: spec.kind,
    gate,
    pass,
    ...(pass
      ? {}
      : { expected: { max: spec.max, min: spec.min }, actual: value }),
  };
}

export function grade(spec: GraderSpec, ctx: GraderContext): GradeResult {
  switch (spec.kind) {
    case "structured":
      return gradeStructured(spec, ctx);
    case "json-file":
      return gradeJsonFile(spec, ctx);
    case "file":
      return gradeFile(spec, ctx);
    case "command":
      return gradeCommand(spec, ctx);
    case "git-clean":
      return gradeGitClean(spec, ctx);
    case "metric":
      return gradeMetric(spec, ctx);
  }
}

export function gradeAll(
  specs: GraderSpec[],
  ctx: GraderContext,
): {
  grades: GradeResult[];
  metrics: Record<string, MetricValue>;
  score: number;
} {
  const grades = specs.map((spec) => grade(spec, ctx));
  const metrics: Record<string, MetricValue> = {};
  for (const spec of specs) {
    if (spec.kind !== "metric") continue;
    // A `max`/`min` threshold makes this spec gate-only (see gradeMetric):
    // its pass/fail already lives in `grades`, and it must NOT also land
    // under `metrics[spec.id]` — otherwise a gated metric like
    // `bash-calls-floor` shows up a second time as an unthresholded
    // compared metric next to its own unbounded sibling.
    if (spec.max !== undefined || spec.min !== undefined) continue;
    const value = metricSource(spec.source ?? "", ctx);
    if (value !== undefined) {
      metrics[spec.id] = { value, direction: spec.direction ?? "lower" };
    }
  }
  const gates = grades.filter((g) => g.gate);
  const score =
    gates.length === 0 ? 1 : gates.filter((g) => g.pass).length / gates.length;
  return { grades, metrics, score };
}
