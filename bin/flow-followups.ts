#!/usr/bin/env bun
/**
 * Local follow-ups: register and (where safe) execute manual local-computer
 * steps a pipeline produces — e.g. `flow install --upgrade` after a new helper
 * lands. Step 11 of `/flow-pipeline` invokes `run` on the MERGED path
 * (executes allowlisted+auto entries) and `run --note-only` on GATED /
 * NEEDS HUMAN paths (lists without executing). Sub-skills register entries
 * via `add` during steps 5–8.
 *
 * Two-layer safety boundary:
 *   1. Entry's `auto: true` flag declares intent to run.
 *   2. Hardcoded ALLOWLIST gates permission (exact-match command string).
 * Both must be true for execution; everything else is noted only. Same
 * narrow-and-named exemption pattern as the `/pr-review` auto-push and
 * `/flow-pipeline` auto-merge clauses in AGENTS.md "Don'ts".
 *
 * Storage: append-only JSONL at <worktree>/.flow-tmp/local-followups.jsonl.
 * Dies with the worktree when `flow-remove-worktree` runs after step 11;
 * not persisted to ~/.flow/state — follow-ups are pipeline-scoped.
 *
 * Usage:
 *   flow-followups add --command <cmd> --reason <why> [--auto]
 *                      [--id <id>] [--registered-by <label>] [--jsonl <path>]
 *   flow-followups run [--note-only] [--json] [--jsonl <path>]
 *   flow-followups pr-body-upsert <PR> [--jsonl <path>]
 *
 * Exit codes:
 *   0 — success (including no-op cases like an empty log).
 *   1 — gh / filesystem error during pr-body-upsert.
 *   2 — bad CLI args or missing required flags.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readState } from "./lib/state";
import { resolveSlugFromPane } from "./lib/tmux";
import { upsertPrBodySection } from "./lib/pr-body-upsert";

// Exact-match command strings the helper is permitted to execute when
// `auto: true` is also set. Expanding this list is a future PR — the narrow
// seed (post-merge skill/agent re-symlink) is the entire safety story for v1.
export const ALLOWLIST: ReadonlySet<string> = new Set([
  "flow install",
  "flow install --upgrade",
]);

const HEAD_LINES = 50;
const TAIL_LINES = 50;
const SECTION_HEADING = "## Local Follow-ups";

export type Entry = {
  id: string;
  command: string;
  reason: string;
  auto: boolean;
  registeredAt: string;
  registeredBy?: string;
};

export type ExecutedEntry = {
  id: string;
  command: string;
  exitCode: number;
  headExcerpt: string;
  tailExcerpt: string;
  totalLines: number;
};

export type NotedEntry = {
  id: string;
  command: string;
  reason: string;
  auto: boolean;
  autoDeniedBecause?: "not-in-allowlist" | "note-only-mode";
};

export type Verdict = {
  summary: { total: number; ran: number; noted: number; failed: number };
  ran: ExecutedEntry[];
  failed: ExecutedEntry[];
  noted: NotedEntry[];
};

export type Spawner = (
  argv: string[],
  options: { cwd?: string },
) => { stdout: string; stderr: string; exitCode: number };

export type GhRunner = (argv: string[]) => {
  stdout: string;
  stderr: string;
  exitCode: number;
};

// --- Path resolution ---

export type ResolveJsonlDeps = {
  resolveSlug?: () => string | null;
  readStateFn?: typeof readState;
  cwd?: () => string;
};

/**
 * Resolves the JSONL log path. Order:
 *   1. explicit `override` (CLI `--jsonl <path>`, used by tests),
 *   2. tmux pane → slug → state.json `.worktree`,
 *   3. cwd-relative fallback (when sub-skills have cd'd into the worktree).
 *
 * Returns the resolved path or null if no resolution succeeded. Callers
 * treat null as "no log to operate on" (run/upsert short-circuit; add
 * surfaces an error).
 */
export function resolveJsonlPath(
  override?: string,
  deps: ResolveJsonlDeps = {},
): string | null {
  if (override) return override;
  const resolveSlug = deps.resolveSlug ?? resolveSlugFromPane;
  const readSt = deps.readStateFn ?? readState;
  const slug = resolveSlug();
  if (slug) {
    const state = readSt(slug);
    if (state?.worktree) {
      return path.join(state.worktree, ".flow-tmp", "local-followups.jsonl");
    }
  }
  const getCwd = deps.cwd ?? (() => process.cwd());
  return path.join(getCwd(), ".flow-tmp", "local-followups.jsonl");
}

