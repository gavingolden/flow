/**
 * Run every command-shaped `## Test Steps` item of a PR body in one pass:
 * execute it in a clean bash, tick the exit-0 ones, attach an evidence
 * block to each executed one, and return a JSON-able summary.
 *
 * Item classification comes from `parseTestSteps` (the same classifier the
 * gate and the lint use); the tick + evidence splice is `rewriteBody` from
 * `flow-inject-evidence`, so a runner pass and a manual recipe pass produce
 * byte-identical bodies. Nothing here shells out except the injectable
 * `exec` seam.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { rewriteBody } from "../flow-inject-evidence";
import { parseTestSteps, type StepKind } from "./test-steps-parse";

export type SkipReason =
  | "human-only"
  | "browser"
  | "prose"
  | "already-checked"
  | "budget";

export type RunTestStepsResult = {
  version: 1;
  bodyFile: string;
  total: number;
  ran: number;
  passed: number;
  ticked: number[];
  failed: {
    line: number;
    command: string;
    exitCode: number;
    timedOut: boolean;
    evidenceFile: string;
  }[];
  skipped: { line: number; kind: StepKind; reason: SkipReason }[];
};

export type ExecResult = {
  output: string;
  exitCode: number;
  timedOut: boolean;
};

export type RunTestStepsOpts = {
  bodyFile: string;
  worktree: string;
  timeoutSec?: number;
  budgetSec?: number;
  only?: number[];
  now?: () => number;
  exec?: (cmd: string, cwd: string, timeoutMs: number) => ExecResult;
};

const DEFAULT_TIMEOUT_SEC = 240;
const DEFAULT_BUDGET_SEC = 540;
const MAX_BUFFER = 64 * 1024 * 1024;
const STRIPPED_ENV = ["FLOW_SLUG", "TMUX_PANE"];

export function extractCommand(text: string): string | null {
  const m = text.match(/^Run\s+`([^`]+)`/) ?? text.match(/^`([^`]+)`/);
  if (!m || m[1].trim() === "") return null;
  return m[1];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultExec(cmd: string, cwd: string, timeoutMs: number): ExecResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STRIPPED_ENV) delete env[key];
  const r = spawnSync("bash", ["-c", cmd], {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timedOut =
    (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  let output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (timedOut) {
    output += `\n[flow-run-test-steps: killed after ${timeoutMs / 1000}s timeout]\n`;
    return { output, exitCode: 124, timedOut: true };
  }
  if (r.error) output += `\n[flow-run-test-steps: ${r.error.message}]\n`;
  return { output, exitCode: r.status ?? 1, timedOut: false };
}

type RunRecord = {
  line: number;
  rawLine: string;
  command: string;
  n: number;
  exec: ExecResult;
  evidenceFile: string;
  delta: number;
  ticked: boolean;
};

export function runTestSteps(opts: RunTestStepsOpts): RunTestStepsResult {
  const timeoutMs = (opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const budgetMs = (opts.budgetSec ?? DEFAULT_BUDGET_SEC) * 1000;
  const now = opts.now ?? Date.now;
  const exec = opts.exec ?? defaultExec;
  const only = opts.only ? new Set(opts.only) : null;
  const body = readFileSync(opts.bodyFile, "utf8");
  const bodyLines = body.split("\n");
  const { steps } = parseTestSteps(body);
  const evidenceDir = path.join(opts.worktree, ".flow-tmp");
  const start = now();

  const runs: RunRecord[] = [];
  const skipped: { line: number; kind: StepKind; reason: SkipReason }[] = [];
  for (const step of steps) {
    if (only && !only.has(step.line)) continue;
    const skip = (reason: SkipReason): void => {
      skipped.push({ line: step.line, kind: step.kind, reason });
    };
    if (step.checked) skip("already-checked");
    else if (step.kind === "subjective" || step.kind === "decision")
      skip("human-only");
    else if (step.kind === "browser") skip("browser");
    else if (step.kind === "prose") skip("prose");
    else {
      const command = extractCommand(step.text);
      const left = budgetMs - (now() - start);
      if (command === null) skip("prose");
      else if (left <= 0) skip("budget");
      else {
        // Cap each item at the remaining budget so the whole run stays
        // inside one Bash tool call; a tool kill would lose the rewrite.
        const itemMs = Math.min(timeoutMs, left);
        if (step.line < 1)
          throw new Error(`cannot locate Test Steps item line: ${step.text}`);
        mkdirSync(evidenceDir, { recursive: true });
        const n = runs.length + 1;
        const result = exec(command, opts.worktree, itemMs);
        const evidenceFile = path.join(evidenceDir, `evidence-${n}.txt`);
        writeFileSync(evidenceFile, result.output);
        writeFileSync(
          path.join(evidenceDir, `exit-${n}`),
          `${result.exitCode}\n`,
        );
        runs.push({
          line: step.line,
          rawLine: bodyLines[step.line - 1],
          command,
          n,
          exec: result,
          evidenceFile,
          delta: 0,
          ticked: false,
        });
      }
    }
  }

  if (runs.length > 0) {
    // Bottom-up so an insertion never shifts a not-yet-rewritten target;
    // anchoring on the exact raw line makes first-match the intended line
    // even for byte-identical duplicates and regex metacharacters.
    const timestamp = new Date().toISOString();
    let lines = bodyLines;
    for (const run of [...runs].sort((a, b) => b.line - a.line)) {
      const prefix = lines.slice(0, run.line - 1);
      const rest = lines.slice(run.line - 1);
      const result = rewriteBody(
        rest.join("\n"),
        {
          bodyFile: opts.bodyFile,
          item: `^${escapeRegExp(run.rawLine)}$`,
          exitCode: run.exec.exitCode,
          timestamp,
        },
        run.exec.output,
      );
      if (!result.ok) throw new Error(result.error);
      const next = result.body.split("\n");
      run.delta = next.length - rest.length;
      run.ticked = result.ticked;
      lines = [...prefix, ...next];
    }
    writeFileSync(opts.bodyFile, lines.join("\n"));
  }

  const shift = (line: number): number =>
    line + runs.reduce((sum, r) => (r.line < line ? sum + r.delta : sum), 0);
  const ordered = [...runs].sort((a, b) => a.line - b.line);

  return {
    version: 1,
    bodyFile: opts.bodyFile,
    total: steps.length,
    ran: runs.length,
    passed: runs.filter((r) => r.exec.exitCode === 0).length,
    ticked: ordered.filter((r) => r.ticked).map((r) => shift(r.line)),
    failed: ordered
      .filter((r) => r.exec.exitCode !== 0)
      .map((r) => ({
        line: shift(r.line),
        command: r.command,
        exitCode: r.exec.exitCode,
        timedOut: r.exec.timedOut,
        evidenceFile: r.evidenceFile,
      })),
    skipped: skipped.map((s) => ({ ...s, line: shift(s.line) })),
  };
}
