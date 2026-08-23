/**
 * Availability probes, child argv/env builders, prompt rendering, and the
 * single-run child-process driver for `flow-eval`. `node:child_process`
 * only — NEVER `Bun.spawn`, which is undefined under vitest's Node-hosted
 * process. Mirrors `bin/flow-plugin-contract-lint.ts`'s
 * `commandOnPath`/`runClaude` availability discipline, minus the `HOME`
 * override: an eval child deliberately stays authenticated against the
 * maintainer's real account (see `buildChildEnv` below) rather than
 * running under an isolated `HOME`, since the point of the harness is to
 * exercise a session the way a real launched pipeline would.
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
import { pluginBinPath, pluginDirArgs } from "./plugin-root";
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
    effort?: string;
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
    // The child runs as an unattended agent under `--permission-mode
    // dontAsk`, with the maintainer's real account, real HOME, and real
    // node_modules (see `linkNodeModules` in eval-fixture.ts). This
    // fixed deny-list bounds that blast radius against the highest-harm
    // shell actions regardless of what any single scenario's
    // `allowedTools` grants — it is not a substitute for a tight
    // `allowedTools` list, which each scenario still owns.
    "--disallowedTools",
    "Bash(git push:*),Bash(gh pr merge:*),Bash(gh pr create:*),Bash(gh pr close:*),Bash(gh release:*),Bash(rm -rf node_modules*)",
    "--max-budget-usd",
    String(scenario.maxBudgetUsd),
    "--session-id",
    opts.sessionId,
    ...(opts.keepSessions ? [] : ["--no-session-persistence"]),
    ...(opts.resultSchema
      ? ["--json-schema", JSON.stringify(opts.resultSchema)]
      : []),
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.effort ? ["--effort", opts.effort] : []),
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
  // Prepend (not append) the fixture's own plugin bin/ ahead of the
  // inherited PATH: the eval child must resolve flow helpers from the
  // checkout under evaluation, not fall through to whatever `~/.local/bin`
  // symlinks the maintainer's shell already has on PATH. `withPluginPath`
  // (append-only) is the right shape for a live flow session's own PATH
  // extension elsewhere; a hermetic eval child needs the opposite order.
  const pluginBin = pluginBinPath(fixture.pluginRoots);
  env.PATH = [fixture.shimDir, pluginBin, base.PATH ?? ""]
    .filter((seg) => seg.length > 0)
    .join(":");
  return env;
}

export type SpawnFn = (
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  onStdout: (chunk: string) => void,
  onStderr?: (chunk: string) => void,
) => { exited: Promise<number>; kill: () => void };

// A child that never has its stderr pipe drained blocks writing to it once
// the OS pipe buffer fills, and stays blocked until `timeoutSec` kills it —
// so stderr is always drained here, even when the caller doesn't pass
// `onStderr` (the events still fire; the drain just has nowhere else to go).
const SIGKILL_GRACE_MS = 5_000;

const defaultSpawn: SpawnFn = (argv, env, cwd, onStdout, onStderr) => {
  const child = spawnAsync(argv[0], argv.slice(1), {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => onStdout(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => onStderr?.(chunk.toString()));
  const exited = new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? -1));
    child.on("error", () => resolve(-1));
  });
  return {
    exited,
    kill: () => {
      child.kill("SIGTERM");
      const escalate = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, SIGKILL_GRACE_MS);
      escalate.unref();
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
    effort?: string;
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
    effort: opts.effort,
    keepSessions: opts.keepSessions,
  });
  const env = buildChildEnv(scenario, fixture, process.env);

  let out = "";
  let stderrOut = "";
  const child = spawn(
    argv,
    env,
    fixture.repoDir,
    (chunk) => {
      out += chunk;
    },
    (chunk) => {
      stderrOut += chunk;
    },
  );

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, scenario.timeoutSec * 1000);
  const exitCode = await child.exited;
  clearTimeout(timer);

  const streamPath = path.join(opts.outDir, "stream.jsonl");
  fs.writeFileSync(streamPath, out);
  if (stderrOut) {
    fs.writeFileSync(path.join(opts.outDir, "stderr.txt"), stderrOut);
  }

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
