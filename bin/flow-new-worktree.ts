#!/usr/bin/env bun
/**
 * Creates a git worktree for parallel agent development.
 *
 * Usage:
 *   flow-new-worktree [<branch-name>] [base-branch] [--reuse]
 *
 * - The branch name is optional when invoked from inside a flow tmux
 *   pane: it auto-resolves from `$TMUX_PANE`'s `@flow-slug` window
 *   option. The supervisor pattern relies on the auto-resolve path; the
 *   explicit positional stays for back-compat and for callers outside
 *   tmux. When both are present they must agree, otherwise the helper
 *   exits 2 (`slug-mismatch:`).
 */

import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { git } from "./lib/git";
import { resolveSlugFromPane } from "./lib/tmux";
import { findAvailableSlot, toDirSuffix } from "./lib/worktree-slot";
import { ensureFlowExcludes, writeBranchMarker } from "./lib/worktree-marker";
import { installCommitHook } from "./lib/worktree-commit-hook";
import {
  detectDefaultBranch,
  getPrimaryDir,
  symlinkSharedFiles,
  validateReusable,
} from "./lib/worktree-fs";

export type WorktreeConfig = {
  branchName: string;
  baseBranch: string;
  repoDir: string;
  worktreeDir: string;
  /** Reuse an existing worktree at the literal slug rather than auto-suffixing. */
  reuse: boolean;
};

export type RunNewWorktreeDeps = {
  /**
   * Slug fallback consulted when the positional arg is omitted, and
   * compared against the positional arg when both are present. Defaults
   * to `resolveSlugFromPane()` against the real tmux. Tests inject a stub.
   */
  resolveSlug?: () => string | null;
};

type PickBranchNameResult =
  | { kind: "ok"; branchName: string }
  | { kind: "error"; message: string; exitCode: number };

/**
 * Reconciles a positional `<slug>` arg with the supervisor pane's
 * `@flow-slug`. The canonical pipeline slug lives on the pane (set by
 * `flow feature create` and read by every other helper); silently accepting a
 * mismatched positional was the PR #152 footgun — state.json keyed by
 * pane slug, worktree directory keyed by the mismatched positional.
 *
 * - both present and equal → use either (they agree).
 * - both present and different → exit 2 (`slug-mismatch:`). Exit code 2
 *   mirrors `flow-state-update.ts`'s arg-parse / usage-error precedent.
 * - only positional given → use it (caller is outside tmux or in a non-flow window).
 * - only pane slug available → use it (caller omitted the arg, supervisor pattern).
 * - neither → exit 1 (`branch name is required`).
 */
export function pickBranchName(
  positional: string | undefined,
  paneSlug: string | null,
): PickBranchNameResult {
  if (positional && paneSlug && positional !== paneSlug) {
    return {
      kind: "error",
      message:
        `slug-mismatch: positional '${positional}' != pane @flow-slug '${paneSlug}'.\n` +
        `  The supervisor's pipeline slug (set by 'flow feature create') is canonical.\n` +
        `  Re-run with no positional arg, or fix the caller to match @flow-slug.`,
      exitCode: 2,
    };
  }
  const branchName = positional ?? paneSlug;
  if (!branchName) {
    return { kind: "error", message: "branch name is required", exitCode: 1 };
  }
  return { kind: "ok", branchName };
}

const MAX_RACE_RETRIES = 5;

const log = {
  info: (msg: string) => console.log(`   ${msg}`),
  success: (msg: string) => console.log(`✅ ${msg}`),
  error: (msg: string) => console.error(`❌ ${msg}`),
  warn: (msg: string) => console.warn(`⚠️  ${msg}`),
};

function run(argv: string[], cwd?: string): void {
  const [cmd, ...rest] = argv;
  const result = spawnSync(cmd, rest, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(stderr || `${cmd} failed with exit code ${result.status}`);
  }
}

function printHelp(): void {
  console.log(`
Usage: flow-new-worktree [<branch-name>] [base-branch] [--reuse]

Creates a git worktree for parallel agent development as a sibling
directory of this repo. Branch name is converted to a directory-safe
suffix; deps are installed; .env and .claude/settings.local.json are
symlinked. Without --reuse, auto-suffixes (<slug>-2, -3, ...) on
collision so concurrent calls return distinct paths.

The branch name is optional inside a flow tmux pane — it auto-resolves
from $TMUX_PANE's @flow-slug. When the positional is also given it must
match the pane slug, otherwise the helper exits 2 (slug-mismatch).

Examples:
  flow-new-worktree feature/new-chart
  flow-new-worktree fix/tooltip-bug develop
  flow-new-worktree feature/new-chart --reuse
  flow-new-worktree           # inside a flow pane: uses @flow-slug
  `);
}

export type ParseArgsResult =
  | { kind: "ok"; config: WorktreeConfig }
  | { kind: "help" }
  | { kind: "error"; message: string; exitCode: number; showHelp?: boolean };

export function parseArgs(
  argv: string[] = process.argv.slice(2),
  deps: RunNewWorktreeDeps = {},
): ParseArgsResult {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  const reuse = argv.includes("--reuse");
  const positional = argv.filter((a) => a !== "--reuse");
  const resolveSlug = deps.resolveSlug ?? (() => resolveSlugFromPane());
  const pick = pickBranchName(positional[0], resolveSlug());
  if (pick.kind === "error") {
    return {
      kind: "error",
      message: pick.message,
      exitCode: pick.exitCode,
      // Only the "branch name is required" path is a usage hint worth a help dump;
      // slug-mismatch already names the fix in its message.
      showHelp: pick.exitCode === 1,
    };
  }
  const branchName = pick.branchName;
  const repoDir = git(["rev-parse", "--show-toplevel"]);
  const repoName = path.basename(repoDir);
  const worktreeDir = path.join(
    path.dirname(repoDir),
    `${repoName}-${toDirSuffix(branchName)}`,
  );
  const baseBranch = positional[1] ?? detectDefaultBranch(repoDir);
  return {
    kind: "ok",
    config: { branchName, baseBranch, repoDir, worktreeDir, reuse },
  };
}

