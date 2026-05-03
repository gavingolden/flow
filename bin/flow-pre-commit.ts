#!/usr/bin/env bun
/**
 * Runs verification checks with automatic scope detection.
 *
 * Detects which project areas have changes (src, scripts, docs) and runs
 * the appropriate checks for each.
 *
 * Usage:
 *   flow-pre-commit                    # auto-detect from git diff
 *   flow-pre-commit --pr 126           # detect from PR changed files
 *   flow-pre-commit --scope src        # explicit scope
 *   flow-pre-commit --pre-push         # read refs from stdin (git hook)
 */

import { readFileSync } from "node:fs";

// --- Types ---

export type Scope = "src" | "scripts" | "docs";

export type ScopeMatcher = {
  prefixes?: string[];
  extensions?: string[];
};

export type CheckResult = {
  name: string;
  scope: Scope;
  passed: boolean;
  durationMs: number;
  output: string;
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
};

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

const VALID_SCOPES: Scope[] = ["src", "scripts", "docs"];
const ZERO_SHA = "0000000000000000000000000000000000000000";

// `scripts/` is the install location in target repos; `bin/` is the canonical
// source location for shipped helper binaries in flow itself; `templates/scripts/`
// holds the remaining orchestrator-only scripts and backward-compat symlinks.
// All three trip the scripts scope so flow's own pre-commit run picks up edits.
//
// `docs` matches by extension (.md), not prefix — markdown files live everywhere
// (root-level READMEs, docs/, skills/.../SKILL.md). Prefix matching would miss
// most of them.
const SCOPE_MATCHERS: Record<Scope, ScopeMatcher> = {
  src: { prefixes: ["src/"] },
  scripts: { prefixes: ["scripts/", "templates/scripts/", "bin/"] },
  docs: { extensions: [".md"] },
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

/** Maps a list of file paths to the scopes they belong to. */
export function detectScopesFromFiles(files: string[]): Scope[] {
  const detected = new Set<Scope>();

  for (const file of files) {
    for (const scope of VALID_SCOPES) {
      if (matchesScope(file, SCOPE_MATCHERS[scope])) {
        detected.add(scope);
      }
    }
  }

  return VALID_SCOPES.filter((s) => detected.has(s));
}

function matchesScope(file: string, matcher: ScopeMatcher): boolean {
  if (matcher.prefixes?.some((p) => file.startsWith(p))) return true;
  if (matcher.extensions?.some((e) => file.endsWith(e))) return true;
  return false;
}

function describeMatcher(matcher: ScopeMatcher): string {
  const parts: string[] = [];
  if (matcher.prefixes) parts.push(...matcher.prefixes);
  if (matcher.extensions) parts.push(...matcher.extensions.map((e) => `*${e}`));
  return parts.join(", ");
}

/** Parses a comma-separated scope string (e.g. "src,scripts"). */
export function parseScopes(input: string): Scope[] {
  const tokens = input
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const result = new Set<Scope>();

  for (const token of tokens) {
    if (!VALID_SCOPES.includes(token as Scope)) {
      throw new Error(`Unknown scope "${token}". Valid scopes: ${VALID_SCOPES.join(", ")}`);
    }
    result.add(token as Scope);
  }

  return VALID_SCOPES.filter((s) => result.has(s));
}

/** Returns the check commands for a given scope. */
export function checksForScope(scope: Scope): CheckDef[] {
  switch (scope) {
    case "src":
      return [
        { name: "npm run typecheck", argv: ["npm", "run", "typecheck"] },
        { name: "npm run test", argv: ["npm", "run", "test"] },
      ];
    case "scripts":
      return [
        { name: "npm run typecheck:scripts", argv: ["npm", "run", "typecheck:scripts"] },
        { name: "npm run test", argv: ["npm", "run", "test"] },
      ];
    case "docs":
      return [{ name: "flow-md-validate .", argv: ["flow-md-validate", "."] }];
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

function runCheck(name: string, argv: string[], scope: Scope): CheckResult {
  const start = performance.now();
  const { stdout, stderr, exitCode } = run(argv);
  const durationMs = Math.round(performance.now() - start);

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
  for (const scope of VALID_SCOPES) {
    const description = describeMatcher(SCOPE_MATCHERS[scope]);
    if (matched.has(scope)) {
      lines.push(`  ${scope.padEnd(8)} → matched (${description})`);
    } else {
      lines.push(`  ${scope.padEnd(8)} — no changes under ${description}`);
    }
  }
  lines.push("");

  if (report.scopes.length === 0) {
    lines.push("No relevant scopes detected — nothing to check.");
  } else {
    lines.push(`Scopes: ${report.scopes.join(", ")}`);
  }
  lines.push("");

  for (const result of report.results) {
    const icon = result.passed ? "PASS" : "FAIL";
    const duration = formatDuration(result.durationMs);
    lines.push(`  ${icon}  ${result.name} (${duration})`);

    if (!result.passed && result.output) {
      const indented = result.output
        .split("\n")
        .map((line) => `        ${line}`)
        .join("\n");
      lines.push(indented);
      lines.push("");
    }
  }

  lines.push("");
  const passed = report.results.filter((r) => r.passed).length;
  const total = report.results.length;
  if (total === 0) {
    lines.push("No checks ran.");
  } else {
    lines.push(
      report.allPassed ? `All ${total} checks passed.` : `${passed}/${total} checks passed.`,
    );
  }

  return lines.join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// --- CLI ---

function printHelp(): void {
  console.log(`
Usage: flow-pre-commit [options]

Runs verification checks with automatic scope detection.
Detects which project areas have changes and runs the appropriate checks.

Options:
  --scope <scopes>   Comma-separated scopes: src, scripts, docs
  --pr <number>      Detect scopes from PR changed files
  --pre-push         Read refs from stdin (used by .githooks/pre-push)
  --help, -h         Show this help message

When no flags are given, scopes are auto-detected from \`git diff HEAD\`.

Check mapping:
  src:      npm run typecheck, npm run test
  scripts:  npm run typecheck:scripts, npm run test
  docs:     flow-md-validate .

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
      console.log(
        `Scope '${scope}': no matching npm scripts defined in package.json — skipping.`,
      );
      continue;
    }
    for (const check of checks) {
      const result = runCheck(check.name, check.argv, scope);
      results.push(result);
    }
  }

  const report: CheckReport = {
    scopes,
    results,
    allPassed: results.every((r) => r.passed),
    changedFiles,
  };

  console.log(formatReport(report));
  process.exit(report.allPassed ? 0 : 1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
