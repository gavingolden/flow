#!/usr/bin/env bun
/**
 * Resolves /flow-pr-review Step 3's review scope (`full | delta`), writes
 * the capped diff for that scope, evaluates the lens gates
 * (bin/lib/review-lens-gates.ts), writes synthetic artifacts for gated
 * lenses so the consolidator's six-mandatory-artifact contract stays
 * intact, and writes `review-scope.json` (its `started_at` doubles as the
 * telemetry attribution window). Prints `NOTICE — review-scope:` /
 * `NOTICE — lens-gated:` lines the wrapper echoes verbatim.
 *
 * Delta scoping requires: a prior marker SHA, that marker an ancestor of
 * HEAD, the prior review clean, delta scope enabled, no forced-full, and
 * the delta diff under DELTA_RATIO_THRESHOLD of the full PR diff — else
 * scope falls back to `full` with a specific reason. There is no `none`
 * scope; the marker-equals-HEAD no-new-commits skip is the Gatekeeper's
 * job (see references/review-scope.md).
 *
 * Usage:
 *   flow-review-scope --pr <n> --worktree <dir>
 *     [--static-analysis <path>] [--out <path>] [--diff-out <path>]
 *     [--no-gates] [--force-full] [--config <path>] [--json]
 *
 * Exit codes: 0 graceful, 2 bad args, 1 gh/git failure.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentName } from "./flow-pr-agent-lens";
import { capDiff, DEFAULT_MAX_LINES, DEFAULT_MAX_TOTAL } from "./flow-pr-diff";
import { evaluateGates, type GateVerdict } from "./lib/review-lens-gates";
import type { AnalysisResult } from "./flow-pr-static-analysis/types";

export const DELTA_RATIO_THRESHOLD = 0.75;

export type ReviewScope = {
  version: 1;
  started_at: string;
  scope: "full" | "delta";
  reason: string;
  base_sha: string | null;
  head_sha: string;
  pr_files: string[];
  delta_files: string[];
  delta_ratio: number | null;
  gates: Record<AgentName, GateVerdict>;
  gates_enabled: boolean;
  delta_enabled: boolean;
  forced_full: boolean;
};

export function resolveScope(input: {
  headSha: string;
  markerSha: string | null;
  isAncestor: boolean;
  priorStatus: string | null;
  prFiles: string[];
  changedSinceMarker: string[];
  fullDiffLines: number;
  deltaDiffLines: number;
  deltaEnabled: boolean;
  forceFull: boolean;
}): Pick<ReviewScope, "scope" | "reason" | "base_sha" | "delta_files" | "delta_ratio"> {
  const full = (
    reason: string,
    base_sha: string | null = null,
  ): Pick<ReviewScope, "scope" | "reason" | "base_sha" | "delta_files" | "delta_ratio"> => ({
    scope: "full",
    reason,
    base_sha,
    delta_files: [],
    delta_ratio: null,
  });

  if (input.forceFull) return full("forced full (widen)", input.markerSha);
  if (!input.deltaEnabled) return full("delta scope disabled", input.markerSha);
  if (input.markerSha === null) return full("no prior marker");
  if (input.markerSha === input.headSha) {
    return full(
      "marker equals HEAD (Gatekeeper owns the no-new-commits skip)",
      input.markerSha,
    );
  }
  if (!input.isAncestor) {
    return full("marker not an ancestor of HEAD", input.markerSha);
  }
  if (input.priorStatus !== "clean") {
    return full(
      `prior review not clean (${input.priorStatus ?? "none"})`,
      input.markerSha,
    );
  }
  if (input.fullDiffLines === 0) {
    return full("delta ≥ 75% of PR diff", input.markerSha);
  }
  const ratio = input.deltaDiffLines / input.fullDiffLines;
  if (ratio >= DELTA_RATIO_THRESHOLD) {
    return full("delta ≥ 75% of PR diff", input.markerSha);
  }

  const prFileSet = new Set(input.prFiles);
  const delta_files = input.changedSinceMarker.filter((f) => prFileSet.has(f));
  return {
    scope: "delta",
    reason: "delta re-entry",
    base_sha: input.markerSha,
    delta_files,
    delta_ratio: ratio,
  };
}

export function syntheticGatedArtifact(reason: string): {
  findings: [];
  rejected_alternatives: [];
  anti_patterns_found: [];
  gated: { reason: string };
} {
  return {
    findings: [],
    rejected_alternatives: [],
    anti_patterns_found: [],
    gated: { reason },
  };
}

export function renderNotices(scope: ReviewScope): string[] {
  const notices: string[] = [];
  if (scope.scope === "full") {
    notices.push(`NOTICE — review-scope: full (${scope.reason})`);
  } else {
    const base7 = (scope.base_sha ?? "").slice(0, 7);
    const head7 = scope.head_sha.slice(0, 7);
    const pct = scope.delta_ratio !== null ? Math.round(scope.delta_ratio * 100) : 0;
    notices.push(
      `NOTICE — review-scope: delta ${base7}..${head7} (${scope.delta_files.length} files, ${pct}% of PR diff)`,
    );
  }
  for (const [lens, verdict] of Object.entries(scope.gates)) {
    if (!verdict.run) {
      notices.push(`NOTICE — lens-gated: ${lens} skipped (${verdict.reason})`);
    }
  }
  return notices;
}

// --- CLI / run() ---

export type GhRunner = (args: string[]) => { stdout: string; exitCode: number };
export type GitRunner = (
  args: string[],
  cwd: string,
) => { stdout: string; exitCode: number };

export type RunDeps = {
  gh: GhRunner;
  git: GitRunner;
  readFile: (p: string) => string | null;
  writeFile: (p: string, content: string) => void;
  now: () => Date;
  homeDir: string;
};

export type ParsedArgs =
  | {
      pr: number;
      worktree: string;
      staticAnalysis?: string;
      out?: string;
      diffOut?: string;
      noGates: boolean;
      forceFull: boolean;
      config?: string;
      json: boolean;
    }
  | { error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  let pr: number | undefined;
  let worktree: string | undefined;
  let staticAnalysis: string | undefined;
  let out: string | undefined;
  let diffOut: string | undefined;
  let noGates = false;
  let forceFull = false;
  let config: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--no-gates") {
      noGates = true;
      continue;
    }
    if (flag === "--force-full") {
      forceFull = true;
      continue;
    }
    if (flag === "--json") {
      json = true;
      continue;
    }
    const value = argv[i + 1];
    switch (flag) {
      case "--pr": {
        if (value === undefined) return { error: "--pr requires a value" };
        const n = Number.parseInt(value, 10);
        if (Number.isNaN(n) || n <= 0) return { error: `invalid --pr value: ${value}` };
        pr = n;
        i++;
        break;
      }
      case "--worktree":
        if (value === undefined) return { error: "--worktree requires a value" };
        worktree = value;
        i++;
        break;
      case "--static-analysis":
        if (value === undefined) return { error: "--static-analysis requires a value" };
        staticAnalysis = value;
        i++;
        break;
      case "--out":
        if (value === undefined) return { error: "--out requires a value" };
        out = value;
        i++;
        break;
      case "--diff-out":
        if (value === undefined) return { error: "--diff-out requires a value" };
        diffOut = value;
        i++;
        break;
      case "--config":
        if (value === undefined) return { error: "--config requires a value" };
        config = value;
        i++;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }

  if (pr === undefined) return { error: "--pr is required" };
  if (worktree === undefined) return { error: "--worktree is required" };
  return { pr, worktree, staticAnalysis, out, diffOut, noGates, forceFull, config, json };
}

function countLines(diff: string): number {
  if (!diff) return 0;
  const lines = diff.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function readTolerantBool(
  readFile: (p: string) => string | null,
  configPath: string,
  key: "lensGates" | "deltaScope",
): boolean {
  const raw = readFile(configPath);
  if (raw === null) return true;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.review?.[key] !== false;
  } catch {
    return true;
  }
}

function atomicWrite(deps: RunDeps, filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`;
  deps.writeFile(tmp, content);
  fs.renameSync(tmp, filePath);
}

export async function run(argv: string[], deps: RunDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-review-scope: ${parsed.error}\n`);
    return 2;
  }

  const worktree = parsed.worktree;
  const configPath = parsed.config ?? path.join(deps.homeDir, ".flow", "config.json");
  const gatesEnabledByConfig = readTolerantBool(deps.readFile, configPath, "lensGates");
  const deltaEnabledByConfig = readTolerantBool(deps.readFile, configPath, "deltaScope");
  const gatesEnabled = !parsed.noGates && gatesEnabledByConfig;
  const deltaEnabled = deltaEnabledByConfig;

  const headResult = deps.git(["rev-parse", "HEAD"], worktree);
  if (headResult.exitCode !== 0) {
    process.stderr.write("flow-review-scope: git rev-parse HEAD failed\n");
    return 1;
  }
  const headSha = headResult.stdout.trim();

  const markerPath = path.join(worktree, ".flow-tmp", "pr-review-last-sha");
  const markerRaw = deps.readFile(markerPath);
  const markerSha = markerRaw !== null && markerRaw.trim() ? markerRaw.trim() : null;

  let isAncestor = false;
  if (markerSha) {
    const r = deps.git(["merge-base", "--is-ancestor", markerSha, "HEAD"], worktree);
    isAncestor = r.exitCode === 0;
  }

  const resultRaw = deps.readFile(
    path.join(worktree, ".flow-tmp", "pr-review-result.json"),
  );
  let priorStatus: string | null = null;
  if (resultRaw !== null) {
    try {
      const parsedResult = JSON.parse(resultRaw);
      priorStatus = typeof parsedResult?.status === "string" ? parsedResult.status : null;
    } catch {
      priorStatus = null;
    }
  }

  const prFilesResult = deps.gh([
    "pr",
    "view",
    String(parsed.pr),
    "--json",
    "files",
    "--jq",
    ".files[].path",
  ]);
  if (prFilesResult.exitCode !== 0) {
    process.stderr.write("flow-review-scope: gh pr view failed\n");
    return 1;
  }
  const prFiles = prFilesResult.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const changedSinceMarker = markerSha
    ? deps
        .git(["diff", "--name-only", `${markerSha}..HEAD`], worktree)
        .stdout.split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    : [];

  const fullDiffResult = deps.gh(["pr", "diff", String(parsed.pr)]);
  if (fullDiffResult.exitCode !== 0) {
    process.stderr.write("flow-review-scope: gh pr diff failed\n");
    return 1;
  }
  const fullDiffRaw = fullDiffResult.stdout;
  const fullDiffLines = countLines(fullDiffRaw);

  const prFileSet = new Set(prFiles);
  const deltaFileCandidates = changedSinceMarker.filter((f) => prFileSet.has(f));
  let deltaDiffRaw = "";
  if (markerSha && deltaFileCandidates.length > 0) {
    const r = deps.git(
      ["diff", `${markerSha}..HEAD`, "--", ...deltaFileCandidates],
      worktree,
    );
    if (r.exitCode === 0) deltaDiffRaw = r.stdout;
  }
  const deltaDiffLines = countLines(deltaDiffRaw);

  const resolved = resolveScope({
    headSha,
    markerSha,
    isAncestor,
    priorStatus,
    prFiles,
    changedSinceMarker,
    fullDiffLines,
    deltaDiffLines,
    deltaEnabled,
    forceFull: parsed.forceFull,
  });

  const scopeFiles = resolved.scope === "delta" ? resolved.delta_files : prFiles;

  const staticAnalysisPath =
    parsed.staticAnalysis ?? path.join(worktree, ".flow-tmp", "static-analysis.json");
  let staticAnalysis: AnalysisResult | undefined;
  const staticAnalysisRaw = deps.readFile(staticAnalysisPath);
  if (staticAnalysisRaw !== null) {
    try {
      staticAnalysis = JSON.parse(staticAnalysisRaw);
    } catch {
      staticAnalysis = undefined;
    }
  }

  const gates = evaluateGates(scopeFiles, { enabled: gatesEnabled, staticAnalysis });

  const scope: ReviewScope = {
    version: 1,
    started_at: deps.now().toISOString(),
    scope: resolved.scope,
    reason: resolved.reason,
    base_sha: resolved.base_sha,
    head_sha: headSha,
    pr_files: prFiles,
    delta_files: resolved.delta_files,
    delta_ratio: resolved.delta_ratio,
    gates,
    gates_enabled: gatesEnabled,
    delta_enabled: deltaEnabled,
    forced_full: parsed.forceFull,
  };

  const diffRaw = resolved.scope === "delta" ? deltaDiffRaw : fullDiffRaw;
  const cappedDiff = capDiff(diffRaw, DEFAULT_MAX_LINES, DEFAULT_MAX_TOTAL, parsed.pr);
  const diffOutPath = parsed.diffOut ?? path.join(worktree, ".flow-tmp", "diff.txt");
  atomicWrite(deps, diffOutPath, cappedDiff);

  for (const [lens, verdict] of Object.entries(gates)) {
    if (!verdict.run) {
      const artifactPath = path.join(worktree, ".flow-tmp", `agent-output-${lens}.json`);
      atomicWrite(deps, artifactPath, JSON.stringify(syntheticGatedArtifact(verdict.reason)));
    }
  }

  const outPath = parsed.out ?? path.join(worktree, ".flow-tmp", "review-scope.json");
  atomicWrite(deps, outPath, JSON.stringify(scope));

  const notices = renderNotices(scope);
  for (const line of notices) process.stdout.write(`${line}\n`);
  if (parsed.json) process.stdout.write(`${JSON.stringify(scope)}\n`);

  return 0;
}

const defaultGh: GhRunner = (args) => {
  const r = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  return { stdout: r.stdout.toString(), exitCode: r.exitCode ?? 1 };
};

const defaultGit: GitRunner = (args, cwd) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { stdout: r.stdout.toString(), exitCode: r.exitCode ?? 1 };
};

const defaultDeps: RunDeps = {
  gh: defaultGh,
  git: defaultGit,
  readFile: (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  writeFile: (p, content) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  },
  now: () => new Date(),
  homeDir: os.homedir(),
};

if (import.meta.main) {
  run(process.argv.slice(2), defaultDeps).then((code) => process.exit(code));
}