export function computeId(command: string, reason: string): string {
  return createHash("sha256")
    .update(`${command}\n${reason}`)
    .digest("hex")
    .slice(0, 12);
}

// --- JSONL I/O ---

/**
 * Reads and parses entries from the JSONL log, deduplicating by id (first
 * occurrence wins). Malformed lines are skipped silently — the append-only
 * model means a line could in theory be truncated mid-write, and ignoring is
 * safer than failing the whole pipeline.
 */
export function readEntries(jsonlPath: string): Entry[] {
  if (!fs.existsSync(jsonlPath)) return [];
  const text = fs.readFileSync(jsonlPath, "utf8");
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      typeof obj.id !== "string" ||
      typeof obj.command !== "string" ||
      typeof obj.reason !== "string"
    ) {
      continue;
    }
    if (seen.has(obj.id)) continue;
    seen.add(obj.id);
    entries.push({
      id: obj.id,
      command: obj.command,
      reason: obj.reason,
      auto: Boolean(obj.auto),
      registeredAt:
        typeof obj.registeredAt === "string" ? obj.registeredAt : "",
      registeredBy:
        typeof obj.registeredBy === "string" ? obj.registeredBy : undefined,
    });
  }
  return entries;
}

export function appendEntry(jsonlPath: string, entry: Entry): void {
  fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
  fs.appendFileSync(jsonlPath, JSON.stringify(entry) + "\n");
}

// --- Excerpt builder (mirrors flow-pre-commit's buildFailureExcerpt) ---

const ANSI_REGEX = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

export function buildExcerpt(rawOutput: string): {
  headExcerpt: string;
  tailExcerpt: string;
  totalLines: number;
} {
  const cleaned = stripAnsi(rawOutput);
  const lines = cleaned.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;
  if (totalLines <= HEAD_LINES + TAIL_LINES) {
    return { headExcerpt: lines.join("\n"), tailExcerpt: "", totalLines };
  }
  return {
    headExcerpt: lines.slice(0, HEAD_LINES).join("\n"),
    tailExcerpt: lines.slice(totalLines - TAIL_LINES).join("\n"),
    totalLines,
  };
}

// --- Verdict computation ---

const defaultSpawn: Spawner = (argv, options) => {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd,
    encoding: "utf8",
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };
};

export type RunOptions = {
  noteOnly?: boolean;
  spawn?: Spawner;
  homeDir?: string;
};

export function runEntries(
  entries: Entry[],
  options: RunOptions = {},
): Verdict {
  const noteOnly = options.noteOnly ?? false;
  const spawnFn = options.spawn ?? defaultSpawn;
  // Execute in $HOME, not the worktree: step 11 runs after merge but before
  // worktree removal, and home is the durable working directory for any
  // post-merge shell action.
  const cwd = options.homeDir ?? process.env.HOME ?? process.cwd();

  const ran: ExecutedEntry[] = [];
  const failed: ExecutedEntry[] = [];
  const noted: NotedEntry[] = [];

  for (const entry of entries) {
    if (noteOnly) {
      noted.push({
        id: entry.id,
        command: entry.command,
        reason: entry.reason,
        auto: entry.auto,
        autoDeniedBecause: entry.auto ? "note-only-mode" : undefined,
      });
      continue;
    }
    if (!entry.auto) {
      noted.push({
        id: entry.id,
        command: entry.command,
        reason: entry.reason,
        auto: false,
      });
      continue;
    }
    if (!ALLOWLIST.has(entry.command)) {
      noted.push({
        id: entry.id,
        command: entry.command,
        reason: entry.reason,
        auto: true,
        autoDeniedBecause: "not-in-allowlist",
      });
      continue;
    }
    const argv = entry.command.split(" ");
    const result = spawnFn(argv, { cwd });
    const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const excerpt = buildExcerpt(combined);
    const executedEntry: ExecutedEntry = {
      id: entry.id,
      command: entry.command,
      exitCode: result.exitCode,
      ...excerpt,
    };
    if (result.exitCode === 0) ran.push(executedEntry);
    else failed.push(executedEntry);
  }

  return {
    summary: {
      total: entries.length,
      ran: ran.length,
      noted: noted.length,
      failed: failed.length,
    },
    ran,
    failed,
    noted,
  };
}

// --- Human-readable rendering ---

