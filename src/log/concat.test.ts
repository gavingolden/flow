import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { banner, concatRender } from "./concat.js";
import { listLogFiles } from "./discover.js";

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

describe("banner", () => {
  it("renders `── <phase> @ <stamp> ───…` padded to the given width", () => {
    const out = banner(
      { phase: "plan", stamp: "2026-04-29T12-00-00-000Z", path: "/x" },
      60,
    );
    expect(out.startsWith("── plan @ 2026-04-29T12-00-00-000Z ")).toBe(true);
    expect(out.endsWith("─")).toBe(true);
    expect(out.length).toBeGreaterThanOrEqual(60);
  });
});

describe("concatRender", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-log-concat-"));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("renders two phase log files in stamp order with banners between them", async () => {
    const taskDir = path.join(tmp, "task");
    const logsDir = path.join(taskDir, "logs");
    await fsp.mkdir(logsDir, { recursive: true });
    await writeJsonl(path.join(logsDir, "plan-2026-04-29T10-00-00-000Z.jsonl"), [
      { ts: "2026-04-29T10:00:00.000Z", kind: "info", msg: "plan-msg" },
    ]);
    await writeJsonl(
      path.join(logsDir, "implement-2026-04-29T11-00-00-000Z.jsonl"),
      [{ ts: "2026-04-29T11:00:00.000Z", kind: "info", msg: "impl-msg" }],
    );
    const files = await listLogFiles(taskDir);
    const stdout = new StringSink();
    const stderr = new StringSink();
    await concatRender(files, {
      stdout,
      stderr,
      forceColor: false,
      bannerWidth: 40,
    });

    // Banners appear in stamp order, before each file's content.
    const planIdx = stdout.buffer.indexOf("── plan @");
    const implIdx = stdout.buffer.indexOf("── implement @");
    const planMsgIdx = stdout.buffer.indexOf("info plan-msg");
    const implMsgIdx = stdout.buffer.indexOf("info impl-msg");
    expect(planIdx).toBeGreaterThanOrEqual(0);
    expect(planMsgIdx).toBeGreaterThan(planIdx);
    expect(implIdx).toBeGreaterThan(planMsgIdx);
    expect(implMsgIdx).toBeGreaterThan(implIdx);
  });

  it("repeats the banner for two files of the same phase (PR 5 retry case)", async () => {
    const taskDir = path.join(tmp, "task");
    const logsDir = path.join(taskDir, "logs");
    await fsp.mkdir(logsDir, { recursive: true });
    await writeJsonl(
      path.join(logsDir, "verify-2026-04-29T10-00-00-000Z.jsonl"),
      [{ ts: "x", kind: "info", msg: "first attempt" }],
    );
    await writeJsonl(
      path.join(logsDir, "verify-2026-04-29T11-00-00-000Z.jsonl"),
      [{ ts: "x", kind: "info", msg: "second attempt" }],
    );
    const files = await listLogFiles(taskDir);
    const stdout = new StringSink();
    const stderr = new StringSink();
    await concatRender(files, {
      stdout,
      stderr,
      forceColor: false,
      bannerWidth: 40,
    });
    const banners = stdout.buffer.match(/── verify @/g) ?? [];
    expect(banners.length).toBe(2);
    expect(stdout.buffer).toContain("first attempt");
    expect(stdout.buffer).toContain("second attempt");
    // Order: first attempt before second.
    expect(stdout.buffer.indexOf("first attempt")).toBeLessThan(
      stdout.buffer.indexOf("second attempt"),
    );
  });

  it("warns on a malformed jsonl line, skips it, and renders surrounding good lines", async () => {
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
      "\n";
    await fsp.writeFile(filePath, body, "utf8");

    const files = await listLogFiles(taskDir);
    const stdout = new StringSink();
    const stderr = new StringSink();
    await concatRender(files, {
      stdout,
      stderr,
      forceColor: false,
      bannerWidth: 40,
    });
    expect(stdout.buffer).toContain("info good-1");
    expect(stdout.buffer).toContain("info good-2");
    expect(stderr.buffer).toContain("malformed jsonl line");
    expect(stderr.buffer).toContain(filePath);
    expect(stderr.buffer).toContain(":2"); // line number
  });

  it("does nothing on empty file list", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    await concatRender([], { stdout, stderr, forceColor: false });
    expect(stdout.buffer).toBe("");
    expect(stderr.buffer).toBe("");
  });
});
