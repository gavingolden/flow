#!/usr/bin/env bun
/**
 * Runs verification checks with automatic scope detection.
 *
 * Detects which project areas have changes (src, scripts, docs) and runs
 * the appropriate checks for each. The `src`, `scripts`, and `root-fallback`
 * scopes additionally run `npm run lint` (a repo-wide `prettier --check .`);
 * filterDefinedChecks keeps it inert in repos with no `lint` script.
 *
 * Usage:
 *   flow-pre-commit                    # auto-detect from git diff
 *   flow-pre-commit --pr 126           # detect from PR changed files
 *   flow-pre-commit --scope src        # explicit scope
 *   flow-pre-commit --pre-push         # read refs from stdin (git hook)
 */

import { readFileSync } from "node:fs";

// --- Types ---

export type Scope = "src" | "scripts" | "docs" | "actions" | "backend" | "root-fallback";

export type ScopeMatcher = {
  prefixes?: string[];
  extensions?: string[];
  /**
   * When true and BOTH prefixes and extensions are defined, a file must match
   * at least one of each (AND). Default (undefined/false) keeps the legacy
   * OR-match: any prefix OR any extension is enough.
   */
  requireAll?: boolean;
};

export type CheckResult = {
  name: string;
  scope: Scope;
  passed: boolean;
  durationMs: number;
  output: string;
  /**
   * Set when a check was skipped instead of run (e.g. an optional external
   * tool is not installed on PATH). A skipped result is still counted as
   * `passed: true` so the overall gate doesn't fail; downstream renderers
   * use `skipReason` to surface it distinctly.
   */
  skipReason?: "actionlint-not-installed" | "go-not-installed";
};

export type CheckReport = {
  scopes: Scope[];
  results: CheckResult[];
  allPassed: boolean;
  /**
   * The file list scope detection saw, when available. Empty for the
   * `--scope <list>` path where the user named scopes explicitly and there
   * is no "changed files" diff to report. Used by formatReport to print
   * the per-scope enumeration so a no-op pass is loud rather than silent.
   */
  changedFiles?: string[];
  /**
   * Files in the diff that no SPECIFIC scope (src/scripts/docs) claimed.
   * Populated even when root-fallback fires — root-fallback is a sentinel
   * scope that doesn't claim files, so consumer-repo maintainers can see
   * which paths landed in the fallback bucket.
   */
  unmatchedFiles?: string[];
  /**
   * Set to "no-checks-defined" when a non-empty diff produces zero checks
   * because no matching npm scripts were defined in the consumer's
   * package.json. Used to override allPassed=true and emit a distinct
   * "No checks ran" message so the silent-pass hole is closed.
   */
  reason?: "no-checks-defined";
};

/**
 * Bounded failure excerpt emitted in `--json` mode. The point of this shape is
 * to keep the supervisor's context predictable: a 50–200 KB stack trace is
 * compressed to a few hundred lines max regardless of the underlying check's
 * verbosity. See `/flow-pipeline` step 6 for the consumer.
 */
export type FailureExcerpt = {
  /** 1-based index of `firstErrorText` within the un-ANSI'd output. */
  firstErrorLine: number | null;
  /** First line in the output matching the error/fail regex, ≤500 chars. */
  firstErrorText: string;
  /** First HEAD_LINES lines of the un-ANSI'd output. */
  headExcerpt: string;
  /** Last TAIL_LINES lines of the un-ANSI'd output. Empty when total ≤ HEAD+TAIL. */
  tailExcerpt: string;
  /** Total line count of the un-ANSI'd output before excerpting. */
  totalLines: number;
};

export type JsonResult = {
  name: string;
  scope: Scope;
  passed: boolean;
  durationMs: number;
  failure?: FailureExcerpt;
  skipReason?: "actionlint-not-installed" | "go-not-installed";
};

export type JsonReport = {
  scopes: Scope[];
  results: JsonResult[];
  allPassed: boolean;
  changedFiles?: string[];
  unmatchedFiles?: string[];
  reason?: "no-checks-defined";
};

const HEAD_LINES = 100;
const TAIL_LINES = 100;
const FIRST_ERROR_TEXT_MAX = 500;

export type PrePushRef = {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
};

