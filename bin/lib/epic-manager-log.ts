/**
 * The shared per-epic manager directory (`~/.flow/state/managers/<epic>/`)
 * and its append-only `log.jsonl`. The sequencer (`flow epic manage`) and the
 * epic executive both write here; the names and base fields are the shared
 * contract, so whichever feature merges second changes imports, never data.
 *
 * `managers/` is a subdirectory of the state dir: `listStates` reads only
 * top-level `*.json` files, so nothing here is mistaken for a pipeline state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLockSync } from "./lock";
import { FLOW_STATE_DIR } from "./paths";

export type ManagerLogKind =
  | "started"
  | "stopped"
  | "launch"
  | "launch-failed"
  | "hold"
  | "drift-halt"
  | "merged-observed"
  | "owner-needed"
  | "grant"
  | "grant-withdrawn"
  | "exec-decision"
  | "exec-challenge"
  | "exec-challenge-outcome"
  | "exec-skip"
  | "exec-owner-reply";

export type ExecLogPayload = {
  decisionId: string;
  reviewKind: "plan" | "wave";
  round?: number;
  decision?: string;
  action?: string;
  doorType?: "two-way" | "one-way";
  confidence?: "high" | "medium" | "low";
  rationale?: string;
  recommendation?: string;
  recommendationAction?: "approve" | "redirect";
  ownerReply?: "accept" | "approve" | "redirect" | "cancel";
  accepted?: boolean;
  wrongApproval?: boolean;
  undo?: string;
  challengeId?: string;
  closed?: boolean;
  actedOn?: boolean;
  order?: string[];
  proposal?: {
    kind: "defer" | "cut" | "add" | "goal";
    featureId?: string;
    text: string;
  };
  mergedFeatureIds?: string[];
  baselineMerged?: string[];
  model?: string;
  effort?: string;
  costUsd?: number;
  backstop?: boolean;
};

export type ManagerLogEntry = {
  ts: string;
  kind: ManagerLogKind;
  featureId?: string;
  slug?: string;
  pr?: number;
  reason?: string;
  key?: string;
  phase?: string;
  window?: string;
  exec?: ExecLogPayload;
};

/** The sequencer loop appends from its tick, so the lock wait stays well under a second. */
const LOG_LOCK = { timeoutMs: 500, pollMs: 25 } as const;

export function managerDir(
  epicSlug: string,
  stateDir: string = FLOW_STATE_DIR,
): string {
  return path.join(stateDir, "managers", epicSlug);
}

function logPath(epicSlug: string, stateDir?: string): string {
  return path.join(managerDir(epicSlug, stateDir), "log.jsonl");
}

export function appendManagerLog(
  epicSlug: string,
  entry: ManagerLogEntry,
  stateDir?: string,
): void {
  const dir = managerDir(epicSlug, stateDir);
  fs.mkdirSync(dir, { recursive: true });
  withFileLockSync(
    path.join(dir, "log.lock"),
    () => {
      fs.appendFileSync(
        logPath(epicSlug, stateDir),
        `${JSON.stringify(entry)}\n`,
      );
    },
    LOG_LOCK,
  );
}

/** Tolerant: unparseable or shapeless lines are skipped; unknown kinds pass through. */
export function readManagerLog(
  epicSlug: string,
  stateDir?: string,
): ManagerLogEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath(epicSlug, stateDir), "utf8");
  } catch {
    return [];
  }
  const out: ManagerLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v: unknown = JSON.parse(line);
      if (
        typeof v === "object" &&
        v !== null &&
        typeof (v as ManagerLogEntry).ts === "string" &&
        typeof (v as ManagerLogEntry).kind === "string"
      ) {
        out.push(v as ManagerLogEntry);
      }
    } catch {
      // skip a torn or hand-edited line
    }
  }
  return out;
}
