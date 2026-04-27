import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { generateHtml } from "./generate_report.ts";
import { improveDescription } from "./improve_description.ts";
import { findProjectRoot, runEval } from "./run_eval.ts";
import type { EvalItem, EvalResult, EvalSummary } from "./utils.ts";
import { parseSkillMd } from "./utils.ts";

function splitEvalSet(evalSet: EvalItem[], holdout: number, seed = 42): [EvalItem[], EvalItem[]] {
  // Simple seeded shuffle using seed for reproducibility
  const rng = (() => {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  })();

  const trigger = evalSet.filter((e) => e.should_trigger);
  const noTrigger = evalSet.filter((e) => !e.should_trigger);

  const shuffle = <T>(arr: T[]) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const shuffledTrigger = shuffle(trigger);
  const shuffledNoTrigger = shuffle(noTrigger);

  const nTriggerTest =
    trigger.length > 1
      ? Math.min(Math.max(1, Math.floor(trigger.length * holdout)), trigger.length - 1)
      : 0;
  const nNoTriggerTest =
    noTrigger.length > 1
      ? Math.min(Math.max(1, Math.floor(noTrigger.length * holdout)), noTrigger.length - 1)
      : 0;

  const testSet = [
    ...shuffledTrigger.slice(0, nTriggerTest),
    ...shuffledNoTrigger.slice(0, nNoTriggerTest),
  ];
  const trainSet = [
    ...shuffledTrigger.slice(nTriggerTest),
    ...shuffledNoTrigger.slice(nNoTriggerTest),
  ];

  return [trainSet, testSet];
}

interface HistoryEntry {
  iteration: number;
  description: string;
  train_passed: number;
  train_failed: number;
  train_total: number;
  train_results: EvalResult[];
  test_passed: number | null;
  test_failed: number | null;
  test_total: number | null;
  test_results: EvalResult[] | null;
  passed: number;
  failed: number;
  total: number;
  results: EvalResult[];
}

interface LoopOutput {
  exit_reason: string;
  original_description: string;
  best_description: string;
  best_score: string;
  best_train_score: string;
  best_test_score: string | null;
  final_description: string;
  iterations_run: number;
  holdout: number;
  train_size: number;
  test_size: number;
  history: HistoryEntry[];
}

