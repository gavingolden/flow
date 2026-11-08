/**
 * `flow doctor` leftover check: worktrees and leftover folders. It renders
 * the last recorded worktree sweep (`~/.flow/state/worktree-sweep/last.json`)
 * instead of scanning repos itself, so it makes no git or network call. The
 * pipeline-record checks live in `doctor-pipelines.ts`, the process checks in
 * `doctor-processes.ts`. Read-only: each warning prints the fix to run.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DoctorCheck, DoctorDeps } from "./doctor";
import { shq } from "./doctor-util";
import { formatBytes, holdReasonText } from "./worktree-sweep-render";
import type { HoldReason } from "./worktree-sweep-rules";
import {
  readLastSweep,
  type SweepItem,
  type SweepResult,
} from "./worktree-sweep-state";

const SECTION = "leftovers" as const;
export const STALE_WORKTREES_META = {
  id: "leftovers-worktrees",
  section: SECTION,
  title: "Stale worktrees",
} as const;

const DAY_MS = 86_400_000;
const STALE_AFTER_MS = 7 * DAY_MS;
const RUN_SWEEP = "flow reap --worktrees";

/** Kept for a reason that needs nothing from the user: counted, never warned. */
const EXPECTED_HOLDS: ReadonlySet<string> = new Set([
  "pr-open",
  "live-session",
  "session-unknown",
  "reserved-by-pipeline",
  "too-recent",
]);

function fixFor(i: SweepItem): string {
  const cd = `cd ${shq(i.repo)} &&`;
  switch (i.reason as HoldReason) {
    case "locked":
      return `git -C ${shq(i.repo)} worktree unlock ${shq(i.path)}`;
    case "uncommitted-changes":
      return `commit or discard the changes in ${shq(i.path)}, then ${RUN_SWEEP} --yes`;
    case "local-config-differs":
      return `copy or delete the local .env / settings file in ${shq(i.path)}, then ${RUN_SWEEP} --yes`;
    case "head-not-on-github":
      return `git -C ${shq(i.path)} push, then ${RUN_SWEEP} --yes`;
    case "in-use-process":
      return "flow reap --yes --include-strays";
    case "in-use-container":
      return `stop the container using it, then ${RUN_SWEEP} --yes`;
    case "gh-unreachable":
    case "deadline-reached":
      return `${RUN_SWEEP} --yes`;
    case "flow-source":
      return `flow setup --upgrade (from your main checkout) to move flow off this copy`;
    case "no-pr":
    case "no-branch":
      return `${cd} flow-remove-worktree ${shq(i.path)}`;
    default:
      return `inspect ${shq(i.path)} and delete it by hand if it is not needed`;
  }
}

function ago(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < DAY_MS) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / DAY_MS)} days`;
}

function summaryLine(
  last: SweepResult,
  ageMs: number,
  expected: SweepItem[],
): string {
  const done = last.items.filter((i) => i.outcome === "removed");
  const wts = done.filter((i) => i.kind === "worktree");
  const husks = done.filter((i) => i.kind === "husk");
  const bytes = wts.reduce((n, i) => n + (i.bytes ?? 0), 0);
  const prOpen = expected.filter((i) => i.reason === "pr-open").length;
  const other = expected.length - prOpen;
  const parts = [
    `removed ${wts.length} folders (${formatBytes(bytes)}), ${husks.length} leftover folders`,
  ];
  if (prOpen > 0) parts.push(`kept ${prOpen} whose PR is still open`);
  if (other > 0) parts.push(`${other} in use or too new to judge`);
  const note = last.acted ? "" : " (preview only, nothing removed)";
  return `last sweep ${ago(ageMs)} ago${note}: ${parts.join("; ")}`;
}

export function checkStaleWorktrees(
  deps: DoctorDeps,
  io: {
    readLastSweep?: () => SweepResult | null;
    nowMs?: () => number;
    exists?: (p: string) => boolean;
  } = {},
): DoctorCheck[] {
  const last = (io.readLastSweep ?? (() => readLastSweep(deps.stateDir)))();
  const exists = io.exists ?? fs.existsSync;
  if (last === null) {
    return [
      {
        ...STALE_WORKTREES_META,
        status: "warn",
        summary: "the worktree cleanup has never run",
        details: [
          "finished worktrees and leftover folders pile up until it runs; it starts on its own from `flow feature create` unless cleanup.worktrees is false",
        ],
        fix: RUN_SWEEP,
      },
    ];
  }

  const ageMs = (io.nowMs ?? deps.nowMs)() - Date.parse(last.at);
  const present = last.items.filter((i) => exists(i.path));
  const held = present.filter((i) => i.outcome === "held");
  const expected = held.filter((i) => EXPECTED_HOLDS.has(i.reason));
  const checks: DoctorCheck[] = [
    {
      ...STALE_WORKTREES_META,
      status: "pass",
      summary: summaryLine(last, ageMs, expected),
      details: [],
    },
  ];
  if (ageMs > STALE_AFTER_MS) {
    checks.push({
      id: "leftovers-worktrees:stale-result",
      section: SECTION,
      title: "Stale worktrees",
      status: "warn",
      summary: `the last worktree cleanup was ${ago(ageMs)} ago`,
      details: ["what it reported below may be out of date"],
      fix: RUN_SWEEP,
    });
  }

  const unrecognized = held.filter((i) => i.reason === "unrecognized-contents");
  for (const i of present) {
    const isFailed = i.outcome === "failed";
    const isKept =
      i.outcome === "held" &&
      !EXPECTED_HOLDS.has(i.reason) &&
      i.reason !== "unrecognized-contents";
    if (!isFailed && !isKept) continue;
    checks.push({
      id: `leftovers-worktrees:${path.basename(i.path)}`,
      section: SECTION,
      title: isFailed ? "Worktree not removed" : "Worktree kept",
      status: "warn",
      summary: `${path.basename(i.path)} ${isFailed ? `could not be removed (${i.detail ?? "unknown error"})` : holdReasonText(i.reason as HoldReason, i.detail)}`,
      details: [i.path],
      fix: isFailed ? `${RUN_SWEEP} --yes` : fixFor(i),
    });
  }
  if (unrecognized.length > 0) {
    checks.push({
      id: "leftovers-worktrees:unrecognized",
      section: SECTION,
      title: "Leftover folders",
      status: "warn",
      summary: `${unrecognized.length} leftover folder(s) hold files flow does not recognize`,
      details: unrecognized.map(
        (i) => `${i.path} (${i.detail ?? "unknown contents"})`,
      ),
      fix: "inspect each folder and delete or rename it; flow never removes files it does not recognize",
    });
  }
  for (const m of last.danglingMounts) {
    checks.push({
      id: `leftovers-worktrees:container:${m.container}`,
      section: SECTION,
      title: "Container recreates a deleted folder",
      status: "warn",
      summary: `container ${m.container} mounts ${m.source}, which was deleted`,
      details: ["Docker recreates the folder every time the container starts"],
      fix: "supabase stop && supabase start (from your main checkout)",
    });
  }
  return checks;
}
