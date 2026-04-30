import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../headless.js", () => ({ runHeadless: vi.fn() }));
vi.mock("./ci-wait.js", () => ({ runCiWaitPhase: vi.fn() }));

import { runHeadless } from "../headless.js";
import { runCiWaitPhase } from "./ci-wait.js";
import { runReviewPhase, type ReviewSummary } from "./review.js";
import {
  readTask,
  writeTask,
  type Task,
  type TaskFrontmatter,
} from "../../state/task-file.js";
import type { TaskStatus } from "../../state/phases.js";

const cleanSummary: ReviewSummary = {
  mode: "review",
  committed: false,
  escalate: false,
  reason: "",
  addressed: [],
  deferred: [],
};

const committedSummary: ReviewSummary = {
  mode: "address",
  committed: true,
  escalate: false,
  reason: "",
  addressed: [
    { file: "src/foo.ts", line: 42, summary: "fixed null deref" },
  ],
  deferred: [],
};

const architecturalSummary: ReviewSummary = {
  mode: "review",
  committed: false,
  escalate: true,
  reason: "architectural-concern",
  addressed: [],
  deferred: [
    {
      file: "src/foo.ts",
      line: 1,
      summary: "wrong layer",
      kind: "architectural",
      tracker_ref: "docs/roadmap.md#followup-relocate",
    },
  ],
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

// Wire up the runHeadless mock to drop a JSON summary file at the path
// pulled out of the prompt's `RESULT_JSON_PATH=...` line.
function mockReviewSummary(summary: ReviewSummary): void {
  vi.mocked(runHeadless).mockImplementation(async (opts) => {
    const m = opts.prompt.match(/RESULT_JSON_PATH=(\S+)/);
    if (!m) throw new Error("integration: prompt missing RESULT_JSON_PATH");
    const resultPath = m[1]!;
    await fs.mkdir(path.dirname(resultPath), { recursive: true });
    await fs.writeFile(resultPath, JSON.stringify(summary), "utf8");
    return { ok: true, output: "", exitCode: 0 };
  });
}

describe("runReviewPhase — single-invocation scenarios", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-review-int-"));
    vi.mocked(runCiWaitPhase).mockResolvedValue({ status: "ok" });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("Story 2: clean review (committed=false) → ok, ci-wait NOT called, status preserved at reviewing", async () => {
    mockReviewSummary(cleanSummary);
    const task = await makeTaskFile(tmp);
    const r = await runReviewPhase(task);
    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runCiWaitPhase)).not.toHaveBeenCalled();

    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.status).toBe("reviewing");
    expect(reloaded.body).toContain("mode: review");
    expect(reloaded.body).toContain("committed: false");
    expect(reloaded.body).toContain("escalate: false");
    expect(reloaded.body).toContain("### review");
  });

  it("Story 1: Address mode auto-fix (committed=true) → ok after ci-wait re-runs", async () => {
    mockReviewSummary(committedSummary);
    const task = await makeTaskFile(tmp);
    const r = await runReviewPhase(task);
    expect(r).toEqual({ status: "ok" });
    expect(vi.mocked(runCiWaitPhase)).toHaveBeenCalledTimes(1);

    const reloaded = await readTask(task.path);
    expect(reloaded.body).toContain("mode: address");
    expect(reloaded.body).toContain("committed: true");
    expect(reloaded.body).toContain("src/foo.ts:42 — fixed null deref");
  });

  it("Story 3: architectural-deferred → needs-human (architectural-concern), ci-wait NOT called", async () => {
    mockReviewSummary(architecturalSummary);
    const task = await makeTaskFile(tmp);
    const r = await runReviewPhase(task);
    expect(r).toEqual({ status: "needs-human", reason: "architectural-concern" });
    expect(vi.mocked(runCiWaitPhase)).not.toHaveBeenCalled();

    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.status).toBe("needs-human");
    expect(reloaded.body).toContain("escalate: true (architectural-concern)");
    expect(reloaded.body).toContain("(architectural)");
  });

  it("propagates a ci-wait failure from the back-edge as the phase result", async () => {
    // If the post-fix CI run fails, review must surface the inner reason
    // verbatim rather than masking it as success and letting gate run on
    // stale state. Pin the propagation contract.
    mockReviewSummary(committedSummary);
    vi.mocked(runCiWaitPhase).mockResolvedValueOnce({
      status: "needs-human",
      reason: "ci-hang",
    });
    const task = await makeTaskFile(tmp);
    const r = await runReviewPhase(task);
    expect(r).toEqual({ status: "needs-human", reason: "ci-hang" });
  });

  it("preserves bot review excerpts from `## Phase outputs > ci` into the prompt", async () => {
    // Cross-phase contract: ci-wait writes bot review excerpts into the
    // ci subsection; review must pass them through to /pr-review verbatim
    // as second-opinion input.
    mockReviewSummary(cleanSummary);
    const task = await makeTaskFile(tmp);
    await runReviewPhase(task);
    expect(vi.mocked(runHeadless)).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(runHeadless).mock.calls[0]![0]!.prompt;
    expect(prompt).toContain("Copilot summary excerpt");
  });

  it("clears any stale summary.json before the subprocess runs", async () => {
    // Resume scenario: a prior crash left a stale summary.json on disk
    // that reads as a clean review. Without the pre-spawn unlink, a
    // subprocess that exits 0 without writing the file would let us
    // succeed against pre-crash content. Pin the unlink so the no-write
    // case becomes an unambiguous "summary missing" failure.
    const task = await makeTaskFile(tmp);
    const reviewDir = path.join(
      task.frontmatter.target_repo,
      ".orchestrator",
      "tasks",
      task.frontmatter.id,
      "review",
    );
    await fs.mkdir(reviewDir, { recursive: true });
    await fs.writeFile(
      path.join(reviewDir, "summary.json"),
      JSON.stringify({ ...cleanSummary, addressed: [{ file: "STALE", line: 1, summary: "STALE" }] }),
      "utf8",
    );
    vi.mocked(runHeadless).mockImplementationOnce(async () => ({
      ok: true,
      output: "",
      exitCode: 0,
    }));
    const r = await runReviewPhase(task);
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.reason).toContain("summary.json missing");
    }
    const reloaded = await readTask(task.path);
    expect(reloaded.body).not.toContain("STALE");
  });

  it("escalates to needs-human (worktree-missing) when frontmatter.worktree points at a non-existent path", async () => {
    const task = await makeTaskFile(tmp, { worktree: "/tmp/does-not-exist-flow-review" });
    const r = await runReviewPhase(task);
    expect(r).toEqual({ status: "needs-human", reason: "worktree-missing" });
    expect(vi.mocked(runHeadless)).not.toHaveBeenCalled();
    const reloaded = await readTask(task.path);
    expect(reloaded.frontmatter.status).toBe("needs-human");
    expect(reloaded.body).toContain("decision: needs-human (worktree-missing)");
  });

  it("escalates to needs-human (worktree-missing) when frontmatter.worktree is null", async () => {
    const task = await makeTaskFile(tmp, { worktree: null });
    const r = await runReviewPhase(task);
    expect(r).toEqual({ status: "needs-human", reason: "worktree-missing" });
    expect(vi.mocked(runHeadless)).not.toHaveBeenCalled();
  });

  it("escalates to needs-human (pr-missing) when frontmatter.pr is null", async () => {
    const task = await makeTaskFile(tmp, { pr: null });
    const r = await runReviewPhase(task);
    expect(r).toEqual({ status: "needs-human", reason: "pr-missing" });
    expect(vi.mocked(runHeadless)).not.toHaveBeenCalled();
  });

  it("returns failed when the subprocess writes malformed JSON", async () => {
    vi.mocked(runHeadless).mockImplementation(async (opts) => {
      const m = opts.prompt.match(/RESULT_JSON_PATH=(\S+)/)!;
      const resultPath = m[1]!;
      await fs.mkdir(path.dirname(resultPath), { recursive: true });
      await fs.writeFile(resultPath, "{ not valid json", "utf8");
      return { ok: true, output: "", exitCode: 0 };
    });
    const task = await makeTaskFile(tmp);
    const r = await runReviewPhase(task);
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.reason).toContain("malformed");
    }
  });

  it("returns failed when the subprocess itself fails", async () => {
    vi.mocked(runHeadless).mockResolvedValueOnce({
      ok: false,
      output: "",
      exitCode: 1,
      error: "synthetic claude crash",
    });
    const task = await makeTaskFile(tmp);
    const r = await runReviewPhase(task);
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.reason).toContain("synthetic claude crash");
    }
    expect(vi.mocked(runCiWaitPhase)).not.toHaveBeenCalled();
  });

  it("truncates the ci excerpt when it exceeds the prompt budget (~4 KB)", async () => {
    mockReviewSummary(cleanSummary);
    const huge = "x".repeat(8 * 1024);
    const task = await makeTaskFile(tmp);
    task.body = task.body.replace("- bot: Copilot summary excerpt", huge);
    await fs.writeFile(
      task.path,
      `---\nid: ${task.frontmatter.id}\nstatus: reviewing\ncreated: ${task.frontmatter.created}\nupdated: ${task.frontmatter.updated}\ntarget_repo: ${task.frontmatter.target_repo}\nworktree: ${task.frontmatter.worktree}\nbranch: ${task.frontmatter.branch}\npr: ${task.frontmatter.pr}\nmanual_validation: null\nmerge_commit: null\n---\n${task.body}`,
      "utf8",
    );
    const reloaded = await readTask(task.path);
    await runReviewPhase(reloaded);
    const prompt = vi.mocked(runHeadless).mock.calls[0]![0]!.prompt;
    expect(prompt).toContain("[truncated for prompt budget]");
    expect(prompt).toContain("xxxx");
  });
});
