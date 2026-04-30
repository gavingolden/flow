import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStatus } from "../../state/phases.js";

vi.mock("../headless.js", () => ({ runHeadless: vi.fn() }));

import { runHeadless } from "../headless.js";
import { runPlanPhase } from "./plan.js";
import { readTask, writeTask, type Task } from "../../state/task-file.js";

async function makeTaskFile(
  tmpDir: string,
  status: TaskStatus = "worktree-ready",
): Promise<Task> {
  const taskPath = path.join(tmpDir, "task.md");
  const initial: Task = {
    path: taskPath,
    frontmatter: {
      id: "2026-04-30-plan-test",
      status,
      created: "2026-04-30T00:00:00.000Z",
      updated: "2026-04-30T00:00:00.000Z",
      target_repo: tmpDir,
      worktree: tmpDir,
      branch: "test-branch",
      pr: null,
      manual_validation: null,
      merge_commit: null,
    },
    body: [
      "## User prompt",
      "",
      "test prompt",
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

const PLAN_DELIVERABLES = [
  "prd.md",
  "task-breakdown.md",
  "pr-description-draft.md",
];

async function writeAllDeliverables(planDir: string): Promise<void> {
  await fs.mkdir(planDir, { recursive: true });
  for (const name of PLAN_DELIVERABLES) {
    await fs.writeFile(path.join(planDir, name), `# ${name}\n`);
  }
}

describe("runPlanPhase — deliverable-aware success gate", () => {
  let tmp: string;
  let planDir: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-plan-"));
    planDir = path.join(tmp, ".orchestrator", "tasks", "2026-04-30-plan-test-plan");
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("subprocess timeout + all deliverables on disk → success, no retry", async () => {
    const task = await makeTaskFile(tmp);
    vi.mocked(runHeadless).mockImplementationOnce(async () => {
      await writeAllDeliverables(planDir);
      return { ok: false, output: "", exitCode: 143, timedOut: true };
    });

    const r = await runPlanPhase(task);

    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(1);
    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.status).toBe("planned");
    expect(reloaded.body).toContain("prd.md: present");
  });

  it("subprocess non-zero exit + all deliverables on disk → success, no retry", async () => {
    const task = await makeTaskFile(tmp);
    vi.mocked(runHeadless).mockImplementationOnce(async () => {
      await writeAllDeliverables(planDir);
      return { ok: false, output: "", exitCode: 1, error: "boom" };
    });

    const r = await runPlanPhase(task);

    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(1);
  });

  it("subprocess timeout + deliverables missing → retries, second attempt succeeds", async () => {
    const task = await makeTaskFile(tmp);
    vi.mocked(runHeadless)
      .mockImplementationOnce(async () => ({
        ok: false,
        output: "",
        exitCode: 143,
        timedOut: true,
      }))
      .mockImplementationOnce(async () => {
        await writeAllDeliverables(planDir);
        return { ok: true, output: "", exitCode: 0 };
      });

    const r = await runPlanPhase(task);

    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(2);
    const secondPrompt = vi.mocked(runHeadless).mock.calls[1]![0].prompt;
    expect(secondPrompt).toContain("PRIOR ATTEMPT TIMED OUT");
  });

  it("both attempts fail with deliverables missing → returns failed", async () => {
    const task = await makeTaskFile(tmp);
    vi.mocked(runHeadless).mockResolvedValue({
      ok: false,
      output: "",
      exitCode: 143,
      timedOut: true,
    });

    const r = await runPlanPhase(task);

    expect(r.status).toBe("failed");
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(2);
  });

  it("happy path: subprocess ok + deliverables on disk → success", async () => {
    const task = await makeTaskFile(tmp);
    vi.mocked(runHeadless).mockImplementationOnce(async () => {
      await writeAllDeliverables(planDir);
      return { ok: true, output: "", exitCode: 0 };
    });

    const r = await runPlanPhase(task);

    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(1);
  });
});
