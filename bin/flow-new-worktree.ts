#!/usr/bin/env bun
/**
 * Creates a git worktree for parallel agent development.
 *
 * Usage: flow-new-worktree <branch-name> [base-branch] [--reuse]
 */

import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { findAvailableSlot, toDirSuffix } from "./lib/worktree-slot";
import {
  ensureFlowTmpExclude,
  ensureGitignoreMarkerEntry,
  writeBranchMarker,
} from "./lib/worktree-marker";
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

const MAX_RACE_RETRIES = 5;

const log = {
  info: (msg: string) => console.log(`   ${msg}`),
  success: (msg: string) => console.log(`✅ ${msg}`),
  error: (msg: string) => console.error(`❌ ${msg}`),
  warn: (msg: string) => console.warn(`⚠️  ${msg}`),
};

function git(args: string[], cwd?: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(stderr || `git ${args[0]} failed with exit code ${result.status}`);
  }
  return (result.stdout ?? "").trim();
}

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
Usage: flow-new-worktree <branch-name> [base-branch] [--reuse]

Creates a git worktree for parallel agent development as a sibling
directory of this repo. Branch name is converted to a directory-safe
suffix; deps are installed; .env and .claude/settings.local.json are
symlinked. Without --reuse, auto-suffixes (<slug>-2, -3, ...) on
collision so concurrent calls return distinct paths.

Examples:
  flow-new-worktree feature/new-chart
  flow-new-worktree fix/tooltip-bug develop
  flow-new-worktree feature/new-chart --reuse
  `);
}

function parseArgs(): WorktreeConfig {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const reuse = args.includes("--reuse");
  const positional = args.filter((a) => a !== "--reuse");
  const branchName = positional[0];
  if (!branchName) {
    log.error("branch name is required");
    printHelp();
    process.exit(1);
  }
  const repoDir = git(["rev-parse", "--show-toplevel"]);
  const repoName = path.basename(repoDir);
  const worktreeDir = path.join(path.dirname(repoDir), `${repoName}-${toDirSuffix(branchName)}`);
  const baseBranch = positional[1] ?? detectDefaultBranch(repoDir);
  return { branchName, baseBranch, repoDir, worktreeDir, reuse };
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
  gitWorktreeAdd: (worktreeDir: string, branchName: string, startPoint: string) => void = (
    worktreeDir,
    branchName,
    startPoint,
  ) => {
    git(["worktree", "add", worktreeDir, "-b", branchName, startPoint], repoDir);
  },
): { branchName: string; worktreeDir: string } {
  const startPoint = `origin/${baseBranch}`;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_RACE_RETRIES; attempt++) {
    const slot = findAvailableSlot(initialBranch, initialDir, repoDir);
    try {
      console.log(`📂 Creating worktree at: ${slot.worktreeDir}`);
      log.info(`Branch: ${slot.branchName} (from ${startPoint})`);
      gitWorktreeAdd(slot.worktreeDir, slot.branchName, startPoint);
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
    : new Error(`flow-new-worktree: failed to create a worktree after ${MAX_RACE_RETRIES} attempts`);
}

function main(): void {
  const config = parseArgs();
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
  ensureGitignoreMarkerEntry(primaryDir);
  ensureFlowTmpExclude(chosen.worktreeDir);

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
