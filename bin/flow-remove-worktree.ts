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
import {
  BRANCH_MARKER_FILENAME,
  FLOW_TMP_DIRNAME,
} from "./lib/worktree-marker";

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
    throw new Error(
      stderr || `git ${args[0]} failed with exit code ${result.exitCode}`,
    );
  }

  return result.stdout.toString().trim();
}

/**
 * True for the error class `git worktree remove` raises when it has already
 * passed its clean-check (no untracked/modified *tracked* files) but then
 * fails to physically delete the worktree directory. git's deletion phase
 * runs only after the clean-check passes, and prints
 * `error: failed to delete '<path>': <strerror(errno)>` — where the errno is
 * `Directory not empty` (a lingering esbuild service or build-cache write
 * raced the removal), `Operation not permitted`, or `Permission denied` (a
 * file lock). We match the stable `failed to delete` deletion-phase prefix
 * plus the raw `not empty` / `ENOTEMPTY` strings rather than special-casing
 * the literal `.vite` path, so the fallback is robust to `node_modules/.vite`,
 * `.svelte-kit`, esbuild caches, and any other ignored build artifact.
 *
 * Crucially this never matches the clean-check *refusal*
 * (`'<path>' contains modified or untracked files, use --force to delete it`):
 * that message has no `failed to delete` / `not empty` token, so a worktree
 * with genuinely uncommitted tracked work still refuses — the rm-rf escalation
 * fires only once git itself has confirmed the only leftover is ignored content.
 */
export function isRemovalPhaseFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("failed to delete") ||
    m.includes("not empty") ||
    m.includes("enotempty")
  );
}

/**
 * True for the error class `git worktree remove` raises when git has already
 * DEREGISTERED the worktree (it is gone from `git worktree list`) but the
 * directory + branch still exist on disk: `fatal: '<path>' is not a working
 * tree`. This fails immediately, before git's clean-check, so there is nothing
 * to retry — a re-run fails identically. Distinct from {@link isRemovalPhaseFailure}
 * (a post-clean-check deletion failure) and from the clean-check refusal
 * ('contains modified or untracked files, use --force'), neither of which
 * contains the `not a working tree` token; keeping it a separate predicate
 * keeps all three classes independently testable.
 */
export function isDeregisteredFailure(message: string): boolean {
  return message.toLowerCase().includes("not a working tree");
}

/** Injectable dependencies for {@link removeWorktreeWithFallback} (tests stub these). */
export type RemoveWorktreeDeps = {
  /** Runs a git command; throws on non-zero exit (real impl: {@link git}). */
  git: (args: string[], cwd?: string) => string;
  /** Force-removes a directory tree (real impl: `fs.rmSync(dir, {recursive, force})`). */
  rmrf: (dir: string) => void;
  /** Logger (real impl: the module-level {@link log}). */
  warn: (msg: string) => void;
};

/**
 * Removes a worktree, keeping the no-`--force` `git worktree remove` as the
 * PRIMARY path so a manual invocation on a worktree with uncommitted tracked
 * work still refuses. Only when git's *own* removal fails on a deletion-phase
 * error (see {@link isRemovalPhaseFailure}) — by which point git has already
 * confirmed the tree is clean of untracked/modified tracked files — do we
 * escalate to `rm -rf <worktreeDir>` + `git worktree prune` to guarantee the
 * leftover ignored build artifacts (node_modules/.vite, .svelte-kit, …) are
 * cleared and the stale worktree admin entry pruned. A single immediate retry
 * runs before the rm-rf fallback to absorb a transient open-handle race.
 *
 * Returns normally on success (the caller proceeds to branch deletion);
 * re-throws any non-deletion-phase failure unchanged (no auto-`--force`). The
 * already-deregistered class (see {@link isDeregisteredFailure}) is also handled
 * — rm -rf + advisory prune, no retry — alongside the deletion-phase class.
 */
export function removeWorktreeWithFallback(
  worktreeDir: string,
  primaryDir: string,
  deps: RemoveWorktreeDeps,
): void {
  try {
    deps.git(["worktree", "remove", worktreeDir], primaryDir);
    return;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);

    // Already-deregistered class: git dropped this worktree from its admin
    // list but the directory still exists, so `git worktree remove` failed
    // immediately with `'<path>' is not a working tree` — before any
    // clean-check, and with nothing to retry. Finish the cleanup the caller
    // expected: rm -rf the leftover directory, prune the stale admin entry
    // (advisory — a prune failure must NOT abort before branch deletion),
    // then return so the caller proceeds to delete the branch.
    if (isDeregisteredFailure(msg)) {
      deps.warn(
        `git worktree remove reported '${worktreeDir}' is not a working tree (already deregistered); forcing rm -rf + git worktree prune.`,
      );
      deps.rmrf(worktreeDir);
      try {
        deps.git(["worktree", "prune"], primaryDir);
      } catch (pruneErr: unknown) {
        const pruneMsg =
          pruneErr instanceof Error ? pruneErr.message : String(pruneErr);
        deps.warn(
          `git worktree prune failed after rm -rf (continuing): ${pruneMsg}`,
        );
      }
      return;
    }

    // A genuine clean-check refusal (uncommitted tracked work) is NOT a
    // deletion-phase failure — re-throw without forcing.
    if (!isRemovalPhaseFailure(msg)) throw e;

    // Retry once: a lingering esbuild service may release its handle between
    // the first attempt and now, letting git's own removal succeed cleanly.
    try {
      deps.git(["worktree", "remove", worktreeDir], primaryDir);
      return;
    } catch (retryErr: unknown) {
      const retryMsg =
        retryErr instanceof Error ? retryErr.message : String(retryErr);
      if (!isRemovalPhaseFailure(retryMsg)) throw retryErr;
    }

    deps.warn(
      `git worktree remove failed on leftover ignored content; forcing rm -rf '${worktreeDir}' + git worktree prune.`,
    );
    deps.rmrf(worktreeDir);
    // `prune` is advisory here: rm -rf already removed the working tree, so a
    // prune failure (e.g. transient .git/worktrees lock contention from a
    // parallel pipeline) must NOT propagate — that would abort the caller
    // before branch deletion and re-strand the user in the exact failure this
    // fallback exists to fix. Worst case is a stale admin entry the next
    // `git worktree prune` reaps.
    try {
      deps.git(["worktree", "prune"], primaryDir);
    } catch (pruneErr: unknown) {
      const pruneMsg =
        pruneErr instanceof Error ? pruneErr.message : String(pruneErr);
      deps.warn(
        `git worktree prune failed after rm -rf (continuing): ${pruneMsg}`,
      );
    }
  }
}

