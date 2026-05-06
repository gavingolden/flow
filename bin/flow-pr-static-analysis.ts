#!/usr/bin/env bun
/**
 * Pre-digests deterministic facts (security, types, lint, coverage) for a PR
 * so `/pr-review`'s four review agents stop re-deriving the same low-level
 * findings from raw diff inspection on every run. Each lens shells out to
 * the consumer's already-installed tooling (semgrep, biome or eslint, tsc,
 * coverage report), parses native output into a unified `Finding` shape,
 * filters to PR-touched lines, and emits a single JSON envelope keyed by
 * lens. Lenses run sequentially today (the underlying spawnSync blocks the
 * event loop, so the Promise.all wrapper is structural, not concurrent —
 * follow-up to make them genuinely parallel: gh-issue #101).
 *
 * Usage:
 *   flow-pr-static-analysis <PR> [--min-confidence <n>] [--max-tool-timeout <sec>]
 *                                [--coverage-file <path>]
 *
 * Per-tool progress goes to STDERR so the final JSON on stdout is cleanly
 * capturable: `RESULT=$(flow-pr-static-analysis $PR)`.
 *
 * Output: a single JSON object on stdout when all lenses settle.
 *   {
 *     "security": Finding[],
 *     "types":    Finding[],
 *     "coverage": Finding[],
 *     "lint":     Finding[],
 *     "meta": {
 *       "security": LensMeta, "types": LensMeta,
 *       "coverage": LensMeta, "lint": LensMeta,
 *       "pr": number, "min_confidence": number, "duration_ms": number
 *     }
 *   }
 *
 * Exit codes:
 *   0 — facts computed (any lens may be skipped — that's still a verdict)
 *   2 — bad CLI args
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

// --- Types -----------------------------------------------------------------

export type LensName = "security" | "types" | "coverage" | "lint";

export type Severity = "error" | "warning" | "info";

export type Source =
  | "semgrep"
  | "biome"
  | "eslint"
  | "tsc"
  | "coverage";

export type Finding = {
  file: string;
  line: number;
  end_line?: number;
  rule_id: string;
  message: string;
  /** 0–100. Filtered against `--min-confidence` before emission. */
  confidence: number;
  severity?: Severity;
  source: Source;
};

export type LensMeta = {
  /** True iff the tool was found and executed (even if it returned no findings). */
  ran: boolean;
  /** Short kebab-case reason when `ran=false`. Stable enum so consumers can match. */
  skipped_reason?: string;
  tool_version?: string;
  duration_ms: number;
};

export type AnalysisResult = {
  security: Finding[];
  types: Finding[];
  coverage: Finding[];
  lint: Finding[];
  meta: {
    security: LensMeta;
    types: LensMeta;
    coverage: LensMeta;
    lint: LensMeta;
    pr: number;
    min_confidence: number;
    duration_ms: number;
  };
};

// --- Confidence mapping ----------------------------------------------------
// Single source of truth. The default `--min-confidence 80` filters soft
// signals automatically; agents see only what's likely to be a real finding.

const SEMGREP_CONFIDENCE: Record<string, number> = {
  ERROR: 95,
  WARNING: 80,
  INFO: 60,
};

const BIOME_CONFIDENCE: Record<string, number> = {
  error: 90,
  warning: 75,
  information: 60,
  info: 60,
};

const ESLINT_CONFIDENCE: Record<number, number> = {
  2: 90, // error
  1: 75, // warning
};

const TSC_CONFIDENCE = 100; // deterministic compiler output

const COVERAGE_UNCOVERED_CONFIDENCE = 85;

// --- Pure parsers ----------------------------------------------------------

/**
 * Parse `semgrep --json` output. The shape is `{results: [...]}` with each
 * result carrying `path`, `start.line`, `end.line`, `check_id`, `extra.severity`,
 * and `extra.message`. Extras vary by version; we read defensively.
 */
