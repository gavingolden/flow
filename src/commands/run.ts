import { execa } from "execa";
import pc from "picocolors";
import { findGitRoot, findTaskFile } from "../util/git.js";
import { readTask } from "../state/task-file.js";
import { runPipeline } from "../pipeline/runner.js";

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
  console.error(pc.dim(`flow: task ${task.frontmatter.id}`));
  console.error(pc.dim(`flow: status ${task.frontmatter.status}`));
  console.error("");

  const result = await runPipeline(task);

  console.error("");
  if (result.status === "ok") {
    const { frontmatter } = await readTask(taskPath);
    console.error(
      pc.green(`flow: pipeline ok — status now ${frontmatter.status}`),
    );
    if (frontmatter.pr) {
      const url = await fetchPrUrl(
        frontmatter.pr,
        frontmatter.worktree ?? repoRoot,
      );
      const line = url ?? `PR #${frontmatter.pr} opened`;
      console.error(pc.green(`flow: ${line}`));
    }
    return;
  }

  console.error(pc.red(`flow: pipeline ${result.status} — ${result.reason}`));
  process.exit(1);
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
