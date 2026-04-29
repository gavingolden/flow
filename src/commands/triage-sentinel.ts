import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  } catch {
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
