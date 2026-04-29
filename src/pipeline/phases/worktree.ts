import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import {
  Task,
  appendPhaseOutput,
  transitionStatus,
  updateTaskFrontmatter,
} from "../../state/task-file.js";
import { deriveBranchName } from "../../state/ids.js";
import { PhaseResult } from "../types.js";

export async function runWorktreePhase(task: Task): Promise<PhaseResult> {
  // If a prior run already created the worktree (frontmatter populated, dir
  // exists), skip the script. This handles both clean re-invocation and
  // crash-recovery between updateTaskFrontmatter and the final
  // transitionStatus.
  if (task.frontmatter.worktree && existsSync(task.frontmatter.worktree)) {
    const symlinkResult = await ensureOrchestratorSymlink(
      task.frontmatter.worktree,
      task.frontmatter.target_repo,
    );
    if (symlinkResult.status !== "ok") return symlinkResult;
    if (task.frontmatter.status !== "worktree-ready") {
      await transitionStatus(task, "worktree-ready");
    }
    return { status: "ok" };
  }
  await transitionStatus(task, "creating-worktree");

  const branch = deriveBranchName(task.frontmatter.id);

  // Pre-flight: branch exists. Two sub-cases:
  //   (a) worktree exists too — prior run crashed *after* worktree creation
  //       but *before* frontmatter was written. Reuse the worktree instead
  //       of re-running the script (which would fail with "branch already
  //       exists").
  //   (b) worktree missing — true orphan. Surface the actionable command.
  const branchExists = await branchExistsLocally(
    task.frontmatter.target_repo,
    branch,
  );
  if (branchExists) {
    const existingWorktreePath = await findWorktreePath(
      task.frontmatter.target_repo,
      branch,
    );
    if (existingWorktreePath) {
      return finalizeWorktree(task, branch, existingWorktreePath);
    }
    return {
      status: "failed",
      reason: `branch ${branch} already exists but has no matching worktree — delete the orphan with: git -C ${shellQuote(task.frontmatter.target_repo)} branch -D ${shellQuote(branch)}`,
    };
  }

  const scriptPath = path.join(
    task.frontmatter.target_repo,
    "scripts",
    "new-agent-worktree.ts",
  );
  if (!existsSync(scriptPath)) {
    return {
      status: "failed",
      reason: `target repo missing ${scriptPath} — flow requires this script for the worktree phase`,
    };
  }

  // The script in econ-data uses a `bun` shebang and is chmod +x. Direct
  // invocation respects the shebang (no need for `npx tsx` or `bun run`).
  const result = await execa(scriptPath, [branch], {
    cwd: task.frontmatter.target_repo,
    reject: false,
  });
  if (result.exitCode !== 0) {
    return {
      status: "failed",
      reason: `worktree script exit ${result.exitCode}: ${result.stderr || result.stdout}`,
    };
  }

  const worktreePath = await findWorktreePath(
    task.frontmatter.target_repo,
    branch,
  );
  if (!worktreePath) {
    return {
      status: "failed",
      reason: `worktree script reported success but branch ${branch} not found in 'git worktree list --porcelain'`,
    };
  }

  return finalizeWorktree(task, branch, worktreePath);
}

// Shared "the worktree exists, populate frontmatter and transition" tail used
// by both the fresh-create path and the crash-recovery branch (branch and
// worktree both exist from a prior run, but frontmatter was never updated).
async function finalizeWorktree(
  task: Task,
  branch: string,
  worktreePath: string,
): Promise<PhaseResult> {
  const symlinkResult = await ensureOrchestratorSymlink(
    worktreePath,
    task.frontmatter.target_repo,
  );
  if (symlinkResult.status !== "ok") return symlinkResult;

  await updateTaskFrontmatter(task, { worktree: worktreePath, branch });
  await appendPhaseOutput(
    task,
    "worktree",
    `- Branch: ${branch}\n- Path: ${worktreePath}`,
  );
  await transitionStatus(task, "worktree-ready");
  return { status: "ok" };
}

async function findWorktreePath(
  repoRoot: string,
  branch: string,
): Promise<string | null> {
  const { stdout } = await execa(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd: repoRoot },
  );
  const stanzas = stdout.split(/\n\n+/);
  for (const stanza of stanzas) {
    const lines = stanza.split("\n");
    const pathLine = lines.find((l) => l.startsWith("worktree "));
    const branchLine = lines.find((l) => l.startsWith("branch "));
    if (!pathLine || !branchLine) continue;
    if (branchLine === `branch refs/heads/${branch}`) {
      return pathLine.slice("worktree ".length);
    }
  }
  return null;
}

async function branchExistsLocally(
  repoRoot: string,
  branch: string,
): Promise<boolean> {
  const result = await execa(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: repoRoot, reject: false },
  );
  return result.exitCode === 0;
}

// Symlink `<worktree>/.orchestrator` → `<target_repo>/.orchestrator` so every
// phase running inside the worktree sees the same task files and plan dirs as
// the main repo. Idempotent: leaves a correct symlink alone, replaces a
// wrong-target symlink, refuses to overwrite a regular file or directory.
//
// Wrapped in try/catch so any FS failure (permissions, parent-dir gone, the
// rare Windows symlink-without-admin case, etc.) maps onto the PhaseResult
// failure variant instead of throwing past the orchestrator's phase boundary.
export async function ensureOrchestratorSymlink(
  worktreePath: string,
  targetRepo: string,
): Promise<PhaseResult> {
  const target = path.join(targetRepo, ".orchestrator");
  const linkPath = path.join(worktreePath, ".orchestrator");

  try {
    // `fs.access` follows symlinks, so a broken or wrong-target symlink would
    // miss; `fs.lstat` detects anything at the path including broken symlinks.
    const existing = await lstatOrNull(linkPath);
    if (existing) {
      if (existing.isSymbolicLink()) {
        const current = await fs.readlink(linkPath);
        if (path.resolve(worktreePath, current) === path.resolve(target)) {
          return { status: "ok" };
        }
        await fs.unlink(linkPath);
      } else {
        return {
          status: "failed",
          reason: `${linkPath} exists and is not a symlink — refusing to overwrite`,
        };
      }
    }

    await fs.symlink(target, linkPath, "dir");
    return { status: "ok" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      reason: `failed to ensure orchestrator symlink at ${linkPath}: ${reason}`,
    };
  }
}

async function lstatOrNull(
  p: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

// POSIX shell single-quote escape for embedding paths in a copy/pasteable
// remediation command. Wraps the value in single quotes and replaces any
// internal single quote with the standard `'\''` close-escape-open dance.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
