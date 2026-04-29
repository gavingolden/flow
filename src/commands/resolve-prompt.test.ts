import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { resolvePromptSource } from "./resolve-prompt.js";

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

function tty(): NodeJS.ReadableStream & { isTTY?: boolean } {
  // Empty Readable that signals it's a TTY. The resolver should never read
  // from it on the TTY paths, so the stream content does not matter.
  const r = Readable.from([]) as Readable & { isTTY?: boolean };
  r.isTTY = true;
  return r;
}

function pipe(
  data: string | string[],
): NodeJS.ReadableStream & { isTTY?: boolean } {
  const chunks = Array.isArray(data) ? data : [data];
  const r = Readable.from(chunks.map((s) => Buffer.from(s, "utf8"))) as
    & Readable
    & { isTTY?: boolean };
  r.isTTY = false;
  return r;
}

describe("resolvePromptSource", () => {
  it("argv-only with TTY stdin returns the argv prompt with no stderr", async () => {
    const stderr = new StringSink();
    const stdin = tty();
    const result = await resolvePromptSource(["fix", "the", "bug"], {
      stdin,
      stderr,
    });
    expect(result).toEqual({ ok: true, prompt: "fix the bug" });
    expect(stderr.buffer).toBe("");
  });

  it("argv-only with piped stdin warns and returns argv (does not read stdin)", async () => {
    const stderr = new StringSink();
    const stdin = pipe("ignored stdin payload\n");
    const result = await resolvePromptSource(["argv", "wins"], {
      stdin,
      stderr,
    });
    expect(result).toEqual({ ok: true, prompt: "argv wins" });
    expect(stderr.buffer).toContain("ignoring stdin");
    expect(stderr.buffer.endsWith("\n")).toBe(true);
    // stdin is intentionally left undrained when argv wins. This matches
    // `git commit -m "x" <<EOF`, where the producer-shell heredoc is simply
    // discarded. A piped producer (`producer | flow start "argv"`) will
    // block on backpressure until flow exits and only then see SIGPIPE —
    // EPIPE is the *eventual* outcome, not the immediate one.
    expect((stdin as Readable).readableEnded).toBe(false);
  });

  it("no argv with piped 'hello\\n' returns 'hello' (single trailing newline stripped)", async () => {
    const stderr = new StringSink();
    const stdin = pipe("hello\n");
    const result = await resolvePromptSource([], { stdin, stderr });
    expect(result).toEqual({ ok: true, prompt: "hello" });
    expect(stderr.buffer).toBe("");
  });

  it("strips all trailing newlines but preserves interior newlines", async () => {
    const stderr = new StringSink();
    const stdin = pipe("line one\nline two\n\n\n");
    const result = await resolvePromptSource([], { stdin, stderr });
    expect(result).toEqual({ ok: true, prompt: "line one\nline two" });
  });

  it("strips trailing CRLF (Windows line endings) without leaving stray \\r", async () => {
    const stderr = new StringSink();
    const stdin = pipe("hello\r\n");
    const result = await resolvePromptSource([], { stdin, stderr });
    expect(result).toEqual({ ok: true, prompt: "hello" });
  });

  it("strips mixed trailing CR/LF runs (\\r\\n\\r\\n, \\r\\n\\n, \\n\\r)", async () => {
    const stderr = new StringSink();
    const stdin = pipe("line one\r\nline two\r\n\r\n");
    const result = await resolvePromptSource([], { stdin, stderr });
    // Interior CRLF is preserved; only the trailing CR/LF run is stripped.
    expect(result).toEqual({ ok: true, prompt: "line one\r\nline two" });
  });

  it("preserves leading whitespace and only trims trailing newlines", async () => {
    const stderr = new StringSink();
    const stdin = pipe("  indented prompt\n");
    const result = await resolvePromptSource([], { stdin, stderr });
    expect(result).toEqual({ ok: true, prompt: "  indented prompt" });
  });

  it("no argv with TTY stdin errors with a message naming both paths", async () => {
    const stderr = new StringSink();
    const stdin = tty();
    const result = await resolvePromptSource([], { stdin, stderr });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/argument/i);
    expect(result.message).toMatch(/stdin/i);
  });

  it("no argv with empty piped stdin errors with a message mentioning stdin", async () => {
    const stderr = new StringSink();
    const stdin = pipe("");
    const result = await resolvePromptSource([], { stdin, stderr });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/stdin/i);
    expect(result.message).toMatch(/empty/i);
  });

  it("no argv with piped stdin containing only newlines is treated as empty", async () => {
    const stderr = new StringSink();
    const stdin = pipe("\n\n\n");
    const result = await resolvePromptSource([], { stdin, stderr });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/empty/i);
  });
});
