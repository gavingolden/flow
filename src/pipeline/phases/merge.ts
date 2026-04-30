import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { execa } from "execa";
import {
  Task,
  appendPhaseOutput,
  transitionStatus,
  updateTaskFrontmatter,
} from "../../state/task-file.js";
import { PhaseResult } from "../types.js";
import { NoopLogger, type Logger } from "../../util/logger.js";
import { NoopJsonlSink, type JsonlSink } from "../../util/jsonl-sink.js";

interface GhPrStateView {
  state?: string;
  mergeCommit?: { oid?: string } | null;
}

export async function runMergePhase(
  task: Task,
  logger: Logger = NoopLogger,
  jsonl: JsonlSink = NoopJsonlSink,
): Promise<PhaseResult> {
  jsonl.event("merge.start", {
    pr: task.frontmatter.pr,
    status: task.frontmatter.status,
  });

  if (task.frontmatter.pr == null) {
    const reason = "merge phase requires task.frontmatter.pr (set by implement); got null";
    logger.error(reason);
    await appendPhaseOutput(task, "merge", `Cannot run merge: ${reason}`);
    await transitionStatus(task, "needs-human", "pr-missing");
    jsonl.event("merge.exit", { result: "needs-human", reason: "pr-missing" });
    return { status: "needs-human", reason: "pr-missing" };
  }
  if (!task.frontmatter.worktree) {
    // Frontmatter-null is a structural issue (worktree phase never set it).
    // Distinct from "worktree directory was already removed on disk" — that
    // case is best-effort below.
    const reason = "merge phase requires a worktree path in frontmatter (set by worktree phase)";
    logger.error(reason);
    await appendPhaseOutput(task, "merge", `Cannot run merge: ${reason}`);
    await transitionStatus(task, "needs-human", "worktree-missing");
    jsonl.event("merge.exit", { result: "needs-human", reason: "worktree-missing" });
    return { status: "needs-human", reason: "worktree-missing" };
  }

  const pr = task.frontmatter.pr;
  const worktree = task.frontmatter.worktree;
  const targetRepo = task.frontmatter.target_repo;
  const branch = task.frontmatter.branch;
  // Use target_repo as the cwd for `gh` calls if the worktree directory has
  // already been removed on disk (resume after a partial cleanup). The PR
  // is identified by number; gh just needs *some* gh-aware cwd.
  const ghCwd = existsSync(worktree) ? worktree : targetRepo;

  // Re-check PR state. Idempotent short-circuit when the merge already
  // happened (resume path or gated→user-merged-externally).
  logger.event("merge.gh.pr-view", `pr=#${pr}`);
  const view = await execa(
    "gh",
    ["pr", "view", String(pr), "--json", "state,mergeCommit"],
    { cwd: ghCwd, reject: false },
  );
  jsonl.event("merge.gh.pr-view", {
    pr,
    exitCode: view.exitCode,
    stderr: truncate(view.stderr ?? "", 500),
  });

  if (view.exitCode !== 0) {
    const detail = (view.stderr || view.stdout || `exit ${view.exitCode}`).trim();
    const reason = `gh pr view #${pr} failed: ${detail}`;
    logger.error(reason);
    await appendPhaseOutput(
      task,
      "merge",
      `- PR: #${pr}\n- Decision: needs-human (gh-error fetching PR state)\n\n\`\`\`text\n${truncate(detail, 1000)}\n\`\`\``,
    );
    await transitionStatus(task, "needs-human", "gh-error");
    jsonl.event("merge.exit", { result: "needs-human", reason: "gh-error" });
    return { status: "needs-human", reason: "gh-error" };
  }

  let viewPayload: GhPrStateView;
  try {
    viewPayload = JSON.parse(view.stdout) as GhPrStateView;
  } catch (err) {
    const reason = `gh pr view #${pr} produced unparseable JSON: ${(err as Error).message}`;
    logger.error(reason);
    await appendPhaseOutput(task, "merge", `Cannot run merge: ${reason}`);
    await transitionStatus(task, "needs-human", "gh-error");
    jsonl.event("merge.exit", { result: "needs-human", reason: "gh-error" });
    return { status: "needs-human", reason: "gh-error" };
  }

  const initialState = (viewPayload.state ?? "").toUpperCase();
  let mergeCommitSha: string | null =
    viewPayload.mergeCommit?.oid?.trim() || null;
  let mergedNow = false;

  if (initialState === "CLOSED") {
    // PR was closed without a merge between gate and merge. Defensive:
    // shouldn't happen on the canonical path because gate routes CLOSED
    // to needs-human. Mirror the gate branch for consistency.
    await appendPhaseOutput(
      task,
      "merge",
      `- PR: #${pr}\n- State: CLOSED (without merge)\n- Decision: needs-human — PR was closed between gate and merge`,
    );
    await transitionStatus(task, "needs-human", "pr-closed-without-merge");
    jsonl.event("merge.exit", {
      result: "needs-human",
      reason: "pr-closed-without-merge",
    });
    return { status: "needs-human", reason: "pr-closed-without-merge" };
  }

  if (initialState !== "MERGED") {
    // OPEN (or unknown) — perform the squash-merge.
    logger.event("merge.gh.pr-merge", `pr=#${pr}`);
    const mergeRes = await execa(
      "gh",
      ["pr", "merge", String(pr), "--squash", "--delete-branch"],
      { cwd: ghCwd, reject: false },
    );
    jsonl.event("merge.gh.pr-merge", {
      pr,
      exitCode: mergeRes.exitCode,
      stderr: truncate(mergeRes.stderr ?? "", 500),
    });
    if (mergeRes.exitCode !== 0) {
      const detail = (mergeRes.stderr || mergeRes.stdout || `exit ${mergeRes.exitCode}`).trim();
      const reason = `gh pr merge #${pr} failed: ${detail}`;
      logger.error(reason);
      await appendPhaseOutput(
        task,
        "merge",
        `- PR: #${pr}\n- Decision: needs-human (gh pr merge failed — likely permissions or branch protection)\n\n\`\`\`text\n${truncate(detail, 1000)}\n\`\`\``,
      );
      await transitionStatus(task, "needs-human", "gh-merge-failed");
      jsonl.event("merge.exit", {
        result: "needs-human",
        reason: "gh-merge-failed",
      });
      return { status: "needs-human", reason: "gh-merge-failed" };
    }
    mergedNow = true;

    // gh pr merge stdout doesn't reliably include the SHA across versions —
    // re-fetch via pr view so we capture it deterministically.
    const postView = await execa(
      "gh",
      ["pr", "view", String(pr), "--json", "mergeCommit"],
      { cwd: ghCwd, reject: false },
    );
    if (postView.exitCode === 0) {
      try {
        const parsed = JSON.parse(postView.stdout) as GhPrStateView;
        const oid = parsed.mergeCommit?.oid?.trim() || null;
        if (oid) mergeCommitSha = oid;
      } catch {
        // Non-fatal: leave mergeCommitSha null and warn below.
      }
    }
  }

  if (mergeCommitSha && task.frontmatter.merge_commit !== mergeCommitSha) {
    await updateTaskFrontmatter(task, { merge_commit: mergeCommitSha });
    logger.event("task.frontmatter", `merge_commit=${mergeCommitSha}`);
  }

  // Worktree removal — best-effort. If the worktree directory is already
  // gone (prior partial run), skip the script invocation entirely; nothing
  // to remove.
  let worktreeOutcome: "removed" | "already-gone" | "warn" = "already-gone";
  let worktreeWarn: string | null = null;
  if (existsSync(worktree)) {
    const removeScript = path.join(targetRepo, "scripts", "remove-agent-worktree.ts");
    if (!existsSync(removeScript)) {
      worktreeOutcome = "warn";
      worktreeWarn = `remove-agent-worktree.ts not found at ${removeScript}; manual cleanup required`;
      logger.warn(worktreeWarn);
      jsonl.event("merge.worktree-removal-failed", { reason: worktreeWarn });
    } else {
      const args = branch ? [branch, "--delete-branch"] : [worktree];
      try {
        const rm = await execa(removeScript, args, {
          cwd: targetRepo,
          reject: false,
        });
        if (rm.exitCode === 0) {
          worktreeOutcome = "removed";
          jsonl.event("merge.worktree-removed", { worktree, branch });
        } else {
          const detail = (rm.stderr || rm.stdout || `exit ${rm.exitCode}`).trim();
          worktreeOutcome = "warn";
          worktreeWarn = `remove-agent-worktree.ts exit ${rm.exitCode}: ${truncate(detail, 500)}`;
          logger.warn(worktreeWarn);
          jsonl.event("merge.worktree-removal-failed", { reason: worktreeWarn });
        }
      } catch (err) {
        const e = err as { shortMessage?: string; message?: string };
        worktreeOutcome = "warn";
        worktreeWarn = `remove-agent-worktree.ts threw: ${e.shortMessage ?? e.message ?? String(err)}`;
        logger.warn(worktreeWarn);
        jsonl.event("merge.worktree-removal-failed", { reason: worktreeWarn });
      }
    }
  }

  // Archive: lazy-mkdir the destination, then atomic rename.
  const archiveDir = path.join(targetRepo, ".orchestrator", "tasks", "archive");
  const archivePath = path.join(archiveDir, `${task.frontmatter.id}.md`);
  await fs.mkdir(archiveDir, { recursive: true });
  // If the task file is already at the archive path (idempotent re-entry
  // after a crash between rename and the final transition), skip the
  // rename and proceed straight to the transition with the existing path.
  if (task.path !== archivePath) {
    if (existsSync(task.path)) {
      await fs.rename(task.path, archivePath);
    } else if (!existsSync(archivePath)) {
      // Pathological: the source is gone but the destination doesn't exist
      // either. Surface clearly rather than letting the next write ENOENT.
      const reason = `task file missing during archive: ${task.path}`;
      logger.error(reason);
      jsonl.event("merge.exit", { result: "failed", reason });
      return { status: "failed", reason };
    }
    task.path = archivePath;
    jsonl.event("merge.archive", { from: archivePath, id: task.frontmatter.id });
  }

  // Render the phase output before the final transition so the renamed
  // task file carries it.
  await appendPhaseOutput(
    task,
    "merge",
    renderMergeSection({
      pr,
      mergedNow,
      mergeCommitSha,
      worktreeOutcome,
      worktreeWarn,
      branch,
      archivePath,
    }),
  );

  await transitionStatus(task, "merged");
  logger.event("task.status", "merged");
  jsonl.event("merge.exit", { result: "ok" });
  return { status: "ok" };
}

interface RenderArgs {
  pr: number;
  mergedNow: boolean;
  mergeCommitSha: string | null;
  worktreeOutcome: "removed" | "already-gone" | "warn";
  worktreeWarn: string | null;
  branch: string | null;
  archivePath: string;
}

function renderMergeSection(a: RenderArgs): string {
  const lines: string[] = [
    `- PR: #${a.pr}`,
    `- Merge: ${a.mergedNow ? "squash-merged via gh pr merge" : "PR was already merged (idempotent short-circuit)"}`,
    `- merge_commit: ${a.mergeCommitSha ?? "(unknown — gh did not report)"}`,
    `- Branch: ${a.branch ?? "(none)"} ${a.mergedNow ? "(deleted)" : ""}`.trimEnd(),
  ];
  if (a.worktreeOutcome === "removed") {
    lines.push("- Worktree: removed");
  } else if (a.worktreeOutcome === "already-gone") {
    lines.push("- Worktree: already gone (no-op)");
  } else {
    lines.push(`- Worktree: WARN: ${a.worktreeWarn ?? "(unspecified)"}`);
  }
  lines.push(`- Archived: ${a.archivePath}`);
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated]`;
}
