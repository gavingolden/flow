import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunAllLogger } from "./run-all-logger.js";

describe("createRunAllLogger", () => {
  let tmp: string;
  let runsDir: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-runall-logger-"));
    runsDir = path.join(tmp, ".orchestrator", "runs");
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("creates both .log and .jsonl files under runsDir", async () => {
    const logger = await createRunAllLogger({ runsDir });
    expect(logger.filePath).toContain(`${runsDir}${path.sep}all-`);
    expect(logger.filePath).toMatch(/\.log$/);
    expect(logger.jsonlPath).toMatch(/\.jsonl$/);
    await logger.close();
    const logExists = await fs
      .stat(logger.filePath)
      .then(() => true)
      .catch(() => false);
    const jsonlExists = await fs
      .stat(logger.jsonlPath)
      .then(() => true)
      .catch(() => false);
    expect(logExists).toBe(true);
    expect(jsonlExists).toBe(true);
  });

  it("event() writes a parseable jsonl line and a plaintext summary", async () => {
    const logger = await createRunAllLogger({ runsDir });
    logger.event("worker.spawn", { id: "task-1", pid: 12345 });
    await logger.close();

    const jsonl = await fs.readFile(logger.jsonlPath, "utf8");
    const lines = jsonl.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.name).toBe("worker.spawn");
    expect(parsed.id).toBe("task-1");
    expect(parsed.pid).toBe(12345);
    expect(typeof parsed.ts).toBe("string");

    const text = await fs.readFile(logger.filePath, "utf8");
    expect(text).toContain("worker.spawn");
    expect(text).toContain("id=task-1");
    expect(text).toContain("pid=12345");
  });

  it("info() writes a timestamped line to the plaintext log only", async () => {
    const logger = await createRunAllLogger({ runsDir });
    logger.info("hello world");
    await logger.close();
    const text = await fs.readFile(logger.filePath, "utf8");
    expect(text).toMatch(/INFO\s+hello world/);
    const jsonl = await fs.readFile(logger.jsonlPath, "utf8");
    expect(jsonl).toBe("");
  });

  it("strips ANSI sequences from plaintext output", async () => {
    const logger = await createRunAllLogger({ runsDir });
    logger.info("\x1b[31mred\x1b[0m message");
    await logger.close();
    const text = await fs.readFile(logger.filePath, "utf8");
    expect(text).not.toContain("\x1b");
    expect(text).toContain("red message");
  });

  it("uses caller-supplied stamp when provided", async () => {
    const logger = await createRunAllLogger({
      runsDir,
      stamp: "2026-04-30T12-00-00-000Z",
    });
    expect(logger.filePath).toContain("all-2026-04-30T12-00-00-000Z.log");
    expect(logger.jsonlPath).toContain("all-2026-04-30T12-00-00-000Z.jsonl");
    await logger.close();
  });

  it("close() flushes both streams (subsequent reads see content)", async () => {
    const logger = await createRunAllLogger({ runsDir });
    logger.info("line 1");
    logger.event("queue.size", { count: 7 });
    logger.info("line 2");
    await logger.close();
    const text = await fs.readFile(logger.filePath, "utf8");
    expect(text).toContain("line 1");
    expect(text).toContain("line 2");
    expect(text).toContain("queue.size");
    const jsonl = await fs.readFile(logger.jsonlPath, "utf8");
    const events = jsonl
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("queue.size");
    expect(events[0].count).toBe(7);
  });
});
