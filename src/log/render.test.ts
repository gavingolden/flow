import { describe, expect, it } from "vitest";
import { renderEvent, renderLine } from "./render.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

describe("renderEvent — stream-json", () => {
  it("renders Bash tool_use with the command inline", () => {
    const out = renderEvent(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "ls -la /tmp" },
            },
          ],
        },
      },
      { forceColor: false },
    );
    expect(out.lines).toEqual(["Bash(ls -la /tmp)"]);
  });

  it("renders Edit / Write / Read tool_use with file_path", () => {
    const make = (name: string) =>
      renderEvent(
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name, input: { file_path: "src/foo.ts" } },
            ],
          },
        },
        { forceColor: false },
      );
    expect(make("Edit").lines).toEqual(["Edit(src/foo.ts)"]);
    expect(make("Write").lines).toEqual(["Write(src/foo.ts)"]);
    expect(make("Read").lines).toEqual(["Read(src/foo.ts)"]);
  });

  it("inline-truncates a Bash command past ~120 chars", () => {
    const longCmd = "echo " + "x".repeat(200);
    const out = renderEvent(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: longCmd } },
          ],
        },
      },
      { forceColor: false },
    );
    expect(out.lines).toHaveLength(1);
    const line = out.lines[0]!;
    // tool name + parens around the truncated arg; arg is at most 120 chars
    // and ends in the ellipsis.
    expect(line.startsWith("Bash(")).toBe(true);
    expect(line.endsWith(")")).toBe(true);
    const inner = line.slice("Bash(".length, -1);
    expect(inner.length).toBe(120);
    expect(inner.endsWith("…")).toBe(true);
  });

  it("renders tool_result as a dimmed summary of the first output line", () => {
    const out = renderEvent(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: "first line\nsecond line\nthird",
              is_error: false,
            },
          ],
        },
      },
      { forceColor: true },
    );
    expect(out.lines).toHaveLength(1);
    const plain = stripAnsi(out.lines[0]!);
    expect(plain).toContain("first line");
    expect(plain).not.toContain("second line");
    // Error-free result uses dimmed (\x1b[2m) head, not red.
    expect(out.lines[0]).toMatch(/\x1b\[2m/);
    expect(out.lines[0]).not.toMatch(/\x1b\[31m/);
  });

  it("renders an error tool_result with red `error`", () => {
    const out = renderEvent(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: "command failed",
              is_error: true,
            },
          ],
        },
      },
      { forceColor: true },
    );
    expect(out.lines[0]).toMatch(/\x1b\[31m/);
    expect(stripAnsi(out.lines[0]!)).toContain("error");
  });

  it("renders assistant text blocks as indented paragraphs", () => {
    const out = renderEvent(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "First paragraph.\n\nSecond paragraph.",
            },
          ],
        },
      },
      { forceColor: false },
    );
    expect(out.lines).toEqual([
      "  First paragraph.",
      "  Second paragraph.",
    ]);
  });

  it("renders thinking blocks dimmed", () => {
    const out = renderEvent(
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "secret reasoning" },
          ],
        },
      },
      { forceColor: true },
    );
    expect(out.lines[0]).toMatch(/\x1b\[2m/);
    expect(stripAnsi(out.lines[0]!)).toBe("  secret reasoning");
  });

  it("renders terminal stream-json result with status, duration, cost", () => {
    const out = renderEvent(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 65_000,
        total_cost_usd: 0.1234,
      },
      { forceColor: false },
    );
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("status=success");
    expect(out.lines[0]).toContain("duration=1m05s");
    expect(out.lines[0]).toContain("cost=$0.1234");
  });

  it("renders an errored stream-json result with status=error in red", () => {
    const out = renderEvent(
      { type: "result", is_error: true, duration_ms: 1_500 },
      { forceColor: true },
    );
    expect(out.lines[0]).toMatch(/\x1b\[31m/);
    expect(stripAnsi(out.lines[0]!)).toContain("status=error");
  });

  it("skips system events silently", () => {
    const out = renderEvent({ type: "system", subtype: "init" });
    expect(out.lines).toEqual([]);
  });
});

