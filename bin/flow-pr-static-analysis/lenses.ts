import * as path from "node:path";
import {
  parseBiomeJson,
  parseCoverageJson,
  parseEslintJson,
  parseNpmAuditJson,
  parseSemgrepJson,
  parseTscOutput,
  relativise,
} from "./parsers";
import type { Finding, LensMeta, LensRun } from "./types";

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

export const runTypesLens: LensRun = async (args, deps) => {
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
  const r = await deps.spawn(bin, [...projectArgs, "--noEmit", "--pretty", "false"], {
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
  const findings = parseNpmAuditJson(r.stdout, packageJsonContent);
  return {
    findings,
    meta: { ran: true, duration_ms: deps.now() - start },
  };
};
