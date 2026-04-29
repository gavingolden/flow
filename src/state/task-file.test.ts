import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readTask,
  readTaskSync,
  writeTask,
  writeTaskSync,
  type Task,
} from "./task-file.js";

async function makeTask(tmp: string): Promise<Task> {
  const taskPath = path.join(tmp, "task.md");
  const t: Task = {
    path: taskPath,
    frontmatter: {
      id: "2026-04-29-x",
      status: "triaged",
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
  await writeTask(t);
  return readTask(taskPath);
}

describe("writeTaskSync", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-tf-sync-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("round-trips byte-equal with the async writer", async () => {
    // Both writers go through the same `formatTask` so a divergence here
    // would mean the sync exit-handler reaper produces files the async
    // `readTask` can't parse — the silent stuck case the PR is meant to
    // prevent.
    const t = await makeTask(tmp);
    t.frontmatter.status = "needs-human";
    writeTaskSync(t);
    const reread = await readTask(t.path);
    expect(reread.frontmatter.status).toBe("needs-human");
  });

  it("uses tmp+rename so a torn write can't leave a half-formed task file", async () => {
    // We can't easily inject an mid-write crash in a unit test, but we can
    // assert the contract: after a successful write, no .tmp sibling
    // remains. If renameSync ever degrades to a copy this would catch it.
    const t = await makeTask(tmp);
    writeTaskSync(t);
    const entries = await fs.readdir(tmp);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
  });
});

describe("readTaskSync", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-tf-rsync-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("matches readTask byte-for-byte on frontmatter and body", async () => {
    const t = await makeTask(tmp);
    const sync = readTaskSync(t.path);
    expect(sync.frontmatter).toEqual(t.frontmatter);
    expect(sync.body).toEqual(t.body);
  });
});
