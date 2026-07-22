/**
 * Durable launch breadcrumb: one JSON line per successful tmux-backed launch,
 * appended to ~/.flow/logs/launch.jsonl. The log is the primary (and only)
 * measurement surface for the end-to-end first-attempt launch rate — see
 * docs/launch-reliability.md. Fail-open like withLaunchSlot: an I/O failure
 * never fails a launch.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dim } from "./color";

export type LaunchRecord = {
  slug: string;
  at: string;
  attempts: number;
  outcome: "started" | "launched-not-confirmed";
  launcher: "plain" | "tmux";
};

/**
 * Appends exactly one `JSON.stringify(record) + "\n"` line, creating the
 * parent directory first. `logPath` is the test seam (specs write to a tmp
 * dir); default resolves at call time so vitest's $HOME swap is honored.
 */
export function appendLaunchRecord(
  record: LaunchRecord,
  logPath?: string,
): void {
  const target =
    logPath ?? path.join(os.homedir(), ".flow", "logs", "launch.jsonl");
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify(record)}\n`);
  } catch {
    process.stderr.write(dim("flow: launch log write skipped\n"));
  }
}
