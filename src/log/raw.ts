import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Writable } from "node:stream";
import type { LogFile } from "./discover.js";

export async function streamRaw(
  files: LogFile[],
  stdout: Writable,
): Promise<void> {
  for (const file of files) {
    const stream = fs.createReadStream(file.path);
    // `end: false` keeps stdout open across files so the next stream can
    // also write into it. The CLI command owns stdout's lifecycle.
    await pipeline(stream, stdout, { end: false });
  }
}
