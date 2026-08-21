/**
 * Availability probes, child argv/env builders, prompt rendering, and the
 * single-run child-process driver for `flow-eval`. `node:child_process`
 * only — NEVER `Bun.spawn`, which is undefined under vitest's Node-hosted
 * process. Mirrors `bin/flow-plugin-contract-lint.ts`'s
 * `commandOnPath`/`runClaude` availability discipline, minus the `HOME`
 * override (an eval child must stay authenticated against the real
 * account — see the flow repo's excluded-path note on
 * `override-home-for-isolation`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn as spawnAsync, spawnSync } from "node:child_process";
import type { ResolvedScenario } from "./eval-suite";
import type { MaterializedFixture } from "./eval-fixture";
import {
  parseStream,
  type ResultEnvelope,
  type StreamEvent,
} from "./eval-transcript";
import { pluginBinPath, pluginDirArgs, withPluginPath } from "./plugin-root";
import { statePath } from "./state";
import { checkpointBodyPath } from "./checkpoint-freshness";
import {
  resumeSeedFor,
  terminalCarryOver,
  terminalContinueSeed,
} from "../flow-session-start-hook";

export type ClaudeAvailability =
  | { ok: true; version: string }
  | {
      ok: false;
      reason:
        | "claude-not-on-path"
        | "claude-not-authenticated"
        | "flow-not-installed";
      notice: string;
    };

function defaultRun(argv: string[]): { exitCode: number; stdout: string } {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
  return { exitCode: result.status ?? -1, stdout: result.stdout ?? "" };
}

export function probeClaude(
  claudeBin: string,
  run: (argv: string[]) => { exitCode: number; stdout: string } = defaultRun,
): ClaudeAvailability {
  const versionResult = run([claudeBin, "--version"]);
  if (versionResult.exitCode !== 0) {
    // Deliberately NOT parameterized by `claudeBin` — the one-line skip
    // notice contract (coder-instructions / the flow-eval acceptance
    // check) greps for the literal "claude is not on PATH" regardless of
    // which --claude-bin value was tried.
    return {
      ok: false,
      reason: "claude-not-on-path",
      notice: "claude is not on PATH",
    };
  }
  const version =
    versionResult.stdout.trim().split(/\s+/)[0] ?? versionResult.stdout.trim();

  const authResult = run([claudeBin, "auth", "status", "--json"]);
  let loggedIn = false;
  try {
    const parsed = JSON.parse(authResult.stdout);
    loggedIn = parsed?.loggedIn === true;
  } catch {
    loggedIn = false;
  }
  if (!loggedIn) {
    return {
      ok: false,
      reason: "claude-not-authenticated",
      notice:
        "claude is not authenticated (run `claude auth login` or `claude auth status`)",
    };
  }
  return { ok: true, version };
}

function defaultExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Free precondition check — the child needs the global agent definitions
 * flow install materializes at `~/.flow/claude-home/.claude/skills/flow-module-core/agents/`,
 * which `bin/skill-md-lint.test.ts`'s agent-presence probes read from this
 * exact path.
 */
export function probeFlowInstall(
  exists: (p: string) => boolean = defaultExists,
  home: string = os.homedir(),
): ClaudeAvailability {
  const agentsDir = path.join(
    home,
    ".flow",
    "claude-home",
    ".claude",
    "skills",
    "flow-module-core",
    "agents",
  );
  if (!exists(agentsDir)) {
    return {
      ok: false,
      reason: "flow-not-installed",
      notice: "flow is not installed (run `flow install` first)",
    };
  }
  return { ok: true, version: "" };
}

