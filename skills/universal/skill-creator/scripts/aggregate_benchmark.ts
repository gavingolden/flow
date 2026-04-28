import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { GradingData, GradingExpectation } from "./utils.ts";

interface StatsRange {
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

interface ConfigStats {
  pass_rate: StatsRange;
  time_seconds: StatsRange;
  tokens: StatsRange;
}

interface DeltaStats {
  pass_rate: string;
  time_seconds: string;
  tokens: string;
}

interface BenchmarkRunResult {
  pass_rate: number;
  passed: number;
  failed: number;
  total: number;
  time_seconds: number;
  tokens: number;
  tool_calls: number;
  errors: number;
}

interface BenchmarkRun {
  eval_id: number;
  configuration: string;
  run_number: number;
  result: BenchmarkRunResult;
  expectations: GradingExpectation[];
  notes: string[];
}

interface BenchmarkMetadata {
  skill_name: string;
  skill_path: string;
  executor_model: string;
  analyzer_model: string;
  timestamp: string;
  evals_run: number[];
  runs_per_configuration: number;
}

interface Benchmark {
  metadata: BenchmarkMetadata;
  runs: BenchmarkRun[];
  run_summary: Record<string, ConfigStats | DeltaStats>;
  notes: string[];
}

function calculateStats(values: number[]): StatsRange {
  if (values.length === 0) {
    return { mean: 0, stddev: 0, min: 0, max: 0 };
  }
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const stddev = n > 1 ? Math.sqrt(values.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    mean: Math.round(mean * 10000) / 10000,
    stddev: Math.round(stddev * 10000) / 10000,
    min: Math.round(Math.min(...values) * 10000) / 10000,
    max: Math.round(Math.max(...values) * 10000) / 10000,
  };
}

interface RunResult {
  eval_id: number;
  run_number: number;
  pass_rate: number;
  passed: number;
  failed: number;
  total: number;
  time_seconds: number;
  tokens: number;
  tool_calls: number;
  errors: number;
  expectations: GradingExpectation[];
  notes: string[];
}

function loadRunResults(benchmarkDir: string): Record<string, RunResult[]> {
  const runsDir = join(benchmarkDir, "runs");
  let searchDir: string;
  if (existsSync(runsDir)) {
    searchDir = runsDir;
  } else {
    const evalDirs = readdirSync(benchmarkDir).filter(
      (d) => d.startsWith("eval-") && statSync(join(benchmarkDir, d)).isDirectory(),
    );
    if (evalDirs.length > 0) {
      searchDir = benchmarkDir;
    } else {
      console.log(`No eval directories found in ${benchmarkDir} or ${runsDir}`);
      return {};
    }
  }

  const results: Record<string, RunResult[]> = {};

  const evalDirs = readdirSync(searchDir)
    .filter((d) => d.startsWith("eval-") && statSync(join(searchDir, d)).isDirectory())
    .sort();

  for (const [evalIdx, evalDirName] of evalDirs.entries()) {
    const evalDir = join(searchDir, evalDirName);
    let evalId = evalIdx;

    const metadataPath = join(evalDir, "eval_metadata.json");
    if (existsSync(metadataPath)) {
      try {
        evalId = JSON.parse(readFileSync(metadataPath, "utf-8")).eval_id ?? evalIdx;
      } catch {
        // fall through
      }
    } else {
      const parsed = parseInt(evalDirName.split("-")[1]);
      if (!isNaN(parsed)) evalId = parsed;
    }

    for (const configName of readdirSync(evalDir).sort()) {
      const configDir = join(evalDir, configName);
      if (!statSync(configDir).isDirectory()) continue;

      let runDirs = readdirSync(configDir).filter(
        (d) => d.startsWith("run-") && statSync(join(configDir, d)).isDirectory(),
      );
      if (runDirs.length === 0 && existsSync(join(configDir, "grading.json"))) {
        runDirs = ["."];
      }
      if (runDirs.length === 0) continue;

      if (!results[configName]) results[configName] = [];

      for (const runDirName of runDirs.sort()) {
        const runDir = runDirName === "." ? configDir : join(configDir, runDirName);
        const runNumber = runDirName === "." ? 1 : parseInt(runDirName.split("-")[1]);
        const gradingFile = join(runDir, "grading.json");

        if (!existsSync(gradingFile)) {
          console.log(`Warning: grading.json not found in ${runDir}`);
          continue;
        }

        let grading: GradingData;
        try {
          grading = JSON.parse(readFileSync(gradingFile, "utf-8"));
        } catch (e) {
          console.log(`Warning: Invalid JSON in ${gradingFile}: ${e}`);
          continue;
        }

        const summary = grading.summary || {};
        const result: RunResult = {
          eval_id: evalId,
          run_number: runNumber,
          pass_rate: summary.pass_rate ?? 0,
          passed: summary.passed ?? 0,
          failed: summary.failed ?? 0,
          total: summary.total ?? 0,
          time_seconds: 0,
          tokens: 0,
          tool_calls: 0,
          errors: 0,
          expectations: grading.expectations || [],
          notes: [],
        };

        const timing = grading.timing || {};
        result.time_seconds = timing.total_duration_seconds ?? 0;

        const timingFile = join(runDir, "timing.json");
        if ((result.time_seconds === 0 || result.tokens === 0) && existsSync(timingFile)) {
          try {
            const timingData = JSON.parse(readFileSync(timingFile, "utf-8"));
            if (result.time_seconds === 0)
              result.time_seconds = timingData.total_duration_seconds ?? 0;
            if (result.tokens === 0) result.tokens = timingData.total_tokens ?? 0;
          } catch {
            // ignore
          }
        }

        const metrics = grading.execution_metrics || {};
        result.tool_calls = metrics.total_tool_calls ?? 0;
        if (!result.tokens) result.tokens = metrics.output_chars ?? 0;
        result.errors = metrics.errors_encountered ?? 0;

        for (const exp of result.expectations) {
          if (!("text" in exp) || !("passed" in exp)) {
            console.log(
              `Warning: expectation in ${gradingFile} missing required fields (text, passed, evidence): ${JSON.stringify(exp)}`,
            );
          }
        }

        const notesSummary = grading.user_notes_summary || {};
        result.notes = [
          ...(notesSummary.uncertainties || []),
          ...(notesSummary.needs_review || []),
          ...(notesSummary.workarounds || []),
        ];

        results[configName].push(result);
      }
    }
  }

  return results;
}

function aggregateResults(
  results: Record<string, RunResult[]>,
): Record<string, ConfigStats | DeltaStats> {
  const runSummary: Record<string, ConfigStats | DeltaStats> = {};
  const BASELINE_NAMES = new Set(["without_skill", "old_skill", "baseline"]);
  const configs = Object.keys(results).sort((a, b) => {
    const aIsBaseline = BASELINE_NAMES.has(a);
    const bIsBaseline = BASELINE_NAMES.has(b);
    if (aIsBaseline !== bIsBaseline) return aIsBaseline ? 1 : -1;
    return a.localeCompare(b);
  });

  for (const config of configs) {
    const runs = results[config] || [];
    if (runs.length === 0) {
      runSummary[config] = {
        pass_rate: { mean: 0, stddev: 0, min: 0, max: 0 },
        time_seconds: { mean: 0, stddev: 0, min: 0, max: 0 },
        tokens: { mean: 0, stddev: 0, min: 0, max: 0 },
      };
      continue;
    }

    runSummary[config] = {
      pass_rate: calculateStats(runs.map((r) => r.pass_rate)),
      time_seconds: calculateStats(runs.map((r) => r.time_seconds)),
      tokens: calculateStats(runs.map((r) => r.tokens)),
    };
  }

  const primary = runSummary[configs[0]] || {};
  const baseline = configs.length >= 2 ? runSummary[configs[1]] || {} : {};

  const deltaPR = (primary.pass_rate?.mean ?? 0) - (baseline.pass_rate?.mean ?? 0);
  const deltaTime = (primary.time_seconds?.mean ?? 0) - (baseline.time_seconds?.mean ?? 0);
  const deltaTokens = (primary.tokens?.mean ?? 0) - (baseline.tokens?.mean ?? 0);

  runSummary.delta = {
    pass_rate: `${deltaPR >= 0 ? "+" : ""}${deltaPR.toFixed(2)}`,
    time_seconds: `${deltaTime >= 0 ? "+" : ""}${deltaTime.toFixed(1)}`,
    tokens: `${deltaTokens >= 0 ? "+" : ""}${Math.round(deltaTokens)}`,
  };

  return runSummary;
}

function generateBenchmark(benchmarkDir: string, skillName = "", skillPath = ""): Benchmark {
  const results = loadRunResults(benchmarkDir);
  const runSummary = aggregateResults(results);

  const runs: BenchmarkRun[] = [];
  for (const config of Object.keys(results)) {
    for (const result of results[config]) {
      runs.push({
        eval_id: result.eval_id,
        configuration: config,
        run_number: result.run_number,
        result: {
          pass_rate: result.pass_rate,
          passed: result.passed,
          failed: result.failed,
          total: result.total,
          time_seconds: result.time_seconds,
          tokens: result.tokens,
          tool_calls: result.tool_calls,
          errors: result.errors,
        },
        expectations: result.expectations,
        notes: result.notes,
      });
    }
  }

  const evalIds = [
    ...new Set(
      Object.values(results)
        .flat()
        .map((r) => r.eval_id),
    ),
  ].sort((a, b) => a - b);

  return {
    metadata: {
      skill_name: skillName || "<skill-name>",
      skill_path: skillPath || "<path/to/skill>",
      executor_model: "<model-name>",
      analyzer_model: "<model-name>",
      timestamp: new Date().toISOString(),
      evals_run: evalIds,
      runs_per_configuration: 3,
    },
    runs,
    run_summary: runSummary,
    notes: [],
  };
}

function generateMarkdown(benchmark: Benchmark): string {
  const { metadata, run_summary: runSummary } = benchmark;
  const configs = Object.keys(runSummary).filter((k) => k !== "delta");
  const configA = configs[0] || "config_a";
  const configB = configs[1] || "config_b";
  const labelA = configA.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
  const labelB = configB.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
  const delta = (runSummary.delta ?? {}) as Partial<DeltaStats>;
  const a = (runSummary[configA] ?? {}) as Partial<ConfigStats>;
  const b = (runSummary[configB] ?? {}) as Partial<ConfigStats>;

  const lines = [
    `# Skill Benchmark: ${metadata.skill_name}`,
    "",
    `**Model**: ${metadata.executor_model}`,
    `**Date**: ${metadata.timestamp}`,
    `**Evals**: ${metadata.evals_run.join(", ")} (${metadata.runs_per_configuration} runs each per configuration)`,
    "",
    "## Summary",
    "",
    `| Metric | ${labelA} | ${labelB} | Delta |`,
    "|--------|------------|---------------|-------|",
    `| Pass Rate | ${((a.pass_rate?.mean ?? 0) * 100).toFixed(0)}% \u00b1 ${((a.pass_rate?.stddev ?? 0) * 100).toFixed(0)}% | ${((b.pass_rate?.mean ?? 0) * 100).toFixed(0)}% \u00b1 ${((b.pass_rate?.stddev ?? 0) * 100).toFixed(0)}% | ${delta.pass_rate ?? "\u2014"} |`,
    `| Time | ${(a.time_seconds?.mean ?? 0).toFixed(1)}s \u00b1 ${(a.time_seconds?.stddev ?? 0).toFixed(1)}s | ${(b.time_seconds?.mean ?? 0).toFixed(1)}s \u00b1 ${(b.time_seconds?.stddev ?? 0).toFixed(1)}s | ${delta.time_seconds ?? "\u2014"}s |`,
    `| Tokens | ${(a.tokens?.mean ?? 0).toFixed(0)} \u00b1 ${(a.tokens?.stddev ?? 0).toFixed(0)} | ${(b.tokens?.mean ?? 0).toFixed(0)} \u00b1 ${(b.tokens?.stddev ?? 0).toFixed(0)} | ${delta.tokens ?? "\u2014"} |`,
  ];

  if (benchmark.notes?.length) {
    lines.push("", "## Notes", "");
    for (const note of benchmark.notes) lines.push(`- ${note}`);
  }

  return lines.join("\n");
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "skill-name": { type: "string", default: "" },
      "skill-path": { type: "string", default: "" },
      output: { type: "string", short: "o" },
    },
    allowPositionals: true,
  });

  const benchmarkDir = positionals[0];
  if (!benchmarkDir) {
    console.log("Usage: bun run aggregate_benchmark.ts <benchmark_dir> [--skill-name name]");
    process.exit(1);
  }

  if (!existsSync(resolve(benchmarkDir))) {
    console.log(`Directory not found: ${benchmarkDir}`);
    process.exit(1);
  }

  const benchmark = generateBenchmark(
    resolve(benchmarkDir),
    values["skill-name"],
    values["skill-path"],
  );

  const outputJson = values.output || join(resolve(benchmarkDir), "benchmark.json");
  const outputMd = outputJson.replace(/\.json$/, ".md");

  writeFileSync(outputJson, JSON.stringify(benchmark, null, 2));
  console.log(`Generated: ${outputJson}`);

  writeFileSync(outputMd, generateMarkdown(benchmark));
  console.log(`Generated: ${outputMd}`);

  const { run_summary: runSummary } = benchmark;
  const configs = Object.keys(runSummary).filter((k) => k !== "delta");
  console.log("\nSummary:");
  for (const config of configs) {
    const pr = (runSummary[config] as ConfigStats).pass_rate.mean;
    const label = config.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    console.log(`  ${label}: ${(pr * 100).toFixed(1)}% pass rate`);
  }
  console.log(
    `  Delta:         ${(runSummary.delta as DeltaStats | undefined)?.pass_rate ?? "\u2014"}`,
  );
}