describe("renderEvent — flow script-phase events", () => {
  it("renders exec with cyan prefix and command + args", () => {
    const out = renderEvent(
      {
        ts: "2026-04-29T00:00:00.000Z",
        kind: "exec",
        cmd: "git",
        args: ["status", "--short"],
      },
      { forceColor: false },
    );
    expect(out.lines).toEqual(["exec git status --short"]);
  });

  it("renders exec.exit with green `exit=0` on success and red on non-zero", () => {
    const ok = renderEvent(
      {
        ts: "x",
        kind: "exec.exit",
        cmd: "git",
        exit: 0,
        durationMs: 250,
      },
      { forceColor: true },
    );
    expect(ok.lines[0]).toMatch(/\x1b\[32m/);
    expect(stripAnsi(ok.lines[0]!)).toContain("exit=0");

    const bad = renderEvent(
      {
        ts: "x",
        kind: "exec.exit",
        cmd: "git",
        exit: 1,
        durationMs: 250,
      },
      { forceColor: true },
    );
    expect(bad.lines[0]).toMatch(/\x1b\[31m/);
    expect(stripAnsi(bad.lines[0]!)).toContain("exit=1");
  });

  it("renders info / warn / error / result with their prefixes", () => {
    const info = renderEvent(
      { ts: "x", kind: "info", msg: "hello" },
      { forceColor: false },
    );
    expect(info.lines).toEqual(["info hello"]);

    const warn = renderEvent(
      { ts: "x", kind: "warn", msg: "careful" },
      { forceColor: false },
    );
    expect(warn.lines).toEqual(["warn careful"]);

    const err = renderEvent(
      { ts: "x", kind: "error", msg: "boom" },
      { forceColor: false },
    );
    expect(err.lines).toEqual(["error boom"]);

    const okResult = renderEvent(
      { ts: "x", kind: "result", status: "ok" },
      { forceColor: false },
    );
    expect(okResult.lines[0]).toContain("result status=ok");

    const failedResult = renderEvent(
      { ts: "x", kind: "result", status: "failed", reason: "tests broke" },
      { forceColor: false },
    );
    expect(failedResult.lines[0]).toContain("result status=failed");
    expect(failedResult.lines[0]).toContain("tests broke");
  });

  it("falls back to <kind> <JSON.stringify(rest)> for unknown kind", () => {
    const out = renderEvent(
      { ts: "x", kind: "bespoke", data: 42, extra: "y" },
      { forceColor: false },
    );
    expect(out.lines).toHaveLength(1);
    expect(stripAnsi(out.lines[0]!)).toBe(`bespoke {"data":42,"extra":"y"}`);
  });
});

describe("renderEvent — color forcing", () => {
  it("forceColor:false strips ANSI escapes from output", () => {
    const out = renderEvent(
      { ts: "x", kind: "warn", msg: "be careful" },
      { forceColor: false },
    );
    expect(out.lines[0]).not.toMatch(ANSI_RE);
  });

  it("forceColor:true emits ANSI escapes even outside a TTY", () => {
    const out = renderEvent(
      { ts: "x", kind: "warn", msg: "be careful" },
      { forceColor: true },
    );
    expect(out.lines[0]).toMatch(ANSI_RE);
  });
});

describe("renderLine", () => {
  it("parses one jsonl line and returns rendered output", () => {
    const evt = { ts: "x", kind: "info", msg: "hi" };
    const out = renderLine(JSON.stringify(evt) + "\n", { forceColor: false });
    expect("lines" in out && out.lines).toEqual(["info hi"]);
  });

  it("returns { malformed: true } for non-JSON input", () => {
    const out = renderLine("not-json", { forceColor: false });
    expect(out).toEqual({ malformed: true });
  });

  it("returns no lines for an empty / whitespace-only input", () => {
    expect(renderLine("")).toEqual({ lines: [] });
    expect(renderLine("\n")).toEqual({ lines: [] });
  });
});