export type GitOps = {
  mergeBase: (ref1: string, ref2: string) => string | null;
  diffFiles: (range: string) => string[];
  defaultBranch: () => string;
};

type CheckDef = {
  name: string;
  argv: string[];
};

// --- Constants ---

// Path-based scopes only — root-fallback is a sentinel scope (not a matcher)
// that fires when a non-empty diff produced no specific-scope matches.
const SPECIFIC_SCOPES: Exclude<Scope, "root-fallback">[] = ["src", "scripts", "docs", "actions", "backend"];
const ZERO_SHA = "0000000000000000000000000000000000000000";

// `scripts/` is the install location in target repos; `bin/` is the canonical
// source location for shipped helper binaries in flow itself; `templates/scripts/`
// holds the remaining orchestrator-only scripts and backward-compat symlinks;
// `.github/workflows/` holds reusable workflows + CI definitions whose
// regression tests live in `bin/`. All four trip the scripts scope so flow's
// own pre-commit run picks up workflow edits and runs the bin/ test suite
// (which includes workflow-shape regression tests against `.github/workflows/`).
//
// `docs` matches by extension (.md), not prefix — markdown files live everywhere
// (root-level READMEs, docs/, skills/.../SKILL.md). Prefix matching would miss
// most of them.
//
// `actions` is an AND-matcher: a file must live under `.github/workflows/`
// AND end in `.yml`/`.yaml` to trip it (a markdown note under the workflows
// dir does not). Workflow YAML edits trip BOTH `scripts` (which runs the
// bin/ workflow-shape regression tests) AND `actions` (which runs
// `actionlint` against the workflows dir) — different defect classes, so
// both checks run.
//
// `backend` is prefix-only (no `.go` AND-match) because `go vet -C backend
// ./...` and `go test -C backend ./...` walk Go packages safely on their
// own, and we want `backend/go.mod` / `backend/go.sum` edits to also re-run
// the gate.
const SCOPE_MATCHERS: Record<Exclude<Scope, "root-fallback">, ScopeMatcher> = {
  src: { prefixes: ["src/"] },
  scripts: {
    prefixes: ["scripts/", "templates/scripts/", "bin/", ".github/workflows/"],
  },
  docs: { extensions: [".md"] },
  actions: {
    prefixes: [".github/workflows/"],
    extensions: [".yml", ".yaml"],
    requireAll: true,
  },
  backend: { prefixes: ["backend/"] },
};

// --- Helpers ---