export function parseSemgrepJson(stdout: string): Finding[] {
  if (!stdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { results?: unknown }).results)
  ) {
    return [];
  }
  const results = (parsed as { results: unknown[] }).results;
  const out: Finding[] = [];
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const raw = r as {
      path?: string;
      start?: { line?: number };
      end?: { line?: number };
      check_id?: string;
      extra?: { severity?: string; message?: string };
    };
    if (
      typeof raw.path !== "string" ||
      typeof raw.start?.line !== "number" ||
      typeof raw.check_id !== "string"
    ) {
      continue;
    }
    const sev = raw.extra?.severity ?? "INFO";
    const confidence = SEMGREP_CONFIDENCE[sev] ?? 60;
    const finding: Finding = {
      file: raw.path,
      line: raw.start.line,
      rule_id: raw.check_id,
      message: raw.extra?.message ?? raw.check_id,
      confidence,
      severity: mapSemgrepSeverity(sev),
      source: "semgrep",
    };
    if (typeof raw.end?.line === "number" && raw.end.line > raw.start.line) {
      finding.end_line = raw.end.line;
    }
    out.push(finding);
  }
  return out;
}

function mapSemgrepSeverity(s: string): Severity {
  if (s === "ERROR") return "error";
  if (s === "WARNING") return "warning";
  return "info";
}

/**
 * Parse `biome check --reporter=json` output. Biome's JSON report has a
 * `diagnostics: [{location, severity, category, message}]` shape. The
 * location's file path may be absolute; the caller normalises against the
 * worktree.
 */
export function parseBiomeJson(stdout: string, worktree: string): Finding[] {
  if (!stdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { diagnostics?: unknown }).diagnostics)
  ) {
    return [];
  }
  const diags = (parsed as { diagnostics: unknown[] }).diagnostics;
  const out: Finding[] = [];
  for (const d of diags) {
    if (!d || typeof d !== "object") continue;
    const raw = d as {
      location?: {
        path?: { file?: string } | string;
        span?: [number, number] | { start?: { line?: number } };
        sourceCode?: string;
      };
      severity?: string;
      category?: string;
      message?: string | { content?: string };
      description?: string;
    };
    const file = extractBiomeFile(raw.location?.path);
    if (!file) continue;
    const line = extractBiomeLine(raw.location);
    if (line === null) continue;
    const sev = (raw.severity ?? "info").toLowerCase();
    const confidence = BIOME_CONFIDENCE[sev] ?? 60;
    const message =
      typeof raw.message === "string"
        ? raw.message
        : raw.message?.content ?? raw.description ?? raw.category ?? "biome diagnostic";
    out.push({
      file: relativise(file, worktree),
      line,
      rule_id: raw.category ?? "biome/unknown",
      message,
      confidence,
      severity: mapBiomeSeverity(sev),
      source: "biome",
    });
  }
  return out;
}

function extractBiomeFile(p: unknown): string | null {
  if (typeof p === "string") return p;
  if (p && typeof p === "object" && typeof (p as { file?: string }).file === "string") {
    return (p as { file: string }).file;
  }
  return null;
}

function extractBiomeLine(loc: unknown): number | null {
  if (!loc || typeof loc !== "object") return null;
  const l = loc as {
    span?: [number, number] | { start?: { line?: number } };
    sourceCode?: string;
  };
  // Modern biome: span is [byteStart, byteEnd] — derive line from sourceCode.
  if (Array.isArray(l.span) && typeof l.span[0] === "number" && typeof l.sourceCode === "string") {
    const prefix = l.sourceCode.slice(0, l.span[0]);
    return prefix.split("\n").length;
  }
  // Older biome: span.start.line.
  if (
    l.span &&
    !Array.isArray(l.span) &&
    typeof (l.span as { start?: { line?: number } }).start?.line === "number"
  ) {
    return (l.span as { start: { line: number } }).start.line;
  }
  return null;
}

function mapBiomeSeverity(s: string): Severity {
  if (s === "error") return "error";
  if (s === "warning") return "warning";
  return "info";
}

/**
 * Parse `eslint --format json` output. The shape is an array of file
 * results: `[{filePath, messages: [{line, ruleId, message, severity}]}]`.
 */
