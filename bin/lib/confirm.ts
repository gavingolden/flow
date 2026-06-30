import * as fs from "node:fs";

/**
 * Synchronous stdin y/N confirmation prompt. Writes `${prompt} [y/N] ` to
 * stdout and reads a single line via `fs.readSync(0, ...)` (Bun supports
 * synchronous stdin reads; avoid `require()` so this module stays pure ESM,
 * matching the rest of bin/lib). Returns `true` only on `y`/`yes`; any read
 * error (e.g. no TTY / closed fd-0) is treated as a decline.
 *
 * Extracted from the formerly-duplicated copies in done.ts (`confirm`),
 * new.ts (`confirmResume`), and epic.ts (`confirmStdin`) once the third
 * consumer landed — the documented extraction trigger.
 */
export function confirmStdin(prompt: string): boolean {
  process.stdout.write(`${prompt} [y/N] `);
  const buf = Buffer.alloc(16);
  let len = 0;
  try {
    len = fs.readSync(0, buf, 0, buf.length, null);
  } catch {
    return false;
  }
  const answer = buf.subarray(0, len).toString("utf8").trim().toLowerCase();
  return answer === "y" || answer === "yes";
}
