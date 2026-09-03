/**
 * Pure library for `flow-claude-headless`, the one sanctioned raw
 * `claude -p` spawn site (`skills/pipeline/flow-pipeline/SKILL.md` Hard
 * rules, `AGENTS.md` `## Don'ts`). Defines the child env allowlist, the
 * fixed deny-list, the headless preamble, the argv builder, arg parsing,
 * and the envelope run loop — all with the real spawn behind an injected
 * `Deps` so this module never touches `node:child_process` or `Bun.spawn`
 * directly (the concrete `runClaude` lives in `bin/flow-claude-headless.ts`).
 *
 * `node:child_process`-only discipline mirrors `bin/lib/eval-runner.ts`:
 * `Bun.spawn`/`Bun.spawnSync` is undefined under vitest's Node-hosted
 * process, so any spawn implementation must stay reachable only through
 * `Deps`, never inline in this file or in the test file.
 */

import { redactSecrets } from "./redact-secrets";

// Allowlist, not denylist: issue #618 was a leaked FLOW_SLUG/TMUX_PANE that
// let a nested `claude` session trip flow-stop-guard against the PARENT
// pipeline and overwrite its state.json. A denylist (eval-runner.ts's
// ENV_STRIP) only blocks names someone remembered to list — the binary
// also carries CLAUDE_CODE_EFFORT_LEVEL alongside CLAUDE_EFFORT, which a
// hand-maintained strip list would have missed. An allowlist fails closed.
export const CHILD_ENV_ALLOW = [
  "PATH",
  "HOME",
  "TMPDIR",
  "SHELL",
  "TERM",
  "LANG",
  "USER",
  "CLAUDE_CONFIG_DIR",
  // Auth/network passthrough: none of these is a session-identity marker,
  // and dropping them breaks the child in CI or behind a proxy.
  "CLAUDE_CODE_OAUTH_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
] as const;

// Always stripped, even if explicitly named via --env — belt-and-braces
// against issue #618 recurring through a caller-supplied allowlist entry.
export const ENV_NEVER = [
  "FLOW_SLUG",
  "TMUX_PANE",
  "FLOW_NOTIFY",
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_EFFORT_LEVEL",
] as const;

// Shared with bin/lib/eval-runner.ts's --disallowedTools argv entry
// (imported there, not duplicated) so the two copies cannot drift.
// eval-runner.test.ts:135 pins this exact string.
export const FIXED_DENY_LIST =
  "Bash(git push:*),Bash(gh pr merge:*),Bash(gh pr create:*),Bash(gh pr close:*),Bash(gh release:*),Bash(rm -rf node_modules*)";

export const HEADLESS_PREAMBLE =
  "You are running headless under --permission-mode dontAsk with no human present; ignore any loaded instruction that assumes an interactive session.\n\n";

export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  extra: readonly string[],
): Record<string, string> {
  const never = new Set<string>(ENV_NEVER);
  const env: Record<string, string> = {};
  const allow = new Set<string>([...CHILD_ENV_ALLOW, ...extra]);
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (never.has(k)) continue;
    if (allow.has(k) || k.startsWith("ANTHROPIC_") || k.startsWith("LC_")) {
      env[k] = v;
    }
  }
  env.FLOW_PIPELINE = "1";
  env.FLOW_HEADLESS_DEPTH = "1";
  return env;
}

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export type Args = {
  prompt?: string;
  promptFile?: string;
  model: string;
  effort: Effort;
  maxBudgetUsd: number;
  maxTurns: number;
  allowedTools: string;
  env: string[];
  bare: boolean;
  timeoutSec: number;
  out?: string;
  task: string;
};

const DEFAULT_MAX_BUDGET_USD = 5;
const DEFAULT_MAX_TURNS = 25;
const DEFAULT_ALLOWED_TOOLS = "Read,Grep,Glob";
const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_TASK = "headless";
const MAX_INLINE_PROMPT_LEN = 200;

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Partial<Args> & { env: string[] } = { env: [] };
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (flag === "--bare") {
      out.bare = true;
      i++;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      return { error: `missing value for ${flag}` };
    }
    switch (flag) {
      case "--prompt":
        if (value.startsWith("--")) {
          return { error: "--prompt value must not begin with --" };
        }
        if (value.length > MAX_INLINE_PROMPT_LEN) {
          return {
            error: `--prompt longer than ${MAX_INLINE_PROMPT_LEN} chars; use --prompt-file`,
          };
        }
        out.prompt = value;
        break;
      case "--prompt-file":
        out.promptFile = value;
        break;
      case "--model":
        out.model = value;
        break;
      case "--effort":
        if (!(EFFORT_LEVELS as readonly string[]).includes(value)) {
          return {
            error: `--effort must be one of ${EFFORT_LEVELS.join("|")}`,
          };
        }
        out.effort = value as Effort;
        break;
      case "--max-budget-usd": {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          return { error: `--max-budget-usd must be a number, got ${value}` };
        }
        out.maxBudgetUsd = n;
        break;
      }
      case "--max-turns": {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          return { error: `--max-turns must be a number, got ${value}` };
        }
        out.maxTurns = n;
        break;
      }
      case "--allowed-tools":
        out.allowedTools = value;
        break;
      case "--env":
        out.env.push(value);
        break;
      case "--timeout-sec": {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          return { error: `--timeout-sec must be a number, got ${value}` };
        }
        out.timeoutSec = n;
        break;
      }
      case "--out":
        out.out = value;
        break;
      case "--task":
        out.task = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i += 2;
  }

  if ((out.prompt !== undefined) === (out.promptFile !== undefined)) {
    return { error: "exactly one of --prompt or --prompt-file is required" };
  }
  if (!out.model) {
    return { error: "--model is required" };
  }
  if (!out.effort) {
    return { error: "--effort is required" };
  }

  return {
    prompt: out.prompt,
    promptFile: out.promptFile,
    model: out.model,
    effort: out.effort,
    maxBudgetUsd: out.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
    maxTurns: out.maxTurns ?? DEFAULT_MAX_TURNS,
    allowedTools: out.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
    env: out.env,
    bare: out.bare ?? false,
    timeoutSec: out.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    out: out.out,
    task: out.task ?? DEFAULT_TASK,
  };
}