function run(argv: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

function gh(args: string[]): string {
  const { stdout, stderr, exitCode } = run(["gh", ...args]);
  if (exitCode !== 0) {
    throw new Error(stderr || `gh ${args.join(" ")} failed with exit code ${exitCode}`);
  }
  return stdout;
}

// --- Scope Detection ---

/**
 * Maps a list of file paths to the scopes they belong to.
 *
 * Returns `[]` for an empty file list (regression-safe — pre-existing
 * no-op behaviour). For a non-empty file list, returns the specific scopes
 * (src/scripts/docs) that any file matched; if no specific scope matched,
 * returns `["root-fallback"]` so consumer-repo diffs that miss the
 * flow-shaped path prefixes still trip a verify pass at the repo root.
 * Mutual exclusion: when at least one specific scope fires, root-fallback
 * never does.
 */
export function detectScopesFromFiles(files: string[]): Scope[] {
  if (files.length === 0) return [];

  const detected = new Set<Scope>();
  for (const file of files) {
    for (const scope of SPECIFIC_SCOPES) {
      if (matchesScope(file, SCOPE_MATCHERS[scope])) {
        detected.add(scope);
      }
    }
  }

  if (detected.size === 0) return ["root-fallback"];
  return SPECIFIC_SCOPES.filter((s) => detected.has(s));
}

/**
 * Returns the files unclaimed by any SPECIFIC scope. root-fallback is a
 * sentinel that doesn't claim files — even when it fires, every changed
 * file appears here so the operator can see what's actually in the
 * fallback bucket.
 */
export function computeUnmatchedFiles(files: string[]): string[] {
  return files.filter(
    (f) => !SPECIFIC_SCOPES.some((s) => matchesScope(f, SCOPE_MATCHERS[s])),
  );
}

/**
 * Computes the `allPassed` verdict + optional `reason` discriminator for a
 * run. Closes the silent-pass hole: `results.every(true)` on an empty array
 * yields `true`, so a non-empty diff that produced zero matching npm
 * scripts would otherwise exit 0 with no signal. When that happens, flag
 * the run with `reason: 'no-checks-defined'` and force `allPassed=false`.
 *
 * `changedFiles=undefined` is the `--scope` path (user named scopes
 * explicitly, no diff to inspect) — there's no "non-empty diff" to gate
 * against, so an empty results set is treated as a normal pass.
 */
export function computeAllPassedAndReason(
  results: CheckResult[],
  changedFiles: string[] | undefined,
): { allPassed: boolean; reason?: "no-checks-defined" } {
  if (results.length === 0 && (changedFiles?.length ?? 0) > 0) {
    return { allPassed: false, reason: "no-checks-defined" };
  }
  return { allPassed: results.every((r) => r.passed) };
}

function matchesScope(file: string, matcher: ScopeMatcher): boolean {
  const prefixHit = matcher.prefixes?.some((p) => file.startsWith(p)) ?? false;
  const extHit = matcher.extensions?.some((e) => file.endsWith(e)) ?? false;
  if (matcher.requireAll && matcher.prefixes && matcher.extensions) {
    return prefixHit && extHit;
  }
  return prefixHit || extHit;
}

function describeMatcher(matcher: ScopeMatcher): string {
  const parts: string[] = [];
  if (matcher.prefixes) parts.push(...matcher.prefixes);
  if (matcher.extensions) parts.push(...matcher.extensions.map((e) => `*${e}`));
  return parts.join(", ");
}

/**
 * Parses a comma-separated scope string (e.g. "src,scripts"). Rejects the
 * `root-fallback` sentinel — it is auto-detect-only, not user-facing, and
 * `--scope src,root-fallback` would silently double-run `npm run typecheck`.
 */
export function parseScopes(input: string): Scope[] {
  const tokens = input
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const result = new Set<Scope>();

  for (const token of tokens) {
    if (!SPECIFIC_SCOPES.includes(token as Exclude<Scope, "root-fallback">)) {
      throw new Error(`Unknown scope "${token}". Valid scopes: ${SPECIFIC_SCOPES.join(", ")}`);
    }
    result.add(token as Scope);
  }

  return SPECIFIC_SCOPES.filter((s) => result.has(s));
}

/** Returns the check commands for a given scope. */
export function checksForScope(scope: Scope): CheckDef[] {
  switch (scope) {
    case "src":
      return [
        { name: "npm run typecheck", argv: ["npm", "run", "typecheck"] },
        { name: "npm run test", argv: ["npm", "run", "test"] },
        { name: "npm run lint", argv: ["npm", "run", "lint"] },
      ];
    case "scripts":
      return [
        { name: "npm run typecheck:scripts", argv: ["npm", "run", "typecheck:scripts"] },
        { name: "npm run test", argv: ["npm", "run", "test"] },
        { name: "npm run lint", argv: ["npm", "run", "lint"] },
      ];
    case "docs":
      return [{ name: "flow-md-validate .", argv: ["flow-md-validate", "."] }];
    case "actions":
      return [
        {
          name: "actionlint .github/workflows/",
          argv: ["actionlint", ".github/workflows/"],
        },
      ];
    case "backend":
      return [
        { name: "go vet -C backend ./...", argv: ["go", "vet", "-C", "backend", "./..."] },
        { name: "go test -C backend ./...", argv: ["go", "test", "-C", "backend", "./..."] },
      ];
    case "root-fallback":
      // Mirror src's check set: a consumer repo whose source layout doesn't
      // match flow's prefixes still expects typecheck + test + lint at the root.
      return [
        { name: "npm run typecheck", argv: ["npm", "run", "typecheck"] },
        { name: "npm run test", argv: ["npm", "run", "test"] },
        { name: "npm run lint", argv: ["npm", "run", "lint"] },
      ];
  }
}

/**
 * Filters a list of checks to only those whose npm run script is defined in
 * the consumer repo's package.json. Non-npm checks (if any are added later)
 * pass through untouched. Letting undefined npm scripts run anyway produces
 * a confusing "Missing script" failure that's really a configuration gap.
 */
export function filterDefinedChecks(
  checks: CheckDef[],
  definedScripts: Set<string>,
): CheckDef[] {
  return checks.filter((c) => {
    if (c.argv[0] !== "npm" || c.argv[1] !== "run") return true;
    return definedScripts.has(c.argv[2]);
  });
}

// --- Check Runners ---

export type Runner = (argv: string[]) => { stdout: string; stderr: string; exitCode: number };

const COMMAND_NOT_FOUND_REGEX = /command not found|ENOENT|: not found/i;

export function runCheck(
  name: string,
  argv: string[],
  scope: Scope,
  runner: Runner = run,
): CheckResult {
  const start = performance.now();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const r = runner(argv);
    stdout = r.stdout;
    stderr = r.stderr;
    exitCode = r.exitCode;
  } catch (e: unknown) {
    // ENOENT-shaped errors (e.g. Bun.spawnSync on some platforms throws when
    // the binary isn't on PATH instead of returning exit 127). Treat as 127
    // so the downstream missing-binary branch fires.
    const code = (e as { code?: string } | null | undefined)?.code;
    const message = String((e as { message?: string } | null | undefined)?.message ?? "");
    if (code === "ENOENT" || /ENOENT|not found/i.test(message)) {
      exitCode = 127;
      stderr = message || "ENOENT";
    } else {
      throw e;
    }
  }
  const durationMs = Math.round(performance.now() - start);

  // actionlint is treated as an OPTIONAL tool — when not installed on PATH,
  // emit a per-result skipReason rather than failing the gate (parallel to
  // how filterDefinedChecks handles missing npm scripts).
  if (
    argv[0] === "actionlint" &&
    (exitCode === 127 || COMMAND_NOT_FOUND_REGEX.test(stderr))
  ) {
    return {
      name,
      scope,
      passed: true,
      durationMs,
      output: "actionlint not installed — skipped",
      skipReason: "actionlint-not-installed",
    };
  }

  // `go` is treated as an OPTIONAL tool — same shape as the actionlint skip
  // branch above. Consumer repos without a Go toolchain (or worktrees where
  // `go` simply isn't on PATH) get a `passed: true` skip rather than a hard
  // gate failure.
  if (
    argv[0] === "go" &&
    (exitCode === 127 || COMMAND_NOT_FOUND_REGEX.test(stderr))
  ) {
    return {
      name,
      scope,
      passed: true,
      durationMs,
      output: "go not installed — skipped",
      skipReason: "go-not-installed",
    };
  }

  return {
    name,
    scope,
    passed: exitCode === 0,
    durationMs,
    output: [stdout, stderr].filter(Boolean).join("\n"),
  };
}

