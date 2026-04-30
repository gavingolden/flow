import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStatus } from "../../state/phases.js";

vi.mock("../headless.js", () => ({ runHeadless: vi.fn() }));
vi.mock("./verify-gate.js", () => ({
  runVerifyGate: vi.fn(),
  surfaceVerifyFailureOnPr: vi.fn(),
}));

import { runHeadless } from "../headless.js";
import { runVerifyGate, surfaceVerifyFailureOnPr } from "./verify-gate.js";
import { runVerifyPhase, truncateForRetryPrompt } from "./verify.js";
import { readTask, writeTask, type Task } from "../../state/task-file.js";

const headlessPrompts: string[] = [];

async function makeTaskFile(
  tmpDir: string,
  fm: Partial<{
    status: TaskStatus;
    pr: number | null;
    branch: string | null;
    worktree: string | null;
  }> = {},
): Promise<Task> {
  const taskPath = path.join(tmpDir, "task.md");
  const initial: Task = {
    path: taskPath,
    frontmatter: {
      id: "2026-04-29-verify-test",
      status: fm.status ?? "pr-open",
      created: "2026-04-29T00:00:00.000Z",
      updated: "2026-04-29T00:00:00.000Z",
      target_repo: tmpDir,
      worktree: fm.worktree === undefined ? tmpDir : fm.worktree,
      branch: fm.branch === undefined ? "test-branch" : fm.branch,
      pr: fm.pr === undefined ? 42 : fm.pr,
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

async function installVerifyScript(tmpDir: string): Promise<void> {
  const flowDir = path.join(tmpDir, ".flow");
  await fs.mkdir(flowDir, { recursive: true });
  const scriptPath = path.join(flowDir, "verify");
  await fs.writeFile(scriptPath, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
}

describe("runVerifyPhase", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-verify-"));
    headlessPrompts.length = 0;

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

  it("happy path: attempt 1 ok + gate ok → status ci, '1/3 passed' (no flake), no PR surface", async () => {
    await installVerifyScript(tmp);
    const task = await makeTaskFile(tmp, { status: "pr-open", pr: 42 });

    const r = await runVerifyPhase(task);

    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runVerifyGate)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(surfaceVerifyFailureOnPr)).not.toHaveBeenCalled();

    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.status).toBe("ci");
    expect(reloaded.body).toContain("verify: 1/3 passed");
    expect(reloaded.body).not.toContain("suspected flake");
  });

  it("retry-then-pass: attempts 1+2 fail (gate-fail), attempt 3 passes → '3/3 passed (2 retries — suspected flake)', status ci, attempt 3 prompt carries truncated failure", async () => {
    await installVerifyScript(tmp);
    vi.mocked(runVerifyGate)
      .mockResolvedValueOnce({ ok: false, output: "first gate failure log" })
      .mockResolvedValueOnce({ ok: false, output: "second gate failure log" })
      .mockResolvedValueOnce({ ok: true, output: "" });

    const task = await makeTaskFile(tmp, { status: "pr-open", pr: 42 });
    const r = await runVerifyPhase(task);

    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(3);
    expect(headlessPrompts[0]).not.toContain("PRIOR ATTEMPT FAILED");
    expect(headlessPrompts[1]).toContain("PRIOR ATTEMPT FAILED");
    expect(headlessPrompts[1]).toContain("first gate failure log");
    expect(headlessPrompts[2]).toContain("PRIOR ATTEMPT FAILED");
    expect(headlessPrompts[2]).toContain("second gate failure log");

    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.status).toBe("ci");
    expect(reloaded.body).toContain("verify: 3/3 passed (2 retries — suspected flake)");
  });

  it("retry-then-pass with one retry: '2/3 passed (1 retry — suspected flake)' (singular)", async () => {
    await installVerifyScript(tmp);
    vi.mocked(runVerifyGate)
      .mockResolvedValueOnce({ ok: false, output: "transient failure" })
      .mockResolvedValueOnce({ ok: true, output: "" });

    const task = await makeTaskFile(tmp, { status: "pr-open", pr: 42 });
    const r = await runVerifyPhase(task);

    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(2);
    const reloaded = await readTask(task.path);
    expect(reloaded.body).toContain("verify: 2/3 passed (1 retry — suspected flake)");
  });

  it("exhaustion: all 3 attempts fail → status needs-human reason 'verify-exhausted', PR caution surfaced, fenced failure block on task", async () => {
    await installVerifyScript(tmp);
    vi.mocked(runVerifyGate).mockResolvedValue({
      ok: false,
      output: "persistent failure log line",
    });

    const task = await makeTaskFile(tmp, { status: "pr-open", pr: 42 });
    const r = await runVerifyPhase(task);

    expect(r).toEqual({ status: "needs-human", reason: "verify-exhausted" });
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(surfaceVerifyFailureOnPr)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(surfaceVerifyFailureOnPr)).toHaveBeenCalledWith(
      42,
      tmp,
      expect.stringContaining("persistent failure log line"),
      expect.anything(),
    );

    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.status).toBe("needs-human");
    expect(reloaded.body).toContain("verify: 3/3 attempts failed");
    expect(reloaded.body).toMatch(/```text\n[\s\S]*persistent failure log line[\s\S]*\n```/);
  });

  it("skill/gate disagreement: headless ok but gate fails → counted as failure, retries", async () => {
    await installVerifyScript(tmp);
    vi.mocked(runVerifyGate)
      .mockResolvedValueOnce({ ok: false, output: "gate failed despite skill ok" })
      .mockResolvedValueOnce({ ok: true, output: "" });

    const task = await makeTaskFile(tmp, { status: "pr-open", pr: 42 });
    const r = await runVerifyPhase(task);

    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(2);
    expect(headlessPrompts[1]).toContain("gate failed despite skill ok");
  });

  it("missing .flow/verify: preflight fails → status needs-human reason 'verify-script-missing', no LLM invocation", async () => {
    // No installVerifyScript() call — script is intentionally absent.
    const task = await makeTaskFile(tmp, { status: "pr-open", pr: 42 });
    const r = await runVerifyPhase(task);

    expect(r).toEqual({ status: "needs-human", reason: "verify-script-missing" });
    expect(vi.mocked(runHeadless)).not.toHaveBeenCalled();
    expect(vi.mocked(runVerifyGate)).not.toHaveBeenCalled();

    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.status).toBe("needs-human");
  });

  it("missing PR: preflight fails → status needs-human reason 'pr-missing', no LLM, no gate, no surface", async () => {
    const task = await makeTaskFile(tmp, { status: "pr-open", pr: null });
    const r = await runVerifyPhase(task);

    expect(r).toEqual({ status: "needs-human", reason: "pr-missing" });
    expect(vi.mocked(runHeadless)).not.toHaveBeenCalled();
    expect(vi.mocked(runVerifyGate)).not.toHaveBeenCalled();
    expect(vi.mocked(surfaceVerifyFailureOnPr)).not.toHaveBeenCalled();
  });

  it("missing worktree: returns failed without invoking LLM", async () => {
    const task = await makeTaskFile(tmp, {
      status: "pr-open",
      pr: 42,
      worktree: null,
    });
    const r = await runVerifyPhase(task);

    expect(r.status).toBe("failed");
    expect(vi.mocked(runHeadless)).not.toHaveBeenCalled();
  });

  it("missing branch: returns failed without invoking LLM", async () => {
    await installVerifyScript(tmp);
    const task = await makeTaskFile(tmp, {
      status: "pr-open",
      pr: 42,
      branch: null,
    });
    const r = await runVerifyPhase(task);

    expect(r.status).toBe("failed");
    expect(vi.mocked(runHeadless)).not.toHaveBeenCalled();
  });

  it("headless non-zero exit: counted as failed attempt and retries", async () => {
    await installVerifyScript(tmp);
    vi.mocked(runHeadless)
      .mockImplementationOnce(async (opts) => {
        headlessPrompts.push(opts.prompt);
        return { ok: false, output: "", error: "headless crash", exitCode: 1 };
      })
      .mockImplementationOnce(async (opts) => {
        headlessPrompts.push(opts.prompt);
        return { ok: true, output: "", exitCode: 0 };
      });

    const task = await makeTaskFile(tmp, { status: "pr-open", pr: 42 });
    const r = await runVerifyPhase(task);

    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(2);
    // Gate was only consulted once (after the second, successful headless run).
    expect(vi.mocked(runVerifyGate)).toHaveBeenCalledTimes(1);
    expect(headlessPrompts[1]).toContain("headless crash");
  });
});

