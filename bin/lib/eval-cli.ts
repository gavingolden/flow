/**
 * `flow-eval`'s CLI logic: the bounded worker pool, `runSuite`
 * (materialize -> dry-run-or-spawn -> grade -> teardown per scenario run),
 * and the `run`/`validate`/`report`/`compare` verb dispatch. Everything
 * here is unit-testable through an injected `Deps` — `bin/flow-eval.ts`
 * stays a thin entry point wiring the real filesystem/git/child-process.
 * Split out to keep this file closer to the line-count target: argv
 * parsing lives in `./eval-args`, the baseline writer + `--all` index
 * writer live in `./eval-baseline`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { git } from "./git";
import {
  buildReport,
  compareReports,
  foldScenario,
  renderComparison,
  renderSummary,
  scoreRun,
  validateReport,
  type EvalReport,
  type GradeResult,
  type RunRecord,
  type RunStatus,
  type ScenarioRecord,
} from "./eval-report";
import { gradeAll, type GraderContext } from "./eval-graders";
import { transcriptMetrics } from "./eval-transcript";
import {
  loadSuite,
  type LoadSuiteDeps,
  type ResolvedScenario,
  type SuiteSpec,
} from "./eval-suite";
import { materializeFixture, type MaterializedFixture } from "./eval-fixture";
import {
  probeClaude,
  probeFlowInstall,
  renderPrompt,
  runScenarioOnce,
  type ClaudeAvailability,
} from "./eval-runner";
import { writeBaselineFiles, writeIndex } from "./eval-baseline";
import { parseArgs, type RunArgs } from "./eval-args";

export {
  parseArgs,
  type CompareArgs,
  type ParsedArgs,
  type ReportArgs,
  type RunArgs,
  type ValidateArgs,
} from "./eval-args";

export type Deps = {
  probeClaude: typeof probeClaude;
  probeFlowInstall: typeof probeFlowInstall;
  materializeFixture: typeof materializeFixture;
  runScenarioOnce: typeof runScenarioOnce;
  gradeAll: typeof gradeAll;
  gitHead: () => string;
  gitDirty: () => boolean;
  now: () => Date;
  writeFile: (p: string, data: string) => void;
  readFile: (p: string) => string;
  mkdirp: (p: string) => void;
  exists: (p: string) => boolean;
  progress: (line: string) => void;
  sessionId: () => string;
  /**
   * Additive beyond the plan's Deps contract: `--all` needs to enumerate
   * suite directories, and the plan's Deps list has no directory-listing
   * hook. Kept out of the contract's explicit field list would leave
   * `listSuiteDirs` on raw `node:fs`, breaking full Deps-injectability for
   * `--all` — a small, mechanical, in-scope addition rather than a
   * deviation from the shape the other fields already establish.
   */
  readdir: (p: string) => string[];
} & LoadSuiteDeps;

/** Bounded concurrency pool: runs `items` through `worker`, never more than
 * `concurrency` in flight at once. */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function runNext(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    runNext,
  );
  await Promise.all(workers);
  return results;
}

const DRY_RUN_SKIPPED_KINDS = new Set(["structured", "command", "metric"]);

function buildGraderContext(
  fixture: MaterializedFixture,
  scenario: ResolvedScenario,
  outcome: {
    streamPath: string;
    result: GraderContext["result"];
    transcript: ReturnType<typeof transcriptMetrics>;
  },
  deps: Deps,
): GraderContext {
  return {
    repoDir: fixture.repoDir,
    fixtureRoot: scenario.dir,
    stateSlug: fixture.slug,
    stateDir: fixture.stateDir,
    streamPath: outcome.streamPath,
    result: outcome.result,
    transcript: outcome.transcript,
    runCommand: (argv, cwd) => {
      const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8" });
      return {
        exitCode: r.status ?? -1,
        stdout: (r.stdout ?? "") + (r.stderr ?? ""),
      };
    },
    readFile: (p) => {
      try {
        return deps.readFile(p);
      } catch {
        return null;
      }
    },
    exists: deps.exists,
  };
}

/**
 * Every in-flight fixture's `teardown` is registered here for the
 * duration of its run so `bin/flow-eval.ts`'s SIGINT handler can sweep
 * whatever is still materialized when an interrupt lands mid-suite —
 * without this, an interrupted `run` leaks `~/.flow/state/eval-*` rows
 * and tmp directories until the next `flow reap`.
 */
export const activeFixtureTeardowns = new Set<() => void>();

