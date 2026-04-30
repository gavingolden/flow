import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoopLogger } from "../../util/logger.js";
import {
  readTask,
  writeTask,
  __setNotifierForTests,
  type Task,
} from "../../state/task-file.js";
import { TaskStatus } from "../../state/phases.js";

vi.mock("../headless.js", () => ({ runHeadless: vi.fn() }));

import { runHeadless } from "../headless.js";
import { buildPlanPrompt, runPlanPhase, summarizePlanOutputs } from "./plan.js";

function makeTask(body: string): Task {
  return {
    path: "/tmp/task-x.md",
    frontmatter: {
      id: "2026-04-30-x",
      status: "planning",
      created: "2026-04-30T00:00:00.000Z",
      updated: "2026-04-30T00:00:00.000Z",
      target_repo: "/repo",
      worktree: "/repo/wt",
      branch: "agent/x",
      pr: null,
      manual_validation: null,
      merge_commit: null,
    },
    body,
  };
}

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

const BASE_BODY = [
  "## User prompt",
  "",
  "do the thing",
  "",
  "## Triage",
  "",
  "- intent: feature",
  "- summary: x",
  "",
].join("\n");

describe("buildPlanPrompt", () => {
  it("includes the BLOCKED.md escape-hatch instruction", () => {
    const prompt = buildPlanPrompt(makeTask(BASE_BODY), "/tmp/plan");
    expect(prompt).toContain("/tmp/plan/BLOCKED.md");
    expect(prompt).toMatch(/Escape hatch/);
  });

  it("does not emit a REVISION NOTES block when ## Revision notes is absent", () => {
    const prompt = buildPlanPrompt(makeTask(BASE_BODY), "/tmp/plan");
    expect(prompt).not.toContain("REVISION NOTES");
  });

  it("threads the latest revision-notes entry into a dedicated REVISION NOTES block", () => {
    const body = `${BASE_BODY}
## Revision notes

- 2026-04-30T10:00:00.000Z: use the FRED quarterly endpoint
`;
    const prompt = buildPlanPrompt(makeTask(body), "/tmp/plan");
    expect(prompt).toContain("REVISION NOTES");
    expect(prompt).toContain("use the FRED quarterly endpoint");
  });

  it("emits only the latest entry when multiple revision-notes entries exist", () => {
    const body = `${BASE_BODY}
## Revision notes

- 2026-04-30T10:00:00.000Z: first redirection (older)
- 2026-04-30T11:00:00.000Z: second redirection — use the daily endpoint
`;
    const prompt = buildPlanPrompt(makeTask(body), "/tmp/plan");
    expect(prompt).toContain("second redirection — use the daily endpoint");
    expect(prompt).not.toContain("first redirection (older)");
  });

  it("keeps the existing PRIOR ATTEMPT FAILED slot distinct from REVISION NOTES", () => {
    const body = `${BASE_BODY}
## Revision notes

- 2026-04-30T10:00:00.000Z: redirection text
`;
    const prompt = buildPlanPrompt(
      makeTask(body),
      "/tmp/plan",
      "synthetic failure",
    );
    expect(prompt).toContain("PRIOR ATTEMPT FAILED");
    expect(prompt).toContain("synthetic failure");
    expect(prompt).toContain("REVISION NOTES");
    expect(prompt).toContain("redirection text");
  });
});

describe("summarizePlanOutputs", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-plan-summary-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns blocked=false and the standard checklist when BLOCKED.md is absent", async () => {
    await fs.writeFile(path.join(tmp, "prd.md"), "x");
    await fs.writeFile(path.join(tmp, "task-breakdown.md"), "x");
    await fs.writeFile(path.join(tmp, "pr-description-draft.md"), "x");
    const summary = await summarizePlanOutputs(tmp, NoopLogger);
    expect(summary.blocked).toBe(false);
    expect(summary.text).toContain("prd.md: present");
    expect(summary.text).toContain("task-breakdown.md: present");
    expect(summary.text).toContain("pr-description-draft.md: present");
    expect(summary.text).not.toContain("BLOCKED");
  });

  it("returns blocked=true and surfaces BLOCKED.md content when present", async () => {
    await fs.writeFile(
      path.join(tmp, "BLOCKED.md"),
      "Question 1: which API endpoint should we use?\nQuestion 2: how should errors be handled?",
    );
    const summary = await summarizePlanOutputs(tmp, NoopLogger);
    expect(summary.blocked).toBe(true);
    expect(summary.text).toContain("BLOCKED:");
    expect(summary.text).toContain("Question 1: which API endpoint");
    expect(summary.text).toContain("Question 2: how should errors be handled?");
  });
});

describe("runPlanPhase — BLOCKED.md branch transitions on-disk status", () => {
  let tmp: string;
  let task: Task;
  let planDir: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-plan-blocked-"));
    __setNotifierForTests({
      notify: async () => {},
      notifySync: () => {},
    });
    const taskPath = path.join(tmp, "task.md");
    const initial: Task = {
      path: taskPath,
      frontmatter: {
        id: "2026-04-30-x",
        status: "worktree-ready",
        created: "2026-04-30T00:00:00.000Z",
        updated: "2026-04-30T00:00:00.000Z",
        target_repo: tmp,
        worktree: tmp,
        branch: "agent/x",
        pr: null,
        manual_validation: null,
        merge_commit: null,
      },
      body: [
        "## User prompt",
        "",
        "do the thing",
        "",
        "## Triage",
        "",
        "- intent: feature",
        "- summary: x",
        "",
        "## Phase log",
        "",
        "## Phase outputs",
        "",
      ].join("\n"),
    };
    await writeTask(initial);
    task = await readTask(taskPath);
    planDir = path.join(tmp, ".orchestrator", "tasks", "2026-04-30-x-plan");
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    vi.clearAllMocks();
    __setNotifierForTests(null);
  });

  it("writes status=needs-human and a 'plan-blocked' Phase log entry when BLOCKED.md is present", async () => {
    vi.mocked(runHeadless).mockImplementation(async () => {
      // The "LLM" produces only BLOCKED.md, no other artefacts.
      await fs.mkdir(planDir, { recursive: true });
      await fs.writeFile(
        path.join(planDir, "BLOCKED.md"),
        "Need clarification on export format.",
      );
      return { ok: true, output: "", exitCode: 0 };
    });

    const result = await runPlanPhase(task);
    expect(result).toEqual({ status: "needs-human", reason: "plan-blocked" });

    // The on-disk task must reflect needs-human, not the mid-flight
    // `planning` state. Without the explicit transitionStatus call in the
    // BLOCKED branch the runner would leave the file at `planning`.
    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.status).toBe("needs-human");
    expect(reloaded.body).toContain("planning → needs-human (plan-blocked)");
  });
});

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
