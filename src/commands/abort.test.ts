import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStatus } from "../state/phases.js";
import { __setNotifierForTests } from "../state/task-file.js";

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

interface ExecaCall {
  cmd: string;
  args: readonly string[];
  cwd?: string;
}

const execaCalls: ExecaCall[] = [];
const execaImpl = vi.fn(
  async (
    cmd: string,
    args: readonly string[] = [],
    opts: { cwd?: string } = {},
  ) => {
    execaCalls.push({ cmd, args, cwd: opts.cwd });
    // Special-case `git rev-parse --show-toplevel` so findGitRoot works.
    if (cmd === "git" && args[0] === "rev-parse") {
      // Return the cwd as the toplevel — fixtures use a fresh dir per test.
      return {
        stdout: opts.cwd ?? process.cwd(),
        exitCode: 0,
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  },
);

vi.mock("execa", () => ({
  execa: (cmd: string, args: readonly string[], opts: { cwd?: string }) =>
    execaImpl(cmd, args, opts),
}));

const { abortCommand } = await import("./abort.js");

interface FixtureOptions {
  status: TaskStatus;
  taskId?: string;
  pr?: number | null;
  worktree?: string | null;
  branch?: string | null;
  withWorktreeDir?: boolean;
  withRemoveScript?: boolean;
  withRunnerPid?: number | null;
  withPauseFlag?: boolean;
}

async function makeFixture(opts: FixtureOptions): Promise<{ repo: string; taskId: string; worktree: string | null }> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "flow-abort-"));

  const taskId = opts.taskId ?? "2026-04-30-abort-test";
  const tasksDir = path.join(repo, ".orchestrator", "tasks");
  await fs.mkdir(tasksDir, { recursive: true });

  let worktreePath: string | null = null;
  if (opts.worktree !== undefined) {
    worktreePath = opts.worktree;
  } else if (opts.withWorktreeDir) {
    worktreePath = path.join(os.tmpdir(), `wt-${taskId}-${Date.now()}`);
    await fs.mkdir(worktreePath, { recursive: true });
  }
  if (opts.withWorktreeDir && worktreePath && !(await pathExists(worktreePath))) {
    await fs.mkdir(worktreePath, { recursive: true });
  }

  if (opts.withRemoveScript) {
    const scriptsDir = path.join(repo, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, "remove-agent-worktree.ts");
    await fs.writeFile(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(scriptPath, 0o755);
  }

  const fmLines = [
    "---",
    `id: ${taskId}`,
    `status: ${opts.status}`,
    "created: 2026-04-30T00:00:00.000Z",
    "updated: 2026-04-30T00:00:00.000Z",
    `target_repo: ${repo}`,
    `worktree: ${worktreePath ? worktreePath : "null"}`,
    `branch: ${opts.branch ?? "null"}`,
    `pr: ${opts.pr ?? "null"}`,
    "manual_validation: null",
    "merge_commit: null",
    "---",
  ];

  const body = [
    ...fmLines,
    "",
    "## User prompt",
    "",
    "abort me",
    "",
    "## Phase log",
    "",
    "## Phase outputs",
    "",
  ].join("\n");

  await fs.writeFile(path.join(tasksDir, `${taskId}.md`), body, "utf8");

  const taskDir = path.join(tasksDir, taskId);
  if (opts.withPauseFlag || opts.withRunnerPid != null) {
    await fs.mkdir(taskDir, { recursive: true });
  }
  if (opts.withPauseFlag) {
    await fs.writeFile(path.join(taskDir, ".pause"), "", "utf8");
  }
  if (opts.withRunnerPid != null) {
    await fs.writeFile(
      path.join(taskDir, "runner.pid"),
      `${opts.withRunnerPid}\n`,
      "utf8",
    );
  }
  return { repo, taskId, worktree: worktreePath };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe("abortCommand", () => {
  beforeEach(() => {
    __setNotifierForTests({
      notify: async () => {},
      notifySync: () => {},
    });
    execaImpl.mockClear();
    execaCalls.length = 0;
  });
  afterEach(() => {
    __setNotifierForTests(null);
  });

  it("rejects without --confirm and does not modify the task file", async () => {
    const { repo, taskId } = await makeFixture({ status: "pr-open" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await abortCommand(taskId, {}, { stdout, stderr, cwd: repo });
    expect(code).toBe(1);
    expect(stderr.data).toContain("requires --confirm");
    const body = await fs.readFile(
      path.join(repo, ".orchestrator", "tasks", `${taskId}.md`),
      "utf8",
    );
    expect(body).toMatch(/^status: pr-open$/m);
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("rejects a merged task", async () => {
    const { repo, taskId } = await makeFixture({ status: "merged" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await abortCommand(
      taskId,
      { confirm: true },
      { stdout, stderr, cwd: repo },
    );
    expect(code).toBe(1);
    expect(stderr.data).toContain("terminal status merged");
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("rejects an already-aborted task", async () => {
    const { repo, taskId } = await makeFixture({ status: "aborted" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await abortCommand(
      taskId,
      { confirm: true },
      { stdout, stderr, cwd: repo },
    );
    expect(code).toBe(1);
    expect(stderr.data).toContain("terminal status aborted");
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("aborts a pr-open task: closes PR, removes worktree+branch, archives", async () => {
    const { repo, taskId, worktree } = await makeFixture({
      status: "pr-open",
      pr: 42,
      branch: "agent/abort-test",
      withWorktreeDir: true,
      withRemoveScript: true,
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await abortCommand(
      taskId,
      { confirm: true },
      { stdout, stderr, cwd: repo },
    );
    expect(code, `stderr=${stderr.data}\nstdout=${stdout.data}`).toBe(0);

    // PR close was called.
    const ghCalls = execaCalls.filter((c) => c.cmd === "gh");
    expect(ghCalls.length).toBeGreaterThanOrEqual(1);
    expect(ghCalls[0]!.args).toEqual([
      "pr",
      "close",
      "42",
      "--comment",
      "aborted by user via flow",
    ]);

    // Worktree script was called with branch + --delete-branch.
    const rmCalls = execaCalls.filter((c) =>
      c.cmd.endsWith("remove-agent-worktree.ts"),
    );
    expect(rmCalls.length).toBe(1);
    expect(rmCalls[0]!.args).toEqual(["agent/abort-test", "--delete-branch"]);

    // Archive: file moved to archive dir, status now aborted.
    const archivePath = path.join(
      repo,
      ".orchestrator",
      "tasks",
      "archive",
      `${taskId}.md`,
    );
    expect(await pathExists(archivePath)).toBe(true);
    expect(
      await pathExists(path.join(repo, ".orchestrator", "tasks", `${taskId}.md`)),
    ).toBe(false);
    const archived = await fs.readFile(archivePath, "utf8");
    expect(archived).toMatch(/^status: aborted$/m);
    expect(archived).toMatch(/→ aborted \(user-aborted\)/);

    expect(stdout.data).toContain(`aborted ${taskId}:`);
    expect(stdout.data).toContain("- PR #42: closed");
    expect(stdout.data).toContain("- Worktree: removed");
    expect(stdout.data).toContain(`- Archived: ${archivePath}`);

    if (worktree) await fs.rm(worktree, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("aborts a worktree-ready task with no PR: skips gh, runs worktree-remove, archives", async () => {
    const { repo, taskId, worktree } = await makeFixture({
      status: "worktree-ready",
      pr: null,
      branch: "agent/abort-no-pr",
      withWorktreeDir: true,
      withRemoveScript: true,
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await abortCommand(
      taskId,
      { confirm: true },
      { stdout, stderr, cwd: repo },
    );
    expect(code).toBe(0);
    const ghCalls = execaCalls.filter((c) => c.cmd === "gh");
    expect(ghCalls.length).toBe(0);
    expect(stdout.data).toContain("- PR: (none)");
    expect(stdout.data).toContain("- Worktree: removed");

    if (worktree) await fs.rm(worktree, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("aborts a triaged task with no PR / no worktree / no branch: archive-only, no WARN lines", async () => {
    const { repo, taskId } = await makeFixture({
      status: "triaged",
      pr: null,
      worktree: null,
      branch: null,
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await abortCommand(
      taskId,
      { confirm: true },
      { stdout, stderr, cwd: repo },
    );
    expect(code).toBe(0);
    expect(stdout.data).toContain("- PR: (none)");
    expect(stdout.data).toContain("- Worktree: (none)");
    expect(stdout.data).not.toContain("WARN");

    const archivePath = path.join(
      repo,
      ".orchestrator",
      "tasks",
      "archive",
      `${taskId}.md`,
    );
    expect(await pathExists(archivePath)).toBe(true);
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("surfaces a WARN when gh pr close fails (non-zero exit) and proceeds", async () => {
    execaImpl.mockImplementation(
      async (cmd: string, args: readonly string[] = [], opts: { cwd?: string } = {}) => {
        execaCalls.push({ cmd, args, cwd: opts.cwd });
        if (cmd === "git" && args[0] === "rev-parse") {
          return { stdout: opts.cwd ?? process.cwd(), exitCode: 0, stderr: "" };
        }
        if (cmd === "gh") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "could not close PR — auth expired",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    );
    const { repo, taskId } = await makeFixture({
      status: "pr-open",
      pr: 99,
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await abortCommand(
      taskId,
      { confirm: true },
      { stdout, stderr, cwd: repo },
    );
    expect(code).toBe(0);
    expect(stdout.data).toContain("- PR #99: WARN: close failed:");
    // Archive still happened.
    const archivePath = path.join(
      repo,
      ".orchestrator",
      "tasks",
      "archive",
      `${taskId}.md`,
    );
    expect(await pathExists(archivePath)).toBe(true);
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("warns when a runner.pid is alive and proceeds", async () => {
    const { repo, taskId } = await makeFixture({
      status: "pr-open",
      pr: null,
      withRunnerPid: process.pid,
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await abortCommand(
      taskId,
      { confirm: true },
      { stdout, stderr, cwd: repo },
    );
    expect(code).toBe(0);
    expect(stdout.data).toContain(`WARN: runner pid ${process.pid} is still active`);
    // Pid file was cleaned up best-effort.
    const pidPath = path.join(
      repo,
      ".orchestrator",
      "tasks",
      taskId,
      "runner.pid",
    );
    expect(await pathExists(pidPath)).toBe(false);
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("cleans up a lingering .pause flag during abort", async () => {
    const { repo, taskId } = await makeFixture({
      status: "needs-human",
      pr: null,
      withPauseFlag: true,
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await abortCommand(
      taskId,
      { confirm: true },
      { stdout, stderr, cwd: repo },
    );
    expect(code).toBe(0);
    const flagPath = path.join(
      repo,
      ".orchestrator",
      "tasks",
      taskId,
      ".pause",
    );
    expect(await pathExists(flagPath)).toBe(false);
    await fs.rm(repo, { recursive: true, force: true });
  });
});
