import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStatus } from "../state/phases.js";

// Hoisted so the vi.mock factories below can reference it.
const { callLog, advanceStatus } = vi.hoisted(() => {
  const callLog: string[] = [];
  // Lazy-resolve readTask/writeTask via dynamic import to avoid circular
  // hoisting issues — task-file is not mocked, so the real impl is fine.
  const advanceStatus = async (taskPath: string, next: string) => {
    const taskFile = await import("../state/task-file.js");
    const t = await taskFile.readTask(taskPath);
    t.frontmatter.status = next as TaskStatus;
    await taskFile.writeTask(t);
  };
  return { callLog, advanceStatus };
});

vi.mock("./phases/plan.js", () => ({
  runPlanPhase: vi.fn(async (task) => {
    callLog.push("plan");
    await advanceStatus(task.path, "planned");
    return { status: "ok" };
  }),
}));

vi.mock("./phases/worktree.js", () => ({
  runWorktreePhase: vi.fn(async (task) => {
    callLog.push("worktree");
    await advanceStatus(task.path, "worktree-ready");
    return { status: "ok" };
  }),
}));

vi.mock("./phases/implement.js", () => ({
  runImplementPhase: vi.fn(async (task) => {
    callLog.push("implement");
    await advanceStatus(task.path, "pr-open");
    return { status: "ok" };
  }),
}));

import { runPipeline } from "./runner.js";
import { readTask, writeTask, type Task } from "../state/task-file.js";

async function makeTaskFile(tmpDir: string, status: TaskStatus): Promise<Task> {
  const taskPath = path.join(tmpDir, "task.md");
  const fm = {
    id: "2026-04-28-test",
    status,
    created: "2026-04-28T00:00:00.000Z",
    updated: "2026-04-28T00:00:00.000Z",
    target_repo: tmpDir,
    worktree: null,
    branch: null,
    pr: null,
    manual_validation: null,
    merge_commit: null,
  };
  const initial: Task = {
    path: taskPath,
    frontmatter: fm as Task["frontmatter"],
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
  return readTask(taskPath);
}

describe("runPipeline dispatch (M2 worktree-first ordering)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-runner-"));
    callLog.length = 0;
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("at status triaged, dispatches worktree → plan → implement in order", async () => {
    const task = await makeTaskFile(tmp, "triaged");
    const r = await runPipeline(task);
    expect(r.status).toBe("ok");
    expect(callLog).toEqual(["worktree", "plan", "implement"]);
  });

  it("at status creating-worktree, resumes from worktree", async () => {
    const task = await makeTaskFile(tmp, "creating-worktree");
    await runPipeline(task);
    expect(callLog[0]).toBe("worktree");
  });

  it("at status worktree-ready, skips worktree and starts at plan", async () => {
    const task = await makeTaskFile(tmp, "worktree-ready");
    await runPipeline(task);
    expect(callLog).toEqual(["plan", "implement"]);
  });

  it("at status planning, resumes from plan (skips worktree)", async () => {
    const task = await makeTaskFile(tmp, "planning");
    await runPipeline(task);
    expect(callLog[0]).toBe("plan");
    expect(callLog).not.toContain("worktree");
  });

  it("at status planned, skips worktree and plan, starts at implement", async () => {
    const task = await makeTaskFile(tmp, "planned");
    await runPipeline(task);
    expect(callLog).toEqual(["implement"]);
  });

  it("at status implementing, resumes from implement", async () => {
    const task = await makeTaskFile(tmp, "implementing");
    await runPipeline(task);
    expect(callLog).toEqual(["implement"]);
  });

  it("at status pr-open, no phases run (post-M2 state)", async () => {
    const task = await makeTaskFile(tmp, "pr-open");
    await runPipeline(task);
    expect(callLog).toEqual([]);
  });
});