function getChangedFiles(): string[] {
  const { stdout } = run(["git", "diff", "--name-only", "HEAD"]);
  if (!stdout) return [];
  return stdout.split("\n").filter(Boolean);
}

/** Reads package.json from cwd and returns the set of defined npm script names. */
function loadDefinedNpmScripts(): Set<string> {
  try {
    const text = readFileSync("package.json", "utf8");
    const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return new Set();
  }
}

function getChangedFilesForPr(prNumber: number): string[] {
  const output = gh(["pr", "diff", String(prNumber), "--name-only"]);
  return output.split("\n").filter(Boolean);
}

// --- Pre-Push ---

const defaultGitOps: GitOps = {
  mergeBase(ref1: string, ref2: string): string | null {
    const { stdout, exitCode } = run(["git", "merge-base", ref1, ref2]);
    if (exitCode !== 0 || !stdout) return null;
    return stdout;
  },
  diffFiles(range: string): string[] {
    const { stdout, stderr, exitCode } = run(["git", "diff", "--name-only", range]);
    if (exitCode !== 0) {
      console.error(`git diff --name-only ${range} failed (exit ${exitCode}): ${stderr}`);
      return [];
    }
    if (!stdout) return [];
    return stdout.split("\n").filter(Boolean);
  },
  // Resolve the remote's default branch via origin/HEAD, then conventional
  // fallbacks. Hardcoding "main" would mis-detect changes in repos that
  // default to "master" or anything else. If nothing resolves, warn and
  // return "main" — the downstream merge-base will return null and
  // getChangedFilesForPush will skip silently, but the warning makes the
  // skip visible instead of mysterious.
  defaultBranch(): string {
    const { stdout: head, exitCode: headExit } = run([
      "git",
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
    ]);
    if (headExit === 0 && head) {
      return head.replace("refs/remotes/origin/", "");
    }
    for (const candidate of ["main", "master"]) {
      const { exitCode } = run(["git", "rev-parse", "--verify", `refs/remotes/origin/${candidate}`]);
      if (exitCode === 0) return candidate;
    }
    console.warn(
      "warning: could not resolve a default remote branch (origin/HEAD unset, neither origin/main nor origin/master exists). " +
        "Falling back to 'main' — merge-base may fail and skip change detection.",
    );
    return "main";
  },
};

