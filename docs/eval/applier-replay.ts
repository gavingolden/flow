#!/usr/bin/env bun
// Hand-run replay harness: re-runs a recorded edit-applier spawn under two
// instruction arms (before = the instructions at BEFORE_REF, after = those at
// AFTER_REF, the tested instructions, not this checkout's) and records turns, waste events, an independent final verify
// and a test count per run. Maintainer-only, never on PATH. Spends real
// money on `run`; `snapshot` and `report` are free.
//   bun docs/eval/applier-replay.ts snapshot --pr <n> [--repo flow]
//   bun docs/eval/applier-replay.ts run --arm before|after --case <file> --out <dir>
//   bun docs/eval/applier-replay.ts rescore --dir <outDir>
//   bun docs/eval/applier-replay.ts report --results <json|dir> [--check]
// `rescore` re-derives the stream-derived fields from each saved stream.jsonl
// (free); costUsd, finalVerify, tests and error are kept as recorded.
// The child goes through bin/lib/eval-runner.ts (stream-json, so its tool
// calls stay observable); never a raw `claude -p`.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runScenarioOnce } from "../../bin/lib/eval-runner";
import type { MaterializedFixture } from "../../bin/lib/eval-fixture";
import type { ResolvedScenario } from "../../bin/lib/eval-suite";
import {
  attributeSpawn,
  firstUserText,
  type SpawnStats,
} from "./applier-turns";
import { parseStream } from "../../bin/lib/eval-transcript";

const BEFORE_REF = "428642c";
const AFTER_REF = "19c2228";
const INSTRUCTIONS = "skills/pipeline/flow-coder-instructions/SKILL.md";
const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const ARTIFACT_RE = /(coder-result|fix-applier-result)\.json$/;

export type Recorded = {
  model: string;
  turns: number;
  fullVerifies: number;
  prettierRounds: number;
  parkedVerifies: number;
  finalVerify: boolean | null;
};
export type Case = {
  pr: number;
  slug: string;
  spawnAt: string;
  baseSha: string;
  spawnPrompt: string;
  flowTmpFiles: Record<string, string>;
  recorded: Recorded;
};
export type RunResult = {
  case: string;
  arm: "before" | "after";
  turns: number;
  costUsd: number;
  fullVerifies: number;
  parkedVerifies: number;
  prettierRounds: number;
  verifyCalls: number;
  verifyCallsWithTimeout: number;
  finalVerify: boolean | null;
  tests: number;
  error?: string;
};

export function pickBaseSha(
  commits: { oid: string; committedDate: string }[],
  spawnAt: string,
  firstParent: string,
): string {
  const at = Date.parse(spawnAt);
  let best: { oid: string; t: number } | null = null;
  for (const c of commits) {
    const t = Date.parse(c.committedDate);
    if (t <= at && (!best || t >= best.t)) best = { oid: c.oid, t };
  }
  return best ? best.oid : firstParent;
}

export const parseWorktree = (prompt: string): string | null =>
  prompt.match(/Working directory[^\n]*\n\s*(\/\S+)/)?.[1] ?? null;

export function rewritePrompt(
  prompt: string,
  o: { fromWorktree: string; toWorktree: string; instructionPath: string },
): string {
  const out = prompt
    .replace(
      /(read the instructions at:\s*\n\s*)\/\S+/,
      (_, pre) => pre + o.instructionPath,
    )
    .replace(
      /(Skill base directory[\s\S]*?\):\s*\n\s*)\/\S+/,
      (_, pre) => pre + path.dirname(o.instructionPath),
    );
  return out.split(o.fromWorktree).join(o.toWorktree);
}

export function selectTestFiles(
  changed: string[],
  allTests: string[],
): string[] {
  const known = new Set(allTests);
  const picked = new Set<string>();
  for (const f of changed) {
    if (TEST_RE.test(f)) {
      if (known.has(f)) picked.add(f);
      continue;
    }
    const colocated = f.replace(/\.[^./]+$/, "") + ".test.ts";
    if (known.has(colocated)) picked.add(colocated);
  }
  return [...picked].sort();
}