export function parseEslintJson(stdout: string, worktree: string): Finding[] {
  if (!stdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Finding[] = [];
  for (const f of parsed) {
    if (!f || typeof f !== "object") continue;
    const raw = f as {
      filePath?: string;
      messages?: Array<{
        line?: number;
        endLine?: number;
        ruleId?: string | null;
        message?: string;
        severity?: number;
      }>;
    };
    if (typeof raw.filePath !== "string" || !Array.isArray(raw.messages)) continue;
    for (const m of raw.messages) {
      if (typeof m.line !== "number") continue;
      const confidence = ESLINT_CONFIDENCE[m.severity ?? 0] ?? 60;
      const finding: Finding = {
        file: relativise(raw.filePath, worktree),
        line: m.line,
        rule_id: m.ruleId ?? "eslint/unknown",
        message: m.message ?? "eslint diagnostic",
        confidence,
        severity: m.severity === 2 ? "error" : "warning",
        source: "eslint",
      };
      if (typeof m.endLine === "number" && m.endLine > m.line) {
        finding.end_line = m.endLine;
      }
      out.push(finding);
    }
  }
  return out;
}

/**
 * Parse `tsc --noEmit --pretty false` stdout. Each diagnostic is a single
 * line: `path/to/file.ts(line,col): error TSnnnn: message`. Multi-line
 * diagnostics (rare; usually wrapped messages) are collapsed onto the
 * first line — we drop continuation lines because they don't carry their
 * own file:line.
 */
export function parseTscOutput(stdout: string, worktree: string): Finding[] {
  if (!stdout.trim()) return [];
  const out: Finding[] = [];
  const re = /^(.+?)\((\d+),\d+\): (error|warning) (TS\d+): (.+)$/;
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    const m = line.match(re);
    if (!m) continue;
    const [, file, lineNum, severityStr, code, message] = m;
    out.push({
      file: relativise(file, worktree),
      line: parseInt(lineNum, 10),
      rule_id: code,
      message,
      confidence: TSC_CONFIDENCE,
      severity: severityStr === "error" ? "error" : "warning",
      source: "tsc",
    });
  }
  return out;
}

/**
 * Parse a `coverage-final.json` (Istanbul/c8/vitest format). Each file is
 * keyed by absolute path with a `statementMap` and `s` (statement-hit
 * counts). We emit one finding per uncovered statement, dropping
 * out-of-bounds entries defensively.
 */
export function parseCoverageJson(content: string, worktree: string): Finding[] {
  if (!content.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const out: Finding[] = [];
  for (const [absFile, fileDataRaw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!fileDataRaw || typeof fileDataRaw !== "object") continue;
    const fd = fileDataRaw as {
      path?: string;
      statementMap?: Record<string, { start?: { line?: number }; end?: { line?: number } }>;
      s?: Record<string, number>;
    };
    const file = relativise(fd.path ?? absFile, worktree);
    const stmtMap = fd.statementMap ?? {};
    const hits = fd.s ?? {};
    for (const [stmtId, count] of Object.entries(hits)) {
      if (count > 0) continue;
      const stmt = stmtMap[stmtId];
      const startLine = stmt?.start?.line;
      if (typeof startLine !== "number") continue;
      const finding: Finding = {
        file,
        line: startLine,
        rule_id: "coverage/uncovered-statement",
        message: `Statement on line ${startLine} is not covered by any test.`,
        confidence: COVERAGE_UNCOVERED_CONFIDENCE,
        severity: "warning",
        source: "coverage",
      };
      const endLine = stmt?.end?.line;
      if (typeof endLine === "number" && endLine > startLine) {
        finding.end_line = endLine;
      }
      out.push(finding);
    }
  }
  return out;
}

// --- Diff scoping ----------------------------------------------------------

/**
 * Compute `{file -> Set<line>}` from a unified diff, tracking only NEW-file
 * line numbers from `+` markers (and incrementing past unchanged context).
 *
 * Why not include `-` lines: a finding on a removed line is a finding on
 * code that no longer exists — it cannot be "introduced by this PR". The
 * `/pr-review` "review only changes introduced by this PR" anti-pattern
 * is enforced here at the helper level, not in each agent's prompt.
 */
export function computeChangedLines(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let currentFile: string | null = null;
  let newLineNum = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      if (!result.has(currentFile)) result.set(currentFile, new Set());
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        newLineNum = parseInt(m[1], 10);
        inHunk = true;
      }
      continue;
    }
    if (!inHunk || currentFile === null) continue;
    if (line.startsWith("+")) {
      result.get(currentFile)!.add(newLineNum);
      newLineNum++;
    } else if (line.startsWith("-")) {
      // removed; don't increment new-file counter
    } else if (line.startsWith(" ") || line === "") {
      newLineNum++;
    }
    // "\ No newline at end of file" and other markers fall through.
  }

  // Drop files that ended up with no `+` lines (rename-only, mode-only).
  for (const [file, set] of result) {
    if (set.size === 0) result.delete(file);
  }
  return result;
}

