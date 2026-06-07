import * as path from "node:path";
import {
  parseBiomeJson,
  parseCoverageJson,
  parseEslintJson,
  parseNpmAuditJson,
  parseSemgrepJson,
  parseSvelteCheckOutput,
  parseTscOutput,
  relativise,
} from "./parsers";
import { workspacePrefixOf } from "../lib/monorepo-scopes";
import type { Args, Finding, LensMeta, LensRun } from "./types";

// --- Lens runners (each returns the lens's findings + meta) ----------------

function timedSkip(start: number, reason: string): { findings: Finding[]; meta: LensMeta } {
  return {
    findings: [],
    meta: { ran: false, skipped_reason: reason, duration_ms: Date.now() - start },
  };
}

export const runSecurityLens: LensRun = async (args, deps) => {
  const start = deps.now();
  const bin = deps.which("semgrep");
  if (!bin) return timedSkip(start, "semgrep-not-on-path");
  deps.writeErr("[security] running semgrep --json --severity ERROR\n");
  const r = await deps.spawn(
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

// Types-lens deps: the shared LensRun deps plus an OPTIONAL list of the
// PR-touched repo-relative paths. Only the types lens reads it (to fan out per
// owning workspace package); the other four lenses keep the base LensRun deps.
type TypesLensDeps = Parameters<LensRun>[1] & { changedPaths?: string[] };

// The single-cwd detect + svelte-check/tsc decision, parameterised on `dir`
// instead of deps.cwd so runTypesLens can fan it out across owning packages.
// Behaviour-preserving: every former deps.cwd reference is now `dir`.
async function runTypesForDir(
  dir: string,
  args: Args,
  deps: Parameters<LensRun>[1],
): Promise<{ findings: Finding[]; meta: LensMeta }> {
  const start = deps.now();
  const timeoutMs = args.maxToolTimeoutSec * 1000;
  // Prefer plain tsconfig.json when present; otherwise pick the first
  // project-specific tsconfig (e.g. tsconfig.scripts.json, tsconfig.app.json).
  // flow's own repo only has tsconfig.scripts.json — without this fallback the
  // types lens silently skipped on the very repo it ships in.
  const tsconfig = resolveTsconfig(dir, deps.fileExists);
  if (!tsconfig) return timedSkip(start, "no-tsconfig");
  // Svelte/SvelteKit repos: bare tsc cannot type `.svelte`/`.svelte.ts` files
  // and lacks the DOM lib + ambient types that `svelte-kit sync` generates, so
  // it emits phantom errors on green PRs. Run `svelte-check` instead and never
  // fall back to bare tsc for a detected-Svelte repo. The two soften reasons
  // below are stable kebab-case skipped_reason values consumers match on:
  //   svelte-check-unavailable — svelte-check binary not resolvable
  //   svelte-kit-sync-failed   — `svelte-kit sync` exited non-zero or timed out
  const svelteKind = detectSvelte(dir, deps.fileExists, deps.readFile);
  if (svelteKind) {
    const localSvelteCheck = path.join(dir, "node_modules", ".bin", "svelte-check");
    const svelteCheckBin = deps.fileExists(localSvelteCheck)
      ? localSvelteCheck
      : deps.which("svelte-check");
    if (!svelteCheckBin) return timedSkip(start, "svelte-check-unavailable");
    if (svelteKind === "sveltekit") {
      const localSvelteKit = path.join(dir, "node_modules", ".bin", "svelte-kit");
      const svelteKitBin = deps.fileExists(localSvelteKit)
        ? localSvelteKit
        : deps.which("svelte-kit");
      if (!svelteKitBin) return timedSkip(start, "svelte-kit-sync-failed");
      deps.writeErr(`[types] running ${svelteKitBin} sync\n`);
      const sync = await deps.spawn(svelteKitBin, ["sync"], { cwd: dir, timeoutMs });
      if (sync.timedOut || sync.exitCode !== 0) {
        return timedSkip(start, "svelte-kit-sync-failed");
      }
    }
    const checkArgs = [
      "--output",
      "machine",
      "--threshold",
      "error",
      ...(tsconfig !== "tsconfig.json" ? ["--tsconfig", tsconfig] : []),
    ];
    deps.writeErr(`[types] running ${svelteCheckBin} ${checkArgs.join(" ")}\n`);
    const r = await deps.spawn(svelteCheckBin, checkArgs, { cwd: dir, timeoutMs });
    if (r.timedOut) return timedSkip(start, "timeout");
    // svelte-check exit semantics: 0 = no errors, 1 = errors found (both
    // "ran" — parse stdout). Anything else is a tooling failure; skip with an
    // explicit reason rather than a silent zero-finding pass.
    if (r.exitCode !== 0 && r.exitCode !== 1) {
      return timedSkip(start, `svelte-check-exit-${r.exitCode}`);
    }
    const findings = parseSvelteCheckOutput(r.stdout, dir);
    return { findings, meta: { ran: true, duration_ms: deps.now() - start } };
  }
  // Prefer locally-installed tsc to avoid surprise version drift; fall back
  // to PATH if neither exists.
  const localTsc = path.join(dir, "node_modules", ".bin", "tsc");
  let bin = deps.fileExists(localTsc) ? localTsc : deps.which("tsc");
  if (!bin) return timedSkip(start, "tsc-not-found");
  const projectArgs = tsconfig === "tsconfig.json" ? [] : ["-p", tsconfig];
  deps.writeErr(`[types] running ${bin} --noEmit --pretty false${projectArgs.length ? ` -p ${tsconfig}` : ""}\n`);
  const r = await deps.spawn(bin, [...projectArgs, "--noEmit", "--pretty", "false"], {
    cwd: dir,
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
  const findings = parseTscOutput(r.stdout, dir);
  return { findings, meta: { ran: true, duration_ms: deps.now() - start } };
}

export const runTypesLens: LensRun = async (args, deps) => {
  const changedPaths = (deps as TypesLensDeps).changedPaths;
  // No threaded diff (other callers, or an empty diff): preserve the exact
  // single-package behaviour — one repo-root run, byte-for-byte unchanged.
  if (!changedPaths || changedPaths.length === 0) {
    return runTypesForDir(deps.cwd, args, deps);
  }

  const repoRoot = deps.cwd;
  // Distinct owning workspace package prefixes (apps/<pkg>/, packages/<pkg>/),
  // gated on a readable package.json owner — the same convention flow-pre-commit
  // uses via detectWorkspaceScopes, replicated here with the lens's own seams.
  const ownedPrefixes: string[] = [];
  const seenPrefixes = new Set<string>();
  let hasUnowned = false;
  for (const file of changedPaths) {
    const prefix = workspacePrefixOf(file);
    if (!prefix) {
      hasUnowned = true;
      continue;
    }
    if (seenPrefixes.has(prefix)) continue;
    seenPrefixes.add(prefix);
    if (deps.readFile(path.join(repoRoot, prefix, "package.json")) !== null) {
      ownedPrefixes.push(prefix);
    } else {
      // Workspace-shaped path with no package.json owner falls back to root.
      hasUnowned = true;
    }
  }

  // No owned workspace package touched: identical to the single-package path.
  if (ownedPrefixes.length === 0) {
    return runTypesForDir(repoRoot, args, deps);
  }

  const allFindings: Finding[] = [];
  const metas: LensMeta[] = [];

  for (const prefix of ownedPrefixes) {
    const { findings, meta } = await runTypesForDir(
      path.join(repoRoot, prefix),
      args,
      deps,
    );
    // tsc/svelte-check spawned in the package cwd emit PACKAGE-relative paths;
    // relativise() is a no-op on already-relative paths, so prepend the package
    // prefix to keep Finding.file repo-relative (apps/web/src/App.svelte) and
    // survive applyDiffScope (keyed on repo-relative changedLines). Never do
    // this on the repo-root path below — those findings are already repo-relative.
    for (const f of findings) {
      allFindings.push({ ...f, file: `${prefix}${f.file}` });
    }
    metas.push(meta);
  }

  // Only run the repo root for touched files with no workspace owner; skip the
  // redundant root run when every touched file is workspace-owned.
  if (hasUnowned) {
    const { findings, meta } = await runTypesForDir(repoRoot, args, deps);
    allFindings.push(...findings);
    metas.push(meta);
  }

  // Fold N per-dir metas into one: ran if ANY ran; duration is the sum; the
  // first real skip reason stays visible so a failing package isn't masked by a
  // passing sibling (Story 6).
  const ran = metas.some((m) => m.ran);
  const duration_ms = metas.reduce((sum, m) => sum + m.duration_ms, 0);
  const firstSkip = metas.find((m) => !m.ran && m.skipped_reason)?.skipped_reason;
  const meta: LensMeta = { ran, duration_ms };
  if (firstSkip) meta.skipped_reason = firstSkip;
  return { findings: allFindings, meta };
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

// Pure Svelte/SvelteKit detection mirroring detectEslintConfig: returns
// "sveltekit" (run `svelte-kit sync` before svelte-check) when @sveltejs/kit is
// a dependency or any svelte.config.* file exists; "svelte" when only a plain
// `svelte` dependency is present; null otherwise. The SvelteKit-vs-plain split
// drives whether the lens runs `svelte-kit sync` first.
function detectSvelte(
  cwd: string,
  fileExists: (p: string) => boolean,
  readFile: (p: string) => string | null,
): "sveltekit" | "svelte" | null {
  const hasSvelteConfig =
    fileExists(path.join(cwd, "svelte.config.js")) ||
    fileExists(path.join(cwd, "svelte.config.ts")) ||
    fileExists(path.join(cwd, "svelte.config.mjs"));
  let hasKitDep = false;
  let hasSvelteDep = false;
  const pkgRaw = readFile(path.join(cwd, "package.json"));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      hasKitDep = "@sveltejs/kit" in deps;
      hasSvelteDep = "svelte" in deps;
    } catch {
      /* swallow */
    }
  }
  if (hasKitDep || hasSvelteConfig) return "sveltekit";
  if (hasSvelteDep) return "svelte";
  return null;
}

export const runLintLens: LensRun = async (args, deps) => {
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
      const r = await deps.spawn(bin, ["check", "--reporter=json", "."], {
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
      const r = await deps.spawn(bin, ["--format", "json", "."], {
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

export const runCoverageLens: LensRun = async (args, deps) => {
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

export const runDependenciesLens: LensRun = async (args, deps) => {
  const start = deps.now();
  if (!deps.fileExists(path.join(deps.cwd, "package.json"))) {
    return timedSkip(start, "no-package-json");
  }
  if (!deps.which("npm")) return timedSkip(start, "npm-not-on-path");
  const packageJsonContent = deps.readFile(path.join(deps.cwd, "package.json"));
  deps.writeErr("[dependencies] running npm audit --json\n");
  const r = await deps.spawn("npm", ["audit", "--json"], {
    cwd: deps.cwd,
    timeoutMs: args.maxToolTimeoutSec * 1000,
  });
  if (r.timedOut) return timedSkip(start, "timeout");
  // npm audit exits 0 when there are no vulnerabilities and 1 when there are;
  // both paths emit the JSON envelope on stdout. Anything else is an
  // npm/configuration error and stdout is typically empty.
  if (r.exitCode !== 0 && r.exitCode !== 1) {
    return timedSkip(start, `npm-exit-${r.exitCode}`);
  }
  // npm audit also exits 1 when the audit itself couldn't run (no
  // package-lock.json, network failure, ENOAUDIT, etc.). In that case stdout
  // is `{"error": {"code": "ENOLOCK", ...}}` — no `vulnerabilities` key.
  // Treat that shape as a skip rather than a falsely-clean ran=true verdict.
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("vulnerabilities" in (parsed as Record<string, unknown>))
  ) {
    return timedSkip(start, "npm-audit-no-vulnerabilities-key");
  }
  const findings = parseNpmAuditJson(r.stdout, packageJsonContent);
  return {
    findings,
    meta: { ran: true, duration_ms: deps.now() - start },
  };
};