// Later runs of the same case and arm replace earlier ones (the one-re-run
// clause); the earlier rows stay in the results file.
export function lastRuns(runs: RunResult[]): RunResult[] {
  const by = new Map<string, RunResult>();
  for (const r of runs) by.set(`${r.case}/${r.arm}`, r);
  return [...by.values()];
}

export function checkFailures(runs: RunResult[]): string[] {
  const out: string[] = [];
  for (const r of lastRuns(runs)) {
    const id = `${r.case}/${r.arm}`;
    if (r.error) out.push(`${id}: run failed (${r.error})`);
    if (!(r.tests > 0)) out.push(`${id}: counted zero tests`);
    if (r.finalVerify === null) out.push(`${id}: no final verify outcome`);
  }
  return out;
}

export function verdict(runs: RunResult[]): {
  ship: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const last = lastRuns(runs);
  const cases = [...new Set(last.map((r) => r.case))].sort();
  const pairs: { id: string; b: RunResult; a: RunResult }[] = [];
  for (const id of cases) {
    const b = last.find((r) => r.case === id && r.arm === "before");
    const a = last.find((r) => r.case === id && r.arm === "after");
    if (!b || !a)
      reasons.push(`${id}: missing the ${b ? "after" : "before"} arm`);
    else pairs.push({ id, b, a });
  }
  if (!pairs.length) reasons.push("no case has both arms");
  for (const { id, b, a } of pairs) {
    for (const r of [b, a])
      if (r.error) reasons.push(`${id}/${r.arm}: run failed (${r.error})`);
    if (
      a.finalVerify === null ||
      b.finalVerify === null ||
      (b.finalVerify && !a.finalVerify)
    )
      reasons.push(
        `(a) ${id}: final verify before=${b.finalVerify} after=${a.finalVerify}`,
      );
    if (!(b.tests > 0 && a.tests > 0 && a.tests >= b.tests))
      reasons.push(`(b) ${id}: tests before=${b.tests} after=${a.tests}`);
    if (!(a.verifyCalls > 0 && a.verifyCallsWithTimeout === a.verifyCalls))
      reasons.push(
        `(e) ${id}: after verify calls with timeout ${a.verifyCallsWithTimeout} of ${a.verifyCalls}`,
      );
  }
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const waste = (r: RunResult) => r.prettierRounds + r.parkedVerifies;
  const bw = sum(pairs.map((p) => waste(p.b)));
  const aw = sum(pairs.map((p) => waste(p.a)));
  if (aw > bw)
    reasons.push(
      `(c) prettier rounds + parked verifies before=${bw} after=${aw}`,
    );
  const bt = sum(pairs.map((p) => p.b.turns));
  const at = sum(pairs.map((p) => p.a.turns));
  if (at > 1.1 * bt)
    reasons.push(
      `(d) turns before=${bt} after=${at} (limit ${(1.1 * bt).toFixed(1)})`,
    );
  return { ship: reasons.length === 0, reasons };
}

export function renderReport(runs: RunResult[]): string {
  const rows = lastRuns(runs).sort((x, y) =>
    `${x.case}/${x.arm}`.localeCompare(`${y.case}/${y.arm}`),
  );
  const heads = [
    "Case",
    "Arm",
    "Turns",
    "Cost",
    "Full verifies",
    "Parked verifies",
    "Prettier-only rounds",
    "Verify calls with timeout / total",
    "Final verify",
    "Tests",
    "Error",
  ];
  const fin = (v: boolean | null) =>
    v === null ? "none" : v ? "pass" : "fail";
  const v = verdict(runs);
  return [
    `| ${heads.join(" | ")} |`,
    `|${heads.map(() => "---").join("|")}|`,
    ...rows.map(
      (r) =>
        `| ${r.case} | ${r.arm} | ${r.turns} | $${r.costUsd.toFixed(2)} | ${r.fullVerifies} | ${r.parkedVerifies} | ${r.prettierRounds} | ${r.verifyCallsWithTimeout} / ${r.verifyCalls} | ${fin(r.finalVerify)} | ${r.tests} | ${r.error ?? ""} |`,
    ),
    "",
    `**Verdict:** ${v.ship ? "ship" : "no-ship"}`,
    ...v.reasons.map((x) => `- ${x}`),
  ].join("\n");
}

