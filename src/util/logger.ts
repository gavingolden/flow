import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import pc from "picocolors";

export interface Logger {
  readonly filePath: string;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  success(msg: string): void;
  heartbeat(msg: string): void;
  event(name: string, details?: string): void;
  phaseStart(name: string, note?: string): void;
  phaseEnd(name: string, durationMs: number, outcome: string): void;
  withHeartbeat<T>(label: string, fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface CreateLoggerOptions {
  runsDir: string;
  taskId: string;
  // When set, the logger appends to this exact path instead of computing
  // one from `runsDir + taskId + stamp`. The detach path uses this so a
  // re-exec'd child writes to the same file the parent already opened
  // and inherited via stdio. `runsDir` is still required (we mkdir it
  // first) but is not consulted for the file path itself.
  filePath?: string;
  // Test injection points. Production callers pass nothing.
  now?: () => Date;
  setInterval?: (handler: () => void, ms: number) => NodeJS.Timeout | number;
  clearInterval?: (handle: NodeJS.Timeout | number) => void;
  heartbeatMs?: number;
  stdout?: Writable;
  // Force ANSI on/off; default = picocolors' auto-detection. Tests force-on
  // because vitest runs under a non-TTY where picocolors strips colors.
  forceColor?: boolean;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export async function createLogger(opts: CreateLoggerOptions): Promise<Logger> {
  const now = opts.now ?? (() => new Date());
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const setIntervalImpl = opts.setInterval ?? globalThis.setInterval;
  const clearIntervalImpl = opts.clearInterval ?? globalThis.clearInterval;
  const stdout = opts.stdout ?? process.stderr;
  const colors =
    opts.forceColor !== undefined ? pc.createColors(opts.forceColor) : pc;

  await fsp.mkdir(opts.runsDir, { recursive: true });
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  // Sanitize taskId before joining into a path. task.frontmatter.id comes
  // from on-disk YAML and could in principle contain `/`, `..`, or other
  // characters that would let the log file escape `runsDir` or create
  // nested directories. Replace anything outside a conservative filename
  // alphabet with `_` so the result is always a single safe filename
  // segment.
  const safeTaskId = opts.taskId.replace(/[^A-Za-z0-9._-]/g, "_");
  const filePath = opts.filePath ?? path.join(opts.runsDir, `${safeTaskId}-${stamp}.log`);
  const stream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
  // Stage 1: wait for the file to open. A failure here is fatal — there's
  // no log file to fall back to.
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
  // Stage 2: install a long-lived error handler so a later failure (disk
  // full, permission change) surfaces to stderr instead of being swallowed
  // by a resolved promise's no-op `reject` (or escalating to an unhandled
  // 'error' event that crashes the process). Best-effort: write a red line
  // to stdout sink so the user notices the persistent log has stopped.
  stream.on("error", (err: Error) => {
    const msg = `[logger] write to ${filePath} failed: ${err.message}`;
    try {
      stdout.write(`${colors.red(msg)}\n`);
    } catch {
      // stdout itself failed — nothing more we can do.
    }
  });

  const writeBoth = (styled: string, plain: string): void => {
    // Each call may carry multi-line content (e.g. teed subprocess stderr,
    // truncated failure logs). Split both sides on '\n' and write each line
    // separately so the file sink keeps its per-line invariant: every line
    // begins with an ISO-8601 timestamp and contains no ANSI codes. This
    // matters for `tail -f` and for grep-by-timestamp on the log file.
    //
    // A trailing newline in the payload would split into a final empty
    // string; writing that as `\n` produces a spurious blank line (and a
    // bare-timestamp line in the file sink). Trim a single trailing
    // newline first so the caller's choice to terminate (or not) doesn't
    // alter the line count.
    const trim = (s: string): string =>
      s.endsWith("\n") ? s.slice(0, -1) : s;
    const styledLines = trim(styled).split("\n");
    for (const line of styledLines) {
      stdout.write(`${line}\n`);
    }
    const plainLines = trim(plain).split("\n");
    for (const line of plainLines) {
      const ts = now().toISOString();
      stream.write(`${ts} ${line.replace(ANSI_RE, "")}\n`);
    }
  };

  const banner = `flow run ${opts.taskId} — started ${now().toISOString()}`;
  writeBoth(colors.dim(banner), banner);

  const logger: Logger = {
    filePath,
    info(msg) {
      writeBoth(colors.gray(`flow: ${msg}`), `INFO  flow: ${msg}`);
    },
    warn(msg) {
      writeBoth(colors.yellow(`flow: WARN ${msg}`), `WARN  flow: ${msg}`);
    },
    error(msg) {
      writeBoth(colors.red(`flow: ERROR ${msg}`), `ERROR flow: ${msg}`);
    },
    success(msg) {
      writeBoth(colors.green(`flow: ${msg}`), `OK    flow: ${msg}`);
    },
    heartbeat(msg) {
      writeBoth(colors.dim(`flow: ${msg}`), `BEAT  flow: ${msg}`);
    },
    event(name, details) {
      const tail = details ? ` ${details}` : "";
      writeBoth(colors.gray(`flow: [${name}]${tail}`), `EVENT flow: [${name}]${tail}`);
    },
    phaseStart(name, note) {
      const tail = note ? ` ${note}` : "";
      writeBoth(
        colors.cyan(`flow: ▶ ${name}${tail}`),
        `PHASE flow: ▶ ${name}${tail}`,
      );
    },
    phaseEnd(name, durationMs, outcome) {
      const dur = formatDuration(durationMs);
      const styled =
        outcome === "ok"
          ? colors.green(`flow: ✓ ${name} ok in ${dur}`)
          : colors.red(`flow: ✗ ${name} ${outcome} in ${dur}`);
      writeBoth(styled, `PHASE flow: ${name} ${outcome} in ${dur}`);
    },
    async withHeartbeat<T>(label: string, fn: () => Promise<T>): Promise<T> {
      const start = now().getTime();
      const handle = setIntervalImpl(() => {
        const elapsed = Math.round((now().getTime() - start) / 1000);
        logger.heartbeat(`${label}: still running, ${elapsed}s elapsed…`);
      }, heartbeatMs);
      try {
        return await fn();
      } finally {
        clearIntervalImpl(handle);
      }
    },
    async close() {
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
    },
  };

  return logger;
}

export const NoopLogger: Logger = {
  filePath: "",
  info() {},
  warn() {},
  error() {},
  success() {},
  heartbeat() {},
  event() {},
  phaseStart() {},
  phaseEnd() {},
  async withHeartbeat<T>(_label: string, fn: () => Promise<T>): Promise<T> {
    return await fn();
  },
  async close() {},
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}
