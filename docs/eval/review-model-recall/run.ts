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
 * Both subcommands are resume-safe (a cell whose successful output file
 * already exists is skipped) and bounded-concurrency — the committed run
 * needed both after an account spend limit killed 10 cells mid-matrix.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AGENT_FINDINGS_JSON_SCHEMA,
  decodeLensArtifact,
  projectLensFindings,
} from "../../../bin/lib/agy-lens-core";
import type { AgentFindings } from "../../../bin/lib/agent-finding-schema";
import { agyLensOutputContract } from "../../../bin/lib/lens-prompt";

const LENSES = ["bug-detection", "pattern-consistency", "test-coverage"];
const PRS = ["812", "756", "802"];
const ARMS = ["sonnet", "opus"];
const DEFAULT_RUNS = 2;
const DEFAULT_MODEL = "opus";
const MODEL_ARMS = new Set(["sonnet", "opus", "fable"]);
const DEFAULT_EFFORT = "medium";
// Bun exposes import.meta.dir; vitest (Node) only import.meta.dirname.
const HERE = import.meta.dirname ?? import.meta.dir;
const REPO_ROOT = join(HERE, "../../..");

// Arms that run through agy (`flow-delegate`) instead of `claude -p`, keyed
// by arm name -> the agy display-name variant. The arm name rides in cell
// file names (`<lens>-<pr>-<arm>-r<run>.json`), so it stays lowercase
// alphanumerics joined by hyphens.
export const AGY_ARMS: Record<string, string> = {
  "agy-opus-5-5-high": "Claude Opus 5.5 (High)",
};
const AGY_CELL_TIMEOUT = "15m";

const DEFAULT_CONCURRENCY = 6;
const CELL_BUDGET_USD: Record<string, number> = { fable: 20, opus: 14 };

function usage(): string {
  return [
    "Usage:",
    "  run.ts matrix [options]",
    "  run.ts judge  [options]",
    "",
    "Options:",
    "  --data-dir <dir>     inputs/outputs (default: ./data)",
    "  --concurrency <n>    parallel cells (default: 6)",
    "  --arms <csv>         arms to run (default: sonnet,opus). sonnet/opus/fable",
    "                       run that model; any other arm name runs --model",
    "  --lenses <csv>       lenses (default: bug-detection,pattern-consistency,test-coverage)",
    "  --prs <csv>          PR numbers (default: 812,756,802)",
    "  --runs <n>           runs per cell (default: 2)",
    "  --model <alias>      model for every non-model arm (default: opus)",
    "  --effort <level>     --effort for the Claude arms (default: medium)",
    `  agy arms (${Object.keys(AGY_ARMS).join(", ")}) run the base prompt plus the delegated-lens`,
    "                       output contract through flow-delegate on the Google plan",
  ].join("\n");
}

// A cell is done only when its out file is a successful `claude -p` result.
// A budget/turn/rate-limit kill still writes a non-empty error envelope, and
// skipping it would let the judge score a failed cell as zero recall.
export function isCompletedCellOutput(text: string): boolean {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return false;
  const r = j as { is_error?: unknown; subtype?: unknown };
  if (r.is_error === true) return false;
  return r.subtype === undefined || r.subtype === "success";
}

