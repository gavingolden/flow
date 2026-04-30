import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";

export const TRIAGE_SENTINEL_ENV = "FLOW_TRIAGE_TASK_ID_FILE";

export function createSentinelPath(): string {
  return path.join(os.tmpdir(), `flow-triage-${randomBytes(8).toString("hex")}.id`);
}

export async function readSentinelTaskId(
  sentinelPath: string,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(sentinelPath, "utf8");
  } catch (err) {
    // ENOENT is the dominant case: triage didn't write the sentinel (e.g.
    // no-change classification, or interrupted before the final Write).
    // Other errors (EISDIR, EACCES, EMFILE) shouldn't crash the parent —
    // we still want to fall through to the "no task id recorded" warning
    // — but they're unexpected and worth surfacing for debuggability
    // instead of swallowing silently.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        pc.yellow(
          `flow: failed to read triage sentinel at ${sentinelPath}: ${(err as Error).message ?? err}`,
        ),
      );
    }
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

export async function cleanupSentinel(sentinelPath: string): Promise<void> {
  try {
    await fs.unlink(sentinelPath);
  } catch {
    // best-effort: ENOENT or any other unlink error is swallowed.
  }
}
