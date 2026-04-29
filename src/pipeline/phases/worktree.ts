import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
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
    const symlinkResult = ensureOrchestratorSymlink(
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

  // Pre-flight: branch exists but no worktree → orphan from a prior crash
  // between `git branch` and `git worktree add`. The script would fail
  // opaquely; surface the actionable command instead.
  const orphan = await detectOrphanBranch(task.frontmatter.target_repo, branch);
  if (orphan) {
    return {
      status: "failed",
      reason: `branch ${branch} already exists but has no matching worktree — delete the orphan with: git -C ${task.frontmatter.target_repo} branch -D ${branch}`,
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

  const symlinkResult = ensureOrchestratorSymlink(
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

async function detectOrphanBranch(
  repoRoot: string,
  branch: string,
): Promise<boolean> {
  const branchExists = await execa(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: repoRoot, reject: false },
  );
  if (branchExists.exitCode !== 0) return false;
  const worktreePath = await findWorktreePath(repoRoot, branch);
  return worktreePath === null;
}

// Symlink `<worktree>/.orchestrator` → `<target_repo>/.orchestrator` so every
// phase running inside the worktree sees the same task files and plan dirs as
// the main repo. Idempotent: leaves a correct symlink alone, replaces a
// wrong-target symlink, refuses to overwrite a regular file or directory.
export function ensureOrchestratorSymlink(
  worktreePath: string,
  targetRepo: string,
): PhaseResult {
  const target = path.join(targetRepo, ".orchestrator");
  const linkPath = path.join(worktreePath, ".orchestrator");

  if (existsSyncOrSymlink(linkPath)) {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const current = readlinkSync(linkPath);
      if (path.resolve(worktreePath, current) === path.resolve(target)) {
        return { status: "ok" };
      }
      unlinkSync(linkPath);
    } else {
      return {
        status: "failed",
        reason: `${linkPath} exists and is not a symlink — refusing to overwrite`,
      };
    }
  }

  symlinkSync(target, linkPath, "dir");
  return { status: "ok" };
}

// `existsSync` follows symlinks, so a broken symlink reports false. Use
// `lstatSync` to detect *anything* at the path (including broken symlinks).
function existsSyncOrSymlink(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
