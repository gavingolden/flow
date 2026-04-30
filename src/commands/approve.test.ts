import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { approveCommand } from "./approve.js";
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
  intent?: string;
  taskId?: string;
  prdContent?: string;
}

async function makeFixture(opts: FixtureOptions): Promise<{ repo: string; taskId: string }> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "flow-approve-"));
  await execa("git", ["init", "-q"], { cwd: repo });
  await execa("git", ["config", "user.email", "t@t"], { cwd: repo });
  await execa("git", ["config", "user.name", "t"], { cwd: repo });

  const taskId = opts.taskId ?? "2026-04-30-checkpoint";
  const tasksDir = path.join(repo, ".orchestrator", "tasks");
  await fs.mkdir(tasksDir, { recursive: true });

  const triageBlock = opts.intent
    ? ["## Triage", "", `- intent: ${opts.intent}`, "- summary: x", ""]
    : [];

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
    "approve me",
    "",
    ...triageBlock,
    "## Phase log",
    "",
    "## Phase outputs",
    "",
  ].join("\n");

  await fs.writeFile(path.join(tasksDir, `${taskId}.md`), body, "utf8");

  if (opts.prdContent !== undefined) {
    const planDir = path.join(tasksDir, `${taskId}-plan`);
    await fs.mkdir(planDir, { recursive: true });
    await fs.writeFile(path.join(planDir, "prd.md"), opts.prdContent, "utf8");
  }

  return { repo, taskId };
}

describe("approveCommand", () => {
  beforeEach(() => {
    __setNotifierForTests({
      notify: async () => {},
      notifySync: () => {},
    });
  });
  afterEach(() => {
    __setNotifierForTests(null);
  });

  it("rejects a task that is not at plan-pending-review", async () => {
    const { repo, taskId } = await makeFixture({ status: "planning" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await approveCommand(taskId, { resume: false }, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(1);
    expect(stderr.data).toContain("not at plan-pending-review");
    expect(stderr.data).toContain("planning");
    // Status was not changed.
    const body = await fs.readFile(
      path.join(repo, ".orchestrator", "tasks", `${taskId}.md`),
      "utf8",
    );
    expect(body).toMatch(/^status: planning$/m);
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("transitions plan-pending-review → planned and appends the Phase log entry", async () => {
    const { repo, taskId } = await makeFixture({
      status: "plan-pending-review",
      prdContent: "# PRD — checkpoint test\n\n## Problem\n\nlines 1\nlines 2\n",
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await approveCommand(taskId, { resume: false }, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code, `stderr=${stderr.data}`).toBe(0);
    const body = await fs.readFile(
      path.join(repo, ".orchestrator", "tasks", `${taskId}.md`),
      "utf8",
    );
    expect(body).toMatch(/^status: planned$/m);
    expect(body).toMatch(/plan-pending-review → planned \(approved by user\)/);
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("--no-resume skips the detached re-spawn but still transitions", async () => {
    const { repo, taskId } = await makeFixture({
      status: "plan-pending-review",
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await approveCommand(taskId, { resume: false }, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code, `stderr=${stderr.data}`).toBe(0);
    expect(stdout.data).toContain("pipeline NOT resumed");
    expect(stdout.data).not.toContain("detached as pid");
    // No runs/ dir was created (the detached spawn would have opened a log).
    await expect(
      fs.access(path.join(repo, ".orchestrator", "runs")),
    ).rejects.toThrow();
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("prints the first ~10 lines of prd.md on success when the file exists", async () => {
    const longPrd = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const { repo, taskId } = await makeFixture({
      status: "plan-pending-review",
      prdContent: longPrd,
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    await approveCommand(taskId, { resume: false }, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(stdout.data).toContain("PRD summary");
    expect(stdout.data).toContain("line 1");
    expect(stdout.data).toContain("line 10");
    expect(stdout.data).not.toContain("line 11");
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("falls back to a generic ack line when prd.md is missing", async () => {
    const { repo, taskId } = await makeFixture({
      status: "plan-pending-review",
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    await approveCommand(taskId, { resume: false }, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(stdout.data).toMatch(/approved \S+: status now planned/);
    expect(stdout.data).not.toContain("PRD summary");
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("rejects a task id that does not resolve to a task file", async () => {
    const { repo } = await makeFixture({ status: "plan-pending-review" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await approveCommand("not-a-real-id", { resume: false }, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(1);
    expect(stderr.data).toContain("not found");
    await fs.rm(repo, { recursive: true, force: true });
  });
});
