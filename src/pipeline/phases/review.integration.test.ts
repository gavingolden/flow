import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../headless.js", () => ({ runHeadless: vi.fn() }));
vi.mock("./implement.js", () => ({ runImplementPhase: vi.fn() }));

import { runHeadless } from "../headless.js";
import { runImplementPhase } from "./implement.js";
import { runReviewPhase } from "./review.js";
import {
  readTask,
  writeTask,
  type Task,
  type TaskFrontmatter,
} from "../../state/task-file.js";
import type { TaskStatus } from "../../state/phases.js";

interface CycleJson {
  summary: string;
  critical: Array<{
    kind: "code" | "architectural";
    file: string;
    line: number;
    summary: string;
    body: string;
  }>;
  minor: Array<{ file: string; line: number; summary: string; body: string }>;
}

const clean: CycleJson = { summary: "looks good", critical: [], minor: [] };

const criticalCode: CycleJson = {
  summary: "needs fix",
  critical: [
    { kind: "code", file: "src/foo.ts", line: 42, summary: "null deref", body: "issue (blocking)" },
  ],
  minor: [],
};

const criticalArchitectural: CycleJson = {
  summary: "wrong layer",
  critical: [
    { kind: "architectural", file: "src/foo.ts", line: 1, summary: "wrong layer", body: "..." },
  ],
  minor: [],
};

async function makeTaskFile(
  targetRepo: string,
  overrides: Partial<TaskFrontmatter> = {},
): Promise<Task> {
  const id = "2026-04-29-review-int";
  const tasksDir = path.join(targetRepo, ".orchestrator", "tasks");
  await fs.mkdir(tasksDir, { recursive: true });
  const taskPath = path.join(tasksDir, `${id}.md`);
  const fm: TaskFrontmatter = {
    id,
    status: "reviewing" as TaskStatus,
    created: "2026-04-29T00:00:00.000Z",
    updated: "2026-04-29T00:00:00.000Z",
    target_repo: targetRepo,
    worktree: targetRepo,
    branch: "test-branch",
    pr: 42,
    manual_validation: null,
    merge_commit: null,
    review_cycles: null,
    ...overrides,
  };
  const initial: Task = {
    path: taskPath,
    frontmatter: fm,
    body: [
      "## User prompt",
      "",
      "test",
      "",
      "## Phase log",
      "",
      "## Phase outputs",
      "",
      "### ci (latest: 2026-04-30T00:00:00Z)",
      "",
      "- bot: Copilot summary excerpt",
      "",
    ].join("\n"),
  };
  await writeTask(initial);
  return readTask(taskPath);
}

// Wire up the runHeadless mock to drop a JSON file at the expected path,
// pulling the path back out of the prompt's `RESULT_JSON_PATH=...` line.
function mockReviewSequence(jsons: CycleJson[]): void {
  const queue = [...jsons];
  vi.mocked(runHeadless).mockImplementation(async (opts) => {
    const next = queue.shift();
    if (!next) {
      throw new Error("integration: runHeadless called more times than canned cycles");
    }
    const m = opts.prompt.match(/RESULT_JSON_PATH=(\S+)/);
    if (!m) throw new Error("integration: prompt missing RESULT_JSON_PATH");
    const resultPath = m[1]!;
    await fs.mkdir(path.dirname(resultPath), { recursive: true });
    await fs.writeFile(resultPath, JSON.stringify(next), "utf8");
    return { ok: true, output: "", exitCode: 0 };
  });
}

