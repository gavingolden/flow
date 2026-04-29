import { existsSync } from "node:fs";
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
import { NoopLogger, type Logger } from "../../util/logger.js";

export async function runWorktreePhase(
  task: Task,
  logger: Logger = NoopLogger,
): Promise<PhaseResult> {
  // If a prior run already created the worktree (frontmatter populated, dir
  // exists), skip the script. This handles both clean re-invocation and
  // crash-recovery between updateTaskFrontmatter and the final
  // transitionStatus.
  if (task.frontmatter.worktree && existsSync(task.frontmatter.worktree)) {
    logger.info(
      `worktree: already present at ${task.frontmatter.worktree}, skipping script`,
    );
    if (task.frontmatter.status !== "worktree-ready") {
      await transitionStatus(task, "worktree-ready");
      logger.event("task.status", "worktree-ready");
    }
    return { status: "ok" };
  }
  await transitionStatus(task, "creating-worktree");
  logger.event("task.status", "creating-worktree");

  const branch = deriveBranchName(task.frontmatter.id);
  logger.event("worktree.branch", branch);
  const scriptPath = path.join(
    task.frontmatter.target_repo,
    "scripts",
    "new-agent-worktree.ts",
  );
  if (!existsSync(scriptPath)) {
    const reason = `target repo missing ${scriptPath} — flow requires this script for the worktree phase`;
    logger.error(reason);
    return { status: "failed", reason };
  }

  // The script in econ-data uses a `bun` shebang and is chmod +x. Direct
  // invocation respects the shebang (no need for `npx tsx` or `bun run`).
  logger.event("subprocess.spawn", `${scriptPath} ${branch}`);
  const start = Date.now();
  const result = await execa(scriptPath, [branch], {
    cwd: task.frontmatter.target_repo,
    reject: false,
  });
  const durSec = Math.round((Date.now() - start) / 1000);
  logger.event(
    "subprocess.exit",
    `worktree-script exit=${result.exitCode} dur=${durSec}s`,
  );
  if (result.exitCode !== 0) {
    const reason = `worktree script exit ${result.exitCode}: ${result.stderr || result.stdout}`;
    logger.error(reason);
    return { status: "failed", reason };
  }

  const worktreePath = await findWorktreePath(
    task.frontmatter.target_repo,
    branch,
  );
  if (!worktreePath) {
    const reason = `worktree script reported success but branch ${branch} not found in 'git worktree list --porcelain'`;
    logger.error(reason);
    return { status: "failed", reason };
  }
  logger.event("worktree.path", worktreePath);

  await updateTaskFrontmatter(task, { worktree: worktreePath, branch });
  logger.event("task.frontmatter", `worktree=${worktreePath} branch=${branch}`);
  await appendPhaseOutput(
    task,
    "worktree",
    `- Branch: ${branch}\n- Path: ${worktreePath}`,
  );
  logger.event("task.appendPhaseOutput", "worktree");
  await transitionStatus(task, "worktree-ready");
  logger.event("task.status", "worktree-ready");
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