/**
 * Filter a finding list to those falling on lines actually touched by the
 * PR. A finding's primary line must intersect the changed-lines set for
 * its file; if `end_line` is set the range overlap is checked.
 *
 * Pre-existing issues on untouched lines of touched files are dropped —
 * they're out of scope for "review only changes introduced by this PR".
 */
export function applyDiffScope(
  findings: Finding[],
  changedLines: Map<string, Set<number>>,
): Finding[] {
  if (changedLines.size === 0) return [];
  return findings.filter((f) => {
    const lines = changedLines.get(f.file);
    if (!lines) return false;
    if (f.end_line === undefined) return lines.has(f.line);
    for (let l = f.line; l <= f.end_line; l++) {
      if (lines.has(l)) return true;
    }
    return false;
  });
}

/**
 * Filter a finding list to those at or above the confidence threshold.
 */
export function applyConfidenceThreshold(findings: Finding[], min: number): Finding[] {
  if (min <= 0) return findings;
  return findings.filter((f) => f.confidence >= min);
}

// --- I/O wiring ------------------------------------------------------------

type CmdResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean };
type SpawnRunner = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => CmdResult;
export type GhRunner = (argv: string[]) => CmdResult;
type WhichFn = (cmd: string) => string | null;

const defaultSpawn: SpawnRunner = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
    timedOut: r.signal === "SIGTERM" || (r.error as NodeJS.ErrnoException)?.code === "ETIMEDOUT",
  };
};

const defaultGh: GhRunner = (argv) => {
  const r = spawnSync("gh", argv, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
    timedOut: false,
  };
};

const defaultWhich: WhichFn = (cmd) => {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? "").trim();
  return out.length > 0 ? out : null;
};

export type Deps = {
  spawn?: SpawnRunner;
  gh?: GhRunner;
  which?: WhichFn;
  readFile?: (p: string) => string | null;
  fileExists?: (p: string) => boolean;
  cwd?: string;
  now?: () => number;
  writeOut?: (s: string) => void;
  writeErr?: (s: string) => void;
};

// --- CLI -------------------------------------------------------------------

export type Args = {
  pr: number;
  minConfidence: number;
  maxToolTimeoutSec: number;
  coverageFile?: string;
};

const HELP_TEXT = `flow-pr-static-analysis — pre-digest static-analysis facts for /pr-review

Usage:
  flow-pr-static-analysis <PR> [options]

Options:
  --min-confidence <n>      Drop findings with confidence below n (0-100, default 80).
                            Set to 0 to disable filtering.
  --max-tool-timeout <sec>  Per-tool wall-clock cap (default 60). A tool that
                            exceeds this is skipped with reason 'timeout'.
  --coverage-file <path>    Path to coverage-final.json (default: auto-detect
                            coverage/coverage-final.json in the worktree).
  --help, -h                Show this help.

Output: a single JSON object on stdout when all four lenses settle. Per-tool
progress is on stderr so the JSON is cleanly capturable.

Exit codes:
  0  facts computed (any lens may be skipped)
  2  argument-parse error`;

export function parseArgs(argv: string[]): Args | { error: string } | { help: true } {
  if (argv.length === 0) return { error: "PR number is required" };
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [first, ...rest] = argv;
  if (first.startsWith("--")) {
    return { error: "PR number must be the first positional argument" };
  }
  const pr = Number.parseInt(first, 10);
  if (!Number.isFinite(pr) || pr <= 0 || String(pr) !== first) {
    return { error: `PR must be a positive integer, got '${first}'` };
  }
  const out: Args = { pr, minConfidence: 80, maxToolTimeoutSec: 60 };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    switch (flag) {
      case "--min-confidence": {
        if (!value || value.startsWith("--")) {
          return { error: "--min-confidence requires a value" };
        }
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 0 || n > 100 || String(n) !== value) {
          return { error: `--min-confidence must be an integer 0-100, got '${value}'` };
        }
        out.minConfidence = n;
        i++;
        continue;
      }
      case "--max-tool-timeout": {
        if (!value || value.startsWith("--")) {
          return { error: "--max-tool-timeout requires a value" };
        }
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n <= 0 || String(n) !== value) {
          return { error: `--max-tool-timeout must be a positive integer, got '${value}'` };
        }
        out.maxToolTimeoutSec = n;
        i++;
        continue;
      }
      case "--coverage-file":
        if (!value || value.startsWith("--")) {
          return { error: "--coverage-file requires a value" };
        }
        out.coverageFile = value;
        i++;
        continue;
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  return out;
}

