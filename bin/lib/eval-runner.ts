/**
 * Run one (fixture × config) pair end-to-end:
 *   1. Materialise a scratch repo from the fixture's seed/.
 *   2. Wire up project-local `.claude/skills/` for the requested config.
 *   3. Invoke `claude -p "<prompt>"` (the implementor); capture the stream.
 *   4. Collect the post-run diff against the baseline commit.
 *   5. Run rubric hard-checks against the diff + repo.
 *   6. Run rubric soft-checks via the LLM judge.
 *   7. Persist artefacts under `evals/.runs/<timestamp>/<config>/<fixture>/`
 *      and return an aggregate result.
 *
 * The implementor invocation is overridable via the `invokeImplementor` option
 * so tests can stub it without running real Claude calls.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { buildSkillSet, SKILL_NAMES, type Config } from "./eval-config";
import { parseRubric, runHardChecks, type HardResult } from "./eval-rubric";
import { parseStreamJsonText, type CostResult, emptyCost } from "./eval-cost";
import { runSoftChecks, type SoftResult } from "./eval-judge";

export type RunResult = {
  fixture: string;
  config: Config;
  pass: boolean;
  hard: HardResult;
  soft: SoftResult;
  implCost: CostResult;
  durationMs: number;
  artefactsDir: string;
};

export type RunOptions = {
  fixtureDir: string;
  config: Config;
  flowSource: string;
  /** evals/.runs/<timestamp>/<config>/<fixture>/ — pre-built by caller. */
  artefactsDir: string;
  /** Override for tests (and an escape hatch). Receives prompt + repoDir, returns raw stream-json. */
  invokeImplementor?: (prompt: string, repoDir: string) => Promise<string>;
};

export async function runFixture(opts: RunOptions): Promise<RunResult> {
  const start = Date.now();
  fs.mkdirSync(opts.artefactsDir, { recursive: true });
  const repoDir = path.join(opts.artefactsDir, "repo");

  copyDir(path.join(opts.fixtureDir, "seed"), repoDir);
  initRepo(repoDir);

  const skillSet = buildSkillSet(opts.config, opts.flowSource, path.join(opts.artefactsDir, "skills-mirror"));
  symlinkSkills(repoDir, skillSet);

  const prompt = fs.readFileSync(path.join(opts.fixtureDir, "prompt.md"), "utf8").trim();
  const invoke = opts.invokeImplementor ?? defaultInvokeImplementor;
  const rawStream = await invoke(prompt, repoDir);
  fs.writeFileSync(path.join(opts.artefactsDir, "implementor.jsonl"), rawStream);
  const implCost = rawStream ? parseStreamJsonText(rawStream) : emptyCost();

  const diff = collectDiff(repoDir);
  fs.writeFileSync(path.join(opts.artefactsDir, "final.diff"), diff);
  const changedPaths = collectChangedPaths(repoDir);

  const rubric = parseRubric(path.join(opts.fixtureDir, "rubric.yml"));
  const hard = runHardChecks(rubric, repoDir, changedPaths);
  fs.writeFileSync(path.join(opts.artefactsDir, "hard.json"), JSON.stringify(hard, null, 2));

  const soft = await runSoftChecks({ prompt, diff, criteria: rubric.soft });
  fs.writeFileSync(path.join(opts.artefactsDir, "judge.jsonl"), soft.rawStream);
  fs.writeFileSync(
    path.join(opts.artefactsDir, "soft.json"),
    JSON.stringify({ pass: soft.pass, verdicts: soft.verdicts }, null, 2),
  );

  return {
    fixture: path.basename(opts.fixtureDir),
    config: opts.config,
    pass: hard.pass && soft.pass,
    hard,
    soft,
    implCost,
    durationMs: Date.now() - start,
    artefactsDir: opts.artefactsDir,
  };
}

function copyDir(src: string, dst: string): void {
  if (!fs.existsSync(src)) throw new Error(`fixture seed missing: ${src}`);
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

function initRepo(repoDir: string): void {
  run("git", ["init", "-q", "-b", "main"], repoDir);
  run("git", ["config", "user.email", "eval@flow.local"], repoDir);
  run("git", ["config", "user.name", "flow-eval"], repoDir);
  run("git", ["add", "-A"], repoDir);
  run("git", ["commit", "-q", "-m", "baseline", "--allow-empty"], repoDir);
}

function symlinkSkills(repoDir: string, skillSet: string): void {
  const skillsDir = path.join(repoDir, ".claude", "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const name of SKILL_NAMES) {
    const src = path.join(skillSet, name);
    if (!fs.existsSync(src)) continue;
    fs.symlinkSync(src, path.join(skillsDir, name));
  }
}

function collectDiff(repoDir: string): string {
  // Stage everything so untracked files appear in the diff alongside modified ones.
  run("git", ["add", "-A"], repoDir);
  return runCapture("git", ["diff", "--cached", "--no-color"], repoDir);
}

function collectChangedPaths(repoDir: string): string[] {
  const out = runCapture("git", ["diff", "--cached", "--name-only"], repoDir);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function run(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${(r.stderr ?? "").trim()}`);
  }
}

function runCapture(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${(r.stderr ?? "").trim()}`);
  }
  return r.stdout ?? "";
}

async function defaultInvokeImplementor(prompt: string, repoDir: string): Promise<string> {
  const bin = process.env.FLOW_EVAL_CLAUDE_BIN ?? "claude";
  const r = spawnSync(
    bin,
    [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--no-session-persistence",
      "--dangerously-skip-permissions",
    ],
    {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (r.status !== 0) {
    throw new Error(`implementor failed (${r.status}): ${(r.stderr ?? "").trim() || "(no stderr)"}`);
  }
  return r.stdout ?? "";
}
