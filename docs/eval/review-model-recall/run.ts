#!/usr/bin/env bun
/**
 * Port of `_reference/run-matrix.sh` + `_reference/run-judge.sh` (see
 * docs/eval/review-model-recall/README.md) into one Bun driver with two
 * subcommands, `matrix` and `judge`. Each cell shells out to
 * `flow-claude-headless` — the ONLY sanctioned headless-Claude spawn
 * site (`skills/pipeline/flow-pipeline/references/headless-claude.md`)
 * — with the same fixed parameters the committed measurement used.
 *
 * `env -u FLOW_SLUG -u TMUX_PANE` matters: without it, a nested run can
 * trip the parent pipeline's stop guard or overwrite its state.json
 * (see AGENTS.md "FLOW_SLUG leak into nested claude sessions").
 *
 * Both subcommands are resume-safe (a cell whose non-empty output file
 * already exists is skipped) and bounded-concurrency — the committed run
 * needed both after an account spend limit killed 10 cells mid-matrix.
 */

import { existsSync, statSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LENSES = ["bug-detection", "pattern-consistency", "test-coverage"];
const PRS = ["812", "756", "802"];
const ARMS = ["sonnet", "opus"];
const DEFAULT_RUNS = 2;
const DEFAULT_MODEL = "opus";
const MODEL_ARMS = new Set(["sonnet", "opus"]);

const DEFAULT_CONCURRENCY = 6;

function usage(): string {
  return [
    "Usage:",
    "  run.ts matrix [options]",
    "  run.ts judge  [options]",
    "",
    "Options:",
    "  --data-dir <dir>     inputs/outputs (default: ./data)",
    "  --concurrency <n>    parallel cells (default: 6)",
    "  --arms <csv>         arms to run (default: sonnet,opus). sonnet/opus run",
    "                       that model; any other arm name runs --model",
    "  --lenses <csv>       lenses (default: bug-detection,pattern-consistency,test-coverage)",
    "  --prs <csv>          PR numbers (default: 812,756,802)",
    "  --runs <n>           runs per cell (default: 2)",
    "  --model <alias>      model for every non-model arm (default: opus)",
  ].join("\n");
}

function nonEmpty(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}

function strippedEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.FLOW_SLUG;
  delete env.TMUX_PANE;
  return env;
}