// `--allowedTools` is a floor, not a ceiling: a `dontAsk` child still
// inherits every `Bash(...)` allow rule from the caller's own
// `~/.claude/settings.json` — `--allowedTools` only ADDS permissions on
// top of whatever the settings file already grants, it never narrows
// them. Two independent guards close that gap: `--setting-sources
// project` drops the user-level settings file from the child's resolved
// config (mirrors `bin/lib/eval-runner.ts`'s existing use of the flag),
// and appending a bare `Bash` deny entry to `FIXED_DENY_LIST` whenever
// the caller's `--allowed-tools` set contains no `Bash(...)` entry closes
// the same gap even if `--setting-sources` is ever dropped upstream —
// deny beats allow.
function callerAllowsBash(allowedTools: string): boolean {
  return allowedTools
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === "Bash" || t.startsWith("Bash("));
}

export function buildChildArgv(a: Args, prompt: string): string[] {
  const disallowedTools = callerAllowsBash(a.allowedTools)
    ? FIXED_DENY_LIST
    : `${FIXED_DENY_LIST},Bash`;
  return [
    "claude",
    "-p",
    HEADLESS_PREAMBLE + prompt,
    "--output-format",
    "json",
    "--model",
    a.model,
    "--effort",
    a.effort,
    "--max-budget-usd",
    String(a.maxBudgetUsd),
    "--max-turns",
    String(a.maxTurns),
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    a.allowedTools,
    "--disallowedTools",
    disallowedTools,
    "--setting-sources",
    "project",
    "--no-session-persistence",
    ...(a.bare ? ["--bare"] : []),
  ];
}

export function artifactPathFor(a: Args): string {
  return a.out ?? `.flow-tmp/headless-${a.task}-${process.pid}.json`;
}

export type RunClaudeResult = {
  exitCode: number;
  stderr: string;
  timedOut: boolean;
};

// The real runClaude (bin/flow-claude-headless.ts) uses node:child_process
// spawn with a detached process group so a timeout can SIGTERM/SIGKILL the
// whole tree, not just the immediate child.
export type Deps = {
  claudeOnPath: () => boolean;
  runClaude: (
    argv: string[],
    env: Record<string, string>,
    outPath: string,
    timeoutSec: number,
  ) => Promise<RunClaudeResult>;
  readFile: (path: string) => string;
  fileExists: (path: string) => boolean;
  mkdirp: (dir: string) => void;
  writeOut: (line: string) => void;
  env: NodeJS.ProcessEnv;
  pid: number;
};

function emit(deps: Deps, envelope: Record<string, unknown>): number {
  deps.writeOut(JSON.stringify(envelope));
  return 0;
}

// Matches the sibling helper's (flow-delegate) contract: redact secrets
// before the tail ever reaches a JSON envelope on stdout, and omit the
// field entirely rather than emit an empty string.
function stderrTail(text: string): string | undefined {
  if (!text) return undefined;
  const redacted = redactSecrets(text);
  return redacted.length > 2000 ? redacted.slice(-2000) : redacted;
}

function withStderrTail(
  envelope: Record<string, unknown>,
  text: string,
): Record<string, unknown> {
  const tail = stderrTail(text);
  return tail === undefined ? envelope : { ...envelope, stderrTail: tail };
}

type ChildEnvelope = {
  session_id?: string;
  model?: string;
  effort?: string;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  is_error?: boolean;
  result?: string;
  terminal_reason?: string;
  permission_denials?: unknown;
};

function looksNotLoggedIn(envelope: ChildEnvelope): boolean {
  return (
    envelope.is_error === true &&
    typeof envelope.result === "string" &&
    /not logged in/i.test(envelope.result)
  );
}