// --- Lens runners (each returns the lens's findings + meta) ----------------

type LensRun = (
  args: Args,
  deps: Required<Pick<Deps, "spawn" | "which" | "readFile" | "fileExists" | "cwd" | "now" | "writeErr">>,
) => Promise<{ findings: Finding[]; meta: LensMeta }>;

function relativise(p: string, worktree: string): string {
  if (!path.isAbsolute(p)) return p;
  const rel = path.relative(worktree, p);
  return rel.startsWith("..") ? p : rel;
}

function timedSkip(start: number, reason: string): { findings: Finding[]; meta: LensMeta } {
  return {
    findings: [],
    meta: { ran: false, skipped_reason: reason, duration_ms: Date.now() - start },
  };
}

const runSecurityLens: LensRun = async (args, deps) => {
  const start = deps.now();
  const bin = deps.which("semgrep");
  if (!bin) return timedSkip(start, "semgrep-not-on-path");
  deps.writeErr("[security] running semgrep --json --severity ERROR\n");
  const r = deps.spawn(
    "semgrep",
    [
      "--json",
      "--quiet",
      "--severity",
      "ERROR",
      "--config",
      "p/security-audit",
      "--config",
      "p/secrets",
      ".",
    ],
    { cwd: deps.cwd, timeoutMs: args.maxToolTimeoutSec * 1000 },
  );
  if (r.timedOut) return timedSkip(start, "timeout");
  // semgrep exits 0 (no findings) or 1 (findings emitted) — both are "ran".
  // Anything else (2 = error, 7 = config) is a parse-error skip.
  if (r.exitCode !== 0 && r.exitCode !== 1) {
    return timedSkip(start, `semgrep-exit-${r.exitCode}`);
  }
  const findings = parseSemgrepJson(r.stdout);
  return {
    findings,
    meta: { ran: true, duration_ms: deps.now() - start },
  };
};

const runTypesLens: LensRun = async (args, deps) => {
  const start = deps.now();
  // Prefer plain tsconfig.json when present; otherwise pick the first
  // project-specific tsconfig (e.g. tsconfig.scripts.json, tsconfig.app.json).
  // flow's own repo only has tsconfig.scripts.json — without this fallback the
  // types lens silently skipped on the very repo it ships in.
  const tsconfig = resolveTsconfig(deps.cwd, deps.fileExists);
  if (!tsconfig) return timedSkip(start, "no-tsconfig");
  // Prefer locally-installed tsc to avoid surprise version drift; fall back
  // to PATH if neither exists.
  const localTsc = path.join(deps.cwd, "node_modules", ".bin", "tsc");
  let bin = deps.fileExists(localTsc) ? localTsc : deps.which("tsc");
  if (!bin) return timedSkip(start, "tsc-not-found");
  const projectArgs = tsconfig === "tsconfig.json" ? [] : ["-p", tsconfig];
  deps.writeErr(`[types] running ${bin} --noEmit --pretty false${projectArgs.length ? ` -p ${tsconfig}` : ""}\n`);
  const r = deps.spawn(bin, [...projectArgs, "--noEmit", "--pretty", "false"], {
    cwd: deps.cwd,
    timeoutMs: args.maxToolTimeoutSec * 1000,
  });
  if (r.timedOut) return timedSkip(start, "timeout");
  // tsc exit semantics (TypeScript wiki, "Exit codes"): 0 = clean,
  // 1 = command-line / configuration error, 2 = type errors emitted on stdout,
  // 3 = no input files. The PR-#99 review fix had 1 and 2 swapped — exit 2
  // is the normal "found type errors" path, not a catastrophic failure, and
  // the smoke test against gavingolden/econ-data#194 caught it. Treat 0 and 2
  // as "ran"; treat 1 and 3+ as catastrophic and skip with an explicit reason
  // so consumers see the failure rather than a silent zero-finding pass.
  if (r.exitCode !== 0 && r.exitCode !== 2) {
    return timedSkip(start, `tsc-exit-${r.exitCode}`);
  }
  const findings = parseTscOutput(r.stdout, deps.cwd);
  return { findings, meta: { ran: true, duration_ms: deps.now() - start } };
};

