import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStatus } from "../../state/phases.js";

vi.mock("execa", () => ({ execa: vi.fn() }));
vi.mock("../headless.js", () => ({ runHeadless: vi.fn() }));
vi.mock("./verify-gate.js", () => ({
  runVerifyGate: vi.fn(),
  surfaceVerifyFailureOnPr: vi.fn(),
}));

import { execa } from "execa";
import { runHeadless } from "../headless.js";
import { runVerifyGate, surfaceVerifyFailureOnPr } from "./verify-gate.js";
import { runImplementPhase } from "./implement.js";
import { readTask, writeTask, type Task } from "../../state/task-file.js";

interface ExecaCall {
  cmd: string;
  args: readonly string[];
}

const execaCalls: ExecaCall[] = [];
const headlessPrompts: string[] = [];

// Queue of `gh pr list` responses, consumed in order. The last entry sticks
// once the queue has been drained — tests don't have to push a separate
// response per probe when later probes should match the prior one.
let prListQueue: Array<Array<{ number: number }>> = [[]];
let prCreateExitCode = 0;

const ghPrListCount = () =>
  execaCalls.filter(
    (c) => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "list",
  ).length;

const ghPrCreateCount = () =>
  execaCalls.filter(
    (c) => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "create",
  ).length;

async function makeTaskFile(
  tmpDir: string,
  fm: Partial<{
    status: TaskStatus;
    pr: number | null;
    branch: string;
  }> = {},
): Promise<Task> {
  const taskPath = path.join(tmpDir, "task.md");
  const initial: Task = {
    path: taskPath,
    frontmatter: {
      id: "2026-04-29-test",
      status: fm.status ?? "implementing",
      created: "2026-04-29T00:00:00.000Z",
      updated: "2026-04-29T00:00:00.000Z",
      target_repo: tmpDir,
      worktree: tmpDir,
      branch: fm.branch ?? "test-branch",
      pr: fm.pr ?? null,
      manual_validation: null,
      merge_commit: null,
    },
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

describe("runImplementPhase — modes and entry gate", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-implement-"));
    execaCalls.length = 0;
    headlessPrompts.length = 0;
    prListQueue = [[]];
    prCreateExitCode = 0;

    vi.mocked(execa).mockImplementation((async (cmd: string, args: string[]) => {
      execaCalls.push({ cmd, args });
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        const next = prListQueue.length > 1 ? prListQueue.shift() : prListQueue[0];
        return { exitCode: 0, stdout: JSON.stringify(next ?? []), stderr: "" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        return {
          exitCode: prCreateExitCode,
          stdout: "https://github.com/o/r/pull/0",
          stderr: prCreateExitCode === 0 ? "" : "synthetic create error",
        };
      }
      throw new Error(`unexpected execa: ${cmd} ${JSON.stringify(args)}`);
    }) as never);

    vi.mocked(runHeadless).mockImplementation(async (opts) => {
      headlessPrompts.push(opts.prompt);
      return { ok: true, output: "", exitCode: 0 };
    });

    vi.mocked(runVerifyGate).mockResolvedValue({ ok: true, output: "" });
    vi.mocked(surfaceVerifyFailureOnPr).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("entry gate (create): pr in frontmatter & status=implementing → reconciles to pr-open without LLM or gh pr create", async () => {
    const task = await makeTaskFile(tmp, { status: "implementing", pr: 42 });
    const r = await runImplementPhase(task, { mode: "create" });
    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runHeadless)).not.toHaveBeenCalled();
    expect(ghPrCreateCount()).toBe(0);
    // pr is non-null, so detectOpenedPr should never have been called either.
    expect(ghPrListCount()).toBe(0);

    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.pr).toBe(42);
    expect(reloaded.frontmatter.status).toBe("pr-open");
  });

  it("entry gate (create): pr=null but gh pr list hits → frontmatter populated, status reconciled, no LLM", async () => {
    prListQueue = [[{ number: 99 }]];
    const task = await makeTaskFile(tmp, { status: "implementing", pr: null });
    const r = await runImplementPhase(task, { mode: "create" });
    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runHeadless)).not.toHaveBeenCalled();
    expect(ghPrCreateCount()).toBe(0);

    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.pr).toBe(99);
    expect(reloaded.frontmatter.status).toBe("pr-open");
  });

  it("entry gate (create) misses → LLM runs, gh pr create fires, frontmatter & status updated", async () => {
    // entry gate: []; post-LLM probe: []; post-create probe: [{ 100 }].
    prListQueue = [[], [], [{ number: 100 }]];
    const task = await makeTaskFile(tmp, { status: "planned", pr: null });
    const r = await runImplementPhase(task, { mode: "create" });
    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(1);
    expect(ghPrCreateCount()).toBe(1);

    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.pr).toBe(100);
    expect(reloaded.frontmatter.status).toBe("pr-open");
  });

  it("side-effect gate (create): LLM opens a PR mid-flight → gh pr create is skipped, existing PR recorded", async () => {
    prListQueue = [[]];
    vi.mocked(runHeadless).mockImplementationOnce(async (opts) => {
      headlessPrompts.push(opts.prompt);
      // The LLM pushed and opened a PR during its run; the post-LLM probe
      // must observe the change.
      prListQueue = [[{ number: 200 }]];
      return { ok: true, output: "", exitCode: 0 };
    });

    const task = await makeTaskFile(tmp, { status: "planned", pr: null });
    const r = await runImplementPhase(task, { mode: "create" });
    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(1);
    expect(ghPrCreateCount()).toBe(0);

    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.pr).toBe(200);
    expect(reloaded.frontmatter.status).toBe("pr-open");
  });

  it("create mode: first verify-gate failure triggers retryOnce with prior failure in the prompt", async () => {
    // entry gate → []; failure-path detectOpenedPr → []; post-LLM gate → [];
    // post-create probe → [{ 300 }].
    prListQueue = [[], [], [], [{ number: 300 }]];
    vi.mocked(runVerifyGate)
      .mockResolvedValueOnce({ ok: false, output: "first gate failure" })
      .mockResolvedValueOnce({ ok: true, output: "" });

    const task = await makeTaskFile(tmp, { status: "planned", pr: null });
    const r = await runImplementPhase(task, { mode: "create" });
    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(2);
    expect(headlessPrompts[1]).toContain("first gate failure");
    expect(ghPrCreateCount()).toBe(1);

    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.pr).toBe(300);
  });

  it("fix mode: LLM runs once with failureLog appended; no gh pr create; pr unchanged; returns ok", async () => {
    const task = await makeTaskFile(tmp, { status: "pr-open", pr: 42 });
    const r = await runImplementPhase(task, {
      mode: "fix",
      failureLog: "verify failed: typecheck error in foo.ts",
    });
    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(1);
    expect(headlessPrompts[0]).toContain("verify failed: typecheck error in foo.ts");
    expect(ghPrCreateCount()).toBe(0);

    const reloaded = await readTask(task.path);
    // pr field is never touched by fix mode regardless of outcome.
    expect(reloaded.frontmatter.pr).toBe(42);
    // Fix mode does NOT transition to "pr-open" on success — that belongs
    // to the caller (PR 5 / PR 7) which knows the post-fix terminal state.
    expect(reloaded.frontmatter.status).toBe("implementing");
  });

  it("fix mode: verify-gate failure → returns failed, single attempt, surfaces failure on existing PR", async () => {
    vi.mocked(runVerifyGate).mockResolvedValueOnce({
      ok: false,
      output: "synthetic gate failure",
    });
    // detectOpenedPr inside the failed-attempt surface step returns the
    // existing PR so surfaceVerifyFailureOnPr can be called against it.
    prListQueue = [[{ number: 42 }]];

    const task = await makeTaskFile(tmp, { status: "pr-open", pr: 42 });
    const r = await runImplementPhase(task, {
      mode: "fix",
      failureLog: "prior failure",
    });
    expect(r.status).toBe("failed");
    // Single-shot in fix mode — no retry, even though create mode would have.
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(surfaceVerifyFailureOnPr)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(surfaceVerifyFailureOnPr)).toHaveBeenCalledWith(
      42,
      tmp,
      expect.stringContaining("synthetic gate failure"),
      expect.anything(),
    );
    expect(ghPrCreateCount()).toBe(0);

    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.pr).toBe(42);
  });
});
