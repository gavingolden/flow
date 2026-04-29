import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";

// Flow-defined event shapes for script phases. Anthropic stream-json events
// piped via `pipeFrom` are not constrained by this union — the PR 6 viewer
// will dispatch on shape.
export type FlowJsonlEvent =
  | { ts: string; kind: "exec"; cmd: string; args?: string[]; cwd?: string }
  | { ts: string; kind: "exec.exit"; cmd: string; exit: number; durationMs: number }
  | { ts: string; kind: "info"; msg: string }
  | { ts: string; kind: "warn"; msg: string }
  | { ts: string; kind: "error"; msg: string }
  | { ts: string; kind: "result"; status: "ok" | "failed" | "needs-human"; reason?: string };

export interface JsonlSink {
  readonly filePath: string;
  event(kind: string, payload?: Record<string, unknown>): void;
  pipeFrom(readable: NodeJS.ReadableStream): Promise<void>;
  close(): Promise<void>;
}

export interface CreateJsonlSinkOptions {
  taskDir: string;
  phase: string;
  // Test injection. Production callers pass nothing.
  now?: () => Date;
  stderr?: Writable;
}

export async function createJsonlSink(
  opts: CreateJsonlSinkOptions,
): Promise<JsonlSink> {
  const now = opts.now ?? (() => new Date());
  const stderr = opts.stderr ?? process.stderr;

  const logsDir = path.join(opts.taskDir, "logs");
  await fsp.mkdir(logsDir, { recursive: true });

  // Reuse the plaintext logger's stamp scheme — millisecond precision
  // (`2026-04-29T17-30-15-531Z`). Two phase invocations within the same
  // task at the same millisecond are vanishingly unlikely under PR 1's
  // single-runner model. PR 5's verify retry-loop may need a counter; add
  // it then.
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const safePhase = opts.phase.replace(/[^A-Za-z0-9._-]/g, "_");
  const filePath = path.join(logsDir, `${safePhase}-${stamp}.jsonl`);

  const stream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      stream.off("error", onOpenError);
      resolve();
    };
    const onOpenError = (err: Error): void => {
      stream.off("open", onOpen);
      reject(err);
    };
    stream.once("open", onOpen);
    stream.once("error", onOpenError);
  });
  // Long-lived error handler — disk full / perm change after open should
  // surface, not crash the process via an unhandled 'error' event.
  stream.on("error", (err: Error) => {
    try {
      stderr.write(`[jsonl-sink] write to ${filePath} failed: ${err.message}\n`);
    } catch {
      // stderr itself failed — nothing more we can do.
    }
  });

  let closed = false;

  const sink: JsonlSink = {
    filePath,
    event(kind, payload) {
      if (closed) return;
      const base = { ts: now().toISOString(), kind };
      // Payload-takes-precedence: if a caller passes `kind` or `ts` in
      // the payload it overrides the base. Intentional — keeps the helper
      // a pass-through rather than a validating wrapper.
      const obj = { ...base, ...(payload ?? {}) };
      stream.write(`${JSON.stringify(obj)}\n`);
    },
    async pipeFrom(readable) {
      // Line-buffer so partial chunks never reach the file. `\n` framing
      // only — never write a chunk that doesn't end on a newline; buffer
      // the residue until the next `data` event or `end`.
      let pending = "";
      readable.setEncoding?.("utf8");
      await new Promise<void>((resolve, reject) => {
        readable.on("data", (chunk: Buffer | string) => {
          if (closed) return;
          pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
          const idx = pending.lastIndexOf("\n");
          if (idx >= 0) {
            const complete = pending.slice(0, idx + 1);
            pending = pending.slice(idx + 1);
            stream.write(complete);
          }
        });
        readable.on("end", () => {
          if (pending.length > 0 && !closed) {
            // Flush residue verbatim — Anthropic stream-json's invariant is
            // one event per line, so a non-newline-terminated tail is a
            // protocol violation we still want recorded for post-mortem.
            stream.write(pending.endsWith("\n") ? pending : `${pending}\n`);
            pending = "";
          }
          resolve();
        });
        readable.on("error", reject);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
    },
  };

  return sink;
}

export const NoopJsonlSink: JsonlSink = {
  filePath: "",
  event() {},
  async pipeFrom(readable) {
    // Drain so the producer doesn't backpressure forever.
    await new Promise<void>((resolve, reject) => {
      readable.on("data", () => {});
      readable.on("end", () => resolve());
      readable.on("error", reject);
    });
  },
  async close() {},
};
