import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import {
  __setNotifierForTests,
  readTask,
  writeTask,
  type Task,
} from "../state/task-file.js";
import type { TaskStatus } from "../state/phases.js";

class StringSink extends Writable {
  data = "";
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    cb();
  }
}

// Round-trip integration smoke. Gated on RUN_INTEGRATION=1 so the
// vitest default run doesn't pay the git-init cost; CI sets the env
// var and exercises the full pause → resume contract end-to-end.
const SHOULD_RUN = process.env.RUN_INTEGRATION === "1";
const describeMaybe = SHOULD_RUN ? describe : describe.skip;

const { respawnSpy } = vi.hoisted(() => ({
  respawnSpy: vi.fn(async () => ({
    pid: 99999,
    logPath: "/tmp/fake.log",
  })),
}));

vi.mock("../util/respawn.js", () => ({
  respawnDetached: respawnSpy,
  FLOW_LOG_PATH_ENV: "FLOW_LOG_PATH",
}));

const { resumeCommand } = await import("./resume.js");

describeMaybe("pause-resume round-trip (RUN_INTEGRATION=1)", () => {
  let repo: string | null = null;
  beforeEach(() => {
    __setNotifierForTests({
      notify: async () => {},
      notifySync: () => {},
    });
    respawnSpy.mockClear();
  });
  afterEach(async () => {
    __setNotifierForTests(null);
    if (repo) await fs.rm(repo, { recursive: true, force: true });
    repo = null;
  });

  it("drop flag → runPipeline pauses → resumeCommand restores status and clears flag", async () => {
    const { runPipeline } = await import("../pipeline/runner.js");
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "flow-pause-resume-smoke-"));
    await execa("git", ["init", "-q"], { cwd: repo });
    await execa("git", ["config", "user.email", "t@t"], { cwd: repo });
    await execa("git", ["config", "user.name", "t"], { cwd: repo });

    const taskId = "2026-04-30-pause-resume-smoke";
    const tasksDir = path.join(repo, ".orchestrator", "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    const taskDir = path.join(tasksDir, taskId);
    await fs.mkdir(taskDir, { recursive: true });

    // Seed the task at worktree-ready so the runner's first iteration
    // would dispatch the plan phase. We don't need the phase to actually
    // run — the pause check fires before invocation.
    const taskPath = path.join(tasksDir, `${taskId}.md`);
    const initial: Task = {
      path: taskPath,
      frontmatter: {
        id: taskId,
        status: "worktree-ready" as TaskStatus,
        created: "2026-04-30T00:00:00.000Z",
        updated: "2026-04-30T00:00:00.000Z",
        target_repo: repo,
        worktree: null,
        branch: null,
        pr: null,
        manual_validation: null,
        merge_commit: null,
      },
      body: [
        "## User prompt",
        "",
        "smoke",
        "",
        "## Phase log",
        "",
        "## Phase outputs",
        "",
      ].join("\n"),
    };
    await writeTask(initial);

    // Drop the flag *before* runPipeline sees the task.
    await fs.writeFile(path.join(taskDir, ".pause"), "", "utf8");

    const task = await readTask(taskPath);
    const result = await runPipeline(task, undefined, { taskDir });
    expect(result).toEqual({ status: "needs-human", reason: "user-paused" });

    const pausedTask = await readTask(taskPath);
    expect(pausedTask.frontmatter.status).toBe("needs-human");
    expect(pausedTask.frontmatter.paused_from).toBe("worktree-ready");
    expect(pausedTask.body).toMatch(
      /worktree-ready → needs-human \(user-paused\)/,
    );

    // Now resume: clears flag, restores status, clears paused_from.
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await resumeCommand(
      taskId,
      { resume: false },
      { stdout, stderr, cwd: repo },
    );
    expect(code, `stderr=${stderr.data}`).toBe(0);

    const flagPath = path.join(taskDir, ".pause");
    await expect(fs.access(flagPath)).rejects.toThrow();

    const after = await readTask(taskPath);
    expect(after.frontmatter.status).toBe("worktree-ready");
    expect(after.frontmatter.paused_from).toBeNull();
    expect(after.body).toMatch(
      /needs-human → worktree-ready \(resumed by user\)/,
    );
    expect(respawnSpy).not.toHaveBeenCalled();
  });
});