async function spawnCapture(argv: string[], outFile: string): Promise<number> {
  const proc = Bun.spawn(argv, {
    env: strippedEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  // Capture stdout only — folding stderr into the same file corrupts the
  // JSON envelope whenever the child logs progress/warnings to stderr.
  await Bun.write(outFile, stdout);
  const rc = await proc.exited;
  if (rc !== 0 && stderr.trim()) {
    console.error(stderr.trim());
  }
  return rc;
}

async function pool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const item = items[idx++]!;
      await fn(item);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
}

type Cell = { lens: string; pr: string; arm: string; run: number };
type Opts = { lenses: string[]; prs: string[]; arms: string[]; runs: number };

function allCells(opts: Opts): Cell[] {
  const cells: Cell[] = [];
  for (const lens of opts.lenses) {
    for (const pr of opts.prs) {
      for (const arm of opts.arms) {
        for (let run = 1; run <= opts.runs; run++) {
          cells.push({ lens, pr, arm, run });
        }
      }
    }
  }
  return cells;
}

async function runMatrixCell(
  dataDir: string,
  model: string,
  cell: Cell,
): Promise<void> {
  const { lens: L, pr: P, arm: ARM, run: R } = cell;
  const out = join(dataDir, "runs", `${L}-${P}-${ARM}-r${R}.json`);
  const envelope = join(
    dataDir,
    "runs",
    `${L}-${P}-${ARM}-r${R}.envelope.json`,
  );
  if (nonEmpty(out)) {
    console.log(`skip ${L} ${P} ${ARM} r${R} (exists)`);
    return;
  }
  mkdirSync(join(dataDir, "runs"), { recursive: true });
  const promptFile = MODEL_ARMS.has(ARM)
    ? join(dataDir, `prompt-${L}-${P}.txt`)
    : join(dataDir, `prompt-${L}-${P}-${ARM}.txt`);
  const cellModel = MODEL_ARMS.has(ARM) ? ARM : model;
  const budget = cellModel === "opus" ? 14 : 6;
  const rc = await spawnCapture(
    [
      "flow-claude-headless",
      "--prompt-file",
      promptFile,
      "--model",
      cellModel,
      "--effort",
      "medium",
      "--allowed-tools",
      "Read,Grep,Glob",
      "--max-budget-usd",
      String(budget),
      "--max-turns",
      "40",
      "--timeout-sec",
      "1200",
      "--task",
      `recall-${L}-${P}-${ARM}-r${R}`,
      "--out",
      out,
    ],
    envelope,
  );
  console.log(`done ${L} ${P} ${ARM} r${R} rc=${rc}`);
}

async function runJudgeCell(
  dataDir: string,
  scriptDir: string,
  cell: Cell,
): Promise<void> {
  const { lens: L, pr: P, arm: ARM, run: R } = cell;
  const out = join(dataDir, "judge", `${L}-${P}-${ARM}-r${R}.json`);
  if (nonEmpty(out)) {
    console.log(`skip ${L} ${P} ${ARM} r${R}`);
    return;
  }
  mkdirSync(join(dataDir, "judge"), { recursive: true });
  const promptFile = join(
    dataDir,
    "judge",
    `${L}-${P}-${ARM}-r${R}.prompt.txt`,
  );
  const buildRc = await spawnCapture(
    [
      "bun",
      join(scriptDir, "build-judge.ts"),
      L,
      P,
      ARM,
      String(R),
      "--data-dir",
      dataDir,
    ],
    promptFile,
  );
  if (buildRc !== 0) {
    console.log(`build-judge failed ${L} ${P} ${ARM} r${R} rc=${buildRc}`);
    return;
  }
  const envelope = join(
    dataDir,
    "judge",
    `${L}-${P}-${ARM}-r${R}.envelope.json`,
  );
  const rc = await spawnCapture(
    [
      "flow-claude-headless",
      "--prompt-file",
      promptFile,
      "--model",
      "sonnet",
      "--effort",
      "medium",
      "--allowed-tools",
      "",
      "--max-budget-usd",
      "3",
      "--max-turns",
      "4",
      "--timeout-sec",
      "600",
      "--task",
      `judge-${L}-${P}-${ARM}-r${R}`,
      "--out",
      out,
    ],
    envelope,
  );
  console.log(`judged ${L} ${P} ${ARM} r${R} rc=${rc}`);
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
}

function csv(argv: string[], flag: string, fallback: string[]): string[] {
  const v = flagValue(argv, flag);
  return v ? v.split(",").filter(Boolean) : fallback;
}

function parseArgs(argv: string[]): {
  dataDir: string;
  concurrency: number;
  lenses: string[];
  prs: string[];
  arms: string[];
  runs: number;
  model: string;
} {
  return {
    dataDir: flagValue(argv, "--data-dir") ?? join(import.meta.dir, "data"),
    concurrency: Number(
      flagValue(argv, "--concurrency") ?? DEFAULT_CONCURRENCY,
    ),
    lenses: csv(argv, "--lenses", LENSES),
    prs: csv(argv, "--prs", PRS),
    arms: csv(argv, "--arms", ARMS),
    runs: Number(flagValue(argv, "--runs") ?? DEFAULT_RUNS),
    model: flagValue(argv, "--model") ?? DEFAULT_MODEL,
  };
}

async function main(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(usage());
    return sub ? 0 : 2;
  }
  const args = parseArgs(argv.slice(1));
  const { dataDir, concurrency } = args;

  if (sub === "matrix") {
    const cells = allCells(args);
    await pool(cells, concurrency, (c) =>
      runMatrixCell(dataDir, args.model, c),
    );
    const runsDir = join(dataDir, "runs");
    const n = existsSync(runsDir)
      ? readdirSync(runsDir).filter(
          (f) => f.endsWith(".json") && !f.endsWith(".envelope.json"),
        ).length
      : 0;
    console.log(`MATRIX COMPLETE: ${n} result files`);
    return 0;
  }

  if (sub === "judge") {
    const cells = allCells(args);
    await pool(cells, concurrency, (c) =>
      runJudgeCell(dataDir, import.meta.dir, c),
    );
    console.log("JUDGING COMPLETE");
    return 0;
  }

  console.error(usage());
  return 2;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

export { allCells, parseArgs };