export function formatVerdict(verdict: Verdict, noteOnly: boolean): string {
  if (verdict.summary.total === 0) return "";
  const lines: string[] = [];
  const headerLabel = noteOnly
    ? "LOCAL FOLLOW-UPS (deferred — PR not yet merged)"
    : "LOCAL FOLLOW-UPS";
  const counts = `${verdict.summary.ran} ran, ${verdict.summary.noted} noted, ${verdict.summary.failed} failed`;
  lines.push(`${headerLabel}: ${counts}`);
  lines.push("");

  for (const entry of verdict.ran) {
    lines.push(`  RAN     ${entry.command}  (exit ${entry.exitCode})`);
  }
  for (const entry of verdict.failed) {
    lines.push(`  FAIL    ${entry.command}  (exit ${entry.exitCode})`);
    const tail = entry.tailExcerpt || entry.headExcerpt;
    if (tail) {
      const tailLines = tail.split("\n").slice(-10);
      for (const ln of tailLines) lines.push(`            ${ln}`);
    }
  }
  for (const entry of verdict.noted) {
    const autoTag =
      entry.auto && entry.autoDeniedBecause !== "not-in-allowlist"
        ? " (auto)"
        : "";
    const denied =
      entry.autoDeniedBecause === "not-in-allowlist"
        ? " (auto-run denied: not in allowlist)"
        : "";
    lines.push(
      `  - [ ]   ${entry.command}  # ${entry.reason}${autoTag}${denied}`,
    );
  }
  return lines.join("\n");
}

// --- PR body section construction & upsert ---

export function buildPrBodySection(entries: Entry[]): string {
  const lines: string[] = [SECTION_HEADING, ""];
  for (const entry of entries) {
    let suffix = "";
    if (entry.auto && ALLOWLIST.has(entry.command)) suffix = " (auto)";
    else if (entry.auto) suffix = " (auto-run denied: not in allowlist)";
    lines.push(`- [ ] ${entry.command}  # ${entry.reason}${suffix}`);
  }
  return lines.join("\n");
}

// --- CLI arg parsing ---

type AddArgs = {
  command: string;
  reason: string;
  auto: boolean;
  id?: string;
  registeredBy?: string;
  jsonlOverride?: string;
};

export function parseAddArgs(argv: string[]): AddArgs | { error: string } {
  const out: Partial<AddArgs> = { auto: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--auto") {
      out.auto = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--command":
        out.command = value;
        break;
      case "--reason":
        out.reason = value;
        break;
      case "--id":
        out.id = value;
        break;
      case "--registered-by":
        out.registeredBy = value;
        break;
      case "--jsonl":
        out.jsonlOverride = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if (!out.command) return { error: "--command is required" };
  if (!out.reason) return { error: "--reason is required" };
  return out as AddArgs;
}

type RunArgs = {
  noteOnly: boolean;
  json: boolean;
  jsonlOverride?: string;
};

export function parseRunArgs(argv: string[]): RunArgs | { error: string } {
  const out: RunArgs = { noteOnly: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--note-only") {
      out.noteOnly = true;
      continue;
    }
    if (flag === "--json") {
      out.json = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    if (flag === "--jsonl") {
      out.jsonlOverride = value;
      i++;
      continue;
    }
    return { error: `unknown flag: ${flag}` };
  }
  return out;
}

type UpsertArgs = {
  pr: number;
  jsonlOverride?: string;
};

export function parseUpsertArgs(
  argv: string[],
): UpsertArgs | { error: string } {
  if (argv.length === 0) return { error: "PR number is required" };
  const first = argv[0];
  const pr = Number.parseInt(first, 10);
  if (!Number.isFinite(pr) || pr <= 0 || String(pr) !== first) {
    return { error: `PR must be a positive integer, got '${first}'` };
  }
  let jsonlOverride: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--jsonl") {
      if (value === undefined || value.startsWith("--")) {
        return { error: "--jsonl requires a value" };
      }
      jsonlOverride = value;
      i++;
      continue;
    }
    return { error: `unknown flag: ${flag}` };
  }
  return { pr, jsonlOverride };
}

// --- Subcommand runners ---

export type AddDeps = {
  resolveJsonl?: (override?: string) => string | null;
  now?: () => string;
};

