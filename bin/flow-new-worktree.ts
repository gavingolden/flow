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
import { spawnSync } from "node:child_process";
import { applyManagedBlock, readGitignore, writeGitignore } from "./lib/gitignore";

// --- Types ---

export type WorktreeConfig = {
  branchName: string;
  baseBranch: string;
  repoDir: string;
  worktreeDir: string;
  /** Reuse an existing worktree at the literal slug rather than auto-suffixing. */
  reuse: boolean;
};

/** Maximum auto-suffix attempts before giving up on collision avoidance. */
export const MAX_SUFFIX_ATTEMPTS = 100;

/** Maximum retries when `git worktree add` itself fails due to a race. */
const MAX_RACE_RETRIES = 5;

/** Filename of the worktree-local branch marker, read by flow-state-update's guard. */
export const BRANCH_MARKER_FILENAME = ".flow-branch";

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
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(stderr || `git ${args[0]} failed with exit code ${result.status}`);
  }
  return (result.stdout ?? "").trim();
}

/** Runs an arbitrary command with an argv array. Throws on non-zero exit. */
function run(argv: string[], cwd?: string): string {
  const [cmd, ...rest] = argv;
  const result = spawnSync(cmd, rest, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(stderr || `${cmd} failed with exit code ${result.status}`);
  }
  return (result.stdout ?? "").trim();
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
Usage: flow-new-worktree <branch-name> [base-branch] [--reuse]

Creates a git worktree for parallel agent development.

Arguments:
  branch-name   Name for the new branch (e.g. feature/new-chart)
  base-branch   Branch to create from (default: auto-detected from origin)

Flags:
  --reuse       Reuse an existing worktree at the literal slug if one
                exists on the requested branch. Without --reuse, the
                helper auto-suffixes (<slug> → <slug>-2 → <slug>-3, ...)
                on collision so concurrent calls return distinct paths.

The worktree is created as a sibling directory to this repo, with the
branch name converted to a directory-safe suffix. Dependencies are
installed and .env / .claude/settings.local.json are symlinked automatically.
A worktree-local marker file (.flow-branch) records the branch name so
flow-state-update can detect cross-pipeline branch contamination.

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
  const repoDir = git(["rev-parse", "--show-toplevel"]);
  const repoName = path.basename(repoDir);
  const dirSuffix = toDirSuffix(branchName);
  const worktreeDir = path.join(path.dirname(repoDir), `${repoName}-${dirSuffix}`);

  const defaultBranch = detectDefaultBranch(repoDir);
  const baseBranch = positional[1] ?? defaultBranch;

  return { branchName, baseBranch, repoDir, worktreeDir, reuse };
}

// --- Slot resolution (auto-suffix collision avoidance) ---