async function runLoop(opts: {
  evalSet: EvalItem[];
  skillPath: string;
  descriptionOverride?: string;
  numWorkers: number;
  timeout: number;
  maxIterations: number;
  runsPerQuery: number;
  triggerThreshold: number;
  holdout: number;
  model: string;
  verbose: boolean;
  liveReportPath?: string;
  logDir?: string;
}): Promise<LoopOutput> {
  const projectRoot = findProjectRoot();
  const { name, description: originalDescription, content } = parseSkillMd(opts.skillPath);
  let currentDescription = opts.descriptionOverride || originalDescription;

  let trainSet: EvalItem[];
  let testSet: EvalItem[];

  if (opts.holdout > 0) {
    [trainSet, testSet] = splitEvalSet(opts.evalSet, opts.holdout);
    if (opts.verbose) {
      console.error(
        `Split: ${trainSet.length} train, ${testSet.length} test (holdout=${opts.holdout})`,
      );
    }
  } else {
    trainSet = opts.evalSet;
    testSet = [];
  }

  const history: HistoryEntry[] = [];
  let exitReason = "unknown";

  for (let iteration = 1; iteration <= opts.maxIterations; iteration++) {
    if (opts.verbose) {
      console.error(`\n${"=".repeat(60)}`);
      console.error(`Iteration ${iteration}/${opts.maxIterations}`);
      console.error(`Description: ${currentDescription}`);
      console.error("=".repeat(60));
    }

    const allQueries = [...trainSet, ...testSet];
    const t0 = Date.now();

    const allResults = await runEval({
      evalSet: allQueries,
      skillName: name,
      description: currentDescription,
      numWorkers: opts.numWorkers,
      timeout: opts.timeout,
      projectRoot,
      runsPerQuery: opts.runsPerQuery,
      triggerThreshold: opts.triggerThreshold,
      model: opts.model,
    });

    const evalElapsed = (Date.now() - t0) / 1000;

    const trainQueriesSet = new Set(trainSet.map((q) => q.query));
    const trainResultList = allResults.results.filter((r) => trainQueriesSet.has(r.query));
    const testResultList = allResults.results.filter((r) => !trainQueriesSet.has(r.query));

    const trainPassed = trainResultList.filter((r) => r.pass).length;
    const trainTotal = trainResultList.length;
    const trainSummary = {
      passed: trainPassed,
      failed: trainTotal - trainPassed,
      total: trainTotal,
    };
    const trainResults = { results: trainResultList, summary: trainSummary };

    let testResults: { results: EvalResult[]; summary: EvalSummary } | null = null;
    let testSummary: EvalSummary | null = null;

    if (testSet.length > 0) {
      const testPassed = testResultList.filter((r) => r.pass).length;
      const testTotal = testResultList.length;
      testSummary = {
        passed: testPassed,
        failed: testTotal - testPassed,
        total: testTotal,
      };
      testResults = { results: testResultList, summary: testSummary };
    }

    history.push({
      iteration,
      description: currentDescription,
      train_passed: trainSummary.passed,
      train_failed: trainSummary.failed,
      train_total: trainSummary.total,
      train_results: trainResults.results,
      test_passed: testSummary?.passed ?? null,
      test_failed: testSummary?.failed ?? null,
      test_total: testSummary?.total ?? null,
      test_results: testResults?.results ?? null,
      passed: trainSummary.passed,
      failed: trainSummary.failed,
      total: trainSummary.total,
      results: trainResults.results,
    });

    if (opts.liveReportPath) {
      const partialOutput = {
        original_description: originalDescription,
        best_description: currentDescription,
        best_score: "in progress",
        iterations_run: history.length,
        holdout: opts.holdout,
        train_size: trainSet.length,
        test_size: testSet.length,
        history,
      };
      writeFileSync(
        opts.liveReportPath,
        generateHtml(partialOutput, { autoRefresh: true, skillName: name }),
      );
    }

    if (opts.verbose) {
      const printStats = (label: string, results: EvalResult[], elapsed: number) => {
        const pos = results.filter((r) => r.should_trigger);
        const neg = results.filter((r) => !r.should_trigger);
        const tp = pos.reduce((s, r) => s + r.triggers, 0);
        const posRuns = pos.reduce((s, r) => s + r.runs, 0);
        const fn = posRuns - tp;
        const fp = neg.reduce((s, r) => s + r.triggers, 0);
        const negRuns = neg.reduce((s, r) => s + r.runs, 0);
        const tn = negRuns - fp;
        const total = tp + tn + fp + fn;
        const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
        const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
        const accuracy = total > 0 ? (tp + tn) / total : 0;
        console.error(
          `${label}: ${tp + tn}/${total} correct, precision=${(precision * 100).toFixed(0)}% recall=${(recall * 100).toFixed(0)}% accuracy=${(accuracy * 100).toFixed(0)}% (${elapsed.toFixed(1)}s)`,
        );
        for (const r of results) {
          const status = r.pass ? "PASS" : "FAIL";
          console.error(
            `  [${status}] rate=${r.triggers}/${r.runs} expected=${r.should_trigger}: ${r.query.slice(0, 60)}`,
          );
        }
      };

      printStats("Train", trainResults.results, evalElapsed);
      if (testSummary) printStats("Test ", testResults!.results, 0);
    }

    if (trainSummary.failed === 0) {
      exitReason = `all_passed (iteration ${iteration})`;
      if (opts.verbose) console.error(`\nAll train queries passed on iteration ${iteration}!`);
      break;
    }

    if (iteration === opts.maxIterations) {
      exitReason = `max_iterations (${opts.maxIterations})`;
      if (opts.verbose) console.error(`\nMax iterations reached (${opts.maxIterations}).`);
      break;
    }

    if (opts.verbose) console.error("\nImproving description...");

    const t1 = Date.now();
    const blindedHistory = history.map((h) => ({
      iteration: h.iteration,
      description: h.description,
      train_passed: h.train_passed,
      train_failed: h.train_failed,
      train_total: h.train_total,
      train_results: h.train_results,
      passed: h.passed,
      failed: h.failed,
      total: h.total,
      results: h.results,
    }));

    const newDescription = await improveDescription({
      skillName: name,
      skillContent: content,
      currentDescription,
      evalResults: trainResults,
      history: blindedHistory,
      model: opts.model,
      logDir: opts.logDir,
      iteration,
    });

    if (opts.verbose) {
      console.error(`Proposed (${((Date.now() - t1) / 1000).toFixed(1)}s): ${newDescription}`);
    }

    currentDescription = newDescription;
  }

  const best =
    testSet.length > 0
      ? history.reduce((a, b) => ((b.test_passed ?? 0) > (a.test_passed ?? 0) ? b : a))
      : history.reduce((a, b) => (b.train_passed > a.train_passed ? b : a));

  const bestScore =
    testSet.length > 0
      ? `${best.test_passed}/${best.test_total}`
      : `${best.train_passed}/${best.train_total}`;

  if (opts.verbose) {
    console.error(`\nExit reason: ${exitReason}`);
    console.error(`Best score: ${bestScore} (iteration ${best.iteration})`);
  }

  return {
    exit_reason: exitReason,
    original_description: originalDescription,
    best_description: best.description,
    best_score: bestScore,
    best_train_score: `${best.train_passed}/${best.train_total}`,
    best_test_score: testSet.length > 0 ? `${best.test_passed}/${best.test_total}` : null,
    final_description: currentDescription,
    iterations_run: history.length,
    holdout: opts.holdout,
    train_size: trainSet.length,
    test_size: testSet.length,
    history,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "eval-set": { type: "string" },
      "skill-path": { type: "string" },
      description: { type: "string" },
      "num-workers": { type: "string", default: "10" },
      timeout: { type: "string", default: "30" },
      "max-iterations": { type: "string", default: "5" },
      "runs-per-query": { type: "string", default: "3" },
      "trigger-threshold": { type: "string", default: "0.5" },
      holdout: { type: "string", default: "0.4" },
      model: { type: "string" },
      verbose: { type: "boolean", default: false },
      report: { type: "string", default: "auto" },
      "results-dir": { type: "string" },
    },
    allowPositionals: false,
  });

  if (!values["eval-set"] || !values["skill-path"] || !values.model) {
    console.error("Required: --eval-set, --skill-path, --model");
    process.exit(1);
  }

  const skillPath = resolve(values["skill-path"]);
  if (!existsSync(join(skillPath, "SKILL.md"))) {
    console.error(`Error: No SKILL.md found at ${skillPath}`);
    process.exit(1);
  }

  const evalSet: EvalItem[] = JSON.parse(readFileSync(resolve(values["eval-set"]), "utf-8"));
  const { name } = parseSkillMd(skillPath);

  let liveReportPath: string | undefined;
  if (values.report !== "none") {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    liveReportPath =
      values.report === "auto"
        ? join(tmpdir(), `skill_description_report_${name}_${timestamp}.html`)
        : resolve(values.report);

    writeFileSync(
      liveReportPath,
      "<html><body><h1>Starting optimization loop...</h1><meta http-equiv='refresh' content='5'></body></html>",
    );
    Bun.spawn(["open", liveReportPath]);
  }

  let resultsDir: string | undefined;
  if (values["results-dir"]) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    resultsDir = join(resolve(values["results-dir"]), timestamp);
    mkdirSync(resultsDir, { recursive: true });
  }

  const logDir = resultsDir ? join(resultsDir, "logs") : undefined;

  const output = await runLoop({
    evalSet,
    skillPath,
    descriptionOverride: values.description,
    numWorkers: parseInt(values["num-workers"]!),
    timeout: parseInt(values.timeout!),
    maxIterations: parseInt(values["max-iterations"]!),
    runsPerQuery: parseInt(values["runs-per-query"]!),
    triggerThreshold: parseFloat(values["trigger-threshold"]!),
    holdout: parseFloat(values.holdout!),
    model: values.model,
    verbose: values.verbose ?? false,
    liveReportPath,
    logDir,
  });

  const jsonOutput = JSON.stringify(output, null, 2);
  console.log(jsonOutput);

  if (resultsDir) {
    writeFileSync(join(resultsDir, "results.json"), jsonOutput);
  }

  if (liveReportPath) {
    writeFileSync(liveReportPath, generateHtml(output, { autoRefresh: false, skillName: name }));
    console.error(`\nReport: ${liveReportPath}`);
  }

  if (resultsDir && liveReportPath) {
    writeFileSync(
      join(resultsDir, "report.html"),
      generateHtml(output, { autoRefresh: false, skillName: name }),
    );
  }

  if (resultsDir) {
    console.error(`Results saved to: ${resultsDir}`);
  }
}
