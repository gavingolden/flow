import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
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

interface FixtureOptions {
  status: TaskStatus;
  pausedFrom?: TaskStatus | null;
  withFlag?: boolean;
  taskId?: string;
}

async function makeFixture(opts: FixtureOptions): Promise<{ repo: string; taskId: string }> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "flow-resume-"));
  await execa("git", ["init", "-q"], { cwd: repo });
  await execa("git", ["config", "user.email", "t@t"], { cwd: repo });
  await execa("git", ["config", "user.name", "t"], { cwd: repo });

  const taskId = opts.taskId ?? "2026-04-30-resume-test";
  const tasksDir = path.join(repo, ".orchestrator", "tasks");
  await fs.mkdir(tasksDir, { recursive: true });

  const fmLines = [
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
  ];
  if (opts.pausedFrom !== undefined) {
    fmLines.push(`paused_from: ${opts.pausedFrom ?? "null"}`);
  }
  fmLines.push("---");

  const body = [
    ...fmLines,
    "",
    "## User prompt",
    "",
    "resume me",
    "",
    "## Phase log",
    "",
    "## Phase outputs",
    "",
  ].join("\n");

  await fs.writeFile(path.join(tasksDir, `${taskId}.md`), body, "utf8");

  if (opts.withFlag) {
    const taskDir = path.join(tasksDir, taskId);
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(path.join(taskDir, ".pause"), "", "utf8");
  }
  return { repo, taskId };
}

describe("resumeCommand", () => {
  beforeEach(() => {
    __setNotifierForTests({
      notify: async () => {},
      notifySync: () => {},
    });
    respawnSpy.mockClear();
  });
  afterEach(() => {
    __setNotifierForTests(null);
  });

  it("clears the flag, restores status, clears paused_from, and respawns", async () => {
    const { repo, taskId } = await makeFixture({
      status: "needs-human",
      pausedFrom: "pr-open",
      withFlag: true,
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await resumeCommand(taskId, {}, { stdout, stderr, cwd: repo });
    expect(code, `stderr=${stderr.data}`).toBe(0);

    const flagPath = path.join(
      repo,
      ".orchestrator",
      "tasks",
      taskId,
      ".pause",
    );
    await expect(fs.access(flagPath)).rejects.toThrow();

    const body = await fs.readFile(
      path.join(repo, ".orchestrator", "tasks", `${taskId}.md`),
      "utf8",
    );
    expect(body).toMatch(/^status: pr-open$/m);
    expect(body).toMatch(/^paused_from: null$/m);
    expect(body).toMatch(/needs-human → pr-open \(resumed by user\)/);

    expect(stdout.data).toContain(`resumed ${taskId}: status now pr-open`);
    expect(stdout.data).toContain("detached as pid 99999");
    expect(respawnSpy).toHaveBeenCalledTimes(1);
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("--no-resume restores state but does not respawn", async () => {
    const { repo, taskId } = await makeFixture({
      status: "needs-human",
      pausedFrom: "pr-open",
      withFlag: true,
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await resumeCommand(taskId, { resume: false }, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code, `stderr=${stderr.data}`).toBe(0);
    expect(stdout.data).toContain("pipeline NOT resumed");
    expect(respawnSpy).not.toHaveBeenCalled();
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("rejects a task at status other than needs-human", async () => {
    const { repo, taskId } = await makeFixture({ status: "pr-open" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await resumeCommand(taskId, { resume: false }, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(1);
    expect(stderr.data).toContain("task is not paused");
    expect(stderr.data).toContain("pr-open");
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("rejects needs-human without paused_from", async () => {
    const { repo, taskId } = await makeFixture({
      status: "needs-human",
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await resumeCommand(taskId, { resume: false }, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(1);
    expect(stderr.data).toContain("not paused via");
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("redirects plan-pending-review to /flow-approve or /flow-revise", async () => {
    const { repo, taskId } = await makeFixture({
      status: "plan-pending-review",
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await resumeCommand(taskId, { resume: false }, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(1);
    expect(stderr.data).toContain("/flow-approve");
    expect(stderr.data).toContain("/flow-revise");
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("clearPauseFlag is idempotent (resume against a missing flag still restores state)", async () => {
    // The flag may already be gone (user typed `rm .pause` between pause
    // and resume). The contract is: resume's job is to restore state, not
    // to require the flag is present.
    const { repo, taskId } = await makeFixture({
      status: "needs-human",
      pausedFrom: "implementing",
      withFlag: false,
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await resumeCommand(taskId, { resume: false }, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code, `stderr=${stderr.data}`).toBe(0);
    const body = await fs.readFile(
      path.join(repo, ".orchestrator", "tasks", `${taskId}.md`),
      "utf8",
    );
    expect(body).toMatch(/^status: implementing$/m);
    await fs.rm(repo, { recursive: true, force: true });
  });
});