/**
 * True for `git branch -d`'s refusal of a branch whose commits are absent from
 * the base's history — `error: the branch '<name>' is not fully merged`. A
 * squash-merge always produces this (the squashed commit is a new object, so
 * the branch tip is never an ancestor of base), which is why a squash-merged
 * branch is left behind by a plain `-d`.
 */
export function isNotFullyMergedFailure(message: string): boolean {
  return message.toLowerCase().includes("not fully merged");
}

/** Discriminated result of {@link deleteBranchWithForceFallback}. */
export type BranchDeleteResult =
  | { status: "deleted" }
  | { status: "force-deleted" }
  | { status: "failed"; message: string };

/**
 * Deletes `branchName` via the safe `git branch -d`. When `-d` refuses with
 * 'not fully merged' (the squash-merge case) AND `allowForceFallback` is set —
 * i.e. the caller passed an explicit `--delete-branch`, an unambiguous
 * instruction to delete the branch regardless of merge state — retry once with
 * the force form `git branch -D`. Any OTHER `-d` failure, or the auto-delete
 * path (where positive merge evidence already vouched for the branch, so a
 * refusal is unexpected and must stay warn-only), does NOT escalate to `-D`.
 * `git` is injected so the fallback is unit-testable via the same seam as
 * {@link removeWorktreeWithFallback}; all logging stays in the caller.
 */
export function deleteBranchWithForceFallback(
  branchName: string,
  primaryDir: string,
  allowForceFallback: boolean,
  git: (args: string[], cwd?: string) => string,
): BranchDeleteResult {
  try {
    git(["branch", "-d", branchName], primaryDir);
    return { status: "deleted" };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (allowForceFallback && isNotFullyMergedFailure(msg)) {
      try {
        git(["branch", "-D", branchName], primaryDir);
        return { status: "force-deleted" };
      } catch (forceErr: unknown) {
        const forceMsg =
          forceErr instanceof Error ? forceErr.message : String(forceErr);
        return { status: "failed", message: forceMsg };
      }
    }
    return { status: "failed", message: msg };
  }
}

/**
 * Probes whether `branchName` is fully merged into `refs/remotes/origin/<baseBranch>`.
 * Two primitives in series, each independently try/caught so a transient failure of
 * one (e.g. unfetched ref) does not poison the other. Returns false on any error —
 * the caller's auto-delete path requires positive evidence, so silence is treated
 * as "not merged" (safe default).
 */
function isBranchMerged(
  branchName: string,
  baseBranch: string,
  primaryDir: string,
): boolean {
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
    log.error("Missing required argument: worktree path or branch name.");
    log.info(
      "  No slug given and could not resolve from $TMUX_PANE's @flow-slug option.",
    );
    log.info(
      "  Pass <slug> explicitly, or run inside a tmux window created by `flow feature create`.",
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
      if (
        !stat.isSymbolicLink() &&
        stat.isFile() &&
        fs.existsSync(primaryFile)
      ) {
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
  const flowTmpDir = path.join(
    info.worktreeDir,
    FLOW_TMP_DIRNAME.replace(/\/$/, ""),
  );
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
  removeWorktreeWithFallback(info.worktreeDir, info.primaryDir, {
    git,
    rmrf: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    warn: log.warn,
  });
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
      // Force-fallback (-d → -D) only on an explicit --delete-branch: that flag
      // is an instruction to delete the branch regardless of merge state, and a
      // squash-merged branch can never satisfy `-d`. The auto-delete path keeps
      // warn-only — its merge probe already vouched for the branch.
      const result = deleteBranchWithForceFallback(
        info.branchName,
        info.primaryDir,
        deleteBranch,
        git,
      );
      if (result.status === "deleted") {
        if (autoDelete && !deleteBranch && baseBranch) {
          log.success(
            `Branch '${info.branchName}' deleted (fully merged into origin/${baseBranch}).`,
          );
        } else {
          log.success(`Branch '${info.branchName}' deleted.`);
        }
      } else if (result.status === "force-deleted") {
        log.success(
          `Branch '${info.branchName}' force-deleted (was not fully merged — likely squash-merged).`,
        );
      } else {
        log.warn(`Could not delete branch: ${result.message}`);
        log.info(
          `You may need to force-delete with: git branch -D ${info.branchName}`,
        );
      }
    }
  } else if (info.branchName) {
    log.info(
      `Branch '${info.branchName}' was kept. Delete it manually when ready:`,
    );
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
