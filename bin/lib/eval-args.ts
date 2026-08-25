/**
 * `flow-eval`'s argv parser, split out of `bin/lib/eval-cli.ts` to keep
 * that file under the AGENTS.md line-count target. Pure — no I/O, no
 * `Deps`, so it needs no test doubles of its own.
 */

import * as path from "node:path";

export type RunArgs = {
  verb: "run";
  suites: string[] | "all";
  out: string;
  runs?: number;
  model?: string;
  effort?: string;
  dryRun: boolean;
  claudeBin: string;
  evalsDir: string;
  threshold?: number;
  keepFixtures: boolean;
  keepSessions: boolean;
  recordBaseline: boolean;
  baselineDir: string;
  allowDirty: boolean;
  concurrency: number;
};
export type ReportArgs = { verb: "report"; in: string };
export type CompareArgs = {
  verb: "compare";
  base: string;
  candidate: string;
  tolerance: number;
  failOnRegression: boolean;
  json: boolean;
};
export type ValidateArgs = { verb: "validate"; paths: string[] };
export type ParsedArgs = RunArgs | ReportArgs | CompareArgs | ValidateArgs;

const DEFAULTS = {
  claudeBin: "claude",
  evalsDir: "evals",
  tolerance: 0.1,
  baselineDir: path.join("docs", "eval", "baseline"),
  concurrency: 1,
};

function flagValue(
  argv: string[],
  i: number,
  flag: string,
): string | { error: string } {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--"))
    return { error: `${flag} requires a value` };
  return v;
}

export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const verb = argv[0];
  if (
    verb !== "run" &&
    verb !== "report" &&
    verb !== "compare" &&
    verb !== "validate"
  ) {
    return {
      error: `unknown or missing verb (expected run|report|compare|validate), got '${verb ?? ""}'`,
    };
  }
  const rest = argv.slice(1);

  if (verb === "validate") {
    const paths = rest.filter((a) => !a.startsWith("--"));
    if (paths.length === 0)
      return { error: "validate requires at least one path" };
    return { verb: "validate", paths };
  }

  if (verb === "report") {
    let inPath: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--in") {
        const v = flagValue(rest, i, "--in");
        if (typeof v !== "string") return v;
        inPath = v;
        i++;
      } else {
        return { error: `unknown flag: ${rest[i]}` };
      }
    }
    if (!inPath) return { error: "--in is required" };
    return { verb: "report", in: inPath };
  }

  if (verb === "compare") {
    let base: string | undefined;
    let candidate: string | undefined;
    let tolerance = DEFAULTS.tolerance;
    let failOnRegression = false;
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (flag === "--fail-on-regression") {
        failOnRegression = true;
        continue;
      }
      if (flag === "--json") {
        json = true;
        continue;
      }
      const v = flagValue(rest, i, flag);
      if (typeof v !== "string") return v;
      if (flag === "--base") base = v;
      else if (flag === "--candidate") candidate = v;
      else if (flag === "--tolerance") {
        const n = Number(v);
        if (!Number.isFinite(n))
          return { error: "--tolerance must be a number" };
        tolerance = n;
      } else return { error: `unknown flag: ${flag}` };
      i++;
    }
    if (!base || !candidate)
      return { error: "--base and --candidate are required" };
    return {
      verb: "compare",
      base,
      candidate,
      tolerance,
      failOnRegression,
      json,
    };
  }

  // run
  const suites: string[] = [];
  let allSuites = false;
  let out: string | undefined;
  let runs: number | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let dryRun = false;
  let claudeBin = DEFAULTS.claudeBin;
  let evalsDir = DEFAULTS.evalsDir;
  let threshold: number | undefined;
  let keepFixtures = false;
  let keepSessions = false;
  let recordBaseline = false;
  let baselineDir = DEFAULTS.baselineDir;
  let allowDirty = false;
  let concurrency = DEFAULTS.concurrency;

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--all") {
      allSuites = true;
      continue;
    }
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (flag === "--keep-fixtures") {
      keepFixtures = true;
      continue;
    }
    if (flag === "--keep-sessions") {
      keepSessions = true;
      continue;
    }
    if (flag === "--record-baseline") {
      recordBaseline = true;
      continue;
    }
    if (flag === "--allow-dirty") {
      allowDirty = true;
      continue;
    }
    const v = flagValue(rest, i, flag);
    if (typeof v !== "string") return v;
    switch (flag) {
      case "--suite":
        suites.push(v);
        break;
      case "--out":
        out = v;
        break;
      case "--runs": {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1)
          return { error: "--runs must be a positive integer" };
        runs = n;
        break;
      }
      case "--model":
        model = v;
        break;
      case "--effort":
        effort = v;
        break;
      case "--claude-bin":
        claudeBin = v;
        break;
      case "--evals-dir":
        evalsDir = v;
        break;
      case "--threshold": {
        const n = Number(v);
        if (!Number.isFinite(n))
          return { error: "--threshold must be a number" };
        threshold = n;
        break;
      }
      case "--baseline-dir":
        baselineDir = v;
        break;
      case "--concurrency": {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1)
          return { error: "--concurrency must be a positive integer" };
        concurrency = n;
        break;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if (!out && recordBaseline) out = ".flow-tmp/eval";
  if (!out) return { error: "--out is required" };
  if (!allSuites && suites.length === 0)
    return { error: "at least one --suite or --all is required" };

  return {
    verb: "run",
    suites: allSuites ? "all" : suites,
    out,
    runs,
    model,
    effort,
    dryRun,
    claudeBin,
    evalsDir,
    threshold,
    keepFixtures,
    keepSessions,
    recordBaseline,
    baselineDir,
    allowDirty,
    concurrency,
  };
}
