import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoopJsonlSink, createJsonlSink } from "./jsonl-sink.js";

describe("createJsonlSink", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-jsonl-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("creates the logs/ dir and a stamped per-phase file path", async () => {
    const fixed = new Date("2026-04-29T12:34:56.789Z");
    const sink = await createJsonlSink({
      taskDir: path.join(tmp, "task"),
      phase: "worktree",
      now: () => fixed,
    });
    expect(sink.filePath).toBe(
      path.join(tmp, "task", "logs", "worktree-2026-04-29T12-34-56-789Z.jsonl"),
    );
    await sink.close();
    await expect(fs.access(sink.filePath)).resolves.toBeUndefined();
  });

  it("event() writes one line per call, each parseable as JSON with ts + kind", async () => {
    const fixed = new Date("2026-04-29T00:00:00.000Z");
    const sink = await createJsonlSink({
      taskDir: path.join(tmp, "task"),
      phase: "worktree",
      now: () => fixed,
    });
    sink.event("info", { msg: "hello" });
    sink.event("exec", { cmd: "git", args: ["status"] });
    sink.event("result", { status: "ok" });
    await sink.close();

    const raw = await fs.readFile(sink.filePath, "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toEqual({
      ts: "2026-04-29T00:00:00.000Z",
      kind: "info",
      msg: "hello",
    });
    expect(parsed[1]).toEqual({
      ts: "2026-04-29T00:00:00.000Z",
      kind: "exec",
      cmd: "git",
      args: ["status"],
    });
    expect(parsed[2]).toEqual({
      ts: "2026-04-29T00:00:00.000Z",
      kind: "result",
      status: "ok",
    });
  });

  it("event payload overrides base ts/kind (payload-takes-precedence)", async () => {
    // Documented behaviour — keeps the helper a thin pass-through. If a
    // caller passes ts/kind explicitly they win. Tests pin this so we don't
    // accidentally silently drop their values.
    const sink = await createJsonlSink({
      taskDir: path.join(tmp, "task"),
      phase: "p",
      now: () => new Date("2026-04-29T00:00:00.000Z"),
    });
    sink.event("info", { ts: "OVERRIDE", kind: "OVERRIDE-KIND", msg: "x" });
    await sink.close();
    const lines = (await fs.readFile(sink.filePath, "utf8")).trimEnd().split("\n");
    const obj = JSON.parse(lines[0]!);
    expect(obj.ts).toBe("OVERRIDE");
    expect(obj.kind).toBe("OVERRIDE-KIND");
    expect(obj.msg).toBe("x");
  });

  it("pipeFrom buffers partial lines and writes them on the next chunk", async () => {
    const sink = await createJsonlSink({
      taskDir: path.join(tmp, "task"),
      phase: "plan",
      now: () => new Date("2026-04-29T00:00:00.000Z"),
    });

    // Hand-rolled producer: emit a full line, then a partial chunk, then the
    // rest, then a final terminated line, then EOF.
    const readable = new Readable({ read() {} });
    const promise = sink.pipeFrom(readable);
    readable.push('{"a":1}\n');
    readable.push('{"b":');
    readable.push('2}\n{"c":3}\n');
    readable.push(null);
    await promise;
    await sink.close();

    const lines = (await fs.readFile(sink.filePath, "utf8")).trimEnd().split("\n");
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("pipeFrom flushes any non-newline-terminated residue at EOF", async () => {
    const sink = await createJsonlSink({
      taskDir: path.join(tmp, "task"),
      phase: "plan",
      now: () => new Date("2026-04-29T00:00:00.000Z"),
    });
    const readable = new Readable({ read() {} });
    const promise = sink.pipeFrom(readable);
    readable.push("partial-only");
    readable.push(null);
    await promise;
    await sink.close();
    const raw = await fs.readFile(sink.filePath, "utf8");
    expect(raw).toBe("partial-only\n");
  });

  it("close() is idempotent and subsequent event() calls are no-ops", async () => {
    const sink = await createJsonlSink({
      taskDir: path.join(tmp, "task"),
      phase: "p",
      now: () => new Date("2026-04-29T00:00:00.000Z"),
    });
    sink.event("info", { msg: "before" });
    await sink.close();
    await sink.close(); // second close must not throw
    sink.event("info", { msg: "after" }); // dropped
    const raw = await fs.readFile(sink.filePath, "utf8");
    expect(raw.trimEnd().split("\n")).toEqual([
      JSON.stringify({ ts: "2026-04-29T00:00:00.000Z", kind: "info", msg: "before" }),
    ]);
  });

  it("interleaved event() and pipeFrom() lines both land in the file", async () => {
    const sink = await createJsonlSink({
      taskDir: path.join(tmp, "task"),
      phase: "plan",
      now: () => new Date("2026-04-29T00:00:00.000Z"),
    });
    const readable = new Readable({ read() {} });
    const promise = sink.pipeFrom(readable);
    readable.push('{"from":"claude"}\n');
    readable.push(null);
    await promise;
    sink.event("result", { status: "ok" });
    await sink.close();
    const lines = (await fs.readFile(sink.filePath, "utf8")).trimEnd().split("\n");
    expect(lines).toContain('{"from":"claude"}');
    expect(
      lines.some((l) => {
        const obj = JSON.parse(l);
        return obj.kind === "result" && obj.status === "ok";
      }),
    ).toBe(true);
  });
});

describe("NoopJsonlSink", () => {
  it("event() is a no-op and close() resolves", async () => {
    NoopJsonlSink.event("info", { msg: "x" });
    await NoopJsonlSink.close();
  });

  it("pipeFrom drains the readable so the producer doesn't backpressure", async () => {
    const readable = Readable.from(["a\n", "b\n"]);
    await NoopJsonlSink.pipeFrom(readable);
  });
});
