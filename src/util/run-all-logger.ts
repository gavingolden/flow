import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// Scheduler-level logging for `flow run --all`. Mirrors the per-task
// logger split: a human-readable plaintext file for tail / grep and a
// jsonl event stream for tooling (`/flow status`, future viewers). The
// per-task logger lives at `runs/<safeTaskId>-<stamp>.log`; the
// scheduler's lives at `runs/all-<stamp>.{log,jsonl}` so PR 6's `flow
// log` can later tell them apart by filename pattern.
//
// Event names are an explicit union — drift here breaks downstream
// consumers (PR 10's status renderer parses `worker.exit` events to
// attribute scheduler activity to the right run).

export type SchedulerEventName =
  | "scheduler.start"
  | "scheduler.exit"
  | "queue.size"
  | "claim.attempted"
  | "claim.acquired"
  | "claim.skipped"
  | "worker.spawn"
  | "worker.exit"
  | "watch.poll"
  | "signal.received";

export interface RunAllLogger {
  readonly filePath: string;
  readonly jsonlPath: string;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  event(name: SchedulerEventName, fields?: Record<string, unknown>): void;
  close(): Promise<void>;
}

export interface CreateRunAllLoggerOptions {
  runsDir: string;
  // Pre-computed stamp lets the detach path open the log file from the
  // parent (so it can `console.log("log → <path>")` immediately) and
  // hand the same paths to the re-exec'd child via env vars. When
  // omitted, the logger picks `now().toISOString().replace(/[:.]/g, "-")`.
  stamp?: string;
  // Test injection. Production callers pass nothing.
  now?: () => Date;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export async function createRunAllLogger(
  opts: CreateRunAllLoggerOptions,
): Promise<RunAllLogger> {
  const now = opts.now ?? (() => new Date());
  await fsp.mkdir(opts.runsDir, { recursive: true });
  const stamp = opts.stamp ?? now().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(opts.runsDir, `all-${stamp}.log`);
  const jsonlPath = path.join(opts.runsDir, `all-${stamp}.jsonl`);

  const textStream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
  const jsonlStream = fs.createWriteStream(jsonlPath, { flags: "a", encoding: "utf8" });
  await Promise.all([waitOpen(textStream), waitOpen(jsonlStream)]);

  // Long-lived error handlers — disk full / permission change after open
  // surfaces to stderr instead of an unhandled `'error'` crashing the
  // scheduler.
  textStream.on("error", (err: Error) => {
    try {
      process.stderr.write(`[run-all-logger] write to ${filePath} failed: ${err.message}\n`);
    } catch {}
  });
  jsonlStream.on("error", (err: Error) => {
    try {
      process.stderr.write(`[run-all-logger] write to ${jsonlPath} failed: ${err.message}\n`);
    } catch {}
  });

  const writeText = (level: string, msg: string): void => {
    const ts = now().toISOString();
    const lines = stripTrailingNewline(msg).split("\n");
    for (const line of lines) {
      textStream.write(`${ts} ${level} ${line.replace(ANSI_RE, "")}\n`);
    }
  };

  return {
    filePath,
    jsonlPath,
    info(msg) {
      writeText("INFO ", msg);
    },
    warn(msg) {
      writeText("WARN ", msg);
    },
    error(msg) {
      writeText("ERROR", msg);
    },
    event(name, fields) {
      const ts = now().toISOString();
      const obj = { ts, name, ...(fields ?? {}) };
      jsonlStream.write(`${JSON.stringify(obj)}\n`);
      // Mirror a one-line summary to the plaintext log so a human
      // tail-following the .log can see scheduler activity without
      // bouncing to jq.
      const summary = renderEventSummary(name, fields);
      textStream.write(`${ts} EVENT ${summary}\n`);
    },
    async close() {
      await Promise.all([
        new Promise<void>((resolve) => textStream.end(() => resolve())),
        new Promise<void>((resolve) => jsonlStream.end(() => resolve())),
      ]);
    },
  };
}

function waitOpen(stream: fs.WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (err: Error): void => {
      stream.off("open", onOpen);
      reject(err);
    };
    stream.once("open", onOpen);
    stream.once("error", onError);
  });
}

function stripTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

function renderEventSummary(
  name: SchedulerEventName,
  fields?: Record<string, unknown>,
): string {
  if (!fields || Object.keys(fields).length === 0) return name;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`${k}=${formatField(v)}`);
  }
  return `${name} ${parts.join(" ")}`;
}

function formatField(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Fall back to JSON for objects/arrays so the plaintext line is
  // unambiguous when scanned with grep.
  return JSON.stringify(v);
}
