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
  const filePath = path.join(opts.runsDir, `${opts.taskId}-${stamp}.log`);
  const stream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
  await new Promise<void>((resolve, reject) => {
    stream.on("open", () => resolve());
    stream.on("error", reject);
  });

  const writeBoth = (styled: string, plain: string): void => {
    stdout.write(`${styled}\n`);
    const ts = now().toISOString();
    stream.write(`${ts} ${plain.replace(ANSI_RE, "")}\n`);
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
