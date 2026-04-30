import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { pauseCommand } from "./pause.js";
import { __setNotifierForTests } from "../state/task-file.js";
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

interface FixtureOptions {
  status: TaskStatus;
  taskId?: string;
}

async function makeFixture(opts: FixtureOptions): Promise<{ repo: string; taskId: string }> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "flow-pause-"));
  await execa("git", ["init", "-q"], { cwd: repo });
  await execa("git", ["config", "user.email", "t@t"], { cwd: repo });
  await execa("git", ["config", "user.name", "t"], { cwd: repo });

  const taskId = opts.taskId ?? "2026-04-30-pause-test";
  const tasksDir = path.join(repo, ".orchestrator", "tasks");
  await fs.mkdir(tasksDir, { recursive: true });

  const body = [
    "---",
    `id: ${taskId}`,
    `status: ${opts.status}`,
    "created: 2026-04-30T00:00:00.000Z",
    "updated: 2026-04-30T00:00:00.000Z",
    `target_repo: ${repo}`,
    "worktree: null",
    "branch: null",
    "pr: null",
    "manual_validation: null",
    "merge_commit: null",
    "---",
    "",
    "## User prompt",
    "",
    "pause me",
    "",
    "## Phase log",
    "",
    "## Phase outputs",
    "",
  ].join("\n");

  await fs.writeFile(path.join(tasksDir, `${taskId}.md`), body, "utf8");
  return { repo, taskId };
}

describe("pauseCommand", () => {
  beforeEach(() => {
    __setNotifierForTests({
      notify: async () => {},
      notifySync: () => {},
    });
  });
  afterEach(() => {
    __setNotifierForTests(null);
  });

  it("drops the pause flag and prints the no-runner hint", async () => {
    const { repo, taskId } = await makeFixture({ status: "pr-open" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await pauseCommand(taskId, {}, { stdout, stderr, cwd: repo });
    expect(code, `stderr=${stderr.data}`).toBe(0);
    const flagPath = path.join(
      repo,
      ".orchestrator",
      "tasks",
      taskId,
      ".pause",
    );
    const stat = await fs.stat(flagPath);
    expect(stat.isFile()).toBe(true);
    expect(stdout.data).toContain(`paused ${taskId}: pause flag dropped at`);
    expect(stdout.data).toContain("no active runner detected");
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("prints the runner-active hint when runner.pid is alive", async () => {
    const { repo, taskId } = await makeFixture({ status: "pr-open" });
    const taskDir = path.join(repo, ".orchestrator", "tasks", taskId);
    await fs.mkdir(taskDir, { recursive: true });
    // Use the test process's own pid — guaranteed alive.
    await fs.writeFile(
      path.join(taskDir, "runner.pid"),
      `${process.pid}\n`,
      "utf8",
    );
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await pauseCommand(taskId, {}, { stdout, stderr, cwd: repo });
    expect(code).toBe(0);
    expect(stdout.data).toContain("runner is active");
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("rejects pausing a merged task", async () => {
    const { repo, taskId } = await makeFixture({ status: "merged" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await pauseCommand(taskId, {}, { stdout, stderr, cwd: repo });
    expect(code).toBe(1);
    expect(stderr.data).toContain("cannot pause task at status merged");
    const flagPath = path.join(
      repo,
      ".orchestrator",
      "tasks",
      taskId,
      ".pause",
    );
    await expect(fs.access(flagPath)).rejects.toThrow();
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("rejects pausing an aborted task", async () => {
    const { repo, taskId } = await makeFixture({ status: "aborted" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await pauseCommand(taskId, {}, { stdout, stderr, cwd: repo });
    expect(code).toBe(1);
    expect(stderr.data).toContain("cannot pause task at status aborted");
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("rejects pausing a needs-human task", async () => {
    const { repo, taskId } = await makeFixture({ status: "needs-human" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await pauseCommand(taskId, {}, { stdout, stderr, cwd: repo });
    expect(code).toBe(1);
    expect(stderr.data).toContain("cannot pause task at status needs-human");
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("redirects plan-pending-review to /flow-revise or /flow-abort", async () => {
    const { repo, taskId } = await makeFixture({
      status: "plan-pending-review",
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await pauseCommand(taskId, {}, { stdout, stderr, cwd: repo });
    expect(code).toBe(1);
    expect(stderr.data).toContain("/flow-revise");
    expect(stderr.data).toContain("/flow-abort");
    const flagPath = path.join(
      repo,
      ".orchestrator",
      "tasks",
      taskId,
      ".pause",
    );
    await expect(fs.access(flagPath)).rejects.toThrow();
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("rejects an unresolvable task id", async () => {
    const { repo } = await makeFixture({ status: "pr-open" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await pauseCommand("not-a-real-id", {}, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(1);
    expect(stderr.data).toContain("not found");
    await fs.rm(repo, { recursive: true, force: true });
  });
});