function resolveTsconfig(
  cwd: string,
  fileExists: (p: string) => boolean,
): string | null {
  if (fileExists(path.join(cwd, "tsconfig.json"))) return "tsconfig.json";
  // Common variants in repos that split typecheck scopes (scripts/app/test).
  const candidates = [
    "tsconfig.scripts.json",
    "tsconfig.app.json",
    "tsconfig.build.json",
    "tsconfig.base.json",
  ];
  for (const c of candidates) {
    if (fileExists(path.join(cwd, c))) return c;
  }
  return null;
}

const runLintLens: LensRun = async (args, deps) => {
  const start = deps.now();
  // Biome first. Detection: biome.json or biome.jsonc in cwd. If the binary
  // isn't available, fall through to eslint rather than skipping outright.
  const hasBiomeConfig =
    deps.fileExists(path.join(deps.cwd, "biome.json")) ||
    deps.fileExists(path.join(deps.cwd, "biome.jsonc"));
  if (hasBiomeConfig) {
    const localBiome = path.join(deps.cwd, "node_modules", ".bin", "biome");
    const bin = deps.fileExists(localBiome) ? localBiome : deps.which("biome");
    if (bin) {
      deps.writeErr(`[lint] running ${bin} check --reporter=json\n`);
      const r = deps.spawn(bin, ["check", "--reporter=json", "."], {
        cwd: deps.cwd,
        timeoutMs: args.maxToolTimeoutSec * 1000,
      });
      if (r.timedOut) return timedSkip(start, "timeout");
      // biome exits 0 (clean) or 1 (issues found); both ran.
      if (r.exitCode !== 0 && r.exitCode !== 1) {
        return timedSkip(start, `biome-exit-${r.exitCode}`);
      }
      return {
        findings: parseBiomeJson(r.stdout, deps.cwd),
        meta: { ran: true, duration_ms: deps.now() - start },
      };
    }
  }
  // Eslint fallback. Detection: eslint.config.{js,ts,mjs,cjs} or .eslintrc.*
  // or package.json#eslintConfig.
  const hasEslintConfig = detectEslintConfig(deps.cwd, deps.fileExists, deps.readFile);
  if (hasEslintConfig) {
    const localEslint = path.join(deps.cwd, "node_modules", ".bin", "eslint");
    const bin = deps.fileExists(localEslint) ? localEslint : deps.which("eslint");
    if (bin) {
      deps.writeErr(`[lint] running ${bin} --format json .\n`);
      const r = deps.spawn(bin, ["--format", "json", "."], {
        cwd: deps.cwd,
        timeoutMs: args.maxToolTimeoutSec * 1000,
      });
      if (r.timedOut) return timedSkip(start, "timeout");
      // eslint exit 0 = clean, 1 = lint findings emitted as JSON on stdout.
      // Exit 2 = fatal error (config error, parser crash) — JSON output is
      // typically empty and we'd otherwise report ran=true with [] findings,
      // masking a real configuration problem. Skip explicitly so consumers see it.
      if (r.exitCode !== 0 && r.exitCode !== 1) {
        return timedSkip(start, `eslint-exit-${r.exitCode}`);
      }
      return {
        findings: parseEslintJson(r.stdout, deps.cwd),
        meta: { ran: true, duration_ms: deps.now() - start },
      };
    }
  }
  return timedSkip(start, hasBiomeConfig || hasEslintConfig ? "linter-not-on-path" : "no-lint-config");
};

function detectEslintConfig(
  cwd: string,
  fileExists: (p: string) => boolean,
  readFile: (p: string) => string | null,
): boolean {
  const candidates = [
    "eslint.config.js",
    "eslint.config.ts",
    "eslint.config.mjs",
    "eslint.config.cjs",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yml",
    ".eslintrc.yaml",
    ".eslintrc",
  ];
  for (const c of candidates) {
    if (fileExists(path.join(cwd, c))) return true;
  }
  // package.json#eslintConfig
  const pkgRaw = readFile(path.join(cwd, "package.json"));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { eslintConfig?: unknown };
      if (pkg.eslintConfig && typeof pkg.eslintConfig === "object") return true;
    } catch {
      /* swallow */
    }
  }
  return false;
}