async function runOneScenarioRun(
  scenario: ResolvedScenario,
  suite: SuiteSpec,
  run: number,
  outBase: string,
  args: RunArgs,
  deps: Deps,
): Promise<RunRecord> {
  const fixture = deps.materializeFixture(scenario, suite.id, run, {
    now: deps.now,
  });
  activeFixtureTeardowns.add(fixture.teardown);
  const runDir = path.join(outBase, suite.id, scenario.id, `run-${run}`);
  deps.mkdirp(runDir);

  try {
    if (args.dryRun) {
      const prompt = renderPrompt(scenario, fixture, deps.readFile);
      deps.writeFile(path.join(runDir, "prompt.txt"), prompt);
      const transcript = transcriptMetrics([], null);
      const ctx = buildGraderContext(
        fixture,
        scenario,
        {
          streamPath: path.join(runDir, "stream.jsonl"),
          result: null,
          transcript,
        },
        deps,
      );
      const grades: GradeResult[] = [];
      for (const spec of scenario.graders) {
        if (DRY_RUN_SKIPPED_KINDS.has(spec.kind)) {
          grades.push({
            id: spec.id,
            kind: spec.kind,
            gate: false,
            pass: false,
            detail: "dry-run: not evaluated (no claude session spawned)",
          });
        } else {
          grades.push(deps.gradeAll([spec], ctx).grades[0]);
        }
      }
      const gates = grades.filter((g) => g.gate);
      const score =
        gates.length === 0
          ? 1
          : gates.filter((g) => g.pass).length / gates.length;
      deps.writeFile(
        path.join(runDir, "grades.json"),
        JSON.stringify({ grades, score }, null, 2) + "\n",
      );
      return { run, status: "skipped", score, grades, metrics: {} };
    }

    const outcome = await deps.runScenarioOnce(scenario, fixture, {
      claudeBin: args.claudeBin,
      outDir: runDir,
      sessionId: deps.sessionId(),
      resultSchema: scenario.resultSchema
        ? JSON.parse(
            deps.readFile(path.join(scenario.dir, scenario.resultSchema)),
          )
        : undefined,
      model: args.model ?? scenario.model,
      keepSessions: args.keepSessions,
    });
    const transcript = transcriptMetrics(outcome.events, outcome.result);
    const ctx = buildGraderContext(
      fixture,
      scenario,
      { streamPath: outcome.streamPath, result: outcome.result, transcript },
      deps,
    );
    const { grades, metrics, score } = deps.gradeAll(scenario.graders, ctx);
    deps.writeFile(
      path.join(runDir, "grades.json"),
      JSON.stringify({ grades, metrics, score }, null, 2) + "\n",
    );

    let status: RunStatus;
    if (outcome.timedOut || outcome.error) status = "error";
    else status = score === 1 ? "pass" : "fail";

    return {
      run,
      status,
      score,
      grades,
      metrics,
      sessionId: outcome.result?.session_id,
      costUsd: outcome.result?.total_cost_usd,
      durationMs: outcome.result?.duration_ms,
      numTurns: outcome.result?.num_turns,
      error: outcome.error,
    };
  } finally {
    activeFixtureTeardowns.delete(fixture.teardown);
    if (!args.keepFixtures) fixture.teardown();
  }
}

async function runSuite(
  suiteDir: string,
  args: RunArgs,
  deps: Deps,
  availability: ClaudeAvailability,
): Promise<EvalReport> {
  const startedAt = deps.now().toISOString();
  const loaded = loadSuite(suiteDir, deps);
  if (!loaded.ok) {
    throw new Error(
      `flow-eval: ${loaded.reason}${loaded.path ? ` (${loaded.path})` : ""}`,
    );
  }
  const { spec, scenarios } = loaded.value;

  if (!args.dryRun && !availability.ok) {
    const scenarioRecords: ScenarioRecord[] = scenarios.map((s) =>
      foldScenario(s.id, s.title, [
        { run: 1, status: "skipped", score: 1, grades: [], metrics: {} },
      ]),
    );
    return buildReport({
      suite: spec,
      scenarios: scenarioRecords,
      runner: { name: "flow-eval-headless" },
      tree: { gitHead: deps.gitHead(), dirty: deps.gitDirty() },
      startedAt,
      finishedAt: deps.now().toISOString(),
      skipped: { reason: availability.reason, notice: availability.notice },
    });
  }

  // Flatten every (scenario, run) pair across the WHOLE suite into one job
  // list so `args.concurrency` bounds concurrency suite-wide, not just
  // within a single scenario's repeat runs — a per-scenario pool would
  // serialize every scenario behind the previous one even at concurrency
  // > 1, defeating the point of the flag.
  const jobs: Array<{ scenario: ResolvedScenario; run: number }> = [];
  for (const scenario of scenarios) {
    const runsN = args.runs ?? scenario.runs;
    for (let run = 1; run <= runsN; run++) jobs.push({ scenario, run });
  }
  const allRecords = await runPool(jobs, args.concurrency, (job) =>
    runOneScenarioRun(job.scenario, spec, job.run, args.out, args, deps),
  );

  const scenarioRecords: ScenarioRecord[] = scenarios.map((scenario) => {
    const records = jobs
      .map((job, i) =>
        job.scenario.id === scenario.id ? allRecords[i] : undefined,
      )
      .filter((r): r is RunRecord => r !== undefined);
    const record = foldScenario(scenario.id, scenario.title, records);
    deps.progress(`flow-eval: ${spec.id}/${scenario.id} -> ${record.status}`);
    return record;
  });

  return buildReport({
    suite: spec,
    scenarios: scenarioRecords,
    runner: {
      name: "flow-eval-headless",
      model: args.model,
      claudeVersion: availability.ok ? availability.version : undefined,
    },
    tree: { gitHead: deps.gitHead(), dirty: deps.gitDirty() },
    startedAt,
    finishedAt: deps.now().toISOString(),
    ...(args.dryRun
      ? {
          skipped: {
            reason: "dry-run" as const,
            notice: "dry-run: no claude session spawned",
          },
        }
      : {}),
  });
}

