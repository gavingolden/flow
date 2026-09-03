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
  type Arm,
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
  /**
   * Recursive, force-quiet removal (`fs.rmSync(p, { recursive: true,
   * force: true })` semantics) — used to wipe a per-run output directory
   * before recreating it, so a cancelled earlier invocation's stale
   * `run-N/` contents never survive into a fresh run.
   */
  rm: (p: string) => void;
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

// `Deps.readFile` throws on a missing file (matching every other reader in
// this file); `LoadSuiteDeps.readFile` is contractually null-tolerant, so
// `loadSuite`'s typed "missing suite.json"/"missing case.json" errors were
// unreachable through either CLI call site below — the throw always won
// first. Adapt at the boundary instead of loosening `Deps.readFile`
// itself, which every other reader in this file still wants to throw.
function nullTolerantReadFile(deps: Deps): LoadSuiteDeps["readFile"] {
  return (p: string) => {
    try {
      return deps.readFile(p);
    } catch {
      return null;
    }
  };
}

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
    assistantTextPath: string;
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
    assistantTextPath: outcome.assistantTextPath,
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

/**
 * The substring whose presence in a run transcript proves a flow plugin
 * root was loaded. Same marker the committed `plugin-loaded` gate graders
 * use in every scenario's `case.json`, kept in one place so the positive
 * gate (with arm) and the inverted gate below (without arm) cannot drift
 * apart.
 */
const PLUGIN_ROOT_MARKER = "flow-module-core";

/**
 * The `without` arm's runtime leak detector.
 *
 * Marking `plugin-loaded` as `withOnly` (so the bare arm is not scored on a
 * gate it can never pass) removes the only signal that would have caught an
 * ablation leak at run time. This gate puts that signal back, inverted: the
 * bare arm's transcript must NOT mention a flow plugin root. It is the
 * runtime counterpart to the composition-time anti-leak assertions in
 * `eval-runner.test.ts` — those prove the argv and env are clean, this
 * proves the child actually behaved as though they were.
 *
 * Without it, a future change that reintroduces a discovery path (a third
 * `--add-dir`, a settings-sourced skills dir) would silently produce a
 * near-zero delta that reads as "the scaffold adds nothing".
 */
function ablationLeakGate(ctx: GraderContext): GradeResult {
  // `ctx.readFile` (not `Deps.readFile`) — the context's reader is
  // contractually null-tolerant, so an unreadable transcript fails this
  // gate rather than throwing out of the grading path.
  const stream = ctx.readFile(ctx.streamPath);
  const leaked = stream !== null && stream.includes(PLUGIN_ROOT_MARKER);
  return {
    id: "ablation-leak-free",
    kind: "file",
    gate: true,
    pass: stream !== null && !leaked,
    expected: `transcript free of "${PLUGIN_ROOT_MARKER}"`,
    actual:
      stream === null ? "transcript unreadable" : leaked ? "present" : "absent",
    detail:
      stream === null
        ? "could not read the run transcript, so the ablation could not be verified"
        : leaked
          ? "the no-plugin arm still loaded a flow plugin root — the ablation leaked, so any delta from this run is meaningless"
          : undefined,
  };
}

/**
 * `arm` of `undefined` behaves as `"with"` for argv/env/slug purposes but
 * leaves `RunRecord.arm` unset, so the single-arm (no `--ablation`) path
 * stays byte-identical to before ablation existed. Only `--ablation
 * with-without` ever passes an explicit `"with"`/`"without"`.
 */