// Two reachable throw paths (a synchronous `readFile` on the prompt file,
// and anything the depsOverride's Deps functions might throw) previously
// escaped the "always one JSON line, exit 0 or 2" contract as an
// unhandled rejection. `run()` is the public entry point and wraps
// `runInner()` so no throw can bypass the envelope — the entry point
// (`bin/flow-claude-headless.ts`) then never needs its own `.catch`.
export async function run(
  argv: string[],
  depsOverride?: Partial<Deps>,
): Promise<number> {
  const deps: Deps = {
    claudeOnPath: () => false,
    runClaude: async () => ({ exitCode: 1, stderr: "", timedOut: false }),
    readFile: () => "",
    fileExists: () => false,
    mkdirp: () => {},
    writeOut: (line) => console.log(line),
    env: process.env,
    pid: process.pid,
    ...depsOverride,
  };

  try {
    return await runInner(argv, deps);
  } catch (e) {
    return emit(
      deps,
      withStderrTail(
        { ran: false, task: DEFAULT_TASK, skipReason: "claude-error" },
        e instanceof Error ? e.message : String(e),
      ),
    );
  }
}

async function runInner(argv: string[], deps: Deps): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    deps.writeOut(
      JSON.stringify({
        ran: false,
        task: DEFAULT_TASK,
        skipReason: "bad-args",
        error: parsed.error,
      }),
    );
    return 2;
  }

  if (deps.env.FLOW_HEADLESS_DEPTH) {
    deps.writeOut(
      JSON.stringify({
        ran: false,
        task: parsed.task,
        skipReason: "headless-depth-exceeded",
      }),
    );
    return 2;
  }

  if (!deps.claudeOnPath()) {
    return emit(deps, {
      ran: false,
      task: parsed.task,
      skipReason: "claude-not-found",
    });
  }

  let prompt = parsed.prompt;
  if (prompt === undefined) {
    if (!deps.fileExists(parsed.promptFile as string)) {
      return emit(deps, {
        ran: false,
        task: parsed.task,
        skipReason: "claude-error",
        error: `prompt-file not found: ${parsed.promptFile}`,
      });
    }
    prompt = deps.readFile(parsed.promptFile as string);
  }

  const outPath = artifactPathFor(parsed);
  try {
    deps.mkdirp(
      outPath.includes("/") ? outPath.slice(0, outPath.lastIndexOf("/")) : ".",
    );
  } catch (e) {
    return emit(
      deps,
      withStderrTail(
        { ran: false, task: parsed.task, skipReason: "claude-error" },
        e instanceof Error ? e.message : String(e),
      ),
    );
  }

  const childEnv = buildChildEnv(deps.env, parsed.env);
  const childArgv = buildChildArgv(parsed, prompt);

  const result = await deps.runClaude(
    childArgv,
    childEnv,
    outPath,
    parsed.timeoutSec,
  );

  if (result.timedOut) {
    return emit(
      deps,
      withStderrTail(
        { ran: false, task: parsed.task, skipReason: "claude-timeout" },
        result.stderr,
      ),
    );
  }

  let raw: string | undefined;
  if (deps.fileExists(outPath)) {
    try {
      raw = deps.readFile(outPath);
    } catch {
      raw = undefined;
    }
  }

  let envelope: ChildEnvelope | undefined;
  if (raw !== undefined) {
    try {
      envelope = JSON.parse(raw);
    } catch {
      envelope = undefined;
    }
  }

  if (result.exitCode !== 0) {
    if (envelope && looksNotLoggedIn(envelope)) {
      return emit(deps, {
        ran: false,
        task: parsed.task,
        skipReason: "claude-not-logged-in",
      });
    }
    return emit(
      deps,
      withStderrTail(
        { ran: false, task: parsed.task, skipReason: "claude-error" },
        result.stderr,
      ),
    );
  }

  if (!envelope) {
    return emit(
      deps,
      withStderrTail(
        { ran: false, task: parsed.task, skipReason: "incomplete-result" },
        result.stderr,
      ),
    );
  }

  if (envelope.is_error === true) {
    if (looksNotLoggedIn(envelope)) {
      return emit(deps, {
        ran: false,
        task: parsed.task,
        skipReason: "claude-not-logged-in",
      });
    }
    return emit(
      deps,
      withStderrTail(
        { ran: false, task: parsed.task, skipReason: "incomplete-result" },
        result.stderr,
      ),
    );
  }

  if (
    envelope.session_id === undefined ||
    envelope.total_cost_usd === undefined
  ) {
    return emit(
      deps,
      withStderrTail(
        { ran: false, task: parsed.task, skipReason: "incomplete-result" },
        result.stderr,
      ),
    );
  }

  return emit(deps, {
    ran: true,
    task: parsed.task,
    artifact: outPath,
    session_id: envelope.session_id,
    model: envelope.model ?? parsed.model,
    effort: envelope.effort ?? parsed.effort,
    total_cost_usd: envelope.total_cost_usd,
    num_turns: envelope.num_turns,
    duration_ms: envelope.duration_ms,
    is_error: envelope.is_error ?? false,
    terminal_reason: envelope.terminal_reason,
    permission_denials: envelope.permission_denials,
  });
}