describe("runReviewPhase — end-to-end loop scenarios", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-review-int-"));
    vi.mocked(runImplementPhase).mockResolvedValue({ status: "ok" });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("Path 1: cycle 0 clean → ok, status preserved at reviewing, review_cycles=0", async () => {
    mockReviewSequence([clean]);
    const task = await makeTaskFile(tmp);
    const r = await runReviewPhase(task);
    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runImplementPhase)).not.toHaveBeenCalled();

    const reloaded = await readTask(task.path);
    // Gate phase (PR 8) will transition; review leaves it at reviewing.
    expect(reloaded.frontmatter.status).toBe("reviewing");
    // Persisted on first entry: null → 0. No fix loop completed, so still 0.
    expect(reloaded.frontmatter.review_cycles).toBe(0);
    expect(reloaded.body).toContain("decision: clean — advancing");
    expect(reloaded.body).toContain("### review");
  });

  it("Path 2: critical-code → fix → critical-code → fix → clean, returns ok with review_cycles=2", async () => {
    mockReviewSequence([criticalCode, criticalCode, clean]);
    const task = await makeTaskFile(tmp);
    const r = await runReviewPhase(task);
    expect(r).toEqual({ status: "ok" });
    // Two implement(fix) calls between the three reviews.
    expect(vi.mocked(runImplementPhase)).toHaveBeenCalledTimes(2);
    // Each implement(fix) call carries a failureLog rendered from the prior
    // review JSON — confirm shape, not exact content.
    const firstCallOpts = vi.mocked(runImplementPhase).mock.calls[0]![1] as { mode: string; failureLog: string };
    expect(firstCallOpts.mode).toBe("fix");
    expect(firstCallOpts.failureLog).toContain("src/foo.ts:42");

    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.status).toBe("reviewing");
    expect(reloaded.frontmatter.review_cycles).toBe(2);
    expect(reloaded.body).toContain("decision: clean — advancing");
    // All three cycles surface in the rendered subsection.
    expect(reloaded.body).toMatch(/cycle 1 .*?summary "needs fix"/);
    expect(reloaded.body).toMatch(/cycle 2 .*?summary "needs fix"/);
    expect(reloaded.body).toMatch(/cycle 3 .*?summary "looks good"/);
  });

  it("Path 3: 3× critical-code → needs-human review-cycles-exhausted, review_cycles=2", async () => {
    mockReviewSequence([criticalCode, criticalCode, criticalCode]);
    const task = await makeTaskFile(tmp);
    const r = await runReviewPhase(task);
    expect(r).toEqual({ status: "needs-human", reason: "review-cycles-exhausted" });
    // 2 fix loops fired between the 3 reviews; the 3rd review hit the cap.
    expect(vi.mocked(runImplementPhase)).toHaveBeenCalledTimes(2);

    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.status).toBe("needs-human");
    expect(reloaded.frontmatter.review_cycles).toBe(2);
    expect(reloaded.body).toContain("decision: needs-human (review-cycles-exhausted)");
    expect(reloaded.body).toMatch(/cycle 1/);
    expect(reloaded.body).toMatch(/cycle 2/);
    expect(reloaded.body).toMatch(/cycle 3/);
  });

  it("Path 4: critical-architectural at cycle 0 → needs-human architectural-concern, review_cycles=0, no fix call", async () => {
    mockReviewSequence([criticalArchitectural]);
    const task = await makeTaskFile(tmp);
    const r = await runReviewPhase(task);
    expect(r).toEqual({ status: "needs-human", reason: "architectural-concern" });
    // The escape hatch must skip the loop-back entirely.
    expect(vi.mocked(runImplementPhase)).not.toHaveBeenCalled();

    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.status).toBe("needs-human");
    // Architectural escape does NOT increment review_cycles.
    expect(reloaded.frontmatter.review_cycles).toBe(0);
    expect(reloaded.body).toContain("decision: needs-human (architectural-concern)");
    expect(reloaded.body).toContain("critical (architectural)");
  });

  it("preserves bot review excerpts from `## Phase outputs > ci` into the review prompt", async () => {
    // ci-wait writes bot review excerpts into the ci subsection; review must
    // pass them through to /pr-review verbatim. This pins the cross-phase
    // contract — without it, the review phase would lose the second-opinion
    // input ci-wait worked to collect.
    mockReviewSequence([clean]);
    const task = await makeTaskFile(tmp);
    await runReviewPhase(task);
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(runHeadless).mock.calls[0]![0]!.prompt;
    expect(prompt).toContain("Copilot summary excerpt");
  });

  it("resume-after-crash: starting with review_cycles=1 reads the persisted value, rehydrates prior cycle, and continues", async () => {
    // Simulate a runner crash mid-fix-loop. The task's frontmatter still
    // says review_cycles=1, status=reviewing, and the pre-crash cycle's
    // result-0.json is still on disk. On re-entry, review must:
    //   (a) read the persisted counter and treat the next review run as
    //       cycle 2 (not 1);
    //   (b) rehydrate cycle 1 from result-0.json so the rendered subsection
    //       still surfaces it (per docs/task-schema.md the review subsection
    //       re-renders with full history).
    mockReviewSequence([clean]);
    const task = await makeTaskFile(tmp, { review_cycles: 1 });
    // Seed the pre-crash cycle 1 JSON on disk so rehydrate has something
    // to read.
    const reviewDir = path.join(
      task.frontmatter.target_repo,
      ".orchestrator",
      "tasks",
      task.frontmatter.id,
      "review",
    );
    await fs.mkdir(reviewDir, { recursive: true });
    await fs.writeFile(
      path.join(reviewDir, "result-0.json"),
      JSON.stringify(criticalCode),
      "utf8",
    );

    await runReviewPhase(task);
    const reloaded = await readTask(task.path);
    // Clean review on re-entry → counter unchanged at 1.
    expect(reloaded.frontmatter.review_cycles).toBe(1);
    // Both cycles surface — the rehydrated pre-crash cycle 1 and the new
    // cycle 2.
    expect(reloaded.body).toContain("cycle 2");
    expect(reloaded.body).toMatch(/cycle 1\b/);
    expect(reloaded.body).toContain("decision: clean — advancing");
  });

  it("escalates to failed when frontmatter.worktree is null or missing on disk", async () => {
    // The defensive worktree check fires before the LLM is spawned. Pin
    // both modes (null and a non-existent path) so a future refactor that
    // collapses the branches can't silently let the runner spawn claude
    // against an invalid cwd.
    const task = await makeTaskFile(tmp, { worktree: "/tmp/does-not-exist-flow-review" });
    const r = await runReviewPhase(task);
    expect(r.status).toBe("failed");
    expect(vi.mocked(runHeadless)).not.toHaveBeenCalled();
  });

  it("escalates to needs-human (pr-missing) when frontmatter.pr is null", async () => {
    // Defensive fail-fast mirrors ci-wait. The runner shouldn't get here in
    // practice (implement opens the PR before transitioning to pr-open) but
    // direct `flow run --phase review` against a malformed task is caught.
    const task = await makeTaskFile(tmp, { pr: null });
    const r = await runReviewPhase(task);
    expect(r).toEqual({ status: "needs-human", reason: "pr-missing" });
    expect(vi.mocked(runHeadless)).not.toHaveBeenCalled();
    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.status).toBe("needs-human");
  });
});