function preflight(config: WorktreeConfig): void {
  for (const [name, label] of [
    [config.branchName, "branch name"],
    [config.baseBranch, "base branch"],
  ] as const) {
    if (spawnSync("git", ["check-ref-format", "--branch", name]).status !== 0) {
      log.error(`Invalid ${label}: '${name}' is not a valid git branch name.`);
      process.exit(1);
    }
  }
}

/**
 * Creates the worktree, retrying with a fresh slot if `git worktree add`
 * itself fails (a peer won the race between our preflight check and our git
 * call). `gitWorktreeAdd` is injectable for tests — production callers omit
 * it and get the real `git worktree add` invocation.
 */
export function createWorktreeWithRetry(
  initialBranch: string,
  initialDir: string,
  baseBranch: string,
  repoDir: string,
  gitWorktreeAdd: (
    worktreeDir: string,
    branchName: string,
    startPoint: string,
  ) => void = (worktreeDir, branchName, startPoint) => {
    git(
      ["worktree", "add", worktreeDir, "-b", branchName, startPoint],
      repoDir,
    );
  },
  warn: (msg: string) => void = log.warn,
): { branchName: string; worktreeDir: string } {
  const startPoint = `origin/${baseBranch}`;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_RACE_RETRIES; attempt++) {
    const slot = findAvailableSlot(initialBranch, initialDir, repoDir);
    try {
      console.log(`📂 Creating worktree at: ${slot.worktreeDir}`);
      log.info(`Branch: ${slot.branchName} (from ${startPoint})`);
      gitWorktreeAdd(slot.worktreeDir, slot.branchName, startPoint);
      // Loud divergence signal: the requested slug collided, so the created
      // worktree/branch carry a numeric suffix the pipeline slug / @flow-slug /
      // ~/.flow/state/<slug>.json filename do NOT. Cleanup must therefore rely
      // on the recorded worktree path in state.json to target this branch, not
      // re-derive from the slug (which would resolve the colliding sibling).
      // Surfacing it here makes the divergence — and any pre-existing leaked
      // sibling that caused the collision — visible in scrollback.
      if (slot.branchName !== initialBranch) {
        warn(
          `worktree slug '${initialBranch}' collided; created '${slot.worktreeDir}' ` +
            `on branch '${slot.branchName}'. The pipeline slug / @flow-slug / state.json ` +
            `stay '${initialBranch}'; cleanup relies on the recorded worktree path in ` +
            `~/.flow/state to remove the correct worktree and branch.`,
        );
      }
      return slot;
    } catch (err) {
      lastErr = err;
      log.warn(
        `attempt ${attempt}/${MAX_RACE_RETRIES} lost a race for ${slot.branchName} — retrying with a fresh slot`,
      );
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(
        `flow-new-worktree: failed to create a worktree after ${MAX_RACE_RETRIES} attempts`,
      );
}

function main(): void {
  const parsed = parseArgs();
  if (parsed.kind === "help") {
    printHelp();
    process.exit(0);
  }
  if (parsed.kind === "error") {
    log.error(parsed.message);
    if (parsed.showHelp) printHelp();
    process.exit(parsed.exitCode);
  }
  const config = parsed.config;
  preflight(config);
  const primaryDir = getPrimaryDir(config.repoDir);

  let chosen: { branchName: string; worktreeDir: string };
  if (config.reuse) {
    validateReusable(config.worktreeDir, config.branchName);
    chosen = { branchName: config.branchName, worktreeDir: config.worktreeDir };
    console.log(`♻️  Reusing existing worktree at: ${chosen.worktreeDir}`);
    log.info(`Branch: ${chosen.branchName}`);
  } else {
    chosen = createWorktreeWithRetry(
      config.branchName,
      config.worktreeDir,
      config.baseBranch,
      config.repoDir,
    );
    console.log("📦 Installing dependencies...");
    run(["npm", "install", "--silent"], chosen.worktreeDir);
    symlinkSharedFiles(chosen.worktreeDir, primaryDir);
  }

  // Idempotent on both fresh and reused worktrees — older script versions may
  // have created the worktree without these.
  writeBranchMarker(chosen.worktreeDir, chosen.branchName);
  ensureFlowExcludes(chosen.worktreeDir);
  // Best-effort: the session trailer is non-critical, so a config/hook-write
  // hiccup must not abort worktree creation (unlike the two calls above).
  try {
    installCommitHook(chosen.worktreeDir);
  } catch (e: unknown) {
    log.warn(
      `could not install prepare-commit-msg hook: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  console.log(`
${config.reuse ? "✅ Worktree reused!" : "✅ Worktree ready!"}
   Directory: ${chosen.worktreeDir}
   Branch:    ${chosen.branchName}

Open in a new agent session (e.g. Claude Code):
   claude "${chosen.worktreeDir}"

When done, clean up with:
   git worktree remove "${chosen.worktreeDir}" && git branch -d "${chosen.branchName}"`);
}

if (import.meta.main) {
  try {
    main();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(msg);
    process.exit(1);
  }
}
