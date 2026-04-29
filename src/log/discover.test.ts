import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  filterByPhase,
  latestFile,
  listLogFiles,
  listTaskIds,
} from "./discover.js";

describe("listLogFiles", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-log-discover-"));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("returns [] cleanly when the logs/ dir does not exist", async () => {
    const files = await listLogFiles(path.join(tmp, "no-such-task"));
    expect(files).toEqual([]);
  });

  it("returns [] when logs/ exists but is empty", async () => {
    const taskDir = path.join(tmp, "task");
    await fsp.mkdir(path.join(taskDir, "logs"), { recursive: true });
    expect(await listLogFiles(taskDir)).toEqual([]);
  });

  it("parses the per-phase stamped filenames and sorts ascending by stamp", async () => {
    const taskDir = path.join(tmp, "task");
    const logs = path.join(taskDir, "logs");
    await fsp.mkdir(logs, { recursive: true });
    // Insert three files out of order. Stamp format mirrors jsonl-sink.ts
    // (millisecond ISO with `:` and `.` replaced by `-`).
    await fsp.writeFile(
      path.join(logs, "implement-2026-04-29T13-00-00-000Z.jsonl"),
      "",
    );
    await fsp.writeFile(
      path.join(logs, "plan-2026-04-29T12-00-00-000Z.jsonl"),
      "",
    );
    await fsp.writeFile(
      path.join(logs, "worktree-2026-04-29T11-00-00-000Z.jsonl"),
      "",
    );
    const files = await listLogFiles(taskDir);
    expect(files.map((f) => f.phase)).toEqual([
      "worktree",
      "plan",
      "implement",
    ]);
    expect(files.map((f) => f.stamp)).toEqual([
      "2026-04-29T11-00-00-000Z",
      "2026-04-29T12-00-00-000Z",
      "2026-04-29T13-00-00-000Z",
    ]);
    for (const f of files) {
      expect(f.path).toBe(path.join(logs, `${f.phase}-${f.stamp}.jsonl`));
    }
  });

  it("ignores non-jsonl files in the logs dir", async () => {
    const taskDir = path.join(tmp, "task");
    const logs = path.join(taskDir, "logs");
    await fsp.mkdir(logs, { recursive: true });
    await fsp.writeFile(
      path.join(logs, "plan-2026-04-29T12-00-00-000Z.jsonl"),
      "",
    );
    await fsp.writeFile(path.join(logs, "README.md"), "");
    await fsp.writeFile(
      path.join(logs, "weird-no-stamp.jsonl"),
      "",
    );
    const files = await listLogFiles(taskDir);
    expect(files).toHaveLength(1);
    expect(files[0]!.phase).toBe("plan");
  });

  it("preserves multi-segment phase names (e.g. verify-retry)", async () => {
    const taskDir = path.join(tmp, "task");
    const logs = path.join(taskDir, "logs");
    await fsp.mkdir(logs, { recursive: true });
    await fsp.writeFile(
      path.join(logs, "verify-retry-2026-04-29T12-00-00-000Z.jsonl"),
      "",
    );
    const files = await listLogFiles(taskDir);
    expect(files).toHaveLength(1);
    expect(files[0]!.phase).toBe("verify-retry");
  });
});

describe("filterByPhase", () => {
  it("returns multiple files when two share a phase prefix (PR 5 retry case)", () => {
    const files = [
      { phase: "verify", stamp: "2026-04-29T10-00-00-000Z", path: "/a" },
      { phase: "verify", stamp: "2026-04-29T11-00-00-000Z", path: "/b" },
      { phase: "implement", stamp: "2026-04-29T09-00-00-000Z", path: "/c" },
    ];
    const filtered = filterByPhase(files, "verify");
    expect(filtered).toHaveLength(2);
    expect(filtered.map((f) => f.path)).toEqual(["/a", "/b"]);
  });

  it("returns [] for a no-match phase", () => {
    const files = [
      { phase: "plan", stamp: "x", path: "/a" },
    ];
    expect(filterByPhase(files, "nope")).toEqual([]);
  });
});

describe("latestFile", () => {
  it("returns the last entry by stamp (input is already stamp-sorted)", () => {
    const files = [
      { phase: "plan", stamp: "2026-04-29T10-00-00-000Z", path: "/a" },
      { phase: "implement", stamp: "2026-04-29T11-00-00-000Z", path: "/b" },
    ];
    expect(latestFile(files)?.path).toBe("/b");
  });

  it("returns null on empty input", () => {
    expect(latestFile([])).toBeNull();
  });
});

describe("listTaskIds", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-log-tasks-"));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("returns [] cleanly when .orchestrator/tasks/ does not exist", async () => {
    expect(await listTaskIds(tmp)).toEqual([]);
  });

  it("returns task ids sorted by mtime descending", async () => {
    const tasksDir = path.join(tmp, ".orchestrator", "tasks");
    await fsp.mkdir(tasksDir, { recursive: true });
    const a = path.join(tasksDir, "alpha.md");
    const b = path.join(tasksDir, "beta.md");
    const c = path.join(tasksDir, "gamma.md");
    await fsp.writeFile(a, "");
    await fsp.writeFile(b, "");
    await fsp.writeFile(c, "");
    // Pin mtimes so the order isn't dependent on filesystem timing
    // resolution. utimes accepts seconds; spread by 60s to be safe.
    const t0 = 1_750_000_000;
    await fsp.utimes(a, t0 + 0, t0 + 0);
    await fsp.utimes(b, t0 + 60, t0 + 60);
    await fsp.utimes(c, t0 + 30, t0 + 30);
    const ids = await listTaskIds(tmp);
    expect(ids).toEqual(["beta", "gamma", "alpha"]);
  });

  it("ignores subdirectories like archive/", async () => {
    const tasksDir = path.join(tmp, ".orchestrator", "tasks");
    await fsp.mkdir(path.join(tasksDir, "archive"), { recursive: true });
    await fsp.writeFile(path.join(tasksDir, "current.md"), "");
    await fsp.writeFile(path.join(tasksDir, "archive", "old.md"), "");
    const ids = await listTaskIds(tmp);
    expect(ids).toEqual(["current"]);
  });

  it("ignores non-md files", async () => {
    const tasksDir = path.join(tmp, ".orchestrator", "tasks");
    await fsp.mkdir(tasksDir, { recursive: true });
    await fsp.writeFile(path.join(tasksDir, "real.md"), "");
    await fsp.writeFile(path.join(tasksDir, "notes.txt"), "");
    expect(await listTaskIds(tmp)).toEqual(["real"]);
  });
});