function completed(path: string): boolean {
  return existsSync(path) && isCompletedCellOutput(readFileSync(path, "utf8"));
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

export function agyCellArgv(o: {
  promptFile: string;
  schemaFile: string;
  out: string;
  model: string;
  addDir: string;
  task: string;
}): string[] {
  return [
    "--output-format",
    "json",
    "--json-schema",
    o.schemaFile,
    "--prompt-file",
    o.promptFile,
    "--model",
    o.model,
    "--add-dir",
    o.addDir,
    "--out",
    o.out,
    "--task",
    o.task,
    "--timeout",
    AGY_CELL_TIMEOUT,
  ];
}

// A decoded cell is written claude-shaped so judge and score read it
// unchanged; an unusable one is `is_error: true`, which the resume predicate
// (isCompletedCellOutput) treats as not done so the next run retries it.
export function wrapAgyCell(
  decoded: { ok: true; value: AgentFindings } | { ok: false },
  meta: { durationMs: number; usage?: Record<string, number> },
): Record<string, unknown> {
  const common = {
    type: "result",
    duration_ms: meta.durationMs,
    ...(meta.usage ? { usage: meta.usage } : {}),
  };
  if (!decoded.ok) {
    return {
      ...common,
      subtype: "error_agy_unusable",
      is_error: true,
      result: "",
    };
  }
  return {
    ...common,
    subtype: "success",
    is_error: false,
    result: JSON.stringify(projectLensFindings(decoded.value)),
  };
}

function lastJsonLine(path: string): Record<string, unknown> {
  try {
    const line =
      readFileSync(path, "utf8").trim().split("\n").filter(Boolean).pop() ??
      "{}";
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function runAgyMatrixCell(dataDir: string, cell: Cell): Promise<void> {
  const { lens: L, pr: P, arm: ARM, run: R } = cell;
  const base = `${L}-${P}-${ARM}-r${R}`;
  const runsDir = join(dataDir, "runs");
  const out = join(runsDir, `${base}.json`);
  if (completed(out)) {
    console.log(`skip ${L} ${P} ${ARM} r${R} (exists)`);
    return;
  }
  mkdirSync(runsDir, { recursive: true });
  const diffPath = join(dataDir, `diff-${P}.patch`);
  const diffFiles = existsSync(diffPath)
    ? (readFileSync(diffPath, "utf8").match(/^\+\+\+ b\//gm) ?? []).length
    : 0;
  const promptFile = join(runsDir, `${base}.agy-prompt.txt`);
  writeFileSync(
    promptFile,
    `${readFileSync(join(dataDir, `prompt-${L}-${P}.txt`), "utf8")}\n\n${agyLensOutputContract(REPO_ROOT, diffFiles)}`,
  );
  const schemaFile = join(dataDir, "agy-findings-schema.json");
  writeFileSync(schemaFile, JSON.stringify(AGENT_FINDINGS_JSON_SCHEMA));
  const raw = join(runsDir, `${base}.agy-raw.json`);
  const envelope = join(runsDir, `${base}.envelope.json`);
  const started = Date.now();
  const rc = await spawnCapture(
    [
      "flow-delegate",
      ...agyCellArgv({
        promptFile,
        schemaFile,
        out: raw,
        model: AGY_ARMS[ARM]!,
        addDir: REPO_ROOT,
        task: `recall-${base}`,
      }),
    ],
    envelope,
  );
  const env = lastJsonLine(envelope);
  const artifact =
    typeof env.artifactPath === "string" ? env.artifactPath : raw;
  const decoded =
    env.ran === true && existsSync(artifact)
      ? decodeLensArtifact(readFileSync(artifact, "utf8"))
      : ({ ok: false } as const);
  const cellJson = wrapAgyCell(decoded, {
    durationMs: Date.now() - started,
    usage:
      typeof env.usage === "object" && env.usage !== null
        ? (env.usage as Record<string, number>)
        : undefined,
  });
  writeFileSync(out, JSON.stringify(cellJson));

  // Count unusable attempts across resumes: "schema-valid on the first
  // attempt" is a recorded clear criterion, and an overwritten out file
  // would otherwise lose the failed attempts that preceded a retry success.
  const sidecar = join(runsDir, `${base}.agy.json`);
  const prior = lastJsonLine(sidecar) as {
    attempts?: number;
    unusable_attempts?: number;
  };
  writeFileSync(
    sidecar,
    JSON.stringify({
      attempts: (prior.attempts ?? 0) + 1,
      unusable_attempts: (prior.unusable_attempts ?? 0) + (decoded.ok ? 0 : 1),
      last_ran: env.ran === true,
      last_skip_reason: env.skipReason ?? null,
    }),
  );
  console.log(
    `done ${L} ${P} ${ARM} r${R} rc=${rc} ${decoded.ok ? "decoded" : "unusable"}`,
  );
}

async function runMatrixCell(
  dataDir: string,
  model: string,
  effort: string,
  cell: Cell,
): Promise<void> {
  if (cell.arm in AGY_ARMS) return runAgyMatrixCell(dataDir, cell);
  const { lens: L, pr: P, arm: ARM, run: R } = cell;
  const out = join(dataDir, "runs", `${L}-${P}-${ARM}-r${R}.json`);
  const envelope = join(
    dataDir,
    "runs",
    `${L}-${P}-${ARM}-r${R}.envelope.json`,
  );
  if (completed(out)) {
    console.log(`skip ${L} ${P} ${ARM} r${R} (exists)`);
    return;
  }
  mkdirSync(join(dataDir, "runs"), { recursive: true });
  const promptFile = MODEL_ARMS.has(ARM)
    ? join(dataDir, `prompt-${L}-${P}.txt`)
    : join(dataDir, `prompt-${L}-${P}-${ARM}.txt`);
  const cellModel = MODEL_ARMS.has(ARM) ? ARM : model;
  const budget = CELL_BUDGET_USD[cellModel] ?? 6;
  const rc = await spawnCapture(
    [
      "flow-claude-headless",
      "--prompt-file",
      promptFile,
      "--model",
      cellModel,
      "--effort",
      effort,
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
  const review = join(dataDir, "runs", `${L}-${P}-${ARM}-r${R}.json`);
  if (!completed(review)) {
    console.log(`wait ${L} ${P} ${ARM} r${R} (review not complete)`);
    return;
  }
  if (completed(out) && statSync(out).mtimeMs >= statSync(review).mtimeMs) {
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
  effort: string;
} {
  return {
    dataDir: flagValue(argv, "--data-dir") ?? join(HERE, "data"),
    concurrency: Number(
      flagValue(argv, "--concurrency") ?? DEFAULT_CONCURRENCY,
    ),
    lenses: csv(argv, "--lenses", LENSES),
    prs: csv(argv, "--prs", PRS),
    arms: csv(argv, "--arms", ARMS),
    runs: Number(flagValue(argv, "--runs") ?? DEFAULT_RUNS),
    model: flagValue(argv, "--model") ?? DEFAULT_MODEL,
    effort: flagValue(argv, "--effort") ?? DEFAULT_EFFORT,
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
      runMatrixCell(dataDir, args.model, args.effort, c),
    );
    const runsDir = join(dataDir, "runs");
    const n = existsSync(runsDir)
      ? readdirSync(runsDir).filter(
          (f) =>
            f.endsWith(".json") &&
            !f.endsWith(".envelope.json") &&
            !f.includes(".agy"),
        ).length
      : 0;
    console.log(`MATRIX COMPLETE: ${n} result files`);
    return 0;
  }

  if (sub === "judge") {
    const cells = allCells(args);
    await pool(cells, concurrency, (c) => runJudgeCell(dataDir, HERE, c));
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
