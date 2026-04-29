import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { logCommand } from "./log.js";

class StringSink extends Writable {
  buffer = "";
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    cb();
  }
}

class BufferSink extends Writable {
  chunks: Buffer[] = [];
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    cb();
  }
  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

async function makeRepo(): Promise<string> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-log-cmd-"));
  await execa("git", ["init", "-q"], { cwd: tmp });
  await execa("git", ["config", "user.email", "t@t"], { cwd: tmp });
  await execa("git", ["config", "user.name", "t"], { cwd: tmp });
  return tmp;
}

async function writeTaskFile(
  repoRoot: string,
  taskId: string,
  mtimeOffsetSeconds: number | null = null,
): Promise<void> {
  const tasksDir = path.join(repoRoot, ".orchestrator", "tasks");
  await fsp.mkdir(tasksDir, { recursive: true });
  const taskPath = path.join(tasksDir, `${taskId}.md`);
  const body = [
    "---",
    `id: ${taskId}`,
    "status: triaged",
    "---",
    "",
    "## User prompt",
    "",
    "x",
    "",
  ].join("\n");
  await fsp.writeFile(taskPath, body, "utf8");
  if (mtimeOffsetSeconds !== null) {
    const t = 1_750_000_000 + mtimeOffsetSeconds;
    await fsp.utimes(taskPath, t, t);
  }
}

async function writeLog(
  repoRoot: string,
  taskId: string,
  filename: string,
  events: unknown[],
): Promise<string> {
  const dir = path.join(
    repoRoot,
    ".orchestrator",
    "tasks",
    taskId,
    "logs",
  );
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fsp.writeFile(filePath, body, "utf8");
  return filePath;
}

describe("logCommand", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeRepo();
  });
  afterEach(async () => {
    await fsp.rm(repo, { recursive: true, force: true });
  });

  it("with no id, lists task ids by mtime descending", async () => {
    await writeTaskFile(repo, "alpha", 0);
    await writeTaskFile(repo, "beta", 60);
    await writeTaskFile(repo, "gamma", 30);
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await logCommand(undefined, {}, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(0);
    expect(stdout.buffer.trimEnd().split("\n")).toEqual([
      "beta",
      "gamma",
      "alpha",
    ]);
  });

  it("with no id and no tasks, prints `no tasks found` and exits 0", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await logCommand(undefined, {}, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(0);
    expect(stdout.buffer).toContain("no tasks found");
  });

  it("returns 1 with an error mentioning .orchestrator/tasks/ for an unknown id", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await logCommand("nope", {}, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(1);
    expect(stderr.buffer).toContain(".orchestrator/tasks/");
  });

  it("returns 0 with `no logs yet` when the logs/ subdir does not exist", async () => {
    await writeTaskFile(repo, "tid");
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await logCommand("tid", {}, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(0);
    expect(stdout.buffer).toContain("no logs yet for tid");
  });

  it("returns 0 and an unmatched-phase message on stderr", async () => {
    await writeTaskFile(repo, "tid");
    await writeLog(repo, "tid", "plan-2026-04-29T10-00-00-000Z.jsonl", [
      { ts: "x", kind: "info", msg: "hello" },
    ]);
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await logCommand("tid", { phase: "verify" }, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(0);
    expect(stderr.buffer).toContain("no log files match phase 'verify'");
  });

  it("default mode pretty-prints all phases with banners", async () => {
    await writeTaskFile(repo, "tid");
    await writeLog(repo, "tid", "plan-2026-04-29T10-00-00-000Z.jsonl", [
      { ts: "x", kind: "info", msg: "plan-msg" },
    ]);
    await writeLog(repo, "tid", "implement-2026-04-29T11-00-00-000Z.jsonl", [
      { ts: "x", kind: "info", msg: "impl-msg" },
    ]);
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await logCommand("tid", {}, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(0);
    expect(stdout.buffer).toContain("── plan @");
    expect(stdout.buffer).toContain("── implement @");
    expect(stdout.buffer).toContain("info plan-msg");
    expect(stdout.buffer).toContain("info impl-msg");
  });

  it("--phase filters to a single phase", async () => {
    await writeTaskFile(repo, "tid");
    await writeLog(repo, "tid", "plan-2026-04-29T10-00-00-000Z.jsonl", [
      { ts: "x", kind: "info", msg: "plan-msg" },
    ]);
    await writeLog(repo, "tid", "implement-2026-04-29T11-00-00-000Z.jsonl", [
      { ts: "x", kind: "info", msg: "impl-msg" },
    ]);
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await logCommand(
      "tid",
      { phase: "plan" },
      { stdout, stderr, cwd: repo },
    );
    expect(code).toBe(0);
    expect(stdout.buffer).toContain("info plan-msg");
    expect(stdout.buffer).not.toContain("info impl-msg");
  });

  it("--raw concatenates byte-identically with no styling", async () => {
    await writeTaskFile(repo, "tid");
    const aPath = await writeLog(
      repo,
      "tid",
      "plan-2026-04-29T10-00-00-000Z.jsonl",
      [{ ts: "x", kind: "info", msg: "a" }],
    );
    const bPath = await writeLog(
      repo,
      "tid",
      "implement-2026-04-29T11-00-00-000Z.jsonl",
      [{ ts: "x", kind: "info", msg: "b" }],
    );
    const stdout = new BufferSink();
    const stderr = new StringSink();
    const code = await logCommand(
      "tid",
      { raw: true },
      { stdout, stderr, cwd: repo },
    );
    expect(code).toBe(0);
    const expected = Buffer.concat([
      await fsp.readFile(aPath),
      await fsp.readFile(bPath),
    ]);
    expect(stdout.bytes().equals(expected)).toBe(true);
  });
});