async function runOneScenarioRun(
  scenario: ResolvedScenario,
  suite: SuiteSpec,
  run: number,
  arm: Arm | undefined,
  outBase: string,
  args: RunArgs,
  deps: Deps,
): Promise<RunRecord> {
  const fixture = deps.materializeFixture(scenario, suite.id, run, {
    now: deps.now,
    arm,
  });
  activeFixtureTeardowns.add(fixture.teardown);
  // Arm-qualify the run directory: two arms at the same run number would
  // otherwise both resolve to `run-${run}` and the SECOND arm's
  // `deps.rm(runDir)` below would delete the FIRST arm's output. Absent
  // or `"with"` keeps today's shape unchanged.
  const runDir = path.join(
    outBase,
    suite.id,
    scenario.id,
    arm === "without" ? `run-${run}-without` : `run-${run}`,
  );
  // Wipe any stale contents left by a cancelled earlier invocation (e.g. a
  // prior --all run interrupted mid-scenario) before recreating the dir,
  // so a fresh run never mixes its output with a leftover run-N/ from a
  // run that never completed.
  deps.rm(runDir);
  deps.mkdirp(runDir);

  const withOnlyIds = new Set(
    scenario.graders.filter((g) => g.withOnly).map((g) => g.id),
  );

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
          assistantTextPath: path.join(runDir, "assistant-text.txt"),
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
      const score = scoreRun(grades, arm ?? "with", withOnlyIds);
      deps.writeFile(
        path.join(runDir, "grades.json"),
        JSON.stringify({ grades, score }, null, 2) + "\n",
      );
      return {
        run,
        status: "skipped",
        score,
        grades,
        metrics: {},
        ...(arm ? { arm } : {}),
      };
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
      effort: args.effort ?? scenario.effort,
      keepSessions: args.keepSessions,
      arm,
    });
    const transcript = transcriptMetrics(outcome.events, outcome.result);
    const ctx = buildGraderContext(
      fixture,
      scenario,
      {
        streamPath: outcome.streamPath,
        assistantTextPath: outcome.assistantTextPath,
        result: outcome.result,
        transcript,
      },
      deps,
    );
    // `gradeAll`'s own inline `score` is discarded in favour of `scoreRun`
    // here — `scoreRun` is the single source of truth for arm-aware
    // (`withOnly`-skipping) scoring; for the `"with"` arm the two are
    // byte-identical (no grade is ever skipped), so this is a no-op change
    // for the single-arm path.
    const { grades, metrics } = deps.gradeAll(scenario.graders, ctx);
    if (arm === "without") grades.push(ablationLeakGate(ctx));
    const score = scoreRun(grades, arm ?? "with", withOnlyIds);
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
      childArgvDigest: outcome.childArgvDigest,
      ...(arm ? { arm } : {}),
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
  const loaded = loadSuite(suiteDir, {
    readFile: nullTolerantReadFile(deps),
    exists: deps.exists,
  });
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

  // Flatten every (scenario, run[, arm]) pair across the WHOLE suite into
  // one job list so `args.concurrency` bounds concurrency suite-wide, not
  // just within a single scenario's repeat runs — a per-scenario pool
  // would serialize every scenario behind the previous one even at
  // concurrency > 1, defeating the point of the flag. `arm` is only ever
  // present when `--ablation with-without` doubles every run into a
  // with/without pair; otherwise each job carries no `arm` at all (the
  // single-arm path's job shape is unchanged).
  const jobs: Array<{ scenario: ResolvedScenario; run: number; arm?: Arm }> =
    [];
  for (const scenario of scenarios) {
    const runsN = args.runs ?? scenario.runs;
    for (let run = 1; run <= runsN; run++) {
      if (args.ablation === "with-without") {
        jobs.push({ scenario, run, arm: "with" });
        jobs.push({ scenario, run, arm: "without" });
      } else {
        jobs.push({ scenario, run });
      }
    }
  }
  const allRecords = await runPool(jobs, args.concurrency, (job) =>
    runOneScenarioRun(
      job.scenario,
      spec,
      job.run,
      job.arm,
      args.out,
      args,
      deps,
    ),
  );

  const scenarioRecords: ScenarioRecord[] = scenarios.map((scenario) => {
    // The scenario's own status/score/runs/metrics are folded from the
    // WITH-arm records ONLY (job.arm !== "without") — this is what keeps
    // them byte-identical to the pre-ablation single-arm fold, and what
    // lets `buildReport`'s summary restriction (see its own comment) hold
    // even when a without-arm ran alongside.
    const withRecords = jobs
      .map((job, i) =>
        job.scenario.id === scenario.id && job.arm !== "without"
          ? allRecords[i]
          : undefined,
      )
      .filter((r): r is RunRecord => r !== undefined);
    const record = foldScenario(scenario.id, scenario.title, withRecords);

    if (args.ablation === "with-without") {
      const withoutRecords = jobs
        .map((job, i) =>
          job.scenario.id === scenario.id && job.arm === "without"
            ? allRecords[i]
            : undefined,
        )
        .filter((r): r is RunRecord => r !== undefined);
      // An error-status run is reported (folded into `withoutFold.status`)
      // but EXCLUDED from the score/metric average that feeds the delta —
      // never counted as a score of 0, which would otherwise make a
      // transient timeout look like a real regression.
      const withoutScored = withoutRecords.filter((r) => r.status !== "error");
      const withoutFold = foldScenario(
        scenario.id,
        scenario.title,
        withoutScored,
      );
      const metricDeltas: Record<string, number> = {};
      for (const name of new Set([
        ...Object.keys(record.metrics),
        ...Object.keys(withoutFold.metrics),
      ])) {
        const w = record.metrics[name]?.median;
        const wo = withoutFold.metrics[name]?.median;
        if (w !== undefined && wo !== undefined) metricDeltas[name] = w - wo;
      }
      record.ablation = {
        with: {
          score: record.score,
          metrics: record.metrics,
          avgCostUsd: avgCostUsd(withRecords),
        },
        without: {
          score: withoutFold.score,
          metrics: withoutFold.metrics,
          avgCostUsd: avgCostUsd(withoutScored),
        },
        scoreDelta: record.score - withoutFold.score,
        metricDeltas,
      };
    }

    deps.progress(`flow-eval: ${spec.id}/${scenario.id} -> ${record.status}`);
    return record;
  });

  const scenariosWithAblation = scenarioRecords.filter((s) => s.ablation);
  const summaryScoreDelta =
    scenariosWithAblation.length > 0
      ? scenariosWithAblation.reduce(
          (sum, s) => sum + (s.ablation?.scoreDelta ?? 0),
          0,
        ) / scenariosWithAblation.length
      : undefined;
  // Lift one representative run's childArgvDigest (the with-arm shape,
  // when ablation ran) up to the report-level `runner.childArgvDigest` —
  // the digest is deterministic given a scenario's flags/arm, so any
  // with-arm run in this suite carries the same value.
  const childArgvDigest = allRecords.find(
    (r) => r.arm !== "without" && r.childArgvDigest,
  )?.childArgvDigest;

  return buildReport({
    suite: spec,
    scenarios: scenarioRecords,
    runner: {
      name: "flow-eval-headless",
      model: args.model,
      effort: args.effort,
      claudeVersion: availability.ok ? availability.version : undefined,
      ...(childArgvDigest ? { childArgvDigest } : {}),
    },
    tree: { gitHead: deps.gitHead(), dirty: deps.gitDirty() },
    startedAt,
    finishedAt: deps.now().toISOString(),
    ...(summaryScoreDelta !== undefined ? { summaryScoreDelta } : {}),
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

function avgCostUsd(records: RunRecord[]): number {
  if (records.length === 0) return 0;
  return records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) / records.length;
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
  if (args.ablation === "with-without") {
    // Informational only — never a prompt, never a confirmation: doubling
    // the arm count doubles the number of `claude` children spawned and
    // therefore the run's real-account spend.
    deps.progress(
      "flow-eval: --ablation with-without doubles the arm count per scenario run, and therefore doubles claude spend for this invocation\n",
    );
  }
  if (args.recordBaseline && deps.gitDirty() && !args.allowDirty) {
    deps.progress(
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
      deps.progress(
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
    process.stderr.write(
      "usage: flow-eval <run|validate|report|compare> [flags]\n" +
        "  run --suite <id>|--all --out <dir> [--record-baseline] [--dry-run] ...\n" +
        "  validate <path>...\n" +
        "  report <report.json>\n" +
        "  compare --base <report.json> --candidate <report.json>\n" +
        "See docs/eval/README.md for the full flag reference.\n",
    );
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
    rm: (p) => fs.rmSync(p, { recursive: true, force: true }),
    exists: (p) => fs.existsSync(p),
    // Files and directories both: `listSuiteDirs` filters by presence of a
    // `suite.json` sibling regardless, and `writeBaselineFiles`'s README
    // merge needs the `<suite>.report.json` *files* under `baselineDir`.
    readdir: (p) => fs.readdirSync(p),
    progress: (line) => process.stderr.write(line + "\n"),
    sessionId: () => randomUUID(),
    ...deps,
  };

  if (parsed.verb === "validate") {
    let ok = true;
    for (const p of parsed.paths) {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        const result = loadSuite(p, {
          readFile: nullTolerantReadFile(fullDeps),
          exists: fullDeps.exists,
        });
        if (!result.ok) {
          fullDeps.progress(`flow-eval: ${p}: ${result.reason}\n`);
          ok = false;
        }
      } else {
        const result = validateReport(JSON.parse(fullDeps.readFile(p)));
        if (!result.ok) {
          fullDeps.progress(`flow-eval: ${p}: ${result.reason}\n`);
          ok = false;
        }
      }
    }
    return ok ? 0 : 2;
  }

  if (parsed.verb === "report") {
    const report = validateReport(JSON.parse(fullDeps.readFile(parsed.in)));
    if (!report.ok) {
      fullDeps.progress(`flow-eval: ${parsed.in}: ${report.reason}\n`);
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
      fullDeps.progress(`flow-eval: could not parse report(s) for compare\n`);
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