/** Parses the stdin lines git passes to a pre-push hook. */
export function parsePrePushInput(input: string): PrePushRef[] {
  return input
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) {
        throw new Error(`Malformed pre-push input: "${line}"`);
      }
      return {
        localRef: parts[0],
        localSha: parts[1],
        remoteRef: parts[2],
        remoteSha: parts[3],
      };
    });
}

/** Computes the union of changed files across all refs being pushed. */
export function getChangedFilesForPush(refs: PrePushRef[], git: GitOps = defaultGitOps): string[] {
  const allFiles = new Set<string>();

  for (const ref of refs) {
    // Skip branch deletions
    if (ref.localSha === ZERO_SHA) continue;

    let range: string;
    if (ref.remoteSha === ZERO_SHA) {
      // New branch — compare against merge-base with the remote's default
      // branch. Detect it dynamically rather than hardcoding "main" (some
      // repos still use "master" or other conventions).
      const base = git.mergeBase(git.defaultBranch(), ref.localSha);
      if (!base) continue;
      range = `${base}..${ref.localSha}`;
    } else {
      range = `${ref.remoteSha}..${ref.localSha}`;
    }

    for (const file of git.diffFiles(range)) {
      allFiles.add(file);
    }
  }

  return [...allFiles];
}

// --- Output ---

