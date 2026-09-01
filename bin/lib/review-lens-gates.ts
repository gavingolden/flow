/**
 * Pure lens-gate rules for /flow-pr-review's Step 3 fan-out: decides, per
 * review lens, whether it runs against the current changed-file set (full
 * PR or delta) plus the static-analysis pre-digest.
 *
 * Explicit allowlists as exported constants, two always-on lenses
 * (bug-detection, pattern-consistency have no narrow domain to gate on),
 * and "never-skip-on-signal" overrides so a real supply-chain/security
 * finding in the static-analysis envelope can never be silently dropped by
 * a file-pattern miss.
 *
 * No glob library: `matchesAny` is a hand-rolled matcher over a small,
 * hard-coded pattern vocabulary (`**\/`, `*`, trailing `/**`), avoiding a
 * runtime dependency on a transitive dev-only package (memory: canonical
 * node_modules has gone missing `picomatch` before).
 */

import type { AgentName } from "../flow-pr-agent-lens";
import type { AnalysisResult } from "../flow-pr-static-analysis/types";

export const MANIFEST_GLOBS: readonly string[] = [
  "package.json",
  "**/package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".npmrc",
  "requirements*.txt",
  "pyproject.toml",
  "poetry.lock",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "Gemfile",
  "Gemfile.lock",
  "Dockerfile*",
  ".github/workflows/**",
];

export const DOCS_GLOBS: readonly string[] = [
  "**/*.md",
  "**/*.mdx",
  "**/*.txt",
  "docs/**",
  "LICENSE*",
  "**/*.template",
];

export const INSTRUCTION_GLOBS: readonly string[] = [
  "skills/**",
  "agents/**",
  ".claude/**",
  ".github/**",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "templates/**",
];

export const ALWAYS_ON_LENSES: readonly AgentName[] = [
  "bug-detection",
  "pattern-consistency",
];

export type GateVerdict = { run: boolean; reason: string };

const ALL_AGENT_NAMES: readonly AgentName[] = [
  "bug-detection",
  "security",
  "pattern-consistency",
  "performance",
  "supply-chain",
  "test-coverage",
];

/** Converts one glob pattern into a matcher for a single file path. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") {
      out += "(?:.*/)?";
      i += 2;
      continue;
    }
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i += 1;
      continue;
    }
    if (c === "*") {
      out += "[^/]*";
      continue;
    }
    if (c === ".") {
      out += "\\.";
      continue;
    }
    out += c.replace(/[-/\\^$+?()|[\]{}]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const REGEX_CACHE = new Map<string, RegExp>();

function matches(file: string, glob: string): boolean {
  let re = REGEX_CACHE.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    REGEX_CACHE.set(glob, re);
  }
  return re.test(file);
}

export function matchesAny(file: string, globs: readonly string[]): boolean {
  return globs.some((g) => matches(file, g));
}

/**
 * True iff every file matches DOCS_GLOBS and none matches INSTRUCTION_GLOBS.
 * An empty file list is NOT docs-only (there's nothing to gate off).
 */
export function isDocsOnly(files: readonly string[]): boolean {
  if (files.length === 0) return false;
  return files.every(
    (f) => matchesAny(f, DOCS_GLOBS) && !matchesAny(f, INSTRUCTION_GLOBS),
  );
}

export function evaluateGates(
  files: readonly string[],
  opts: { enabled: boolean; staticAnalysis?: AnalysisResult },
): Record<AgentName, GateVerdict> {
  const out: Record<string, GateVerdict> = {};

  if (!opts.enabled) {
    for (const name of ALL_AGENT_NAMES) {
      out[name] = { run: true, reason: "gates disabled" };
    }
    return out as Record<AgentName, GateVerdict>;
  }

  for (const name of ALWAYS_ON_LENSES) {
    out[name] = { run: true, reason: "always-on lens" };
  }

  const docsOnly = isDocsOnly(files);
  const hasManifest = files.some((f) => matchesAny(f, MANIFEST_GLOBS));
  const hasDependencySignal = (opts.staticAnalysis?.dependencies?.length ?? 0) > 0;
  const hasSecuritySignal = (opts.staticAnalysis?.security?.length ?? 0) > 0;

  out["supply-chain"] =
    hasManifest || hasDependencySignal
      ? { run: true, reason: hasManifest ? "manifest/lockfile changed" : "static-analysis dependencies signal" }
      : {
          run: false,
          reason: `no manifest/lockfile among ${files.length} changed files`,
        };

  out.security =
    docsOnly && !hasSecuritySignal
      ? { run: false, reason: `docs-only diff (${files.length} files)` }
      : { run: true, reason: hasSecuritySignal ? "static-analysis security signal" : "not docs-only" };

  out.performance = docsOnly
    ? { run: false, reason: `docs-only diff (${files.length} files)` }
    : { run: true, reason: "not docs-only" };

  out["test-coverage"] = docsOnly
    ? { run: false, reason: `docs-only diff (${files.length} files)` }
    : { run: true, reason: "not docs-only" };

  return out as Record<AgentName, GateVerdict>;
}
