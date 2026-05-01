#!/usr/bin/env bun
/**
 * Creates a git worktree for parallel agent development.
 *
 * Usage:
 *   flow-new-worktree <branch-name> [base-branch]
 *
 * Examples:
 *   flow-new-worktree feature/new-chart
 *   flow-new-worktree fix/tooltip-bug develop
 */

import * as fs from "fs";
import * as path from "path";

// --- Types ---

export type WorktreeConfig = {
  branchName: string;
  baseBranch: string;
  repoDir: string;
  worktreeDir: string;
};

// --- Logging ---

const log = {
  info: (msg: string) => console.log(`   ${msg}`),
  success: (msg: string) => console.log(`✅ ${msg}`),
  error: (msg: string) => console.error(`❌ ${msg}`),
  warn: (msg: string) => console.warn(`⚠️  ${msg}`),
};

// --- Helpers ---

/** Runs a git command with an argv array and returns stdout. Throws on non-zero exit. */
function git(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(stderr || `git ${args[0]} failed with exit code ${result.exitCode}`);
  }

  return result.stdout.toString().trim();
}

/** Runs an arbitrary command with an argv array. Throws on non-zero exit. */
function run(argv: string[], cwd?: string): string {
  const result = Bun.spawnSync(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(stderr || `${argv[0]} failed with exit code ${result.exitCode}`);
  }

  return result.stdout.toString().trim();
}

/** Files symlinked from the primary repo into each new worktree. */
export const SYMLINK_FILES = [".env", ".claude/settings.local.json"];

/** Converts a branch name to a directory-safe suffix (e.g. feature/foo → feature-foo). */
export function toDirSuffix(branchName: string): string {
  return branchName.replace(/\//g, "-");
}

/** Returns the primary (main) worktree directory, even when run from a secondary worktree. */
export function getPrimaryDir(repoDir: string): string {
  const raw = git(["worktree", "list", "--porcelain"], repoDir);
  const firstLine = raw.split("\n")[0];
  if (!firstLine?.startsWith("worktree ")) {
    return repoDir; // fallback
  }
  return firstLine.slice("worktree ".length);
}

/**
 * Auto-detects the default branch. Tries origin/HEAD first, then conventional
 * defaults (main, master) verified against the remote. Throws if none work —
 * "HEAD" is not a valid branch name and would fail downstream validation.
 */
function detectDefaultBranch(repoDir: string): string {
  try {
    const ref = git(["symbolic-ref", "refs/remotes/origin/HEAD"], repoDir);
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // origin/HEAD not set — fall through to conventional defaults
  }

  for (const candidate of ["main", "master"]) {
    try {
      git(["rev-parse", "--verify", `refs/remotes/origin/${candidate}`], repoDir);
      return candidate;
    } catch {
      // try next
    }
  }

  throw new Error(
    "Could not auto-detect the default branch. Pass it explicitly as the second argument.",
  );
}

// --- CLI ---

function printHelp(): void {
  console.log(`
Usage: flow-new-worktree <branch-name> [base-branch]

Creates a git worktree for parallel agent development.

Arguments:
  branch-name   Name for the new branch (e.g. feature/new-chart)
  base-branch   Branch to create from (default: auto-detected from origin)

The worktree is created as a sibling directory to this repo, with the
branch name converted to a directory-safe suffix. Dependencies are
installed and .env / .claude/settings.local.json are symlinked automatically.

Examples:
  flow-new-worktree feature/new-chart
  flow-new-worktree fix/tooltip-bug develop
  `);
}

function parseArgs(): WorktreeConfig {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const branchName = args[0];
  const repoDir = git(["rev-parse", "--show-toplevel"]);
  const repoName = path.basename(repoDir);
  const dirSuffix = toDirSuffix(branchName);
  const worktreeDir = path.join(path.dirname(repoDir), `${repoName}-${dirSuffix}`);

  const defaultBranch = detectDefaultBranch(repoDir);
  const baseBranch = args[1] ?? defaultBranch;

  return { branchName, baseBranch, repoDir, worktreeDir };
}

// --- Preflight ---

/** Validates that a string is a legal git branch name. Exits with a clear message if not. */
function validateRefName(name: string, label: string): void {
  const result = Bun.spawnSync(["git", "check-ref-format", "--branch", name], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    log.error(`Invalid ${label}: '${name}' is not a valid git branch name.`);
    process.exit(1);
  }
}

function preflight(config: WorktreeConfig): void {
  // Validate ref names before they reach any command
  validateRefName(config.branchName, "branch name");
  validateRefName(config.baseBranch, "base branch");

  // Check if branch already exists
  try {
    git(["show-ref", "--verify", "--quiet", `refs/heads/${config.branchName}`], config.repoDir);
    log.error(
      `Branch '${config.branchName}' already exists. Pick a different name or delete it first.`,
    );
    process.exit(1);
  } catch {
    // Branch doesn't exist — good
  }

  // Check if directory already exists
  if (fs.existsSync(config.worktreeDir)) {
    log.error(`Directory already exists: ${config.worktreeDir}`);
    process.exit(1);
  }
}

// --- Main ---

function main(): void {
  const config = parseArgs();
  preflight(config);

  // Create worktree from the remote-tracking ref so that a prior `git fetch origin`
  // guarantees an up-to-date starting point (local branches may be stale).
  const startPoint = `origin/${config.baseBranch}`;
  console.log(`📂 Creating worktree at: ${config.worktreeDir}`);
  log.info(`Branch: ${config.branchName} (from ${startPoint})`);
  git(["worktree", "add", config.worktreeDir, "-b", config.branchName, startPoint], config.repoDir);

  // Install dependencies
  console.log("📦 Installing dependencies...");
  run(["npm", "install", "--silent"], config.worktreeDir);

  // Symlink shared files (always from the primary worktree, not the current one)
  const primaryDir = getPrimaryDir(config.repoDir);
  for (const relPath of SYMLINK_FILES) {
    const source = path.join(primaryDir, relPath);
    const target = path.join(config.worktreeDir, relPath);
    if (fs.existsSync(source)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Handle existing target for idempotent symlink creation
      if (fs.existsSync(target)) {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || stat.isFile()) {
          fs.unlinkSync(target);
        } else {
          log.warn(`Skipping symlink for ${relPath}: target exists and is not a file or symlink`);
          continue;
        }
      }
      fs.symlinkSync(source, target);
      log.success(`Symlinked ${relPath}`);
    } else {
      log.warn(`No ${relPath} found to symlink`);
    }
  }

  // Summary
  console.log("");
  log.success("Worktree ready!");
  log.info(`Directory: ${config.worktreeDir}`);
  log.info(`Branch:    ${config.branchName}`);
  console.log("");
  console.log("Open in a new agent session (e.g. Claude Code):");
  console.log(`   claude "${config.worktreeDir}"`);
  console.log("");
  console.log("When done, clean up with:");
  console.log(
    `   git worktree remove "${config.worktreeDir}" && git branch -d "${config.branchName}"`,
  );
}

// Only run main when executed directly (not when imported for testing).
// Uses import.meta.main (symlink-aware) so the script runs correctly when
// invoked through a symlink — flow setup symlinks this file from bin/ into
// ~/.local/bin/, and legacy flow install symlinks templates/scripts/'s shim
// (which itself points back here) into <consumer>/scripts/.
if (import.meta.main) {
  try {
    main();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(msg);
    process.exit(1);
  }
}
