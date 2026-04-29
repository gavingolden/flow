import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listLogFiles } from "./discover.js";
import { follow } from "./follow.js";

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

const writeJsonl = async (
  filePath: string,
  events: unknown[],
): Promise<void> => {
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fsp.writeFile(filePath, body, "utf8");
};

const appendJsonl = async (
  filePath: string,
  events: unknown[],
): Promise<void> => {
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fsp.appendFile(filePath, body, "utf8");
};

describe("follow", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-log-follow-"));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("returns no-file and prints `no logs yet for <id>` when targetSet is empty", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const result = await follow({
      stdout,
      stderr,
      taskDir: path.join(tmp, "task"),
      taskId: "tid",
      targetSet: [],
      pollIntervalMs: 5,
      idleWindowMs: 20,
      forceColor: false,
    });
    expect(result.reason).toBe("no-file");
    expect(stdout.buffer).toContain("no logs yet for tid");
  });

  it("exits on a flow-result event and surfaces the status", async () => {
    const taskDir = path.join(tmp, "task");
    const logsDir = path.join(taskDir, "logs");
    await fsp.mkdir(logsDir, { recursive: true });
    const filePath = path.join(
      logsDir,
      "implement-2026-04-29T11-00-00-000Z.jsonl",
    );
    await writeJsonl(filePath, [
      { ts: "x", kind: "info", msg: "starting" },
      { ts: "x", kind: "result", status: "ok" },
    ]);
    const files = await listLogFiles(taskDir);
    const stdout = new StringSink();
    const stderr = new StringSink();
    const result = await follow({
      stdout,
      stderr,
      taskDir,
      taskId: "tid",
      targetSet: files,
      pollIntervalMs: 5,
      idleWindowMs: 50,
      forceColor: false,
    });
    expect(result.reason).toBe("flow-result");
    expect(result.status).toBe("ok");
    expect(stdout.buffer).toContain("info starting");
    expect(stdout.buffer).toContain("flow result status=ok");
    // Footer: no newer file → between-phases line.
    expect(stdout.buffer).toContain("between phases or finished");
  });

  it("exits on a stream-json terminal result", async () => {
    const taskDir = path.join(tmp, "task");
    const logsDir = path.join(taskDir, "logs");
    await fsp.mkdir(logsDir, { recursive: true });
    const filePath = path.join(
      logsDir,
      "plan-2026-04-29T10-00-00-000Z.jsonl",
    );
    await writeJsonl(filePath, [
      {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1000,
        total_cost_usd: 0.01,
      },
    ]);
    const files = await listLogFiles(taskDir);
    const stdout = new StringSink();
    const stderr = new StringSink();
    const result = await follow({
      stdout,
      stderr,
      taskDir,
      taskId: "tid",
      targetSet: files,
      pollIntervalMs: 5,
      idleWindowMs: 50,
      forceColor: false,
    });
    expect(result.reason).toBe("stream-json-result");
    expect(result.status).toBe("success");
  });

  it("includes a next-phase hint when a newer phase log file exists", async () => {
    const taskDir = path.join(tmp, "task");
    const logsDir = path.join(taskDir, "logs");
    await fsp.mkdir(logsDir, { recursive: true });
    const oldPath = path.join(
      logsDir,
      "plan-2026-04-29T10-00-00-000Z.jsonl",
    );
    await writeJsonl(oldPath, [
      { ts: "x", kind: "result", status: "ok" },
    ]);
    // Newer phase log exists: implement at later stamp.
    await writeJsonl(
      path.join(logsDir, "implement-2026-04-29T11-00-00-000Z.jsonl"),
      [{ ts: "x", kind: "info", msg: "running" }],
    );
    const files = await listLogFiles(taskDir);
    // Tail just the older `plan` file.
    const planOnly = files.filter((f) => f.phase === "plan");
    const stdout = new StringSink();
    const stderr = new StringSink();
    const result = await follow({
      stdout,
      stderr,
      taskDir,
      taskId: "tid",
      targetSet: planOnly,
      pollIntervalMs: 5,
      idleWindowMs: 50,
      forceColor: false,
    });
    expect(result.reason).toBe("flow-result");
    expect(stdout.buffer).toContain("hint: flow log tid --follow --phase implement");
  });

  it("hint points at the *next* newer phase, not the latest, when multiple newer files exist", async () => {
    const taskDir = path.join(tmp, "task");
    const logsDir = path.join(taskDir, "logs");
    await fsp.mkdir(logsDir, { recursive: true });
    // Tail `plan` (oldest); two newer phases exist on disk. The hint must
    // surface `implement` (the immediate next), not `verify` (the latest).
    await writeJsonl(
      path.join(logsDir, "plan-2026-04-29T10-00-00-000Z.jsonl"),
      [{ ts: "x", kind: "result", status: "ok" }],
    );
    await writeJsonl(
      path.join(logsDir, "implement-2026-04-29T11-00-00-000Z.jsonl"),
      [{ ts: "x", kind: "info", msg: "implementing" }],
    );
    await writeJsonl(
      path.join(logsDir, "verify-2026-04-29T12-00-00-000Z.jsonl"),
      [{ ts: "x", kind: "info", msg: "verifying" }],
    );
    const files = await listLogFiles(taskDir);
    const planOnly = files.filter((f) => f.phase === "plan");
    const stdout = new StringSink();
    const stderr = new StringSink();
    const result = await follow({
      stdout,
      stderr,
      taskDir,
      taskId: "tid",
      targetSet: planOnly,
      pollIntervalMs: 5,
      idleWindowMs: 50,
      forceColor: false,
    });
    expect(result.reason).toBe("flow-result");
    expect(stdout.buffer).toContain(
      "hint: flow log tid --follow --phase implement",
    );
    expect(stdout.buffer).not.toContain(
      "hint: flow log tid --follow --phase verify",
    );
  });

  it("warns with file path and line number on a malformed jsonl line, then continues", async () => {
    const taskDir = path.join(tmp, "task");
    const logsDir = path.join(taskDir, "logs");
    await fsp.mkdir(logsDir, { recursive: true });
    const filePath = path.join(
      logsDir,
      "plan-2026-04-29T10-00-00-000Z.jsonl",
    );
    const body =
      JSON.stringify({ ts: "x", kind: "info", msg: "good-1" }) +
      "\n" +
      "this-is-not-json\n" +
      JSON.stringify({ ts: "x", kind: "info", msg: "good-2" }) +
      "\n" +
      JSON.stringify({ ts: "x", kind: "result", status: "ok" }) +
      "\n";
    await fsp.writeFile(filePath, body, "utf8");
    const files = await listLogFiles(taskDir);
    const stdout = new StringSink();
    const stderr = new StringSink();
    const result = await follow({
      stdout,
      stderr,
      taskDir,
      taskId: "tid",
      targetSet: files,
      pollIntervalMs: 5,
      idleWindowMs: 50,
      forceColor: false,
    });
    expect(result.reason).toBe("flow-result");
    expect(stdout.buffer).toContain("info good-1");
    expect(stdout.buffer).toContain("info good-2");
    expect(stderr.buffer).toContain("malformed jsonl line");
    expect(stderr.buffer).toContain(filePath);
    expect(stderr.buffer).toContain(":2"); // line number
  });

  it("exits on idle window when no terminal event appears", async () => {
    const taskDir = path.join(tmp, "task");
    const logsDir = path.join(taskDir, "logs");
    await fsp.mkdir(logsDir, { recursive: true });
    const filePath = path.join(
      logsDir,
      "plan-2026-04-29T10-00-00-000Z.jsonl",
    );
    await writeJsonl(filePath, [{ ts: "x", kind: "info", msg: "alone" }]);
    const files = await listLogFiles(taskDir);

    const stdout = new StringSink();
    const stderr = new StringSink();
    const start = Date.now();
    const result = await follow({
      stdout,
      stderr,
      taskDir,
      taskId: "tid",
      targetSet: files,
      pollIntervalMs: 5,
      idleWindowMs: 30,
      forceColor: false,
    });
    const elapsed = Date.now() - start;
    expect(result.reason).toBe("idle");
    expect(stdout.buffer).toContain("info alone");
    expect(stdout.buffer).toContain("no new bytes for the idle window");
    // Sanity check: total runtime stays well under one second so we
    // know the test isn't sleeping on real clock time.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("renders bytes appended after follow starts", async () => {
    const taskDir = path.join(tmp, "task");
    const logsDir = path.join(taskDir, "logs");
    await fsp.mkdir(logsDir, { recursive: true });
    const filePath = path.join(
      logsDir,
      "implement-2026-04-29T10-00-00-000Z.jsonl",
    );
    await writeJsonl(filePath, [{ ts: "x", kind: "info", msg: "first" }]);
    const files = await listLogFiles(taskDir);

    const stdout = new StringSink();
    const stderr = new StringSink();

    const followP = follow({
      stdout,
      stderr,
      taskDir,
      taskId: "tid",
      targetSet: files,
      pollIntervalMs: 5,
      idleWindowMs: 200,
      forceColor: false,
    });
    // Append after the follower has started polling.
    await new Promise((r) => setTimeout(r, 15));
    await appendJsonl(filePath, [
      { ts: "x", kind: "info", msg: "second" },
      { ts: "x", kind: "result", status: "failed", reason: "oops" },
    ]);
    const result = await followP;
    expect(result.reason).toBe("flow-result");
    expect(result.status).toBe("failed");
    expect(stdout.buffer).toContain("info first");
    expect(stdout.buffer).toContain("info second");
    expect(stdout.buffer).toContain("flow result status=failed");
  });
});
