#!/usr/bin/env bun
/**
 * Removes a git worktree and optionally deletes the associated branch.
 *
 * Usage:
 *   flow-remove-worktree [<worktree-path-or-branch>]
 *
 * The positional is optional when invoked from inside a flow tmux pane:
 * the slug auto-resolves from `$TMUX_PANE`'s `@flow-slug` window option
 * and is fed into the same path/branch resolution logic.
 *
 * Examples:
 *   flow-remove-worktree ../flow-agent-improve-tooltips
 *   flow-remove-worktree agent/improve-tooltips
 *   flow-remove-worktree                            # slug from $TMUX_PANE
 */

import * as fs from "fs";
import * as path from "path";
import { resolveSlugFromPane } from "./lib/tmux";
import { detectDefaultBranch, SYMLINK_FILES } from "./lib/worktree-fs";
import { BRANCH_MARKER_FILENAME, FLOW_TMP_DIRNAME } from "./lib/worktree-marker";

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

/**
 * Probes whether `branchName` is fully merged into `refs/remotes/origin/<baseBranch>`.
 * Two primitives in series, each independently try/caught so a transient failure of
 * one (e.g. unfetched ref) does not poison the other. Returns false on any error —
 * the caller's auto-delete path requires positive evidence, so silence is treated
 * as "not merged" (safe default).
 */
function isBranchMerged(branchName: string, baseBranch: string, primaryDir: string): boolean {
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  try {
    const out = git(["branch", "--merged", remoteRef], primaryDir);
    const names = out
      .split("\n")
      .map((line) => line.replace(/^\*/, "").trim())
      .filter(Boolean);
    if (names.includes(branchName)) return true;
  } catch {
    // fall through to merge-base probe
  }
  try {
    const result = Bun.spawnSync(
      ["git", "merge-base", "--is-ancestor", branchName, remoteRef],
      { cwd: primaryDir, stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode === 0) return true;
  } catch {
    // both probes failed — treat as not merged
  }
  return false;
}

// --- Types ---

type WorktreeInfo = {
  /** Absolute path to the worktree directory being removed. */
  worktreeDir: string;
  /** Absolute path to the primary (main) worktree directory. */
  primaryDir: string;
  /** Branch name of the worktree being removed (undefined for detached HEAD). */
  branchName?: string;
};

// --- CLI ---

function printHelp(): void {
  console.log(`
Usage: flow-remove-worktree [<worktree-path-or-branch>]

Removes a git worktree and optionally deletes the associated branch.

Arguments:
  worktree-path-or-branch   Path to the worktree directory, or the branch
                            name used when creating it. Optional inside a
                            flow tmux pane — the slug auto-resolves from
                            $TMUX_PANE's @flow-slug option.

Options:
  --delete-branch            Also delete the branch after removing the worktree.

Examples:
  flow-remove-worktree ../flow-agent-improve-tooltips
  flow-remove-worktree agent/improve-tooltips --delete-branch
  flow-remove-worktree                # slug from \$TMUX_PANE
  `);
}

/**
 * Picks the input to feed into resolveWorktree(). Returns the explicit
 * positional when given, else falls back to the supervisor's pane slug.
 * Pure: tests inject a fake resolveSlug.
 */
export function resolveInput(
  positional: string | undefined,
  resolveSlug: () => string | null,
): string | null {
  if (positional !== undefined) return positional;
  return resolveSlug();
}

// --- Resolution ---

export type WorktreeListEntry = {
  path: string;
  branch?: string;
  bare?: boolean;
};

/** Parses `git worktree list --porcelain` output into structured entries. */
export function parseWorktreeListOutput(raw: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: Partial<WorktreeListEntry> = {};

  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "") {
      if (current.path) {
        entries.push(current as WorktreeListEntry);
      }
      current = {};
    }
  }
  // Push last entry if file doesn't end with blank line
  if (current.path) {
    entries.push(current as WorktreeListEntry);
  }

  return entries;
}

/** Lists worktrees by shelling out to git and parsing the porcelain output. */
function listWorktrees(repoDir: string): WorktreeListEntry[] {
  const raw = git(["worktree", "list", "--porcelain"], repoDir);
  return parseWorktreeListOutput(raw);
}

