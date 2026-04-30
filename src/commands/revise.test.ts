import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { reviseCommand } from "./revise.js";
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
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "flow-revise-"));
  await execa("git", ["init", "-q"], { cwd: repo });
  await execa("git", ["config", "user.email", "t@t"], { cwd: repo });
  await execa("git", ["config", "user.name", "t"], { cwd: repo });

  const taskId = opts.taskId ?? "2026-04-30-revise";
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
    "do the thing",
    "",
    "## Phase log",
    "",
    "## Phase outputs",
    "",
  ].join("\n");

  await fs.writeFile(path.join(tasksDir, `${taskId}.md`), body, "utf8");
  return { repo, taskId };
}

function makePipedStdin(text: string): NodeJS.ReadableStream & { isTTY?: boolean } {
  const r = Readable.from([text]) as NodeJS.ReadableStream & { isTTY?: boolean };
  r.isTTY = false;
  return r;
}

function makeTtyStdin(): NodeJS.ReadableStream & { isTTY?: boolean } {
  const r = Readable.from([]) as NodeJS.ReadableStream & { isTTY?: boolean };
  r.isTTY = true;
  return r;
}

describe("reviseCommand", () => {
  beforeEach(() => {
    __setNotifierForTests({
      notify: async () => {},
      notifySync: () => {},
    });
  });
  afterEach(() => {
    __setNotifierForTests(null);
  });

  it("appends to ## Revision notes, transitions to worktree-ready, and records the truncated note in Phase log", async () => {
    const { repo, taskId } = await makeFixture({ status: "plan-pending-review" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await reviseCommand(
      taskId,
      { message: "redirect to use FRED API", resume: false },
      { stdout, stderr, stdin: makeTtyStdin(), cwd: repo },
    );
    expect(code, `stderr=${stderr.data}`).toBe(0);
    const body = await fs.readFile(
      path.join(repo, ".orchestrator", "tasks", `${taskId}.md`),
      "utf8",
    );
    expect(body).toMatch(/^status: worktree-ready$/m);
    expect(body).toContain("## Revision notes");
    expect(body).toContain("redirect to use FRED API");
    expect(body).toMatch(
      /plan-pending-review → worktree-ready \(revise: redirect to use FRED API\)/,
    );
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("reads the message from stdin when --message is omitted", async () => {
    const { repo, taskId } = await makeFixture({ status: "plan-pending-review" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await reviseCommand(
      taskId,
      { resume: false },
      {
        stdout,
        stderr,
        stdin: makePipedStdin("piped redirection text"),
        cwd: repo,
      },
    );
    expect(code, `stderr=${stderr.data}`).toBe(0);
    const body = await fs.readFile(
      path.join(repo, ".orchestrator", "tasks", `${taskId}.md`),
      "utf8",
    );
    expect(body).toContain("piped redirection text");
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("returns 1 and does not transition when no --message and stdin is a TTY", async () => {
    const { repo, taskId } = await makeFixture({ status: "plan-pending-review" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await reviseCommand(
      taskId,
      { resume: false },
      { stdout, stderr, stdin: makeTtyStdin(), cwd: repo },
    );
    expect(code).toBe(1);
    expect(stderr.data).toMatch(/prompt is required/);
    const body = await fs.readFile(
      path.join(repo, ".orchestrator", "tasks", `${taskId}.md`),
      "utf8",
    );
    expect(body).toMatch(/^status: plan-pending-review$/m);
    expect(body).not.toContain("## Revision notes");
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("rejects a task that is not at plan-pending-review without recording a transition", async () => {
    const { repo, taskId } = await makeFixture({ status: "planning" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await reviseCommand(
      taskId,
      { message: "redirect", resume: false },
      { stdout, stderr, stdin: makeTtyStdin(), cwd: repo },
    );
    expect(code).toBe(1);
    expect(stderr.data).toContain("not at plan-pending-review");
    const body = await fs.readFile(
      path.join(repo, ".orchestrator", "tasks", `${taskId}.md`),
      "utf8",
    );
    expect(body).toMatch(/^status: planning$/m);
    expect(body).not.toContain("## Revision notes");
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("appends a second entry on a second revise (does not replace the first)", async () => {
    const { repo, taskId } = await makeFixture({ status: "plan-pending-review" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    await reviseCommand(
      taskId,
      { message: "first redirection", resume: false },
      { stdout, stderr, stdin: makeTtyStdin(), cwd: repo },
    );
    // Move the task back to plan-pending-review (simulate the pipeline
    // having re-planned and paused again) so the second revise is valid.
    const taskPath = path.join(
      repo,
      ".orchestrator",
      "tasks",
      `${taskId}.md`,
    );
    let body = await fs.readFile(taskPath, "utf8");
    body = body.replace(
      /^status: worktree-ready$/m,
      "status: plan-pending-review",
    );
    await fs.writeFile(taskPath, body, "utf8");

    await reviseCommand(
      taskId,
      { message: "second redirection", resume: false },
      { stdout: new StringSink(), stderr: new StringSink(), stdin: makeTtyStdin(), cwd: repo },
    );

    const finalBody = await fs.readFile(taskPath, "utf8");
    expect(finalBody).toContain("first redirection");
    expect(finalBody).toContain("second redirection");
    // Both entries live under a single ## Revision notes section, not two.
    const occurrences = (finalBody.match(/^## Revision notes/gm) ?? []).length;
    expect(occurrences).toBe(1);
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("--no-resume skips the detached re-spawn", async () => {
    const { repo, taskId } = await makeFixture({ status: "plan-pending-review" });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await reviseCommand(
      taskId,
      { message: "redirect", resume: false },
      { stdout, stderr, stdin: makeTtyStdin(), cwd: repo },
    );
    expect(code, `stderr=${stderr.data}`).toBe(0);
    expect(stdout.data).toContain("pipeline NOT resumed");
    expect(stdout.data).not.toContain("detached as pid");
    await expect(
      fs.access(path.join(repo, ".orchestrator", "runs")),
    ).rejects.toThrow();
    await fs.rm(repo, { recursive: true, force: true });
  });
});
