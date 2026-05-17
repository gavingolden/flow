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
import { spawnSync } from "node:child_process";

import { HELP_TEXT, parseArgs } from "./flow-pr-static-analysis/cli";
import {
  runCoverageLens,
  runLintLens,
  runSecurityLens,
  runTypesLens,
} from "./flow-pr-static-analysis/lenses";
import {
  applyConfidenceThreshold,
  applyDiffScope,
  computeChangedLines,
} from "./flow-pr-static-analysis/parsers";
import type {
  AnalysisResult,
  Deps,
  Finding,
  GhRunner,
  LensMeta,
  SpawnRunner,
  WhichFn,
} from "./flow-pr-static-analysis/types";

// Re-export the public surface so existing consumers (bin/flow-pr-static-analysis.test.ts
// in particular) can keep importing from this entry point without rewiring paths.
export {
  applyConfidenceThreshold,
  applyDiffScope,
  computeChangedLines,
} from "./flow-pr-static-analysis/parsers";
export {
  parseBiomeJson,
  parseCoverageJson,
  parseEslintJson,
  parseSemgrepJson,
  parseTscOutput,
} from "./flow-pr-static-analysis/parsers";
export { parseArgs } from "./flow-pr-static-analysis/cli";
export type {
  AnalysisResult,
  Args,
  Deps,
  Finding,
  GhRunner,
  LensMeta,
  LensName,
  Severity,
  Source,
} from "./flow-pr-static-analysis/types";

// --- I/O wiring (defaults live here so the entry point owns process side-effects) ---

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

function defaultReadFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

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

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
