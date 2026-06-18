#!/usr/bin/env bun
/**
 * Pre-digests deterministic facts (security, types, lint, dependencies) for
 * a PR so `/pr-review`'s six review agents stop re-deriving the same
 * low-level findings from raw diff inspection on every run. Each lens shells
 * out to the consumer's already-installed tooling (semgrep, biome or eslint,
 * tsc, npm audit), parses native output into a unified `Finding` shape,
 * filters to PR-touched lines, and emits a single JSON envelope keyed by
 * lens. All lenses run concurrently via Promise.all over async spawn
 * wrappers.
 *
 * Usage:
 *   flow-pr-static-analysis <PR> [--min-confidence <n>] [--max-tool-timeout <sec>]
 *
 * Per-tool progress goes to STDERR so the final JSON on stdout is cleanly
 * capturable: `RESULT=$(flow-pr-static-analysis $PR)`.
 *
 * Output: a single JSON object on stdout when all lenses settle.
 *   {
 *     "security":     Finding[],
 *     "types":        Finding[],
 *     "lint":         Finding[],
 *     "dependencies": Finding[],
 *     "meta": {
 *       "security": LensMeta, "types": LensMeta,
 *       "lint": LensMeta,
 *       "dependencies": LensMeta,
 *       "pr": number, "min_confidence": number, "duration_ms": number
 *     }
 *   }
 *
 * Exit codes:
 *   0 — facts computed (any lens may be skipped — that's still a verdict)
 *   2 — bad CLI args
 */

import * as fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

import { HELP_TEXT, parseArgs } from "./flow-pr-static-analysis/cli";
import {
  runDependenciesLens,
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
  CmdResult,
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
  parseBiomeJson,
  parseEslintJson,
  parseNpmAuditJson,
  parseSemgrepJson,
  parseSvelteCheckOutput,
  parseTscOutput,
  SVELTE_CHECK_CONFIDENCE,
  SVELTE_CHECK_WARNING_CONFIDENCE,
} from "./flow-pr-static-analysis/parsers";
export { parseArgs } from "./flow-pr-static-analysis/cli";
export type {
  AnalysisResult,
  Args,
  CmdResult,
  Deps,
  Finding,
  GhRunner,
  LensMeta,
  LensName,
  Severity,
  Source,
} from "./flow-pr-static-analysis/types";

// --- I/O wiring (defaults live here so the entry point owns process side-effects) ---

const MAX_STREAM_BYTES = 32 * 1024 * 1024;

// Shared async spawn used by both defaultSpawn (timeout-armed) and defaultGh
// (no timeout). Caller opts in to a SIGTERM/SIGKILL escalation by setting
// `opts.timeoutMs`; omitting it skips the timeout machinery entirely so
// non-timeout consumers (gh) don't keep the event loop alive on a stray timer.
export const spawnAsync: SpawnRunner = (cmd, args, opts) =>
  new Promise<CmdResult>((resolve) => {
    const child = spawn(
      cmd,
      args,
      opts.cwd !== undefined ? { cwd: opts.cwd } : undefined,
    );
    let stdout = "";
    let stderr = "";
    let stdoutLen = 0;
    let stderrLen = 0;
    let settled = false;
    // maxBuffer parity with spawnSync: on overflow we stop appending but keep
    // the process running, matching spawnSync's truncate-rather-than-kill.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdoutLen >= MAX_STREAM_BYTES) return;
      const remaining = MAX_STREAM_BYTES - stdoutLen;
      if (chunk.length <= remaining) {
        stdout += chunk;
        stdoutLen += chunk.length;
      } else {
        stdout += chunk.slice(0, remaining);
        stdoutLen = MAX_STREAM_BYTES;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderrLen >= MAX_STREAM_BYTES) return;
      const remaining = MAX_STREAM_BYTES - stderrLen;
      if (chunk.length <= remaining) {
        stderr += chunk;
        stderrLen += chunk.length;
      } else {
        stderr += chunk.slice(0, remaining);
        stderrLen = MAX_STREAM_BYTES;
      }
    });
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        // Grace window: if the child traps SIGTERM, escalate to SIGKILL after
        // 2s. The .unref() is load-bearing — without it a resolved spawn keeps
        // the event loop alive for the full 2s and hangs vitest at shutdown.
        killTimer = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 2000);
        killTimer.unref();
      }, opts.timeoutMs);
    }
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout: "",
        stderr: String(err),
        exitCode: -1,
        timedOut: false,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        timedOut,
      });
    });
  });

const defaultSpawn: SpawnRunner = (cmd, args, opts) =>
  spawnAsync(cmd, args, opts);

const defaultGh: GhRunner = (argv) => spawnAsync("gh", argv, {});

// Deliberately sync: called once per lens before the parallel critical path,
// so converting would balloon test-mock churn for zero perf gain. The file
// mixes async (spawn/gh) and sync (which) subprocess primitives by design.
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
    writeErr(
      "usage: flow-pr-static-analysis <PR> [--min-confidence <n>] [--max-tool-timeout <sec>]\n",
    );
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
  const diffResult = await gh(["pr", "diff", String(parsed.pr)]);
  if (diffResult.exitCode !== 0) {
    writeErr(
      `flow-pr-static-analysis: gh pr diff ${parsed.pr} failed: ${diffResult.stderr.trim() || "no stderr"}\n`,
    );
    // Emit an envelope with every lens skipped so the consumer's JSON.parse
    // still works. The skipped_reason makes the failure visible.
    const empty = (reason: string): LensMeta => ({
      ran: false,
      skipped_reason: reason,
      duration_ms: 0,
    });
    const result: AnalysisResult = {
      security: [],
      types: [],
      lint: [],
      dependencies: [],
      meta: {
        security: empty("gh-pr-diff-failed"),
        types: empty("gh-pr-diff-failed"),
        lint: empty("gh-pr-diff-failed"),
        dependencies: empty("gh-pr-diff-failed"),
        pr: parsed.pr,
        min_confidence: parsed.minConfidence,
        duration_ms: now() - startAll,
      },
    };
    writeOut(JSON.stringify(result) + "\n");
    return 0;
  }
  const changedLines = computeChangedLines(diffResult.stdout);

  // Only the types lens consumes the PR-touched paths (to fan out per owning
  // workspace package); the other four receive the base lensDeps and ignore it.
  const typesLensDeps = { ...lensDeps, changedPaths: [...changedLines.keys()] };

  const [security, types, lint, dependencies] = await Promise.all([
    runSecurityLens(parsed, lensDeps),
    runTypesLens(parsed, typesLensDeps),
    runLintLens(parsed, lensDeps),
    runDependenciesLens(parsed, lensDeps),
  ]);

  const filterAndScope = (findings: Finding[]): Finding[] =>
    applyConfidenceThreshold(
      applyDiffScope(findings, changedLines),
      parsed.minConfidence,
    );

  const result: AnalysisResult = {
    security: filterAndScope(security.findings),
    types: filterAndScope(types.findings),
    lint: filterAndScope(lint.findings),
    dependencies: filterAndScope(dependencies.findings),
    meta: {
      security: security.meta,
      types: types.meta,
      lint: lint.meta,
      dependencies: dependencies.meta,
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