/** Returns true when the named branch ref exists locally. */
function branchExists(branchName: string, repoDir: string): boolean {
  try {
    git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repoDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Picks the first non-colliding (branch, worktreeDir) pair starting from the
 * literal pair, then `<slug>-2`, `<slug>-3`, ..., up to MAX_SUFFIX_ATTEMPTS.
 * The first attempt uses the bare slug (no `-1` suffix) — only collisions
 * trigger numeric suffixing.
 */
export function findAvailableSlot(
  initialBranch: string,
  initialDir: string,
  repoDir: string,
): { branchName: string; worktreeDir: string } {
  for (let i = 1; i <= MAX_SUFFIX_ATTEMPTS; i++) {
    const branchName = i === 1 ? initialBranch : `${initialBranch}-${i}`;
    const worktreeDir = i === 1 ? initialDir : `${initialDir}-${i}`;
    if (!branchExists(branchName, repoDir) && !fs.existsSync(worktreeDir)) {
      return { branchName, worktreeDir };
    }
  }
  throw new Error(
    `flow-new-worktree: could not find an available slot after ${MAX_SUFFIX_ATTEMPTS} attempts ` +
      `(starting from ${initialBranch}). If this many parallel pipelines are intentional, ` +
      `clean up stale worktrees first with 'git worktree list' / 'flow done'.`,
  );
}

/**
 * Validates that an existing directory is a usable worktree on the expected
 * branch. Throws with a message naming what's wrong if the directory isn't
 * a worktree, isn't checked out, or is on a different branch.
 */
function validateReusable(worktreeDir: string, expectedBranch: string): void {
  if (!fs.existsSync(worktreeDir)) {
    throw new Error(`--reuse: no worktree at ${worktreeDir} to reuse`);
  }
  const gitMarker = path.join(worktreeDir, ".git");
  if (!fs.existsSync(gitMarker)) {
    throw new Error(`--reuse: ${worktreeDir} is not a git worktree (no .git entry)`);
  }
  const current = git(["branch", "--show-current"], worktreeDir);
  if (current !== expectedBranch) {
    throw new Error(
      `--reuse: ${worktreeDir} is on branch '${current}', expected '${expectedBranch}'`,
    );
  }
}

// --- Preflight ---

/** Validates that a string is a legal git branch name. Exits with a clear message if not. */
function validateRefName(name: string, label: string): void {
  const result = spawnSync("git", ["check-ref-format", "--branch", name], { encoding: "utf8" });
  if (result.status !== 0) {
    log.error(`Invalid ${label}: '${name}' is not a valid git branch name.`);
    process.exit(1);
  }
}

/** Validates ref-name shape only — collision avoidance is handled separately. */
function preflight(config: WorktreeConfig): void {
  validateRefName(config.branchName, "branch name");
  validateRefName(config.baseBranch, "base branch");
}

// --- Side effects post-creation ---

/** Writes the worktree-local branch-name marker that flow-state-update reads. */
export function writeBranchMarker(worktreeDir: string, branchName: string): void {
  fs.writeFileSync(path.join(worktreeDir, BRANCH_MARKER_FILENAME), branchName + "\n", "utf8");
}

/**
 * Ensures the primary repo's .gitignore contains a `# managed by flow runtime`
 * block listing the branch-marker filename. Idempotent — replaces the block in
 * place if already present.
 */
export function ensureGitignoreMarkerEntry(primaryDir: string): void {
  const existing = readGitignore(primaryDir) ?? "";
  const next = applyManagedBlock(existing, {
    tag: "runtime",
    paths: [BRANCH_MARKER_FILENAME],
  });
  if (next !== existing) writeGitignore(primaryDir, next);
}

/** Symlinks .env and .claude/settings.local.json from the primary worktree. */
function symlinkSharedFiles(worktreeDir: string, primaryDir: string): void {
  for (const relPath of SYMLINK_FILES) {
    const source = path.join(primaryDir, relPath);
    const target = path.join(worktreeDir, relPath);
    if (!fs.existsSync(source)) {
      log.warn(`No ${relPath} found to symlink`);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
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
  }
}

/**
 * Creates the worktree, retrying with a fresh slot if `git worktree add`
 * itself fails due to a peer that won the race between our preflight check
 * and our git call. Returns the actually-used (branch, dir) pair.
 */
function createWorktreeWithRetry(
  initialBranch: string,
  initialDir: string,
  baseBranch: string,
  repoDir: string,
): { branchName: string; worktreeDir: string } {
  const startPoint = `origin/${baseBranch}`;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_RACE_RETRIES; attempt++) {
    const slot = findAvailableSlot(initialBranch, initialDir, repoDir);
    try {
      console.log(`📂 Creating worktree at: ${slot.worktreeDir}`);
      log.info(`Branch: ${slot.branchName} (from ${startPoint})`);
      git(
        ["worktree", "add", slot.worktreeDir, "-b", slot.branchName, startPoint],
        repoDir,
      );
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

// --- Main ---

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

  // Marker + gitignore are idempotent and safe to run on both fresh and reused
  // worktrees — the marker may be missing on a worktree created by an earlier
  // version of this script, and the gitignore block may not yet exist.
  writeBranchMarker(chosen.worktreeDir, chosen.branchName);
  ensureGitignoreMarkerEntry(primaryDir);

  // Summary — always prints the *actual* chosen pair so the supervisor parses
  // the right values when auto-suffix kicks in.
  console.log("");
  log.success(config.reuse ? "Worktree reused!" : "Worktree ready!");
  log.info(`Directory: ${chosen.worktreeDir}`);
  log.info(`Branch:    ${chosen.branchName}`);
  console.log("");
  console.log("Open in a new agent session (e.g. Claude Code):");
  console.log(`   claude "${chosen.worktreeDir}"`);
  console.log("");
  console.log("When done, clean up with:");
  console.log(
    `   git worktree remove "${chosen.worktreeDir}" && git branch -d "${chosen.branchName}"`,
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