/** Formats a CheckReport as human-readable output. */
export function formatReport(report: CheckReport): string {
  const lines: string[] = [];
  const matched = new Set<Scope>(report.scopes);

  // Loud preamble: enumerate every considered scope with a per-scope status.
  // Without this, "No relevant scopes detected" is indistinguishable from a
  // real bug — the user can't tell whether the helper saw the diff and
  // matched nothing, or whether detection silently broke.
  if (report.changedFiles !== undefined) {
    const n = report.changedFiles.length;
    lines.push(`flow-pre-commit: ${n} changed file${n === 1 ? "" : "s"}; checking scopes…`);
  } else {
    lines.push("flow-pre-commit: checking explicitly-requested scopes…");
  }
  // Iterate SPECIFIC_SCOPES — root-fallback is a sentinel scope with no
  // matcher entry, surfaced on a separate line below when it fires.
  for (const scope of SPECIFIC_SCOPES) {
    const description = describeMatcher(SCOPE_MATCHERS[scope]);
    if (matched.has(scope)) {
      lines.push(`  ${scope.padEnd(8)} → matched (${description})`);
    } else {
      lines.push(`  ${scope.padEnd(8)} — no changes under ${description}`);
    }
  }
  if (matched.has("root-fallback")) {
    lines.push("  root-fallback → matched (no specific scope claimed these files)");
  }
  lines.push("");

  if (report.scopes.length === 0) {
    lines.push("No relevant scopes detected — nothing to check.");
  } else {
    lines.push(`Scopes: ${report.scopes.join(", ")}`);
  }
  lines.push("");

  if (report.unmatchedFiles && report.unmatchedFiles.length > 0) {
    lines.push(`Unmatched files (${report.unmatchedFiles.length}):`);
    for (const file of report.unmatchedFiles) {
      lines.push(`  ${file}`);
    }
    lines.push("");
  }

  for (const result of report.results) {
    const icon = result.skipReason ? "SKIP" : result.passed ? "PASS" : "FAIL";
    const duration = formatDuration(result.durationMs);
    lines.push(`  ${icon}  ${result.name} (${duration})`);

    if (result.skipReason && result.output) {
      const indented = result.output
        .split("\n")
        .map((line) => `        ${line}`)
        .join("\n");
      lines.push(indented);
    } else if (!result.passed && result.output) {
      const indented = result.output
        .split("\n")
        .map((line) => `        ${line}`)
        .join("\n");
      lines.push(indented);
      lines.push("");
    }
  }

  lines.push("");
  const skipped = report.results.filter((r) => r.skipReason).length;
  const ran = report.results.filter((r) => !r.skipReason);
  const passed = ran.filter((r) => r.passed).length;
  const total = ran.length;
  if (total === 0 && skipped === 0) {
    if (report.reason === "no-checks-defined") {
      lines.push("No checks ran (no matching npm scripts defined in package.json).");
    } else {
      lines.push("No checks ran.");
    }
  } else if (report.allPassed) {
    if (skipped > 0 && total === 0) {
      lines.push(`No checks ran (${skipped} skipped).`);
    } else if (skipped > 0) {
      lines.push(`All ${total} checks passed (${skipped} skipped).`);
    } else {
      lines.push(`All ${total} checks passed.`);
    }
  } else {
    if (skipped > 0) {
      lines.push(`${passed}/${total} checks passed (${skipped} skipped).`);
    } else {
      lines.push(`${passed}/${total} checks passed.`);
    }
  }

  return lines.join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// --- JSON output ---

const ANSI_REGEX = /\x1b\[[0-9;]*[A-Za-z]/g;
// Matches the most common terminal/runner failure markers. `\b` word
// boundaries cover error/fail/FAIL (case-insensitive); the symbols ✗ ✘ are
// matched directly because word boundaries don't apply to non-word codepoints.
const FIRST_ERROR_REGEX = /\b(?:error|fail)\b|✗|✘/i;

/** Strips ANSI escape sequences and replaces non-printable bytes with `�`. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "�");
}

/**
 * Builds a bounded `FailureExcerpt` from a check's raw stdout+stderr. Used by
 * `--json` mode to produce predictable-size output for downstream consumers
 * (the `/flow-pipeline` supervisor and `/verify` sub-skill) instead of the
 * uncapped raw output that `formatReport` indents inline.
 */
export function buildFailureExcerpt(rawOutput: string): FailureExcerpt {
  const cleaned = stripAnsi(rawOutput);
  const lines = cleaned.split("\n");
  // A trailing newline produces a final empty element from `split`. Drop it
  // so `totalLines` reflects content lines, not the artifact of the split.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;

  let firstErrorLine: number | null = null;
  let firstErrorText = "";
  for (let i = 0; i < lines.length; i++) {
    if (FIRST_ERROR_REGEX.test(lines[i])) {
      firstErrorLine = i + 1;
      firstErrorText = lines[i].slice(0, FIRST_ERROR_TEXT_MAX);
      break;
    }
  }

  let headExcerpt: string;
  let tailExcerpt: string;
  if (totalLines <= HEAD_LINES + TAIL_LINES) {
    headExcerpt = lines.join("\n");
    tailExcerpt = "";
  } else {
    headExcerpt = lines.slice(0, HEAD_LINES).join("\n");
    tailExcerpt = lines.slice(totalLines - TAIL_LINES).join("\n");
  }

  return { firstErrorLine, firstErrorText, headExcerpt, tailExcerpt, totalLines };
}

/**
 * Renders a `CheckReport` as a single JSON object string. Failures get a
 * bounded `FailureExcerpt`; passing checks omit the `failure` field entirely
 * to keep the structure compact.
 */
export function formatJsonReport(report: CheckReport): string {
  const json: JsonReport = {
    scopes: report.scopes,
    results: report.results.map((r) => {
      const result: JsonResult = {
        name: r.name,
        scope: r.scope,
        passed: r.passed,
        durationMs: r.durationMs,
      };
      if (!r.passed) result.failure = buildFailureExcerpt(r.output);
      if (r.skipReason) result.skipReason = r.skipReason;
      return result;
    }),
    allPassed: report.allPassed,
  };
  if (report.changedFiles !== undefined) json.changedFiles = report.changedFiles;
  if (report.unmatchedFiles && report.unmatchedFiles.length > 0) {
    json.unmatchedFiles = report.unmatchedFiles;
  }
  if (report.reason) json.reason = report.reason;
  return JSON.stringify(json, null, 2);
}

// --- CLI ---

function printHelp(): void {
  console.log(`
Usage: flow-pre-commit [options]

Runs verification checks with automatic scope detection.
Detects which project areas have changes and runs the appropriate checks.

Options:
  --scope <scopes>   Comma-separated scopes: src, scripts, docs, actions, backend
  --pr <number>      Detect scopes from PR changed files
  --pre-push         Read refs from stdin (used by .githooks/pre-push)
  --json             Emit a single bounded JSON object on stdout instead
                     of the human-readable report. Failures include a
                     {firstErrorLine, firstErrorText, headExcerpt,
                     tailExcerpt, totalLines} excerpt capped at ~200 lines
                     per check. Consumed by the /verify sub-skill and the
                     /flow-pipeline step 6 retry prompt.
  --help, -h         Show this help message

When no flags are given, scopes are auto-detected from \`git diff HEAD\`.

Check mapping:
  src:            npm run typecheck, npm run test, npm run lint
  scripts:        npm run typecheck:scripts, npm run test, npm run lint
  docs:           flow-md-validate .
  actions:        actionlint .github/workflows/
  backend:        go vet -C backend ./..., go test -C backend ./...
  root-fallback:  npm run typecheck, npm run test, npm run lint
                  (fires when no other scope matched)

The lint check is skipped when no 'lint' npm script is defined.

The same checks may run multiple times if multiple scopes are detected.
Each check is run independently and reports its own pass/fail.
  `);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const json = args.includes("--json");
  const prePush = args.includes("--pre-push");
  let scopes: Scope[];
  let changedFiles: string[] | undefined;
  const scopeIdx = args.indexOf("--scope");
  const prIdx = args.indexOf("--pr");

  if (prePush) {
    // Warn if working tree is dirty — checks run against the working tree, not the pushed commits
    const { stdout: dirtyFiles } = run(["git", "status", "--porcelain"]);
    if (dirtyFiles) {
      console.warn(
        "warning: working tree has uncommitted changes — checks may not match pushed commits\n",
      );
    }

    const input = await Bun.stdin.text();
    const refs = parsePrePushInput(input);
    if (refs.length === 0) {
      process.exit(0);
    }
    changedFiles = getChangedFilesForPush(refs);
    scopes = detectScopesFromFiles(changedFiles);
  } else if (scopeIdx !== -1) {
    const value = args[scopeIdx + 1];
    if (!value) {
      console.error("Error: --scope requires a value (e.g. --scope src,scripts)");
      process.exit(1);
    }
    scopes = parseScopes(value);
    // Explicit-scope path: no changed-files diff to print.
  } else if (prIdx !== -1) {
    const value = args[prIdx + 1];
    if (!value) {
      console.error("Error: --pr requires a PR number");
      process.exit(1);
    }
    const prNumber = parseInt(value, 10);
    if (isNaN(prNumber) || prNumber <= 0) {
      console.error(`Error: Invalid PR number: ${value}`);
      process.exit(1);
    }
    changedFiles = getChangedFilesForPr(prNumber);
    scopes = detectScopesFromFiles(changedFiles);
  } else {
    changedFiles = getChangedFiles();
    scopes = detectScopesFromFiles(changedFiles);
  }

  const definedScripts = loadDefinedNpmScripts();
  const results: CheckResult[] = [];
  for (const scope of scopes) {
    const checks = filterDefinedChecks(checksForScope(scope), definedScripts);
    if (checks.length === 0) {
      // In --json mode this diagnostic would corrupt stdout (which must be
      // a single parseable JSON object), so route it to stderr instead.
      const skipMsg = `Scope '${scope}': no matching npm scripts defined in package.json — skipping.`;
      if (json) console.error(skipMsg);
      else console.log(skipMsg);
      continue;
    }
    for (const check of checks) {
      const result = runCheck(check.name, check.argv, scope);
      results.push(result);
    }
  }

  const unmatchedFiles =
    changedFiles !== undefined ? computeUnmatchedFiles(changedFiles) : undefined;

  const { allPassed, reason } = computeAllPassedAndReason(results, changedFiles);

  const report: CheckReport = {
    scopes,
    results,
    allPassed,
    changedFiles,
  };
  if (unmatchedFiles && unmatchedFiles.length > 0) report.unmatchedFiles = unmatchedFiles;
  if (reason) report.reason = reason;

  console.log(json ? formatJsonReport(report) : formatReport(report));
  process.exit(report.allPassed ? 0 : 1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
