/**
 * Pure lens-gate rules for /flow-pr-review's Step 3 fan-out: decides, per
 * review lens, whether it runs against the current changed-file set (full
 * PR or delta), the static-analysis pre-digest, and a diff-content signal
 * (`hasNewBareImports`) that catches a new runtime dependency introduced
 * via a bare import/require even when no manifest file changed in the
 * same diff.
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

import { builtinModules } from "node:module";
import type { AgentName } from "../flow-pr-agent-lens";
import type { AnalysisResult } from "../flow-pr-static-analysis/types";

export const MANIFEST_GLOBS: readonly string[] = [
  "package.json",
  "**/package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  "yarn.lock",
  ".yarnrc.yml",
  "pnpm-lock.yaml",
  "**/.npmrc",
  "requirements*.txt",
  "pyproject.toml",
  "poetry.lock",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "Gemfile",
  "Gemfile.lock",
  "**/Dockerfile*",
  ".github/dependabot.yml",
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

// Each alternative anchors on a fixed keyword/punctuation boundary before the
// quoted specifier, with a single non-backtracking `[^'"]+` capture — no
// nested/overlapping whitespace quantifiers, so match time is linear in line
// length regardless of input shape.
const FROM_IMPORT_RE = /(?:^|[\s};])from\s+(['"])([^'"]+)\1/;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*(['"])([^'"]+)\1/;
const SIDE_EFFECT_IMPORT_RE = /^\+\s*import\s+(['"])([^'"]+)\1\s*;?\s*$/;
const REQUIRE_RE = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/;

const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules);

function isBareSpecifier(specifier: string): boolean {
  if (/^(\.|\/|node:|bun:|#)/.test(specifier)) return false;
  const pkgRoot = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  if (NODE_BUILTINS.has(specifier) || NODE_BUILTINS.has(pkgRoot)) return false;
  return true;
}

/**
 * True iff any ADDED diff line (`+` prefix, never the `+++ b/file` file
 * header) introduces an `import`/`require` of a bare specifier — one that
 * does not start with `.`, `/`, `node:`, `bun:`, or `#` (Node subpath
 * imports), and is not an unprefixed Node builtin module (`fs`, `path`,
 * `child_process`, etc. — those ship with the runtime, not npm). Covers
 * static named/default imports (including prettier-wrapped `} from "pkg"`
 * continuation lines), dynamic `import("pkg")`, side-effect `import
 * "pkg"`, `export ... from "pkg"` re-exports, and `require("pkg")`. A new
 * bare specifier signals a new runtime dependency even when no manifest
 * file changed in the same diff (e.g. a monorepo workspace hoisting an
 * existing root-level dependency).
 */
export function hasNewBareImports(diffText: string): boolean {
  for (const line of diffText.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const m =
      FROM_IMPORT_RE.exec(line) ??
      DYNAMIC_IMPORT_RE.exec(line) ??
      SIDE_EFFECT_IMPORT_RE.exec(line) ??
      REQUIRE_RE.exec(line);
    if (!m) continue;
    const specifier = m[2];
    if (!specifier) continue;
    if (isBareSpecifier(specifier)) return true;
  }
  return false;
}

export function evaluateGates(
  files: readonly string[],
  opts: {
    enabled: boolean;
    staticAnalysis?: AnalysisResult;
    newBareImports?: boolean;
  },
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
  const hasDependencySignal =
    (opts.staticAnalysis?.dependencies?.length ?? 0) > 0;
  const hasSecuritySignal = (opts.staticAnalysis?.security?.length ?? 0) > 0;

  out["supply-chain"] =
    hasManifest || hasDependencySignal || opts.newBareImports
      ? {
          run: true,
          reason: hasManifest
            ? "manifest/lockfile changed"
            : hasDependencySignal
              ? "static-analysis dependencies signal"
              : "new bare-specifier import in diff",
        }
      : {
          run: false,
          reason: `no manifest/lockfile among ${files.length} changed files`,
        };

  out.security =
    docsOnly && !hasSecuritySignal
      ? { run: false, reason: `docs-only diff (${files.length} files)` }
      : {
          run: true,
          reason: hasSecuritySignal
            ? "static-analysis security signal"
            : "not docs-only",
        };

  out.performance = docsOnly
    ? { run: false, reason: `docs-only diff (${files.length} files)` }
    : { run: true, reason: "not docs-only" };

  out["test-coverage"] = docsOnly
    ? { run: false, reason: `docs-only diff (${files.length} files)` }
    : { run: true, reason: "not docs-only" };

  return out as Record<AgentName, GateVerdict>;
}