function listSuiteDirs(evalsDir: string, deps: Deps): string[] {
  // A directory is a suite iff it carries a suite.json — sibling
  // directories like `_shims/` never do.
  const entries: string[] = [];
  for (const name of deps.readdir(evalsDir)) {
    if (deps.exists(path.join(evalsDir, name, "suite.json")))
      entries.push(name);
  }
  return entries;
}

async function runVerb(args: RunArgs, deps: Deps): Promise<number> {
  if (args.recordBaseline && deps.gitDirty() && !args.allowDirty) {
    process.stderr.write(
      "flow-eval: --record-baseline refuses a dirty tree (pass --allow-dirty to override)\n",
    );
    return 2;
  }

  const suiteIds =
    args.suites === "all" ? listSuiteDirs(args.evalsDir, deps) : args.suites;
  const availability = deps.probeFlowInstall(
    deps.exists,
  ) satisfies ClaudeAvailability;
  const resolvedAvailability: ClaudeAvailability = availability.ok
    ? deps.probeClaude(args.claudeBin)
    : availability;

  const reports: EvalReport[] = [];
  for (const suiteId of suiteIds) {
    const suiteDir = path.join(args.evalsDir, suiteId);
    const report = await runSuite(suiteDir, args, deps, resolvedAvailability);
    deps.mkdirp(path.join(args.out, suiteId));
    deps.writeFile(
      path.join(args.out, suiteId, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    deps.writeFile(
      path.join(args.out, suiteId, "summary.md"),
      renderSummary(report) + "\n",
    );
    reports.push(report);

    if (report.skipped) {
      process.stderr.write(
        `flow-eval: skipped — ${report.skipped.notice} (vitest remains the CI gate; install and log in to Claude Code to run evals)\n`,
      );
    }
  }

  if (args.suites === "all") {
    writeIndex(reports, args.out, deps);
  }

  if (args.recordBaseline) {
    writeBaselineFiles(reports, args, deps);
  }

  if (args.threshold !== undefined) {
    const missed = reports.filter(
      (r) => !r.skipped && r.summary.score < (args.threshold as number),
    );
    if (missed.length > 0) return 1;
  }

  return 0;
}

export async function main(
  argv: string[],
  deps?: Partial<Deps>,
): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-eval: ${parsed.error}\n`);
    return 2;
  }

  const fullDeps: Deps = {
    probeClaude,
    probeFlowInstall,
    materializeFixture,
    runScenarioOnce,
    gradeAll,
    gitHead: () => git(["rev-parse", "HEAD"]),
    gitDirty: () => git(["status", "--porcelain"]).length > 0,
    now: () => new Date(),
    writeFile: (p, data) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
    },
    readFile: (p) => fs.readFileSync(p, "utf8"),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    exists: (p) => fs.existsSync(p),
    readdir: (p) =>
      fs
        .readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name),
    progress: (line) => process.stderr.write(line + "\n"),
    sessionId: () => randomUUID(),
    ...deps,
  };

  if (parsed.verb === "validate") {
    let ok = true;
    for (const p of parsed.paths) {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        const result = loadSuite(p, fullDeps);
        if (!result.ok) {
          process.stderr.write(`flow-eval: ${p}: ${result.reason}\n`);
          ok = false;
        }
      } else {
        const result = validateReport(JSON.parse(fullDeps.readFile(p)));
        if (!result.ok) {
          process.stderr.write(`flow-eval: ${p}: ${result.reason}\n`);
          ok = false;
        }
      }
    }
    return ok ? 0 : 2;
  }

  if (parsed.verb === "report") {
    const report = validateReport(JSON.parse(fullDeps.readFile(parsed.in)));
    if (!report.ok) {
      process.stderr.write(`flow-eval: ${parsed.in}: ${report.reason}\n`);
      return 2;
    }
    process.stdout.write(renderSummary(report.value) + "\n");
    return 0;
  }

  if (parsed.verb === "compare") {
    const base = validateReport(JSON.parse(fullDeps.readFile(parsed.base)));
    const candidate = validateReport(
      JSON.parse(fullDeps.readFile(parsed.candidate)),
    );
    if (!base.ok || !candidate.ok) {
      process.stderr.write(
        `flow-eval: could not parse report(s) for compare\n`,
      );
      return 2;
    }
    const cmp = compareReports(base.value, candidate.value, {
      tolerance: parsed.tolerance,
    });
    process.stdout.write(
      (parsed.json ? JSON.stringify(cmp, null, 2) : renderComparison(cmp)) +
        "\n",
    );
    if (parsed.failOnRegression && cmp.regressions.length > 0) return 1;
    return 0;
  }

  return runVerb(parsed, fullDeps);
}

export { scoreRun };
