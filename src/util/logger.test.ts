import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoopLogger, createLogger, formatDuration } from "./logger.js";

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

const ANSI_RE = /\x1b\[[0-9;]*m/g;

describe("createLogger", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-logger-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("creates the runs dir and a per-invocation log file with a start banner", async () => {
    const sink = new StringSink();
    const fixed = new Date("2026-04-29T12:34:56.000Z");
    const logger = await createLogger({
      runsDir: path.join(tmp, "runs"),
      taskId: "abc",
      now: () => fixed,
      stdout: sink,
    });

    expect(logger.filePath).toBe(
      path.join(tmp, "runs", "abc-2026-04-29T12-34-56-000Z.log"),
    );
    await logger.close();

    const fileContent = await fs.readFile(logger.filePath, "utf8");
    expect(fileContent).toContain("flow run abc — started 2026-04-29T12:34:56.000Z");
    expect(sink.buffer).toContain(
      "flow run abc — started 2026-04-29T12:34:56.000Z",
    );
  });

  it("strips ANSI from the file sink and prefixes ISO timestamps", async () => {
    const sink = new StringSink();
    const fixed = new Date("2026-04-29T00:00:00.000Z");
    const logger = await createLogger({
      runsDir: path.join(tmp, "runs"),
      taskId: "t",
      now: () => fixed,
      stdout: sink,
      forceColor: true,
    });
    logger.info("hello");
    logger.warn("careful");
    logger.error("boom");
    logger.success("done");
    await logger.close();

    expect(sink.buffer).toMatch(ANSI_RE);

    const file = await fs.readFile(logger.filePath, "utf8");
    expect(file).not.toMatch(ANSI_RE);
    for (const line of file.trimEnd().split("\n")) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    }
    expect(file).toContain("INFO  flow: hello");
    expect(file).toContain("WARN  flow: careful");
    expect(file).toContain("ERROR flow: boom");
    expect(file).toContain("OK    flow: done");
  });

  it("routes each level through a distinct picocolors style", async () => {
    const sink = new StringSink();
    const logger = await createLogger({
      runsDir: path.join(tmp, "runs"),
      taskId: "t",
      now: () => new Date(0),
      stdout: sink,
      forceColor: true,
    });
    sink.buffer = "";
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.success("s");
    logger.heartbeat("h");
    await logger.close();

    // gray=info: \x1b[90m, yellow=warn: \x1b[33m, red=error: \x1b[31m,
    // green=success: \x1b[32m, dim=heartbeat: \x1b[2m. picocolors uses these
    // codes consistently.
    const lines = sink.buffer.trimEnd().split("\n");
    expect(lines[0]).toMatch(/\x1b\[90m.*flow: i/);
    expect(lines[1]).toMatch(/\x1b\[33m.*flow: WARN w/);
    expect(lines[2]).toMatch(/\x1b\[31m.*flow: ERROR e/);
    expect(lines[3]).toMatch(/\x1b\[32m.*flow: s/);
    expect(lines[4]).toMatch(/\x1b\[2m.*flow: h/);
  });

  it("phaseStart and phaseEnd render duration and outcome", async () => {
    const sink = new StringSink();
    const logger = await createLogger({
      runsDir: path.join(tmp, "runs"),
      taskId: "t",
      now: () => new Date(0),
      stdout: sink,
    });
    sink.buffer = "";
    logger.phaseStart("plan", "(retry 2/2)");
    logger.phaseEnd("plan", 252_000, "ok");
    logger.phaseEnd("implement", 63_000, "failed");
    await logger.close();

    expect(sink.buffer).toContain("plan (retry 2/2)");
    expect(sink.buffer).toContain("plan ok in 4m12s");
    expect(sink.buffer).toContain("implement failed in 1m03s");
  });

  it("withHeartbeat fires every heartbeatMs and clears the interval after fn resolves", async () => {
    const sink = new StringSink();
    let nowMs = 0;
    const intervalCallbacks = new Set<() => void>();
    const cleared = new Set<symbol>();
    const handles = new Map<symbol, () => void>();

    const logger = await createLogger({
      runsDir: path.join(tmp, "runs"),
      taskId: "t",
      now: () => new Date(nowMs),
      stdout: sink,
      heartbeatMs: 15_000,
      setInterval: (handler) => {
        const sym = Symbol();
        handles.set(sym, handler);
        intervalCallbacks.add(handler);
        return sym as unknown as NodeJS.Timeout;
      },
      clearInterval: (handle) => {
        cleared.add(handle as unknown as symbol);
      },
    });
    sink.buffer = "";

    let resolveFn!: (v: number) => void;
    const fnPromise = new Promise<number>((r) => {
      resolveFn = r;
    });
    const wrapped = logger.withHeartbeat("plan", () => fnPromise);

    // First tick at +15s
    nowMs = 15_000;
    for (const cb of intervalCallbacks) cb();
    // Second tick at +30s
    nowMs = 30_000;
    for (const cb of intervalCallbacks) cb();

    expect(sink.buffer).toContain("plan: still running, 15s elapsed");
    expect(sink.buffer).toContain("plan: still running, 30s elapsed");

    resolveFn(42);
    await wrapped;

    expect(cleared.size).toBe(1);
    await logger.close();
  });

  it("withHeartbeat clears the interval when fn throws", async () => {
    const cleared = new Set<symbol>();
    const logger = await createLogger({
      runsDir: path.join(tmp, "runs"),
      taskId: "t",
      now: () => new Date(0),
      stdout: new StringSink(),
      setInterval: () => Symbol() as unknown as NodeJS.Timeout,
      clearInterval: (h) => {
        cleared.add(h as unknown as symbol);
      },
    });

    await expect(
      logger.withHeartbeat("plan", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(cleared.size).toBe(1);
    await logger.close();
  });

  it("prefixes every line of a multi-line message with its own ISO timestamp in the file sink", async () => {
    const sink = new StringSink();
    const fixed = new Date("2026-04-29T00:00:00.000Z");
    const logger = await createLogger({
      runsDir: path.join(tmp, "runs"),
      taskId: "t",
      now: () => fixed,
      stdout: sink,
    });
    sink.buffer = "";
    // Multi-line content shows up in real call sites (teed subprocess
    // stderr, truncated failure logs, gate output blocks).
    logger.warn("line one\nline two\nline three");
    await logger.close();

    const file = await fs.readFile(logger.filePath, "utf8");
    // Drop the start banner line so we only assert on the new entries.
    const lines = file
      .trimEnd()
      .split("\n")
      .filter((l) => l.includes("line "));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    }
    expect(lines[0]).toContain("WARN  flow: line one");
    // Continuation lines are emitted bare — no synthetic "WARN flow:" prefix —
    // because we want the file sink to reflect the original payload faithfully
    // while still giving every line a timestamp for tail / grep.
    expect(lines[1]).toContain("line two");
    expect(lines[2]).toContain("line three");
  });

  it("sanitizes unsafe characters in taskId so the log file stays inside runsDir", async () => {
    const sink = new StringSink();
    const fixed = new Date("2026-04-29T00:00:00.000Z");
    const logger = await createLogger({
      runsDir: path.join(tmp, "runs"),
      taskId: "../evil/id with spaces",
      now: () => fixed,
      stdout: sink,
    });
    // Path must stay inside runsDir — no `..` segments, no nested dirs.
    const expected = path.join(
      tmp,
      "runs",
      ".._evil_id_with_spaces-2026-04-29T00-00-00-000Z.log",
    );
    expect(logger.filePath).toBe(expected);
    await logger.close();
    // File actually exists at the safe path.
    await expect(fs.access(expected)).resolves.toBeUndefined();
  });

  it("does not emit a spurious blank line when the payload ends with a newline", async () => {
    // Multi-line payloads from teed subprocess output may or may not
    // include a trailing newline. The line-splitting writer must
    // produce the same line count either way — otherwise the file
    // sink ends up with a bare-timestamp line and stdout shows a blank
    // line, both of which break grep / tail expectations.
    const sink = new StringSink();
    const fixed = new Date("2026-04-29T00:00:00.000Z");
    const logger = await createLogger({
      runsDir: path.join(tmp, "runs"),
      taskId: "t",
      now: () => fixed,
      stdout: sink,
    });
    sink.buffer = "";
    logger.warn("only line\n");
    await logger.close();
    const file = await fs.readFile(logger.filePath, "utf8");
    const matchedLines = file
      .trimEnd()
      .split("\n")
      .filter((l) => l.includes("only line"));
    expect(matchedLines).toHaveLength(1);
    // No bare-timestamp line either — every file line carries content.
    for (const line of file.trimEnd().split("\n")) {
      expect(line).not.toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z $/);
    }
    // And stdout shouldn't have an empty trailing line for the warn.
    const stdoutWarnLines = sink.buffer
      .trimEnd()
      .split("\n")
      .filter((l) => l.includes("only line"));
    expect(stdoutWarnLines).toHaveLength(1);
  });

  it("event renders with and without details", async () => {
    const sink = new StringSink();
    const logger = await createLogger({
      runsDir: path.join(tmp, "runs"),
      taskId: "t",
      now: () => new Date(0),
      stdout: sink,
    });
    sink.buffer = "";
    logger.event("pr.opened");
    logger.event("subprocess.exit", "claude exit=0 dur=4s");
    await logger.close();
    expect(sink.buffer).toContain("[pr.opened]");
    expect(sink.buffer).toContain("[subprocess.exit] claude exit=0 dur=4s");
  });

  it("suppresses stdout mirror when caller passes filePath (detached-child contract)", async () => {
    // The detach path opens the plaintext log file in the parent and
    // inherits stdio fds pointing at it into the child. If the logger
    // also mirrored styled lines to its stdout sink, every entry would
    // land in the same file twice — once timestamped+plain via the
    // logger's stream, again styled via the inherited stdout fd. The
    // contract: when filePath is explicitly set, the file stream is the
    // sole sink.
    const sink = new StringSink();
    const fixed = new Date("2026-04-29T12:34:56.000Z");
    const explicitPath = path.join(tmp, "explicit.log");
    const logger = await createLogger({
      runsDir: path.join(tmp, "runs"),
      taskId: "abc",
      filePath: explicitPath,
      now: () => fixed,
      stdout: sink,
    });
    logger.info("hello");
    logger.error("boom");
    await logger.close();
    const fileContent = await fs.readFile(explicitPath, "utf8");
    expect(fileContent).toContain("INFO  flow: hello");
    expect(fileContent).toContain("ERROR flow: boom");
    // Stdout sink should have received nothing — not the banner, not
    // info, not error.
    expect(sink.buffer).toBe("");
  });
});

describe("NoopLogger", () => {
  it("never throws and withHeartbeat just calls fn", async () => {
    NoopLogger.info("x");
    NoopLogger.warn("x");
    NoopLogger.error("x");
    NoopLogger.success("x");
    NoopLogger.heartbeat("x");
    NoopLogger.event("x");
    NoopLogger.phaseStart("x");
    NoopLogger.phaseEnd("x", 1, "ok");
    expect(await NoopLogger.withHeartbeat("x", async () => 7)).toBe(7);
    await NoopLogger.close();
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [500, "500ms"],
    [1_000, "1s"],
    [59_000, "59s"],
    [60_000, "1m00s"],
    [63_000, "1m03s"],
    [252_000, "4m12s"],
  ])("%d → %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