const unwrapRead = (text: string) =>
  text
    .replace(/\n*<system-reminder>[\s\S]*?<\/system-reminder>\s*$/, "")
    .replace(/^\s*\d+\t/gm, "");

// .flow-tmp files the recorded run read (Read tool or a bare `cat`), keyed by
// path relative to .flow-tmp. Skips the artifact, truncated reads, and any
// file the run wrote before reading it.
export function extractFlowTmpFiles(
  records: unknown[],
  worktree: string,
): Record<string, string> {
  const prefix = `${worktree}/.flow-tmp/`;
  const results = new Map<string, string>();
  for (const r of records as any[]) {
    if (r?.type !== "user" || !Array.isArray(r.message?.content)) continue;
    for (const b of r.message.content)
      if (b?.type === "tool_result")
        results.set(
          b.tool_use_id,
          Array.isArray(b.content)
            ? b.content.map((x: any) => x?.text ?? "").join("\n")
            : String(b.content ?? ""),
        );
  }
  const out: Record<string, string> = {};
  const written = new Set<string>();
  const seen = new Set<string>();
  for (const r of records as any[]) {
    if (r?.type !== "assistant") continue;
    for (const b of r.message?.content ?? []) {
      if (b?.type !== "tool_use") continue;
      const inp = b.input ?? {};
      if (b.name === "Write" || b.name === "Edit") {
        written.add(String(inp.file_path ?? ""));
        continue;
      }
      let file = "";
      if (
        b.name === "Read" &&
        inp.offset === undefined &&
        inp.limit === undefined
      )
        file = String(inp.file_path ?? "");
      else if (b.name === "Bash") {
        const cat = String(inp.command ?? "").match(
          /^(?:cd [^&;]+(?:&&|;)\s*)?cat\s+(\/\S+)\s*$/,
        );
        file = cat?.[1] ?? "";
        for (const m of String(inp.command ?? "").matchAll(/>\s*(\/\S+)/g))
          written.add(m[1]);
      }
      if (!file.startsWith(prefix) || ARTIFACT_RE.test(file)) continue;
      if (written.has(file) || seen.has(file)) continue;
      const text = results.get(b.id);
      if (text === undefined || text.includes("<persisted-output>")) continue;
      seen.add(file);
      out[file.slice(prefix.length)] =
        b.name === "Read" ? unwrapRead(text) : text;
    }
  }
  return out;
}

export function editSetFiles(
  prompt: string,
  flowTmpFiles: Record<string, string>,
  worktree: string,
): string[] | null {
  let raw: string | undefined;
  const inline = prompt.match(
    /Edit-set \(verbatim, JSON-shaped\)[^\n]*:\s*\n\s*(\[[\s\S]*?\])\s*\n\s*\n/,
  );
  if (inline) raw = inline[1];
  else {
    const p = prompt.match(/Edit-set[^\n]*\n\s*(\/\S+\.json)/)?.[1];
    if (p) raw = flowTmpFiles[p.replace(`${worktree}/.flow-tmp/`, "")];
  }
  try {
    const parsed = JSON.parse(raw ?? "");
    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed.entries ?? parsed.edits);
    return Array.isArray(arr) ? arr.map((e: any) => String(e.file)) : null;
  } catch {
    return null;
  }
}

