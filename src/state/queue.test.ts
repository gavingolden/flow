import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTriagedTasks } from "./queue.js";

interface SeedOptions {
  id: string;
  status?: string;
  created?: string;
}

async function writeTask(
  tasksDir: string,
  { id, status = "triaged", created = "2026-04-29T00:00:00.000Z" }: SeedOptions,
): Promise<void> {
  const body = [
    "---",
    `id: ${id}`,
    `status: ${status}`,
    `created: ${created}`,
    `updated: ${created}`,
    "target_repo: /tmp/repo",
    "worktree: null",
    "branch: null",
    "pr: null",
    "manual_validation: null",
    "merge_commit: null",
    "---",
    "",
    "## User prompt",
    "",
    "stub",
    "",
    "## Phase log",
    "",
    "## Phase outputs",
    "",
  ].join("\n");
  await fs.writeFile(path.join(tasksDir, `${id}.md`), body, "utf8");
}

describe("listTriagedTasks", () => {
  let tmp: string;
  let tasksDir: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-queue-"));
    tasksDir = path.join(tmp, ".orchestrator", "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns empty list when .orchestrator/tasks/ is empty", async () => {
    const out = await listTriagedTasks(tmp);
    expect(out).toEqual([]);
  });

  it("returns empty list when .orchestrator/tasks/ does not exist", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "flow-queue-empty-"));
    try {
      const out = await listTriagedTasks(empty);
      expect(out).toEqual([]);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it("returns only triaged tasks (filters worktree-ready, merged, etc.)", async () => {
    await writeTask(tasksDir, { id: "a-triaged", status: "triaged" });
    await writeTask(tasksDir, { id: "b-worktree", status: "worktree-ready" });
    await writeTask(tasksDir, { id: "c-merged", status: "merged" });
    await writeTask(tasksDir, { id: "d-needs-human", status: "needs-human" });
    await writeTask(tasksDir, { id: "e-triaged", status: "triaged" });

    const out = await listTriagedTasks(tmp);
    expect(out.map((q) => q.id).sort()).toEqual(["a-triaged", "e-triaged"]);
  });

  it("orders by created ascending (oldest first)", async () => {
    await writeTask(tasksDir, {
      id: "newest",
      created: "2026-04-30T00:00:00.000Z",
    });
    await writeTask(tasksDir, {
      id: "middle",
      created: "2026-04-29T00:00:00.000Z",
    });
    await writeTask(tasksDir, {
      id: "oldest",
      created: "2026-04-28T00:00:00.000Z",
    });
    const out = await listTriagedTasks(tmp);
    expect(out.map((q) => q.id)).toEqual(["oldest", "middle", "newest"]);
  });

  it("ignores archived/ subdir entries", async () => {
    await writeTask(tasksDir, { id: "live-triaged", status: "triaged" });
    const archive = path.join(tasksDir, "archive");
    await fs.mkdir(archive, { recursive: true });
    await writeTask(archive, { id: "old-triaged", status: "triaged" });
    const out = await listTriagedTasks(tmp);
    expect(out.map((q) => q.id)).toEqual(["live-triaged"]);
  });

  it("skips a malformed file but returns the well-formed remainder", async () => {
    await writeTask(tasksDir, { id: "good", status: "triaged" });
    await fs.writeFile(
      path.join(tasksDir, "broken.md"),
      "---\n: : : not yaml\n---\nbody",
      "utf8",
    );
    const skipped: string[] = [];
    const out = await listTriagedTasks(tmp, {
      onSkip: (filePath) => skipped.push(filePath),
    });
    expect(out.map((q) => q.id)).toEqual(["good"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("broken.md");
  });
});
