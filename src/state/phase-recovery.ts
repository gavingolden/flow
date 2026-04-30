import fsp from "node:fs/promises";
import { filterByPhase, latestFile, listLogFiles } from "../log/discover.js";
import type { TaskStatus } from "./phases.js";

// Status → phase mapping. A task at one of these transient phase-running
// statuses is "inside" the corresponding phase; if its parent process died
// before the phase function returned, the JSONL log for the phase carries
// the evidence of how far the work got.
//
// Statuses that are *not* mid-phase (settled like `pr-open`, terminal like
// `merged`) map to `null` — there's no "the parent died mid-phase"
// scenario to detect for them.
export const STATUS_TO_PHASE: Partial<Record<TaskStatus, string>> = {
  "creating-worktree": "worktree",
  planning: "plan",
  implementing: "implement",
  verifying: "verify",
  reviewing: "review",
  gating: "gate",
  merging: "merge",
};

export interface RecoveryEvidence {
  phase: string;
  jsonlPath: string;
  // The Anthropic stream-json `type:result` event reports success when
  // either `subtype === "success"` or `is_error === false`.
  subprocessSucceeded: boolean;
  // Flow's own `kind:result` event is written by `runPipeline` *after*
  // `transitionStatus` lands on disk; absence is the signal that the
  // parent died between subprocess exit and phase-function return.
  flowResultRecorded: boolean;
}

export async function inspectPhaseLogs(
  taskDir: string,
  status: TaskStatus,
): Promise<RecoveryEvidence | null> {
  const phase = STATUS_TO_PHASE[status];
  if (!phase) return null;

  const all = await listLogFiles(taskDir);
  const forPhase = filterByPhase(all, phase);
  const target = latestFile(forPhase);
  if (!target) return null;

  let raw: string;
  try {
    raw = await fsp.readFile(target.path, "utf8");
  } catch {
    return null;
  }
  if (raw.length === 0) return null;

  let subprocessSucceeded = false;
  let flowResultRecorded = false;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Truncated or partial line from a parent that died mid-write.
      continue;
    }
    if (parsed["type"] === "result") {
      const subtype = parsed["subtype"];
      const isError = parsed["is_error"];
      if (subtype === "success" || isError === false) {
        subprocessSucceeded = true;
      }
    } else if (parsed["kind"] === "result") {
      flowResultRecorded = true;
    }
  }

  return {
    phase,
    jsonlPath: target.path,
    subprocessSucceeded,
    flowResultRecorded,
  };
}

export function needsRecovery(
  evidence: RecoveryEvidence | null,
): boolean {
  if (!evidence) return false;
  return evidence.subprocessSucceeded && !evidence.flowResultRecorded;
}
