import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";
import { runMergePhase } from "./merge.js";
import {
  __setNotifierForTests,
  readTask,
  writeTask,
  type Task,
} from "../../state/task-file.js";
import { NoopNotifier } from "../../util/notify.js";
import { TaskStatus } from "../../state/phases.js";
import { NoopLogger, type Logger } from "../../util/logger.js";
import type { JsonlSink } from "../../util/jsonl-sink.js";

interface FakeJsonl {
  event: ReturnType<typeof vi.fn>;
  pipeFrom: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  filePath: string;
}

function makeJsonl(): FakeJsonl & JsonlSink {
  return {
    filePath: "/tmp/fake-jsonl",
    event: vi.fn(),
    pipeFrom: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

interface SilentLogger extends Logger {
  warns: string[];
  errors: string[];
}

function makeLogger(): SilentLogger {
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    ...NoopLogger,
    warn(msg: string) {
      warns.push(msg);
    },
    error(msg: string) {
      errors.push(msg);
    },
    warns,
    errors,
  };
}

interface SetupOpts {
  status: TaskStatus;
  pr: number | null;
  worktreeOnDisk?: boolean;
  worktreeNullInFrontmatter?: boolean;
  removeScriptOnDisk?: boolean;
  mergeCommit?: string | null;
}

async function setup(opts: SetupOpts): Promise<{
  tmp: string;
  task: Task;
  worktreePath: string | null;
}> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-merge-"));
  let worktreePath: string | null = null;
  if (opts.worktreeNullInFrontmatter) {
    worktreePath = null;
  } else {
    worktreePath = path.join(tmp, "worktree");
    if (opts.worktreeOnDisk !== false) {
      await fs.mkdir(worktreePath, { recursive: true });
    }
  }

  // remove-agent-worktree.ts shim. Default present so the worktree-removal
  // step exercises the success path.
  if (opts.removeScriptOnDisk !== false) {
    const scriptsDir = path.join(tmp, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, "remove-agent-worktree.ts");
    await fs.writeFile(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(scriptPath, 0o755);
  }

  const taskId = "2026-04-30-merge-test";
  const tasksDir = path.join(tmp, ".orchestrator", "tasks");
  await fs.mkdir(tasksDir, { recursive: true });
  const taskPath = path.join(tasksDir, `${taskId}.md`);

  const initial: Task = {
    path: taskPath,
    frontmatter: {
      id: taskId,
      status: opts.status,
      created: "2026-04-30T00:00:00.000Z",
      updated: "2026-04-30T00:00:00.000Z",
      target_repo: tmp,
      worktree: worktreePath,
      branch: "agent/test",
      pr: opts.pr,
      manual_validation: false,
      merge_commit: opts.mergeCommit ?? null,
    },
    body: [
      "## User prompt",
      "",
      "test",
      "",
      "## Phase log",
      "",
      "## Phase outputs",
      "",
    ].join("\n"),
  };
  await writeTask(initial);
  const task = await readTask(taskPath);
  return { tmp, task, worktreePath };
}

interface ExecaCall {
  cmd: string;
  args: readonly string[];
}

interface MockResponses {
  prViewBeforeMerge?: { exitCode?: number; stdout?: string; stderr?: string };
  prMerge?: { exitCode?: number; stdout?: string; stderr?: string };
  prViewAfterMerge?: { exitCode?: number; stdout?: string; stderr?: string };
  removeWorktree?: { exitCode?: number; stdout?: string; stderr?: string };
}

function installExecaMock(
  responses: MockResponses,
  callsRef: ExecaCall[],
): void {
  let prViewCallCount = 0;
  vi.mocked(execa).mockImplementation((async (cmd: string, args: string[]) => {
    callsRef.push({ cmd, args });
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
      prViewCallCount += 1;
      if (prViewCallCount === 1) {
        const r = responses.prViewBeforeMerge ?? { exitCode: 0, stdout: "{}" };
        return {
          exitCode: r.exitCode ?? 0,
          stdout: r.stdout ?? "{}",
          stderr: r.stderr ?? "",
        };
      }
      const r = responses.prViewAfterMerge ?? { exitCode: 0, stdout: "{}" };
      return {
        exitCode: r.exitCode ?? 0,
        stdout: r.stdout ?? "{}",
        stderr: r.stderr ?? "",
      };
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "merge") {
      const r = responses.prMerge ?? { exitCode: 0 };
      return {
        exitCode: r.exitCode ?? 0,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      };
    }
    if (cmd.endsWith("remove-agent-worktree.ts")) {
      const r = responses.removeWorktree ?? { exitCode: 0 };
      return {
        exitCode: r.exitCode ?? 0,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      };
    }
    throw new Error(`unexpected execa: ${cmd} ${JSON.stringify(args)}`);
  }) as never);
}

