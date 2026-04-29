import fs from "node:fs";
import readline from "node:readline";
import type { Writable } from "node:stream";
import type { LogFile } from "./discover.js";
import { type RenderOptions, colorsFor, renderLine } from "./render.js";

export interface ConcatOptions extends RenderOptions {
  stdout: Writable;
  stderr: Writable;
  // Banner width when not tied to a TTY column count. The CLI passes
  // `process.stdout.columns ?? undefined`; tests pass a fixed value.
  bannerWidth?: number;
}

const DEFAULT_BANNER_WIDTH = 60;

export async function concatRender(
  files: LogFile[],
  opts: ConcatOptions,
): Promise<void> {
  const colors = colorsFor(opts);
  const width = opts.bannerWidth ?? DEFAULT_BANNER_WIDTH;
  for (const file of files) {
    opts.stdout.write(`${colors.bold(banner(file, width))}\n`);
    await renderFile(file.path, opts);
    opts.stdout.write("\n");
  }
}

export function banner(file: LogFile, width: number): string {
  // Format: `── <phase> @ <stamp> ─────────`. Pad with em-dashes to `width`
  // (or the natural length, whichever is larger).
  const head = `── ${file.phase} @ ${file.stamp} `;
  const padLen = Math.max(2, width - head.length);
  return head + "─".repeat(padLen);
}

export async function renderFile(
  filePath: string,
  opts: ConcatOptions,
): Promise<void> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNum = 0;
  for await (const line of rl) {
    lineNum++;
    if (line.length === 0) continue;
    const out = renderLine(line, opts);
    if ("malformed" in out) {
      opts.stderr.write(
        `warning: malformed jsonl line at ${filePath}:${lineNum}\n`,
      );
      continue;
    }
    for (const rendered of out.lines) {
      opts.stdout.write(`${rendered}\n`);
    }
  }
}
