import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listLogFiles, filterByPhase } from "./discover.js";
import { streamRaw } from "./raw.js";

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

describe("streamRaw", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-log-raw-"));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("byte-identically concatenates files in stamp order", async () => {
    const taskDir = path.join(tmp, "task");
    const logsDir = path.join(taskDir, "logs");
    await fsp.mkdir(logsDir, { recursive: true });
    const aPath = path.join(logsDir, "plan-2026-04-29T10-00-00-000Z.jsonl");
    const bPath = path.join(
      logsDir,
      "implement-2026-04-29T11-00-00-000Z.jsonl",
    );
    const aBody = Buffer.from(
      JSON.stringify({ type: "assistant", message: { content: [] } }) +
        "\n" +
        JSON.stringify({ ts: "x", kind: "info", msg: "hello" }) +
        "\n",
      "utf8",
    );
    const bBody = Buffer.from(
      JSON.stringify({ type: "result", subtype: "success" }) + "\n",
      "utf8",
    );
    await fsp.writeFile(aPath, aBody);
    await fsp.writeFile(bPath, bBody);

    const files = await listLogFiles(taskDir);
    const sink = new BufferSink();
    await streamRaw(files, sink);
    expect(sink.bytes().equals(Buffer.concat([aBody, bBody]))).toBe(true);
  });

  it("with --phase filter input, only matching files contribute bytes", async () => {
    const taskDir = path.join(tmp, "task");
    const logsDir = path.join(taskDir, "logs");
    await fsp.mkdir(logsDir, { recursive: true });
    const verifyPath = path.join(
      logsDir,
      "verify-2026-04-29T10-00-00-000Z.jsonl",
    );
    const planPath = path.join(
      logsDir,
      "plan-2026-04-29T11-00-00-000Z.jsonl",
    );
    const verifyBody = Buffer.from(
      JSON.stringify({ ts: "x", kind: "info", msg: "verify" }) + "\n",
      "utf8",
    );
    const planBody = Buffer.from(
      JSON.stringify({ ts: "x", kind: "info", msg: "plan" }) + "\n",
      "utf8",
    );
    await fsp.writeFile(verifyPath, verifyBody);
    await fsp.writeFile(planPath, planBody);

    const all = await listLogFiles(taskDir);
    const filtered = filterByPhase(all, "verify");
    const sink = new BufferSink();
    await streamRaw(filtered, sink);
    expect(sink.bytes().equals(verifyBody)).toBe(true);
  });

  it("does nothing on empty file list", async () => {
    const sink = new BufferSink();
    await streamRaw([], sink);
    expect(sink.bytes().length).toBe(0);
  });
});