describe("runMergePhase", () => {
  let tmpRoot: string | null = null;
  let calls: ExecaCall[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    __setNotifierForTests(NoopNotifier);
  });

  afterEach(async () => {
    __setNotifierForTests(null);
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  it("pr-missing: routes to needs-human without calling gh", async () => {
    const { tmp, task } = await setup({ status: "merging", pr: null });
    tmpRoot = tmp;
    const r = await runMergePhase(task, makeLogger(), makeJsonl());
    expect(r).toEqual({ status: "needs-human", reason: "pr-missing" });
    expect(vi.mocked(execa)).not.toHaveBeenCalled();
  });

  it("worktree null in frontmatter: routes to needs-human worktree-missing", async () => {
    const { tmp, task } = await setup({
      status: "merging",
      pr: 184,
      worktreeNullInFrontmatter: true,
    });
    tmpRoot = tmp;
    const r = await runMergePhase(task, makeLogger(), makeJsonl());
    expect(r.status).toBe("needs-human");
    if (r.status === "needs-human") expect(r.reason).toBe("worktree-missing");
  });

  it("happy path: gh pr merge fires, mergeCommit captured via post-view, worktree removed, task archived, status=merged", async () => {
    const { tmp, task } = await setup({ status: "merging", pr: 184 });
    tmpRoot = tmp;
    installExecaMock(
      {
        prViewBeforeMerge: {
          stdout: JSON.stringify({ state: "OPEN", mergeCommit: null }),
        },
        prMerge: { exitCode: 0 },
        prViewAfterMerge: {
          stdout: JSON.stringify({ mergeCommit: { oid: "fresh-merge-sha" } }),
        },
        removeWorktree: { exitCode: 0 },
      },
      calls,
    );

    const r = await runMergePhase(task, makeLogger(), makeJsonl());
    expect(r).toEqual({ status: "ok" });

    const archivePath = path.join(
      tmp,
      ".orchestrator",
      "tasks",
      "archive",
      "2026-04-30-merge-test.md",
    );
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(task.path)).toBe(true); // task.path was updated post-archive
    expect(task.path).toBe(archivePath);

    const reread = await readTask(archivePath);
    expect(reread.frontmatter.status).toBe("merged");
    expect(reread.frontmatter.merge_commit).toBe("fresh-merge-sha");
    expect(reread.body).toContain("squash-merged via gh pr merge");
    expect(reread.body).toContain("Worktree: removed");

    // gh pr merge was called exactly once.
    const mergeCalls = calls.filter(
      (c) => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "merge",
    );
    expect(mergeCalls).toHaveLength(1);
  });

  it("gh pr merge non-zero exit: routes to needs-human gh-merge-failed", async () => {
    const { tmp, task } = await setup({ status: "merging", pr: 184 });
    tmpRoot = tmp;
    installExecaMock(
      {
        prViewBeforeMerge: {
          stdout: JSON.stringify({ state: "OPEN", mergeCommit: null }),
        },
        prMerge: { exitCode: 1, stderr: "branch protection requires approving review" },
      },
      calls,
    );

    const r = await runMergePhase(task, makeLogger(), makeJsonl());
    expect(r).toEqual({
      status: "needs-human",
      reason: "gh-merge-failed",
    });
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("needs-human");
    expect(reread.body).toContain("branch protection");
    // Task file must NOT have been archived on a merge failure.
    expect(reread.path).not.toContain("/archive/");
  });

  it("PR already MERGED: skips gh pr merge, captures commit from initial view, archives", async () => {
    const { tmp, task } = await setup({
      status: "merging",
      pr: 184,
      mergeCommit: null,
    });
    tmpRoot = tmp;
    installExecaMock(
      {
        prViewBeforeMerge: {
          stdout: JSON.stringify({
            state: "MERGED",
            mergeCommit: { oid: "preexisting-sha" },
          }),
        },
        removeWorktree: { exitCode: 0 },
      },
      calls,
    );

    const r = await runMergePhase(task, makeLogger(), makeJsonl());
    expect(r).toEqual({ status: "ok" });

    const mergeCalls = calls.filter(
      (c) => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "merge",
    );
    expect(mergeCalls).toHaveLength(0);

    const archivePath = path.join(
      tmp,
      ".orchestrator",
      "tasks",
      "archive",
      "2026-04-30-merge-test.md",
    );
    const reread = await readTask(archivePath);
    expect(reread.frontmatter.status).toBe("merged");
    expect(reread.frontmatter.merge_commit).toBe("preexisting-sha");
    expect(reread.body).toContain("PR was already merged");
  });

  it("worktree-removal failure: warns, continues to archive, still reaches merged", async () => {
    const { tmp, task } = await setup({ status: "merging", pr: 184 });
    tmpRoot = tmp;
    installExecaMock(
      {
        prViewBeforeMerge: {
          stdout: JSON.stringify({ state: "OPEN", mergeCommit: null }),
        },
        prMerge: { exitCode: 0 },
        prViewAfterMerge: {
          stdout: JSON.stringify({ mergeCommit: { oid: "merge-sha" } }),
        },
        removeWorktree: {
          exitCode: 1,
          stderr: "uncommitted changes in worktree",
        },
      },
      calls,
    );

    const logger = makeLogger();
    const r = await runMergePhase(task, logger, makeJsonl());
    expect(r).toEqual({ status: "ok" });
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("merged");
    expect(reread.body).toContain("WARN");
    expect(reread.body).toContain("uncommitted changes");
    expect(logger.warns.some((w) => w.includes("uncommitted changes"))).toBe(true);
  });

  it("creates the archive directory lazily and updates Task.path post-rename", async () => {
    const { tmp, task } = await setup({ status: "merging", pr: 184 });
    tmpRoot = tmp;
    installExecaMock(
      {
        prViewBeforeMerge: {
          stdout: JSON.stringify({ state: "OPEN", mergeCommit: null }),
        },
        prMerge: { exitCode: 0 },
        prViewAfterMerge: {
          stdout: JSON.stringify({ mergeCommit: { oid: "sha" } }),
        },
        removeWorktree: { exitCode: 0 },
      },
      calls,
    );

    const archiveDir = path.join(tmp, ".orchestrator", "tasks", "archive");
    expect(existsSync(archiveDir)).toBe(false);

    await runMergePhase(task, makeLogger(), makeJsonl());

    expect(existsSync(archiveDir)).toBe(true);
    expect(task.path).toBe(path.join(archiveDir, "2026-04-30-merge-test.md"));
    // Original task path no longer exists.
    expect(
      existsSync(path.join(tmp, ".orchestrator", "tasks", "2026-04-30-merge-test.md")),
    ).toBe(false);
  });

  it("idempotent re-entry: PR already MERGED + worktree already gone → still archives and transitions cleanly", async () => {
    const { tmp, task } = await setup({
      status: "merging",
      pr: 184,
      worktreeOnDisk: false,
      mergeCommit: "prior-sha",
    });
    tmpRoot = tmp;
    installExecaMock(
      {
        prViewBeforeMerge: {
          stdout: JSON.stringify({
            state: "MERGED",
            mergeCommit: { oid: "prior-sha" },
          }),
        },
      },
      calls,
    );

    const r = await runMergePhase(task, makeLogger(), makeJsonl());
    expect(r).toEqual({ status: "ok" });

    const archivePath = path.join(
      tmp,
      ".orchestrator",
      "tasks",
      "archive",
      "2026-04-30-merge-test.md",
    );
    const reread = await readTask(archivePath);
    expect(reread.frontmatter.status).toBe("merged");
    expect(reread.body).toContain("Worktree: already gone");

    // No remove-agent-worktree.ts call should have happened — directory was
    // already gone when the phase started.
    const removeCalls = calls.filter((c) =>
      c.cmd.endsWith("remove-agent-worktree.ts"),
    );
    expect(removeCalls).toHaveLength(0);
  });

  it("post-archive, pre-final-transition crash: skips re-rename and finalises status=merged", async () => {
    // Pin for `merge.ts:221` — `if (task.path !== archivePath)`. The
    // canonical resume case from `docs/phases/merge.md` L66-67: a crash
    // between `fs.rename(...)` and the final `transitionStatus(... ,
    // "merged")` leaves the task file already at the archive path. The
    // next entry must detect that, skip the rename, and still finalise
    // cleanly (no ENOENT, no double-archive event, no spurious WARN).
    const { tmp, task } = await setup({
      status: "merging",
      pr: 184,
      worktreeOnDisk: false, // already cleaned up before the crash
      mergeCommit: "merged-before-crash-sha",
    });
    tmpRoot = tmp;

    // Pre-stage the task file at the archive path to model the
    // post-rename, pre-final-transition state.
    const archiveDir = path.join(tmp, ".orchestrator", "tasks", "archive");
    const archivePath = path.join(archiveDir, "2026-04-30-merge-test.md");
    await fs.mkdir(archiveDir, { recursive: true });
    const original = await readTask(task.path);
    // Re-write the file at the archive path; remove the original so the
    // resume path can detect the post-rename state.
    await fs.rename(original.path, archivePath);
    const resumed = await readTask(archivePath);

    installExecaMock(
      {
        prViewBeforeMerge: {
          stdout: JSON.stringify({
            state: "MERGED",
            mergeCommit: { oid: "merged-before-crash-sha" },
          }),
        },
      },
      calls,
    );

    const jsonl = makeJsonl();
    const r = await runMergePhase(resumed, makeLogger(), jsonl);
    expect(r).toEqual({ status: "ok" });

    const reread = await readTask(archivePath);
    expect(reread.frontmatter.status).toBe("merged");
    expect(reread.frontmatter.merge_commit).toBe("merged-before-crash-sha");

    // The original (pre-archive) path must NOT exist post-resume — the
    // file was already at the archive path and should remain there.
    expect(
      existsSync(path.join(tmp, ".orchestrator", "tasks", "2026-04-30-merge-test.md")),
    ).toBe(false);
    expect(existsSync(archivePath)).toBe(true);

    // No `gh pr merge` (already MERGED), and no remove-agent-worktree
    // (worktree already gone).
    const mergeCalls = calls.filter(
      (c) => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "merge",
    );
    expect(mergeCalls).toHaveLength(0);
    const removeCalls = calls.filter((c) =>
      c.cmd.endsWith("remove-agent-worktree.ts"),
    );
    expect(removeCalls).toHaveLength(0);

    // No `merge.archive` jsonl event because the rename is skipped —
    // the task file was already at the archive path on entry.
    const archiveEvents = jsonl.event.mock.calls.filter(
      (c) => c[0] === "merge.archive",
    );
    expect(archiveEvents).toHaveLength(0);
  });

  it("emits merge.start, merge.gh.pr-view, merge.gh.pr-merge, merge.archive, merge.exit jsonl events", async () => {
    const { tmp, task } = await setup({ status: "merging", pr: 184 });
    tmpRoot = tmp;
    installExecaMock(
      {
        prViewBeforeMerge: {
          stdout: JSON.stringify({ state: "OPEN", mergeCommit: null }),
        },
        prMerge: { exitCode: 0 },
        prViewAfterMerge: {
          stdout: JSON.stringify({ mergeCommit: { oid: "sha" } }),
        },
        removeWorktree: { exitCode: 0 },
      },
      calls,
    );
    const jsonl = makeJsonl();
    await runMergePhase(task, makeLogger(), jsonl);
    const events = jsonl.event.mock.calls.map((c) => c[0] as string);
    expect(events).toContain("merge.start");
    expect(events).toContain("merge.gh.pr-view");
    expect(events).toContain("merge.gh.pr-merge");
    expect(events).toContain("merge.archive");
    expect(events).toContain("merge.exit");
  });
});