/** Resolves the user's input (path or branch name) to full worktree info. */
function resolveWorktree(input: string): WorktreeInfo {
  const repoDir = git(["rev-parse", "--show-toplevel"]);
  const worktrees = listWorktrees(repoDir);

  // The primary worktree is the first one listed (the main checkout)
  const primary = worktrees[0];
  if (!primary) {
    log.error("Could not determine the primary worktree.");
    process.exit(1);
  }

  // Try matching by absolute path first
  const absInput = path.resolve(input);
  let match = worktrees.find((w) => w.path === absInput);

  // Fall back to branch name match
  if (!match) {
    match = worktrees.find((w) => w.branch === input);
  }

  // Fall back to directory-suffix match (e.g. "agent/foo" → "*-agent-foo")
  if (!match) {
    const suffix = input.replace(/\//g, "-");
    match = worktrees.find((w) => w.path.endsWith(`-${suffix}`));
  }

  if (!match) {
    log.error(`Could not find a worktree matching '${input}'.`);
    log.info("Current worktrees:");
    for (const w of worktrees) {
      log.info(`  ${w.path} [${w.branch ?? "detached"}]`);
    }
    process.exit(1);
  }

  if (match.path === primary.path) {
    log.error("Cannot remove the primary worktree.");
    process.exit(1);
  }

  return {
    worktreeDir: match.path,
    primaryDir: primary.path,
    branchName: match.branch,
  };
}

// --- Main ---

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const positional = args.filter((a) => !a.startsWith("--"));
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const deleteBranch = flags.has("--delete-branch");

  // Zero-arg path is the load-bearing supervisor case: `flow-remove-worktree`
  // from inside a flow tmux pane resolves the slug from `$TMUX_PANE`'s
  // `@flow-slug` option. Don't print help here — fall through to resolveInput().
  const input = resolveInput(positional[0], () => resolveSlugFromPane());
  if (!input) {
    log.error(
      "Missing required argument: worktree path or branch name.",
    );
    log.info(
      "  No slug given and could not resolve from $TMUX_PANE's @flow-slug option.",
    );
    log.info(
      "  Pass <slug> explicitly, or run inside a tmux window created by `flow new`.",
    );
    process.exit(1);
  }

  const info = resolveWorktree(input);

  console.log(`🗑️  Removing worktree: ${info.worktreeDir}`);
  log.info(`Branch: ${info.branchName ?? "(detached)"}`);
  log.info(`Primary: ${info.primaryDir}`);
  console.log("");

  // Warn about non-symlinked config files that may have local changes
  for (const relPath of SYMLINK_FILES) {
    const worktreeFile = path.join(info.worktreeDir, relPath);
    const primaryFile = path.join(info.primaryDir, relPath);
    if (fs.existsSync(worktreeFile)) {
      const stat = fs.lstatSync(worktreeFile);
      if (!stat.isSymbolicLink() && stat.isFile() && fs.existsSync(primaryFile)) {
        const primaryStat = fs.lstatSync(primaryFile);
        if (!primaryStat.isFile()) continue;
        // Compare contents — warn if they differ
        const worktreeContent = fs.readFileSync(worktreeFile, "utf-8");
        const primaryContent = fs.readFileSync(primaryFile, "utf-8");
        if (worktreeContent !== primaryContent) {
          log.warn(
            `${relPath} in worktree is not a symlink and differs from the primary copy. Changes will be lost.`,
          );
        }
      }
    }
  }

  // Clean flow-owned files before asking git to remove the worktree.
  // `git worktree remove` refuses when the tree contains untracked files. The
  // primary defence is `.git/info/exclude` (registered by `flow-new-worktree`
  // via `ensureFlowExcludes`), which marks both `.flow-tmp/` and `.flow-branch`
  // as ignored across every worktree of the repo. The cleanup below is the
  // fallback for older worktrees whose common dir wasn't yet registered. Scope
  // is strictly these two paths — do not pass `--force` to `git worktree remove`
  // and do not sweep arbitrary untracked files.
  const flowTmpDir = path.join(info.worktreeDir, FLOW_TMP_DIRNAME.replace(/\/$/, ""));
  if (fs.existsSync(flowTmpDir)) {
    log.info(`Cleaning scratch dir: ${flowTmpDir}`);
    fs.rmSync(flowTmpDir, { recursive: true, force: true });
  }
  const branchMarker = path.join(info.worktreeDir, BRANCH_MARKER_FILENAME);
  if (fs.existsSync(branchMarker)) {
    log.info(`Cleaning branch marker: ${branchMarker}`);
    fs.rmSync(branchMarker, { force: true });
  }

  // Remove worktree (use primaryDir as cwd in case we're inside the worktree being removed)
  console.log("🧹 Removing worktree...");
  git(["worktree", "remove", info.worktreeDir], info.primaryDir);
  log.success("Worktree removed.");

  // Auto-delete probe: when --delete-branch wasn't passed AND the per-task branch
  // is provably fully merged into origin/<base>, fall through to the same deletion
  // arm. Detached HEAD skips. Detection failures are swallowed so the existing
  // "kept" arm fires unchanged — auto-delete requires positive evidence.
  let autoDelete = false;
  let baseBranch: string | undefined;
  if (!deleteBranch && info.branchName) {
    try {
      baseBranch = detectDefaultBranch(info.primaryDir);
      if (isBranchMerged(info.branchName, baseBranch, info.primaryDir)) {
        autoDelete = true;
      }
    } catch {
      // Default-branch detection or probe failed — fall through to "kept".
    }
  }

  if (deleteBranch || autoDelete) {
    if (!info.branchName) {
      log.warn(
        "--delete-branch was requested but the worktree had no associated branch (detached HEAD). Skipping branch deletion.",
      );
    } else {
      console.log(`🌿 Deleting branch '${info.branchName}'...`);
      try {
        git(["branch", "-d", info.branchName], info.primaryDir);
        if (autoDelete && !deleteBranch && baseBranch) {
          log.success(
            `Branch '${info.branchName}' deleted (fully merged into origin/${baseBranch}).`,
          );
        } else {
          log.success(`Branch '${info.branchName}' deleted.`);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(`Could not delete branch: ${msg}`);
        log.info(`You may need to force-delete with: git branch -D ${info.branchName}`);
      }
    }
  } else if (info.branchName) {
    log.info(`Branch '${info.branchName}' was kept. Delete it manually when ready:`);
    log.info(`  git branch -d ${info.branchName}`);
  }

  console.log("");
  log.success("Done!");
}

// Only run main when executed directly (not when imported for testing).
// Uses import.meta.main (symlink-aware) so the script runs correctly when
// invoked through a symlink — flow install symlinks this file from
// templates/scripts/ into the target repo's scripts/.
if (import.meta.main) {
  try {
    main();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(msg);
    process.exit(1);
  }
}
