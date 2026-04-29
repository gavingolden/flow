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
  runPlanPhase: vi.fn(async (task, _logger, _jsonl) => {
    callLog.push("plan");
    await advanceStatus(task.path, "planned");
    return { status: "ok" };
  }),
}));

vi.mock("./phases/worktree.js", () => ({
  runWorktreePhase: vi.fn(async (task, _logger, _jsonl) => {
    callLog.push("worktree");
    await advanceStatus(task.path, "worktree-ready");
    return { status: "ok" };
  }),
}));

vi.mock("./phases/implement.js", () => ({
  runImplementPhase: vi.fn(async (task, _logger, _jsonl) => {
    callLog.push("implement");
    await advanceStatus(task.path, "pr-open");
    return { status: "ok" };
  }),
}));

import { runPipeline } from "./runner.js";
import { readTask, writeTask, type Task } from "../state/task-file.js";
import { runPlanPhase } from "./phases/plan.js";
import { NoopLogger, type Logger } from "../util/logger.js";

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

  it("threads a per-phase JsonlSink to each phase and closes it (writing a result line)", async () => {
    // The runner is the single layer that knows phase identity, so it owns
    // sink lifecycle. This pins: a) phases receive a real sink when
    // taskDir is set, b) the runner writes a result line and closes after
    // the phase returns.
    const task = await makeTaskFile(tmp, "worktree-ready");
    let receivedSink: unknown = null;
    vi.mocked(runPlanPhase).mockImplementationOnce(async (t, _logger, jsonl) => {
      receivedSink = jsonl;
      jsonl?.event("info", { msg: "from plan phase" });
      callLog.push("plan");
      await advanceStatus(t.path, "planned");
      return { status: "ok" };
    });

    await runPipeline(task, NoopLogger, { taskDir: tmp });

    expect(receivedSink).toBeTruthy();
    expect((receivedSink as { filePath: string }).filePath).toMatch(
      /\/logs\/plan-.*\.jsonl$/,
    );
    const logsDir = path.join(tmp, "logs");
    const entries = await fs.readdir(logsDir);
    const planFile = entries.find((e) => e.startsWith("plan-"));
    expect(planFile).toBeTruthy();
    const raw = await fs.readFile(path.join(logsDir, planFile!), "utf8");
    const parsedLines = raw
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    // Both the phase's own info event and the runner's terminating result
    // event should be present.
    expect(parsedLines.some((p) => p.kind === "info" && p.msg === "from plan phase")).toBe(true);
    expect(parsedLines.some((p) => p.kind === "result" && p.status === "ok")).toBe(true);
  });

  it("writes a result/failed line to the jsonl file when the phase throws", async () => {
    const task = await makeTaskFile(tmp, "worktree-ready");
    vi.mocked(runPlanPhase).mockImplementationOnce(async () => {
      throw new Error("synthetic plan crash");
    });
    await expect(runPipeline(task, NoopLogger, { taskDir: tmp })).rejects.toThrow(
      "synthetic plan crash",
    );
    const entries = await fs.readdir(path.join(tmp, "logs"));
    const planFile = entries.find((e) => e.startsWith("plan-"));
    expect(planFile).toBeTruthy();
    const raw = await fs.readFile(path.join(tmp, "logs", planFile!), "utf8");
    const parsed = raw.trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(
      parsed.some(
        (p) =>
          p.kind === "result" &&
          p.status === "failed" &&
          typeof p.reason === "string" &&
          p.reason.includes("synthetic plan crash"),
      ),
    ).toBe(true);
  });

  it("uses NoopJsonlSink when taskDir is omitted (existing test path stays clean)", async () => {
    // Ensures the pipeline doesn't accidentally write logs into cwd or
    // throw when callers don't pass taskDir. This is the path
    // src/pipeline/runner.test.ts has been on for months.
    const task = await makeTaskFile(tmp, "worktree-ready");
    await runPipeline(task);
    // No logs/ subdir created.
    await expect(fs.access(path.join(tmp, "logs"))).rejects.toThrow();
    expect(callLog).toEqual(["plan", "implement"]);
  });

  it("emits a phaseEnd line even when a phase throws past the PhaseResult contract", async () => {
    // Without the runner's try/catch around `spec.phase`, a thrown phase
    // leaves the persistent log file ending with an unterminated
    // `▶ <phase>` line — exactly the post-mortem case that needs the
    // most visibility. This test pins the boundary-symmetry contract.
    const task = await makeTaskFile(tmp, "worktree-ready");
    vi.mocked(runPlanPhase).mockImplementationOnce(async () => {
      callLog.push("plan");
      throw new Error("synthetic plan crash");
    });

    const events: string[] = [];
    const recorder: Logger = {
      ...NoopLogger,
      phaseStart: (name) => events.push(`start:${name}`),
      phaseEnd: (name, _ms, outcome) => events.push(`end:${name}:${outcome}`),
    };

    await expect(runPipeline(task, recorder)).rejects.toThrow(
      "synthetic plan crash",
    );
    // worktree was already done (status=worktree-ready), so plan is the
    // first dispatched phase. We expect a matched start/end pair even on
    // throw, with the failure outcome `threw`.
    expect(events).toContain("start:plan");
    expect(events).toContain("end:plan:threw");
  });
});