function sh(cwd: string, argv: string[], env?: NodeJS.ProcessEnv) {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
function git(cwd: string, ...args: string[]): string {
  const r = sh(cwd, ["git", ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err.trim()}`);
  return r.out;
}
const repoRoot = () =>
  git(
    path.dirname(fileURLToPath(import.meta.url)),
    "rev-parse",
    "--show-toplevel",
  ).trim();

function snapshot(flag: (n: string) => string | undefined) {
  const pr = Number(flag("--pr"));
  const repo = flag("--repo") ?? "flow";
  if (!Number.isInteger(pr)) throw new Error("--pr <n> is required");
  const root = repoRoot();
  const mapPath = path.resolve(
    flag("--map") ?? ".flow-tmp/edit-applier-pr-map.json",
  );
  const rows = (JSON.parse(fs.readFileSync(mapPath, "utf8")) as any[][])
    .filter((r) => r[1] === repo && r[5] === pr)
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (!rows.length) throw new Error(`no ${repo} PR ${pr} spawn in ${mapPath}`);
  const [, , slug, , , , rel] = rows[0];
  const projects =
    flag("--projects") ?? path.join(os.homedir(), ".claude", "projects");
  const recs = fs
    .readFileSync(path.join(projects, String(rel)), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const spawnPrompt = firstUserText(recs);
  const worktree = parseWorktree(spawnPrompt);
  if (!worktree) throw new Error("spawn prompt names no working directory");
  const spawnAt: string = recs.find((r) => r.timestamp).timestamp;
  const flowTmpFiles = extractFlowTmpFiles(recs, worktree);
  const files = editSetFiles(spawnPrompt, flowTmpFiles, worktree);
  if (!files?.length) throw new Error(`PR ${pr}: edit-set is not recoverable`);

  git(root, "fetch", "origin", `pull/${pr}/head`);
  const commits = JSON.parse(
    sh(root, ["gh", "pr", "view", String(pr), "--json", "commits"]).out,
  ).commits as { oid: string; committedDate: string }[];
  const firstParent = git(root, "rev-parse", `${commits[0].oid}^`).trim();
  const baseSha = pickBaseSha(commits, spawnAt, firstParent);
  const tests = git(root, "ls-tree", "-r", "--name-only", baseSha)
    .split("\n")
    .filter((f) => TEST_RE.test(f));
  const picked = selectTestFiles(files, tests);
  console.error(
    `PR ${pr} base ${baseSha.slice(0, 7)}: ${picked.length} tests selected for the edit-set files`,
  );
  if (!picked.length && !process.argv.includes("--allow-no-tests"))
    throw new Error(
      `PR ${pr}: no tested file at base — pick another PR (or pass --allow-no-tests)`,
    );

  const s = attributeSpawn(recs);
  const c: Case = {
    pr,
    slug: String(slug),
    spawnAt,
    baseSha,
    spawnPrompt,
    flowTmpFiles,
    recorded: {
      model: s.model,
      turns: s.turns,
      fullVerifies: s.fullVerifies,
      prettierRounds: s.prettierRounds,
      parkedVerifies: s.parkedVerifies,
      finalVerify: s.finalVerify,
    },
  };
  const out = path.resolve(
    root,
    flag("--out") ?? "docs/eval/applier-replay/cases",
  );
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `pr-${pr}.json`);
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
  console.log(file);
}

// A second run of the same case and arm keeps the first one's stream and
// result under a -runN suffix, so the rule's "both stay" holds on disk.
export function retirePriorRun(outDir: string, name: string) {
  const dir = path.join(outDir, name);
  const result = path.join(outDir, `${name}.result.json`);
  if (!fs.existsSync(dir) && !fs.existsSync(result)) return;
  let n = 1;
  while (
    fs.existsSync(path.join(outDir, `${name}-run${n}`)) ||
    fs.existsSync(path.join(outDir, `${name}-run${n}.result.json`))
  )
    n++;
  if (fs.existsSync(dir))
    fs.renameSync(dir, path.join(outDir, `${name}-run${n}`));
  if (fs.existsSync(result))
    fs.renameSync(result, path.join(outDir, `${name}-run${n}.result.json`));
}

async function run(flag: (n: string) => string | undefined) {
  const arm = flag("--arm");
  if (arm !== "before" && arm !== "after")
    throw new Error("--arm before|after");
  const casePath = path.resolve(flag("--case") ?? "");
  const c: Case = JSON.parse(fs.readFileSync(casePath, "utf8"));
  const id = path.basename(casePath, ".json");
  const outDir = path.resolve(flag("--out") ?? ".flow-tmp/applier-replay");
  const runDir = path.join(outDir, `${id}-${arm}`);
  retirePriorRun(outDir, `${id}-${arm}`);
  fs.mkdirSync(runDir, { recursive: true });
  const root = repoRoot();
  const canonical = git(root, "worktree", "list", "--porcelain").match(
    /^worktree (.+)$/m,
  )![1];
  const from = parseWorktree(c.spawnPrompt);
  if (!from) throw new Error("spawn prompt names no working directory");

  git(root, "fetch", "origin", `pull/${c.pr}/head`);
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `applier-replay-${id}-${arm}-`)),
  );
  const result: RunResult = {
    case: id,
    arm,
    turns: 0,
    costUsd: 0,
    fullVerifies: 0,
    parkedVerifies: 0,
    prettierRounds: 0,
    verifyCalls: 0,
    verifyCallsWithTimeout: 0,
    finalVerify: null,
    tests: 0,
  };
  try {
    git(root, "worktree", "add", "--detach", tmp, c.baseSha);
    const nm = path.join(tmp, "node_modules");
    if (git(tmp, "ls-files", "node_modules").trim()) {
      fs.rmSync(nm, { recursive: true, force: true });
      git(tmp, "update-index", "--skip-worktree", "node_modules");
    }
    fs.rmSync(nm, { recursive: true, force: true });
    fs.symlinkSync(path.join(canonical, "node_modules"), nm);
    for (const [rel, text] of Object.entries(c.flowTmpFiles)) {
      const f = path.join(tmp, ".flow-tmp", rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    }
    fs.mkdirSync(path.join(tmp, ".flow-tmp"), { recursive: true });

    const instr = path.join(runDir, "instructions", "SKILL.md");
    fs.mkdirSync(path.dirname(instr), { recursive: true });
    fs.writeFileSync(
      instr,
      arm === "before"
        ? git(root, "show", `${BEFORE_REF}:${INSTRUCTIONS}`)
        : git(root, "show", `${AFTER_REF}:${INSTRUCTIONS}`),
    );
    fs.writeFileSync(
      path.join(runDir, "prompt-input.txt"),
      rewritePrompt(c.spawnPrompt, {
        fromWorktree: from,
        toWorktree: tmp,
        instructionPath: instr,
      }),
    );

    const mk = (n: string) => {
      const d = path.join(runDir, n);
      fs.mkdirSync(d, { recursive: true });
      return d;
    };
    const scenario: ResolvedScenario = {
      id,
      title: `applier replay ${id} ${arm}`,
      provenance: "docs/eval/applier-replay.md",
      prompt: "prompt-input.txt",
      graders: [],
      dir: runDir,
      runs: 1,
      maxBudgetUsd: 20,
      timeoutSec: 2700,
      mcpServers: [],
      allowedTools: ["Bash", "Read", "Edit", "Write", "Grep", "Glob"],
    };
    const fixture: MaterializedFixture = {
      root: runDir,
      repoDir: tmp,
      claudeHome: mk("claude-home"),
      bareClaudeHome: mk("bare-claude-home"),
      pluginRoots: [],
      shimDir: mk("shims"),
      slug: c.slug,
      stateDir: mk("state"),
      teardown: () => {},
    };
    const out = await runScenarioOnce(scenario, fixture, {
      claudeBin: flag("--claude-bin") ?? "claude",
      outDir: runDir,
      sessionId: crypto.randomUUID(),
      model: "sonnet",
      effort: "medium",
    });
    const s = attributeSpawn(out.events);
    Object.assign(result, streamFields(s), {
      costUsd: out.result?.total_cost_usd ?? 0,
    });
    const err = out.timedOut ? "timeout" : out.error;
    if (err) result.error = err;

    // Exit 1 when it only warns about ignored paths; new files are still added.
    sh(tmp, ["git", "add", "-N", "--", ".", ":!node_modules", ":!.flow-tmp"]);
    // Against the base, not HEAD: some recorded prompts tell the agent to commit.
    const changed = git(tmp, "diff", "--name-only", c.baseSha)
      .split("\n")
      .filter(Boolean);
    const allTests = git(tmp, "ls-files")
      .split("\n")
      .filter((f) => TEST_RE.test(f));
    const files = selectTestFiles(changed, allTests);
    if (files.length) {
      const t = sh(tmp, ["npx", "vitest", "run", "--reporter=json", ...files]);
      try {
        result.tests =
          JSON.parse(t.out.slice(t.out.indexOf("{"))).numTotalTests ?? 0;
      } catch {
        result.tests = 0;
      }
    }
    const env = { ...process.env };
    delete env.FLOW_SLUG;
    const v = sh(tmp, ["flow-pre-commit", "--json"], env);
    const m = v.out.match(/"allPassed":\s*(true|false)/);
    result.finalVerify = m ? m[1] === "true" : null;
  } catch (e) {
    result.error ??= `harness: ${(e as Error).message}`;
  } finally {
    sh(root, ["git", "worktree", "remove", "--force", tmp]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const file = path.join(outDir, `${id}-${arm}.result.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  console.log(file);
}

export const streamFields = (s: SpawnStats) => ({
  turns: s.turns,
  fullVerifies: s.fullVerifies,
  parkedVerifies: s.parkedVerifies,
  prettierRounds: s.prettierRounds,
  verifyCalls: s.verifyCalls,
  verifyCallsWithTimeout: s.verifyCallsWithTimeout,
});

export const mergeRescore = (old: RunResult, s: SpawnStats): RunResult => ({
  ...old,
  ...streamFields(s),
});

function rescore(flag: (n: string) => string | undefined) {
  const dir = path.resolve(flag("--dir") ?? "");
  for (const f of fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".result.json"))) {
    const file = path.join(dir, f);
    const stream = path.join(
      dir,
      f.replace(/\.result\.json$/, ""),
      "stream.jsonl",
    );
    const old: RunResult = JSON.parse(fs.readFileSync(file, "utf8"));
    const { events } = parseStream(fs.readFileSync(stream, "utf8"));
    const fresh = attributeSpawn(events);
    const next = mergeRescore(old, fresh);
    const diffs = (Object.keys(streamFields(fresh)) as (keyof RunResult)[])
      .filter((k) => old[k] !== next[k])
      .map((k) => `${k} ${old[k]} -> ${next[k]}`);
    if (diffs.length)
      fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
    console.log(
      `${f.replace(/\.result\.json$/, "")}: ${diffs.join(", ") || "unchanged"}`,
    );
  }
}