describe("truncateForRetryPrompt", () => {
  it("≤ 200 lines: passes through unchanged", () => {
    const log = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
    expect(truncateForRetryPrompt(log)).toBe(log);
  });

  it("at the 200-line boundary: passes through unchanged", () => {
    const log = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");
    expect(truncateForRetryPrompt(log)).toBe(log);
  });

  it("> 200 lines: returns matched-error header + matches + tail of last 200", () => {
    const head = Array.from({ length: 800 }, (_, i) =>
      i % 50 === 0 ? `head error ${i}` : `head benign ${i}`,
    );
    const tail = Array.from({ length: 200 }, (_, i) => `tail-${i}`);
    const log = [...head, ...tail].join("\n");

    const out = truncateForRetryPrompt(log);

    expect(out).toMatch(/\[matched \d+ error\/fail\/panic line/);
    expect(out).toContain("[…tail…]");
    // First and last tail lines are present.
    expect(out).toContain("tail-0");
    expect(out).toContain("tail-199");
    // At least one head error match preserved.
    expect(out).toContain("head error 0");
    // Result has fewer lines than input.
    expect(out.split("\n").length).toBeLessThan(log.split("\n").length);
  });

  it("caps matches at 100 lines so a pathological all-error log can't reflood the prompt", () => {
    // 500 head lines, all error matches; 200 tail lines.
    const head = Array.from({ length: 500 }, (_, i) => `head error ${i}`);
    const tail = Array.from({ length: 200 }, (_, i) => `tail-${i}`);
    const log = [...head, ...tail].join("\n");

    const out = truncateForRetryPrompt(log);
    // Header signals the cap was applied.
    expect(out).toMatch(/showing first 100/);
    // Match block: 100 lines of "head error N" ending at index 99.
    expect(out).toContain("head error 99");
    // The 100th match (index 100, the 101st line) is omitted.
    expect(out).not.toContain("head error 100\n");
  });
});
