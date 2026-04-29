import path from "node:path";
import { execa } from "execa";
import pc from "picocolors";
import { findGitRoot, findTaskFile } from "../util/git.js";
import { readTask } from "../state/task-file.js";
import { runPipeline } from "../pipeline/runner.js";
import { createLogger } from "../util/logger.js";

export async function runCommand(taskId: string): Promise<void> {
  const repoRoot = await findGitRoot();
  if (!repoRoot) {
    console.error(
      pc.red("error: flow run must be executed inside a git repository"),
    );
    process.exit(1);
  }

  const taskPath = await findTaskFile(taskId, repoRoot);
  if (!taskPath) {
    console.error(
      pc.red(
        `error: task '${taskId}' not found in .orchestrator/tasks/ or .orchestrator/tasks/archive/`,
      ),
    );
    process.exit(1);
  }

  const task = await readTask(taskPath);
  const logger = await createLogger({
    runsDir: path.join(repoRoot, ".orchestrator", "runs"),
    taskId: task.frontmatter.id,
  });
  let exitCode = 0;
  try {
    logger.info(`log → ${logger.filePath}`);
    logger.info(`task ${task.frontmatter.id}`);
    logger.info(`status ${task.frontmatter.status}`);

    const result = await runPipeline(task, logger);

    if (result.status === "ok") {
      const { frontmatter } = await readTask(taskPath);
      logger.success(`pipeline ok — status now ${frontmatter.status}`);
      if (frontmatter.pr) {
        const url = await fetchPrUrl(
          frontmatter.pr,
          frontmatter.worktree ?? repoRoot,
        );
        logger.success(url ?? `PR #${frontmatter.pr} opened`);
      }
      return;
    }

    logger.error(`pipeline ${result.status} — ${result.reason}`);
    exitCode = 1;
  } catch (err) {
    // An uncaught throw from runPipeline (a phase that threw past the
    // PhaseResult contract, an FS error, etc.) would otherwise bypass
    // the persistent log entirely — finally closes the stream but no
    // ERROR line was ever written. Surface it through the logger so
    // the run's log file actually records why we died, then re-raise
    // so Node still exits non-zero.
    const e = err as { message?: string; stack?: string };
    logger.error(`pipeline crashed: ${e.message ?? String(err)}`);
    if (e.stack) logger.error(e.stack);
    exitCode = 1;
    throw err;
  } finally {
    await logger.close();
    if (exitCode !== 0) process.exit(exitCode);
  }
}

async function fetchPrUrl(
  prNumber: number,
  cwd: string,
): Promise<string | null> {
  // execa with reject:false still throws on spawn-time errors (gh missing,
  // cwd deleted). The success path of `flow run` must never crash on a
  // best-effort URL lookup, so swallow any throw and let the caller fall
  // back to the bare `PR #<n>` line.
  try {
    const result = await execa(
      "gh",
      ["pr", "view", String(prNumber), "--json", "url", "-q", ".url"],
      { cwd, reject: false },
    );
    if (result.exitCode !== 0) return null;
    const url = result.stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}