export function runAdd(argv: string[], deps: AddDeps = {}): number {
  const parsed = parseAddArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-followups: ${parsed.error}`);
    console.error(
      "usage: flow-followups add --command <cmd> --reason <why> [--auto]\n" +
        "                         [--id <id>] [--registered-by <label>] [--jsonl <path>]",
    );
    return 2;
  }
  const resolve = deps.resolveJsonl ?? ((o?: string) => resolveJsonlPath(o));
  const now = deps.now ?? (() => new Date().toISOString());
  const jsonlPath = resolve(parsed.jsonlOverride);
  if (!jsonlPath) {
    console.error("flow-followups: could not resolve JSONL path");
    return 2;
  }
  const id = parsed.id ?? computeId(parsed.command, parsed.reason);
  const existing = readEntries(jsonlPath);
  if (existing.some((e) => e.id === id)) return 0;
  const entry: Entry = {
    id,
    command: parsed.command,
    reason: parsed.reason,
    auto: parsed.auto,
    registeredAt: now(),
    registeredBy: parsed.registeredBy,
  };
  appendEntry(jsonlPath, entry);
  return 0;
}

export type RunCmdDeps = {
  resolveJsonl?: (override?: string) => string | null;
  spawn?: Spawner;
  homeDir?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
};

export function runRun(argv: string[], deps: RunCmdDeps = {}): number {
  const parsed = parseRunArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-followups: ${parsed.error}`);
    console.error(
      "usage: flow-followups run [--note-only] [--json] [--jsonl <path>]",
    );
    return 2;
  }
  const resolve = deps.resolveJsonl ?? ((o?: string) => resolveJsonlPath(o));
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const err = deps.err ?? ((s: string) => process.stderr.write(s));
  const jsonlPath = resolve(parsed.jsonlOverride);
  const entries = jsonlPath ? readEntries(jsonlPath) : [];
  const verdict = runEntries(entries, {
    noteOnly: parsed.noteOnly,
    spawn: deps.spawn,
    homeDir: deps.homeDir,
  });
  // Surface allowlist denials to stderr so users see why an `auto: true`
  // entry was downgraded to noted. The JSON verdict already carries
  // `autoDeniedBecause`, but the human path needs an explicit warning —
  // otherwise a misconfigured registration silently fails to auto-run.
  for (const n of verdict.noted) {
    if (n.autoDeniedBecause === "not-in-allowlist") {
      err(
        `flow-followups: '${n.command}' has auto: true but is not in the allowlist; noted only.\n`,
      );
    }
  }
  if (parsed.json) {
    out(JSON.stringify(verdict) + "\n");
  } else {
    const formatted = formatVerdict(verdict, parsed.noteOnly);
    if (formatted) out(formatted + "\n");
  }
  return 0;
}

export type UpsertDeps = {
  resolveJsonl?: (override?: string) => string | null;
  gh?: GhRunner;
  tmpDirFactory?: () => string;
};

const defaultGh: GhRunner = (argv) => {
  const r = spawnSync("gh", argv, { encoding: "utf8" });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };
};

export function runUpsert(argv: string[], deps: UpsertDeps = {}): number {
  const parsed = parseUpsertArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-followups: ${parsed.error}`);
    console.error("usage: flow-followups pr-body-upsert <PR> [--jsonl <path>]");
    return 2;
  }
  const resolve = deps.resolveJsonl ?? ((o?: string) => resolveJsonlPath(o));
  const jsonlPath = resolve(parsed.jsonlOverride);
  const entries = jsonlPath ? readEntries(jsonlPath) : [];
  if (entries.length === 0) return 0;

  const gh = deps.gh ?? defaultGh;
  const view = gh([
    "pr",
    "view",
    String(parsed.pr),
    "--json",
    "body",
    "--jq",
    ".body",
  ]);
  if (view.exitCode !== 0) {
    console.error(`flow-followups: gh pr view failed: ${view.stderr.trim()}`);
    return 1;
  }
  const currentBody = view.stdout;
  const section = buildPrBodySection(entries);
  const newBody = upsertPrBodySection(currentBody, SECTION_HEADING, section);
  if (newBody === currentBody) return 0;

  const tmpDirFactory =
    deps.tmpDirFactory ??
    (() => fs.mkdtempSync(path.join(os.tmpdir(), "flow-followups-")));
  const tmpDir = tmpDirFactory();
  const tmpFile = path.join(tmpDir, "body.md");
  fs.writeFileSync(tmpFile, newBody);
  try {
    const edit = gh(["pr", "edit", String(parsed.pr), "--body-file", tmpFile]);
    if (edit.exitCode !== 0) {
      console.error(`flow-followups: gh pr edit failed: ${edit.stderr.trim()}`);
      return 1;
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  return 0;
}

// --- Top-level dispatcher ---

export function run(argv: string[]): number {
  if (argv.length === 0) {
    console.error(
      "flow-followups: subcommand is required (add | run | pr-body-upsert)",
    );
    return 2;
  }
  const [sub, ...rest] = argv;
  switch (sub) {
    case "add":
      return runAdd(rest);
    case "run":
      return runRun(rest);
    case "pr-body-upsert":
      return runUpsert(rest);
    default:
      console.error(`flow-followups: unknown subcommand '${sub}'`);
      return 2;
  }
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
