#!/usr/bin/env bun
/**
 * Delegate a single prompt to a headless Antigravity (`agy`) session
 * running on the user's Google AI Ultra subscription quota, capturing the
 * model's stdout as an artifact file.
 *
 * Purpose: cost-arbitrage. Offload research / heavy reasoning to the
 * user's idle Ultra quota instead of burning Claude subscription credits.
 * The helper is OPTIONAL and opportunistic — when `agy` is absent, logged
 * out, or errors, it exits 0 with `{ran:false,skipReason}` so a caller can
 * fall back to an in-process Claude path rather than failing the pipeline.
 * Same "exit 2 = bad args, every runtime failure is a quiet exit-0 skip"
 * split as `flow-notify` / `flow-ui-validate`, and the same optional-tool
 * `skipReason` shape as `flow-pre-commit`.
 *
 * Verified agy contract (agy 1.0.x, 2026-06):
 * - Reliable headless invocation is `agy <flags> -p "<prompt>"` with the
 *   prompt as the FINAL token. A flag placed after `-p` is swallowed into
 *   the positional prompt, so buildAgyArgv appends the prompt last and a
 *   unit test guards that invariant.
 * - `--sandbox` (terminal restrictions) is always passed. In `-p` mode agy
 *   may block on a tool-permission prompt; `--skip-permissions` adds agy's
 *   `--dangerously-skip-permissions` for non-interactive tool-using runs.
 *   It is opt-in, not default: the repo is never added to agy's workspace,
 *   so even an auto-approving run cannot mutate it, but the default path
 *   stays the empirically-verified `--sandbox`-only invocation.
 * - agy's stdout is redirected to a real FILE (never a pipe — a non-TTY
 *   pipe can silently drop agy's output) and the file is the artifact.
 *   stdin is closed; agy needs no TTY on stdin.
 * - `--print-timeout <godur>` bounds the run and backstops the case where a
 *   logged-out agy blocks instead of failing fast.
 * - No `--model` is passed unless requested, deferring to the user's agy
 *   session default; hardcoding a variant string would rot on the next agy
 *   rename and silently force every run to skip. Research callers should
 *   pass `--model "Gemini 3.1 Pro (High)"` for Gemini diversity + arbitrage.
 *
 * Usage:
 *   flow-delegate (--prompt "<text>" | --prompt-file <path>)
 *                 [--model "<variant>"] [--timeout <godur>] [--skip-permissions]
 *                 [--add-dir <dir>]... [--out <path>] [--task <name>]
 *
 *   A prompt whose text literally begins with `--` (a CLI flag, a `---` YAML
 *   fence, a diff hunk header) is rejected by the missing-value guard; pass it
 *   via `--prompt-file` instead. Mirrors the `flow-notify` precedent.
 *
 * stdout is always a one-line JSON envelope:
 *   success: {"ran":true,"task":..,"model":..,"artifactPath":..,"exitCode":0,"durationMs":..}
 *   skip:    {"ran":false,"skipReason":"agy-not-found"|"agy-not-authenticated"|"agy-error",..}
 *
 * Exit codes:
 *   0 — delegated successfully, OR a quiet graceful skip (agy missing /
 *       logged out / errored). Callers branch on the `ran` field.
 *   2 — usage error (no/both prompt sources, unknown flag, missing value,
 *       unreadable --prompt-file).
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { parseStructured } from "./lib/structured-response";

const DEFAULT_TIMEOUT = "5m";
const DEFAULT_TASK = "default";

export type Args = {
  prompt?: string;
  promptFile?: string;
  model?: string;
  timeout: string;
  skipPermissions: boolean;
  addDirs: string[];
  out?: string;
  task: string;
  // "text" (default, unspecified) or "json" — passed straight through to
  // agy's `--output-format`, and also gates the duration_seconds/usage
  // envelope-lift in `run()`.
  outputFormat?: "text" | "json";
  // Path to a JSON-Schema file passed to agy's own `--json-schema` for
  // wire-level constrained decoding. Mutually exclusive with
  // structuredFallback — they are the two arms of the schema A/B.
  jsonSchema?: string;
  // Path to a JSON-Schema file used LOCALLY (never sent to agy): the schema
  // is inlined into the prompt as an instruction, and the response is
  // parsed/validated with `parseStructured`, retried once on failure.
  structuredFallback?: string;
};

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Partial<Args> & { addDirs: string[] } = { addDirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--skip-permissions") {
      out.skipPermissions = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--prompt":
        out.prompt = value;
        break;
      case "--prompt-file":
        out.promptFile = value;
        break;
      case "--model":
        out.model = value;
        break;
      case "--timeout":
        out.timeout = value;
        break;
      case "--add-dir":
        out.addDirs.push(value);
        break;
      case "--out":
        out.out = value;
        break;
      case "--task":
        out.task = value;
        break;
      case "--output-format":
        if (value !== "text" && value !== "json") {
          return { error: `--output-format must be "text" or "json"` };
        }
        out.outputFormat = value;
        break;
      case "--json-schema":
        out.jsonSchema = value;
        break;
      case "--structured-fallback":
        out.structuredFallback = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if ((out.prompt !== undefined) === (out.promptFile !== undefined)) {
    return { error: "exactly one of --prompt or --prompt-file is required" };
  }
  // --json-schema (wire-level, sent to agy) and --structured-fallback
  // (local parse-and-validate) are the two arms of the schema A/B and must
  // never coexist on one call.
  if (out.jsonSchema !== undefined && out.structuredFallback !== undefined) {
    return {
      error: "--json-schema and --structured-fallback are mutually exclusive",
    };
  }
  return {
    prompt: out.prompt,
    promptFile: out.promptFile,
    model: out.model,
    timeout: out.timeout ?? DEFAULT_TIMEOUT,
    skipPermissions: out.skipPermissions ?? false,
    addDirs: out.addDirs,
    out: out.out,
    task: out.task ?? DEFAULT_TASK,
    outputFormat: out.outputFormat,
    jsonSchema: out.jsonSchema,
    structuredFallback: out.structuredFallback,
  };
}

// Assemble the agy argv with the prompt as the FINAL token (load-bearing:
// a flag after the positional prompt is swallowed into the prompt text).
export function buildAgyArgv(args: Args, prompt: string): string[] {
  const argv: string[] = ["--sandbox", "--print-timeout", args.timeout];
  if (args.skipPermissions) argv.push("--dangerously-skip-permissions");
  if (args.model) argv.push("--model", args.model);
  for (const dir of args.addDirs) argv.push("--add-dir", dir);
  // --output-format / --json-schema must land BEFORE the trailing -p — a
  // flag placed after the positional prompt is swallowed into the prompt
  // text (see the module header). --structured-fallback contributes no agy
  // flag: it is a purely local parse-and-validate path.
  if (args.outputFormat) argv.push("--output-format", args.outputFormat);
  if (args.jsonSchema) argv.push("--json-schema", args.jsonSchema);
  argv.push("-p", prompt);
  return argv;
}

export function artifactPathFor(args: Args): string {
  return args.out ?? `.flow-tmp/delegate-${args.task}.md`;
}

// An auth failure is downgraded to a quieter, more actionable skipReason
// than a generic error so a caller can tell "log in to agy" apart from
// "the model run failed".
export function looksUnauthenticated(text: string): boolean {
  return /unauthenticat|not authenticated|not logged in|please log\s?in|sign in|auth(?:entication)? (?:required|failed)|reauthenticate/i.test(
    text,
  );
}

export type AgyResult = { exitCode: number; stderr: string };

export type Deps = {
  agyOnPath: () => boolean;
  // Runs `agy <argv>` with stdout redirected to outPath (a real file, not a
  // pipe) and stdin closed; returns the exit code and captured stderr.
  runAgy: (argv: string[], outPath: string) => AgyResult;
  readFile: (path: string) => string;
  fileExists: (path: string) => boolean;
  mkdirp: (dir: string) => void;
  now: () => number;
  writeOut: (line: string) => void;
};

function emit(deps: Deps, envelope: Record<string, unknown>): number {
  deps.writeOut(JSON.stringify(envelope));
  return 0;
}

// Reads outPath as a JSON envelope (the shape agy itself writes when
// `--output-format json` is set) and lifts its `duration_seconds` / `usage`
// fields. NEVER throws — an unreadable or unparseable artifact, or one that
// carries neither field, simply yields an empty projection.
function liftJsonEnvelope(
  deps: Deps,
  outPath: string,
): { durationSeconds?: number; usage?: Record<string, number> } {
  let raw: string;
  try {
    raw = deps.readFile(outPath);
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const obj = parsed as Record<string, unknown>;
  const lifted: { durationSeconds?: number; usage?: Record<string, number> } =
    {};
  if (typeof obj.duration_seconds === "number") {
    lifted.durationSeconds = obj.duration_seconds;
  }
  if (
    typeof obj.usage === "object" &&
    obj.usage !== null &&
    !Array.isArray(obj.usage)
  ) {
    lifted.usage = obj.usage as Record<string, number>;
  }
  return lifted;
}

// Re-reads outPath as the model's raw response text and validates it against
// the structured-fallback schema. NEVER throws — an unreadable artifact is
// reported as a parse failure, same as an unparseable response.
//
// In `--output-format json` mode, outPath holds the agy JSON ENVELOPE, not
// model prose (same contract as flow-model-bench.ts's fanout unwrap). Unwrap
// `.response` (preferring `.structured_output` when present) before
// validating, mirroring commit 46c0eb6's runner-side fix — without this, the
// envelope itself gets fed to parseStructured, which can never satisfy a
// fixture schema requiring model-authored keys, so every json-mode
// structured-fallback call retries once and fails identically.
function attemptStructuredParse(
  deps: Deps,
  outPath: string,
  schema: unknown,
  jsonMode: boolean,
): ReturnType<typeof parseStructured> {
  let text: string;
  try {
    text = deps.readFile(outPath);
  } catch {
    return {
      ok: false,
      reason: "could not read artifact for structured parse",
    };
  }
  if (jsonMode) {
    try {
      const envelope = JSON.parse(text) as Record<string, unknown>;
      if (
        envelope.structured_output !== undefined &&
        envelope.structured_output !== null
      ) {
        text = JSON.stringify(envelope.structured_output);
      } else if (typeof envelope.response === "string") {
        text = envelope.response;
      }
    } catch {
      // not an envelope (text mode / partial write) — fall through with the
      // raw text, same as before this fix.
    }
  }
  return parseStructured(text, schema);
}

export function run(argv: string[], depsOverride?: Partial<Deps>): number {
  const deps = resolveDeps(depsOverride);
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-delegate: ${parsed.error}`);
    console.error(
      "usage: flow-delegate (--prompt <text> | --prompt-file <path>) [--model <variant>] [--timeout <godur>] [--skip-permissions] [--add-dir <dir>]... [--out <path>] [--task <name>] [--output-format text|json] [--json-schema <path>] [--structured-fallback <path>]",
    );
    return 2;
  }

  let prompt = parsed.prompt;
  if (prompt === undefined) {
    if (!deps.fileExists(parsed.promptFile as string)) {
      console.error(
        `flow-delegate: prompt-file not found: ${parsed.promptFile}`,
      );
      return 2;
    }
    // fileExists is existence-only; an EACCES/EISDIR/TOCTOU read still
    // throws here. A bad --prompt-file is a usage/input error → exit 2,
    // consistent with the not-found branch above.
    try {
      prompt = deps.readFile(parsed.promptFile as string);
    } catch {
      console.error(
        `flow-delegate: cannot read prompt-file: ${parsed.promptFile}`,
      );
      return 2;
    }
  }

  // --structured-fallback reads its schema file locally (never sent to agy)
  // and inlines it into the prompt as an instruction. A missing/unreadable/
  // malformed schema file is a usage/input error → exit 2, mirroring the
  // --prompt-file precedent above.
  let structuredSchema: unknown;
  if (parsed.structuredFallback) {
    if (!deps.fileExists(parsed.structuredFallback)) {
      console.error(
        `flow-delegate: --structured-fallback schema file not found: ${parsed.structuredFallback}`,
      );
      return 2;
    }
    let schemaText: string;
    try {
      schemaText = deps.readFile(parsed.structuredFallback);
    } catch {
      console.error(
        `flow-delegate: cannot read --structured-fallback schema file: ${parsed.structuredFallback}`,
      );
      return 2;
    }
    try {
      structuredSchema = JSON.parse(schemaText);
    } catch {
      console.error(
        `flow-delegate: --structured-fallback schema file is not valid JSON: ${parsed.structuredFallback}`,
      );
      return 2;
    }
    prompt = `${prompt}\n\nRespond with a single JSON object matching this shape (no prose, no markdown fence):\n${schemaText.trim()}`;
  }

  // Graceful skip: agy not installed → caller falls back to Claude.
  if (!deps.agyOnPath()) {
    return emit(deps, {
      ran: false,
      skipReason: "agy-not-found",
      task: parsed.task,
    });
  }

  const outPath = artifactPathFor(parsed);
  // An unwritable --out dir is a usage/input error → exit 2.
  try {
    deps.mkdirp(dirname(outPath));
  } catch {
    console.error(
      `flow-delegate: cannot create output dir: ${dirname(outPath)}`,
    );
    return 2;
  }
  const start = deps.now();
  // A thrown spawn failure is a runtime failure → graceful exit-0 skip, per
  // the contract (callers branch on the `ran` field, not the exit code).
  let result: AgyResult;
  try {
    result = deps.runAgy(buildAgyArgv(parsed, prompt), outPath);
  } catch {
    return emit(deps, {
      ran: false,
      skipReason: "agy-error",
      task: parsed.task,
    });
  }

  if (result.exitCode !== 0) {
    const skipReason = looksUnauthenticated(result.stderr)
      ? "agy-not-authenticated"
      : "agy-error";
    return emit(deps, {
      ran: false,
      skipReason,
      task: parsed.task,
      exitCode: result.exitCode,
    });
  }

  // Schema-free fallback: parse-validate-retry-once. A retry spawn failure
  // is swallowed (never thrown) — the re-attempted parse against the stale
  // artifact simply stays failed, which is the correct twice-failed outcome.
  let parseRetries: number | undefined;
  let structuredParse: "ok" | "failed" | undefined;
  if (parsed.structuredFallback) {
    const jsonMode = parsed.outputFormat === "json";
    let attempt = attemptStructuredParse(
      deps,
      outPath,
      structuredSchema,
      jsonMode,
    );
    parseRetries = 0;
    if (!attempt.ok) {
      parseRetries = 1;
      try {
        deps.runAgy(buildAgyArgv(parsed, prompt), outPath);
      } catch {
        // fall through — attempt below re-reads the stale (or absent)
        // artifact and stays a failed parse, never a throw.
      }
      attempt = attemptStructuredParse(
        deps,
        outPath,
        structuredSchema,
        jsonMode,
      );
    }
    structuredParse = attempt.ok ? "ok" : "failed";
  }

  // Computed AFTER any structured-fallback retry so it covers the full
  // wall-clock cost of the call, including the retry.
  const durationMs = deps.now() - start;

  const envelope: Record<string, unknown> = {
    ran: true,
    task: parsed.task,
    model: parsed.model ?? null,
    artifactPath: outPath,
    exitCode: 0,
    durationMs,
  };
  if (parsed.outputFormat === "json") {
    const lifted = liftJsonEnvelope(deps, outPath);
    if (lifted.durationSeconds !== undefined) {
      envelope.durationSeconds = lifted.durationSeconds;
    }
    if (lifted.usage !== undefined) {
      envelope.usage = lifted.usage;
    }
  }
  if (parsed.structuredFallback) {
    envelope.structuredParse = structuredParse;
    envelope.parseRetries = parseRetries;
  }
  return emit(deps, envelope);
}

function defaultAgyOnPath(): boolean {
  // `which` exits 0 with a path on hit, non-zero on miss; only the exit
  // code matters.
  return (
    Bun.spawnSync(["which", "agy"], { stdout: "ignore", stderr: "ignore" })
      .exitCode === 0
  );
}

function defaultRunAgy(argv: string[], outPath: string): AgyResult {
  // Redirect stdout to a real FILE descriptor (never "pipe" — agy can
  // silently drop output to a non-TTY pipe). stdin closed: agy needs no TTY.
  const fd = openSync(outPath, "w");
  try {
    const r = Bun.spawnSync(["agy", ...argv], {
      stdin: "ignore",
      stdout: fd,
      stderr: "pipe",
    });
    const stderr = r.stderr ? new TextDecoder().decode(r.stderr) : "";
    return { exitCode: r.exitCode ?? 1, stderr };
  } finally {
    closeSync(fd);
  }
}

function resolveDeps(o?: Partial<Deps>): Deps {
  return {
    agyOnPath: o?.agyOnPath ?? defaultAgyOnPath,
    runAgy: o?.runAgy ?? defaultRunAgy,
    readFile: o?.readFile ?? ((p) => readFileSync(p, "utf8")),
    fileExists: o?.fileExists ?? ((p) => existsSync(p)),
    mkdirp: o?.mkdirp ?? ((d) => void mkdirSync(d, { recursive: true })),
    now: o?.now ?? (() => Date.now()),
    writeOut: o?.writeOut ?? ((line) => console.log(line)),
  };
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
