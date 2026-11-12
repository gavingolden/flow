/**
 * The manager's scope-free decision log, `~/.flow/manager/log.jsonl`. The
 * sequencer (f1), the executive (f5), grants and prune all write here; every
 * entry carries `repo`, and `epic` / `slug` / `scope` when they apply. Readers
 * filter — a prompt-packet builder must always pass at least one filter key,
 * since this one file holds every repo's decisions.
 */

import * as fs from "node:fs";
import { withFileLockSync, type LockOptions } from "./lock";
import { managerFile, managerHome, managerLockPath } from "./manager-home";

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
  | "exec-owner-reply"
  | "rollup"
  | "budget-alert"
  | "proposal-answered";

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
  /** Required: the repo name as `canonicalRepoName` / `identityForState` report it. */
  repo: string;
  epic?: string;
  scope?: string;
  featureId?: string;
  slug?: string;
  pr?: number;
  reason?: string;
  key?: string;
  phase?: string;
  window?: string;
  exec?: ExecLogPayload;
  /** `rollup` lines only: `YYYY-MM` and counts by kind then outcome. */
  month?: string;
  counts?: Record<string, Record<string, number>>;
};

/** The sequencer appends from its tick, so its lock wait stays well under a second (Ctrl-C exits promptly). */
export const SEQUENCER_LOG_LOCK: LockOptions = { timeoutMs: 500, pollMs: 25 };

export function logPath(home: string = managerHome()): string {
  return managerFile("log.jsonl", home);
}

export function logLockPath(home: string = managerHome()): string {
  return managerLockPath("log", home);
}

export function appendManagerLog(
  entry: ManagerLogEntry,
  opts: { home?: string; lock?: LockOptions } = {},
): void {
  const home = opts.home ?? managerHome();
  fs.mkdirSync(home, { recursive: true });
  withFileLockSync(
    logLockPath(home),
    () => {
      fs.appendFileSync(logPath(home), `${JSON.stringify(entry)}\n`);
    },
    opts.lock ?? {},
  );
}

/** Tolerant: unparseable or shapeless lines are skipped; unknown kinds pass through. */
export function parseLogLines(raw: string): ManagerLogEntry[] {
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

export type ManagerLogFilter = { epic?: string; slug?: string; repo?: string };

export function readManagerLog(
  filter: ManagerLogFilter = {},
  home: string = managerHome(),
): ManagerLogEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath(home), "utf8");
  } catch {
    return [];
  }
  return parseLogLines(raw).filter(
    (e) =>
      (filter.epic === undefined || e.epic === filter.epic) &&
      (filter.slug === undefined || e.slug === filter.slug) &&
      (filter.repo === undefined || e.repo === filter.repo),
  );
}
