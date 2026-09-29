/**
 * `flow doctor` pipeline-record checks: records that can no longer resume,
 * finished records never closed, and never-started orphans. Read-only — a
 * pipeline is never judged dead by the absence of a tmux window (the plain
 * launcher has none); only the shared never-started predicate reads windows.
 */

import * as fs from "node:fs";
import type { DoctorCheck, DoctorDeps } from "./doctor";
import { capped } from "./doctor-util";
import {
  reapableStartingOrphans,
  STARTING_ORPHAN_GRACE_MS,
} from "./reap-orphans";
import {
  FINISHED_PHASE_SET,
  listStates,
  WORKTREE_REMOVED_PHASE_SET,
  type PipelineState,
} from "./state";
import { listWindows, type TmuxWindow } from "./tmux";

const SECTION = "leftovers" as const;

function tolerantWindows(): TmuxWindow[] {
  try {
    return listWindows();
  } catch {
    return [];
  }
}

export function checkPipelineState(
  deps: DoctorDeps,
  io: {
    listStates?: () => PipelineState[];
    listWindows?: () => TmuxWindow[];
  } = {},
): DoctorCheck[] {
  const states = (io.listStates ?? (() => listStates(deps.stateDir)))();
  const checks: DoctorCheck[] = [];

  const unresumable = states.filter(
    (s) =>
      !FINISHED_PHASE_SET.has(s.phase) &&
      s.worktree !== undefined &&
      !fs.existsSync(s.worktree),
  );
  if (unresumable.length === 0) {
    checks.push({
      id: "leftovers-unresumable",
      section: SECTION,
      title: "Unresumable pipelines",
      status: "pass",
      summary: "every unfinished pipeline still has its worktree",
      details: [],
    });
  }
  for (const s of unresumable) {
    checks.push({
      id: `leftovers-unresumable:${s.slug}`,
      section: SECTION,
      title: "Unresumable pipeline",
      status: "warn",
      summary: `${s.slug} (${s.phase}) lost its worktree`,
      details: [
        `expected at ${s.worktree}`,
        "flow done closes that pipeline's record so it can no longer be resumed",
      ],
      fix: `flow done ${s.slug}`,
    });
  }

  const unclosed = states.filter((s) =>
    WORKTREE_REMOVED_PHASE_SET.has(s.phase),
  );
  checks.push(
    unclosed.length === 0
      ? {
          id: "leftovers-unclosed",
          section: SECTION,
          title: "Finished pipeline records",
          status: "pass",
          summary: "no finished pipeline records are left open",
          details: [],
        }
      : {
          id: "leftovers-unclosed",
          section: SECTION,
          title: "Finished pipeline records",
          status: "warn",
          summary: `${unclosed.length} merged or cancelled pipeline record(s) never closed`,
          details: [
            capped(unclosed.map((s) => s.slug)).join(", "),
            "flow done --merged removes those records; they stop appearing in flow ls",
          ],
          fix: "flow done --merged",
        },
  );

  const windows = (io.listWindows ?? tolerantWindows)();
  const neverStarted = reapableStartingOrphans(
    states,
    windows,
    deps.nowMs(),
    STARTING_ORPHAN_GRACE_MS,
  );
  if (neverStarted.length === 0) {
    checks.push({
      id: "leftovers-never-started",
      section: SECTION,
      title: "Never-started pipelines",
      status: "pass",
      summary: "no pipeline stalled before it started",
      details: [],
    });
  }
  for (const slug of neverStarted) {
    checks.push({
      id: `leftovers-never-started:${slug}`,
      section: SECTION,
      title: "Never-started pipeline",
      status: "warn",
      summary: `${slug} never got past starting`,
      details: [
        "flow done closes that pipeline's record so it can no longer be resumed",
      ],
      fix: `flow done ${slug}`,
    });
  }
  return checks;
}