export function renderPrompt(
  scenario: ResolvedScenario,
  fixture: MaterializedFixture,
  readFile: (p: string) => string,
): string {
  const blocks: string[] = [];
  for (const rel of scenario.preload ?? []) {
    const content = readFile(path.join(scenario.dir, rel));
    blocks.push(
      `<eval-context name="${path.basename(rel)}">\n${content}\n</eval-context>`,
    );
  }

  let seedPrefix = "";
  if (scenario.promptSeed === "resume") {
    seedPrefix = resumeSeedFor(fixture.slug, "feature") + "\n\n";
  } else if (scenario.promptSeed === "terminal") {
    const rawState = readFile(statePath(fixture.slug, fixture.stateDir));
    const state = JSON.parse(rawState) as {
      phase: string;
      repo: string;
      worktree?: string;
      pr?: number;
    };
    let body = "";
    try {
      body = readFile(checkpointBodyPath(fixture.slug, fixture.stateDir));
    } catch {
      body = "";
    }
    seedPrefix =
      terminalCarryOver(fixture.slug, state.phase, "feature", body) +
      "\n\n" +
      terminalContinueSeed(fixture.slug, state.phase, "feature", {
        repo: state.repo,
        worktree: state.worktree,
        pr: state.pr,
      }) +
      "\n\n";
  }

  const promptBody = readFile(path.join(scenario.dir, scenario.prompt)).replace(
    /\$REPO\b/g,
    fixture.repoDir,
  );

  return [...blocks, seedPrefix + promptBody]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

export function buildChildArgv(
  scenario: ResolvedScenario,
  fixture: MaterializedFixture,
  opts: {
    claudeBin: string;
    sessionId: string;
    prompt: string;
    resultSchema?: unknown;
    model?: string;
    keepSessions?: boolean;
  },
): string[] {
  return [
    opts.claudeBin,
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--add-dir",
    fixture.claudeHome,
    ...pluginDirArgs(fixture.pluginRoots),
    "--setting-sources",
    "project",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    scenario.allowedTools.join(","),
    "--max-budget-usd",
    String(scenario.maxBudgetUsd),
    "--session-id",
    opts.sessionId,
    ...(opts.keepSessions ? [] : ["--no-session-persistence"]),
    ...(opts.resultSchema
      ? ["--json-schema", JSON.stringify(opts.resultSchema)]
      : []),
    ...(opts.model ? ["--model", opts.model] : []),
  ];
}

const ENV_STRIP = ["FLOW_SLUG", "TMUX_PANE", "CLAUDECODE"] as const;

export function buildChildEnv(
  scenario: ResolvedScenario,
  fixture: MaterializedFixture,
  base: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if ((ENV_STRIP as readonly string[]).includes(k)) continue;
    env[k] = v;
  }
  env.FLOW_PIPELINE = "1";
  env.FLOW_EVAL_FIXTURE = fixture.repoDir;
  if (scenario.env?.flowSlug) {
    env.FLOW_SLUG = fixture.slug;
  }
  const currentPath = `${fixture.shimDir}:${base.PATH ?? ""}`;
  env.PATH =
    withPluginPath(pluginBinPath(fixture.pluginRoots), currentPath) ??
    currentPath;
  return env;
}

export type SpawnFn = (
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  onStdout: (chunk: string) => void,
) => { exited: Promise<number>; kill: () => void };

const defaultSpawn: SpawnFn = (argv, env, cwd, onStdout) => {
  const child = spawnAsync(argv[0], argv.slice(1), {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => onStdout(chunk.toString()));
  const exited = new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? -1));
    child.on("error", () => resolve(-1));
  });
  return {
    exited,
    kill: () => {
      child.kill();
    },
  };
};

export type RunOutcome = {
  exitCode: number;
  timedOut: boolean;
  streamPath: string;
  events: StreamEvent[];
  result: ResultEnvelope | null;
  error?: string;
};

export async function runScenarioOnce(
  scenario: ResolvedScenario,
  fixture: MaterializedFixture,
  opts: {
    claudeBin: string;
    outDir: string;
    sessionId: string;
    resultSchema?: unknown;
    model?: string;
    keepSessions?: boolean;
    spawn?: SpawnFn;
    readFile?: (p: string) => string;
  },
): Promise<RunOutcome> {
  const readFile = opts.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const spawn = opts.spawn ?? defaultSpawn;

  fs.mkdirSync(opts.outDir, { recursive: true });
  const prompt = renderPrompt(scenario, fixture, readFile);
  fs.writeFileSync(path.join(opts.outDir, "prompt.txt"), prompt);

  const argv = buildChildArgv(scenario, fixture, {
    claudeBin: opts.claudeBin,
    sessionId: opts.sessionId,
    prompt,
    resultSchema: opts.resultSchema,
    model: opts.model,
    keepSessions: opts.keepSessions,
  });
  const env = buildChildEnv(scenario, fixture, process.env);

  let out = "";
  const child = spawn(argv, env, fixture.repoDir, (chunk) => {
    out += chunk;
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, scenario.timeoutSec * 1000);
  const exitCode = await child.exited;
  clearTimeout(timer);

  const streamPath = path.join(opts.outDir, "stream.jsonl");
  fs.writeFileSync(streamPath, out);

  const { events, result } = parseStream(out);
  const error = result?.is_error ? (result.subtype ?? "error") : undefined;

  return {
    exitCode,
    timedOut,
    streamPath,
    events,
    result,
    ...(error ? { error } : {}),
  };
}