const runCoverageLens: LensRun = async (args, deps) => {
  const start = deps.now();
  const candidate =
    args.coverageFile ?? path.join(deps.cwd, "coverage", "coverage-final.json");
  if (!deps.fileExists(candidate)) {
    return timedSkip(start, "no-coverage-output");
  }
  const content = deps.readFile(candidate);
  if (content === null) return timedSkip(start, "coverage-read-failed");
  deps.writeErr(`[coverage] reading ${relativise(candidate, deps.cwd)}\n`);
  return {
    findings: parseCoverageJson(content, deps.cwd),
    meta: { ran: true, duration_ms: deps.now() - start },
  };
};

// --- Runner ---------------------------------------------------------------

export async function run(argv: string[], deps: Deps = {}): Promise<number> {
  const writeOut = deps.writeOut ?? ((s) => process.stdout.write(s));
  const writeErr = deps.writeErr ?? ((s) => process.stderr.write(s));

  const parsed = parseArgs(argv);
  if ("help" in parsed) {
    writeOut(HELP_TEXT + "\n");
    return 0;
  }
  if ("error" in parsed) {
    writeErr(`flow-pr-static-analysis: ${parsed.error}\n`);
    writeErr("usage: flow-pr-static-analysis <PR> [--min-confidence <n>] [--max-tool-timeout <sec>]\n");
    return 2;
  }

  const cwd = deps.cwd ?? process.cwd();
  const spawn = deps.spawn ?? defaultSpawn;
  const gh = deps.gh ?? defaultGh;
  const which = deps.which ?? defaultWhich;
  const readFile = deps.readFile ?? defaultReadFile;
  const fileExists = deps.fileExists ?? ((p) => fs.existsSync(p));
  const now = deps.now ?? (() => Date.now());

  const lensDeps = { spawn, which, readFile, fileExists, cwd, now, writeErr };
  const startAll = now();

  // Compute changed lines once via gh pr diff. If gh fails, every lens
  // collapses to empty findings (we can't diff-scope without a diff).
  const diffResult = gh(["pr", "diff", String(parsed.pr)]);
  if (diffResult.exitCode !== 0) {
    writeErr(`flow-pr-static-analysis: gh pr diff ${parsed.pr} failed: ${diffResult.stderr.trim() || "no stderr"}\n`);
    // Emit an envelope with every lens skipped so the consumer's JSON.parse
    // still works. The skipped_reason makes the failure visible.
    const empty = (reason: string): LensMeta => ({
      ran: false,
      skipped_reason: reason,
      duration_ms: 0,
    });
    const result: AnalysisResult = {
      security: [], types: [], coverage: [], lint: [],
      meta: {
        security: empty("gh-pr-diff-failed"),
        types: empty("gh-pr-diff-failed"),
        coverage: empty("gh-pr-diff-failed"),
        lint: empty("gh-pr-diff-failed"),
        pr: parsed.pr,
        min_confidence: parsed.minConfidence,
        duration_ms: now() - startAll,
      },
    };
    writeOut(JSON.stringify(result) + "\n");
    return 0;
  }
  const changedLines = computeChangedLines(diffResult.stdout);

  // Promise.all over four spawnSync-backed lens runners is structural, not
  // concurrent — each await resolves immediately because the work already
  // happened synchronously inside the lens runner. Follow-up to switch to
  // async spawn for genuine parallelism: gh-issue #101.
  const [security, types, coverage, lint] = await Promise.all([
    runSecurityLens(parsed, lensDeps),
    runTypesLens(parsed, lensDeps),
    runCoverageLens(parsed, lensDeps),
    runLintLens(parsed, lensDeps),
  ]);

  const filterAndScope = (findings: Finding[]): Finding[] =>
    applyConfidenceThreshold(applyDiffScope(findings, changedLines), parsed.minConfidence);

  const result: AnalysisResult = {
    security: filterAndScope(security.findings),
    types: filterAndScope(types.findings),
    coverage: filterAndScope(coverage.findings),
    lint: filterAndScope(lint.findings),
    meta: {
      security: security.meta,
      types: types.meta,
      coverage: coverage.meta,
      lint: lint.meta,
      pr: parsed.pr,
      min_confidence: parsed.minConfidence,
      duration_ms: now() - startAll,
    },
  };
  writeOut(JSON.stringify(result) + "\n");
  return 0;
}

function defaultReadFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
