#!/usr/bin/env bun
/**
 * `flow-conflict-marker-check --committed` — a source-tree-invoked CLI over
 * `bin/lib/conflict-markers.ts`'s pure scan module. Reads the COMMITTED tree
 * (`git grep ... HEAD`, `git show ... -m HEAD`), never the worktree — after a
 * commit, worktree == index == HEAD, so a worktree-vs-index diff has nothing
 * left to diff and reports clean regardless of content (see AGENTS.md
 * "Don't gate a post-commit verification on a worktree-vs-index diff").
 *
 * This is the merge-resolver's Layer 2 check (`merge-resolver-instructions.md`
 * Step 5) — Layer 1 is `git diff --check` run per-file BEFORE the resolution
 * commit, which is the only layer that catches a partial edit (a lone
 * `=======` left mid-file).
 *
 * Usage: flow-conflict-marker-check --committed
 *   exit 0  clean (no blocking markers; any pre-existing ones are advisory)
 *   exit 1  blocking (a marker in a file this commit's merge touched)
 *   exit 2  error (bad invocation, not a flow checkout, or a git failure)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  MARKER_PATTERN,
  formatHits,
  parseGitGrepOutput,
  parseTouchedFiles,
  partitionHits,
  type MarkerHit,
} from "./lib/conflict-markers";

const USAGE = "usage: flow-conflict-marker-check --committed";

export type ParsedArgs = { mode: "committed" } | { error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 1 && argv[0] === "--committed") {
    return { mode: "committed" };
  }
  if (argv.length === 0) {
    return { error: "--committed is required" };
  }
  return { error: `unknown arguments: ${argv.join(" ")}` };
}

export type FlowRootResult = { root: string } | { error: string };

/**
 * Derives `<flow-root>` from this script's own path (`bin/<this
 * file>.ts` → one directory up) and validates it: a `package.json` whose
 * `.name` is exactly `"flow"`, plus a `bin/` directory. Bun's
 * `import.meta.path` is symlink-aware (resolves through a `~/.local/bin`
 * PATH symlink to the canonical source file — see `bin/lib/paths.ts`), so
 * this check is unaffected by how the script was invoked.
 */
export function resolveFlowRoot(fromPath: string): FlowRootResult {
  const root = path.resolve(path.dirname(fromPath), "..");
  const fail = (): FlowRootResult => ({
    error: `derived FLOW_ROOT does not contain a flow checkout: ${root}`,
  });
  let pkgName: unknown;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { name?: unknown };
    pkgName = pkg.name;
  } catch {
    return fail();
  }
  if (pkgName !== "flow") return fail();
  try {
    if (!fs.statSync(path.join(root, "bin")).isDirectory()) return fail();
  } catch {
    return fail();
  }
  return { root };
}

type SpawnResult = { stdout: string; stderr: string; exitCode: number };

export type DecideResult = {
  verdict: "clean" | "blocking" | "error";
  blocking: MarkerHit[];
  preExisting: MarkerHit[];
  message?: string;
};

/**
 * Pure core: the exit table is unit-testable without spawning `git`.
 * `grep.exitCode`: 1 → clean (no hits anywhere); 0 → parse + partition;
 * anything else (including negative/signal-killed) → error. `touched`
 * (the `git show -m HEAD` call) must itself have exited 0, or the touched-
 * file scope can't be trusted and the whole check errors closed.
 */
export function decide(
  grep: Pick<SpawnResult, "stdout" | "exitCode">,
  touched: Pick<SpawnResult, "stdout" | "stderr" | "exitCode">,
): DecideResult {
  if (grep.exitCode === 1) {
    return { verdict: "clean", blocking: [], preExisting: [] };
  }
  if (grep.exitCode !== 0) {
    return {
      verdict: "error",
      blocking: [],
      preExisting: [],
      message: `git grep exited ${grep.exitCode}`,
    };
  }
  if (touched.exitCode !== 0) {
    return {
      verdict: "error",
      blocking: [],
      preExisting: [],
      message:
        touched.stderr.trim() || `git show exited ${touched.exitCode}`,
    };
  }
  const hits = parseGitGrepOutput(grep.stdout, "HEAD");
  const scope = new Set(parseTouchedFiles(touched.stdout));
  const { blocking, preExisting } = partitionHits(hits, scope);
  return {
    verdict: blocking.length > 0 ? "blocking" : "clean",
    blocking,
    preExisting,
  };
}

function run(argv: string[]): SpawnResult {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(
      `flow-conflict-marker-check: ${parsed.error}\n${USAGE}\n`,
    );
    process.exit(2);
    return;
  }

  const rootResult = resolveFlowRoot(import.meta.path);
  if ("error" in rootResult) {
    process.stderr.write(`flow-conflict-marker-check: ${rootResult.error}\n`);
    process.exit(2);
    return;
  }

  const grep = run([
    "git",
    "grep",
    "--full-name",
    "-nE",
    MARKER_PATTERN,
    "HEAD",
    "--",
    ":/",
  ]);
  const touched = run(["git", "show", "--name-only", "--format=", "-m", "HEAD"]);
  const result = decide(grep, touched);

  const lines = [
    ...formatHits(result.blocking, "BLOCKING"),
    ...formatHits(result.preExisting, "PRE-EXISTING"),
  ];
  if (result.verdict === "error" && result.message) {
    lines.push(`error: ${result.message}`);
  }
  lines.push(`verdict: ${result.verdict}`);
  console.log(lines.join("\n"));

  process.exit(
    result.verdict === "clean" ? 0 : result.verdict === "blocking" ? 1 : 2,
  );
}

if (import.meta.main) {
  main();
}