export function loadResults(p: string): RunResult[] {
  if (!fs.statSync(p).isDirectory())
    return JSON.parse(fs.readFileSync(p, "utf8"));
  return fs
    .readdirSync(p)
    .filter((f) => f.endsWith(".result.json"))
    .map((f) => ({ f, t: fs.statSync(path.join(p, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t)
    .map(({ f }) => JSON.parse(fs.readFileSync(path.join(p, f), "utf8")));
}

function report(flag: (n: string) => string | undefined) {
  const runs = loadResults(path.resolve(flag("--results") ?? ""));
  const write = flag("--write-json");
  if (write) fs.writeFileSync(write, JSON.stringify(runs, null, 2) + "\n");
  console.log(renderReport(runs));
  if (process.argv.includes("--check")) {
    const bad = checkFailures(runs);
    for (const b of bad) console.error(`check failed: ${b}`);
    if (bad.length) process.exit(1);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) =>
    argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined;
  const cmd = argv[0];
  try {
    if (cmd === "snapshot") snapshot(flag);
    else if (cmd === "run") await run(flag);
    else if (cmd === "rescore") rescore(flag);
    else if (cmd === "report") report(flag);
    else
      throw new Error(
        "usage: applier-replay.ts snapshot|run|rescore|report (see header)",
      );
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
