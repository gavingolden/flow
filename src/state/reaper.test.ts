import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reapStatusAsync, reapStatusSync } from "./reaper.js";
import { readTask, writeTask, type Task } from "./task-file.js";
import type { TaskStatus } from "./phases.js";

async function makeTask(tmp: string, status: TaskStatus): Promise<string> {
  const taskPath = path.join(tmp, "task.md");
  const initial: Task = {
    path: taskPath,
    frontmatter: {
      id: "2026-04-29-reaper",
      status,
      created: "2026-04-29T00:00:00.000Z",
      updated: "2026-04-29T00:00:00.000Z",
      target_repo: tmp,
      worktree: null,
      branch: null,
      pr: null,
      manual_validation: null,
      merge_commit: null,
    },
    body: ["## User prompt", "", "test", "", "## Phase log", "", "## Phase outputs", ""].join("\n"),
  };
  await writeTask(initial);
  return taskPath;
}

describe("reapStatusAsync", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-reaper-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it.each([
    ["triaged", "runner-crashed"],
    ["creating-worktree", "signaled"],
    ["planning", "immediate-exit"],
    ["implementing", "runner-crashed"],
  ] as const)(
    "remaps transient status %s → needs-human with reason %s",
    async (status, reason) => {
      const taskPath = await makeTask(tmp, status as TaskStatus);
      const remapped = await reapStatusAsync(taskPath, reason);
      expect(remapped).toBe(true);
      const t = await readTask(taskPath);
      expect(t.frontmatter.status).toBe("needs-human");
      // Phase log records the reason so PR 10's `/flow status` can surface
      // *why* the runner gave up.
      expect(t.body).toContain(`→ needs-human (${reason})`);
    },
  );

  it.each(["worktree-ready", "planned", "pr-open", "merged", "aborted", "needs-human"] as const)(
    "leaves non-transient status %s alone",
    async (status) => {
      const taskPath = await makeTask(tmp, status as TaskStatus);
      const remapped = await reapStatusAsync(taskPath, "runner-crashed");
      expect(remapped).toBe(false);
      const t = await readTask(taskPath);
      expect(t.frontmatter.status).toBe(status);
    },
  );

  it("returns false rather than throwing when the task file is missing", async () => {
    const remapped = await reapStatusAsync(
      path.join(tmp, "does-not-exist.md"),
      "runner-crashed",
    );
    expect(remapped).toBe(false);
  });
});

describe("reapStatusSync (used from process.on('exit', ...))", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-reaper-sync-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("remaps transient status synchronously and writes to disk", async () => {
    const taskPath = await makeTask(tmp, "implementing");
    const remapped = reapStatusSync(taskPath, "signaled");
    expect(remapped).toBe(true);
    const t = await readTask(taskPath);
    expect(t.frontmatter.status).toBe("needs-human");
    expect(t.body).toContain("→ needs-human (signaled)");
  });

  it("is idempotent — second call no-ops because the status is already non-transient", async () => {
    const taskPath = await makeTask(tmp, "implementing");
    expect(reapStatusSync(taskPath, "signaled")).toBe(true);
    expect(reapStatusSync(taskPath, "runner-crashed")).toBe(false);
  });
});
