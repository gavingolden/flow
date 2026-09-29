/**
 * `flow doctor` leftover checks: stale worktrees. The pipeline-record checks
 * live in `doctor-pipelines.ts`, the process checks in `doctor-processes.ts`;
 * all three are re-exported here. Read-only: nothing
 * here removes a worktree, deletes a record, or signals a process — each
 * warning prints the command that does.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseWorktreeListOutput } from "../flow-remove-worktree";
import type { DoctorCheck, DoctorDeps } from "./doctor";
import {
  listStates,
  WORKTREE_REMOVED_PHASE_SET,
  type PipelineState,
} from "./state";
import { BRANCH_MARKER_FILENAME } from "./worktree-marker";

export { checkLeakedProcesses } from "./doctor-processes";
export { checkPipelineState } from "./doctor-pipelines";

const SECTION = "leftovers" as const;
const GIT_TIMEOUT_MS = 5000;

function shq(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function cwdRepo(deps: DoctorDeps): string | null {
  const r = deps.run("git", ["-C", deps.cwd, "rev-parse", "--show-toplevel"], {
    timeoutMs: 2000,
  });
  const top = r.stdout.trim();
  return r.status === 0 && top !== "" ? top : null;
}

export function checkStaleWorktrees(
  deps: DoctorDeps,
  io: { listStates?: () => PipelineState[] } = {},
): DoctorCheck[] {
  const states = (io.listStates ?? (() => listStates(deps.stateDir)))();
  const repos = new Map<string, string>();
  for (const s of states) if (!repos.has(s.repo)) repos.set(s.repo, s.slug);
  const here = cwdRepo(deps);
  if (here !== null && !repos.has(here)) repos.set(here, "");

  const checks: DoctorCheck[] = [];
  const seenPrimaries = new Set<string>();
  for (const [repo, slug] of repos) {
    const list = fs.existsSync(repo)
      ? deps.run("git", ["-C", repo, "worktree", "list", "--porcelain"], {
          timeoutMs: GIT_TIMEOUT_MS,
        })
      : null;
    if (list === null || list.status !== 0 || list.timedOut) {
      checks.push({
        id: `leftovers-worktrees:unreadable-${checks.length}`,
        section: SECTION,
        title: "Worktree scan",
        status: "warn",
        summary: `could not inspect repo at ${repo}`,
        details: [
          list === null
            ? "the recorded repo path no longer exists"
            : "git worktree list failed or timed out",
        ],
        fix: slug === "" ? "flow doctor" : `flow done ${slug}`,
      });
      continue;
    }
    const entries = parseWorktreeListOutput(list.stdout);
    const primary = entries[0] ? real(entries[0].path) : repo;
    if (seenPrimaries.has(primary)) continue;
    seenPrimaries.add(primary);
    for (const e of entries.slice(1)) {
      if (e.bare) continue;
      if (!fs.existsSync(path.join(e.path, BRANCH_MARKER_FILENAME))) continue;
      const owners = states.filter(
        (s) => s.worktree !== undefined && real(s.worktree) === real(e.path),
      );
      const stale =
        owners.length === 0 ||
        owners.every((s) => WORKTREE_REMOVED_PHASE_SET.has(s.phase));
      if (!stale) continue;
      checks.push({
        id: `leftovers-worktrees:${path.basename(e.path)}`,
        section: SECTION,
        title: "Stale worktree",
        status: "warn",
        summary: `${path.basename(e.path)} belongs to no live pipeline`,
        details: [
          e.path,
          "flow-remove-worktree removes the directory and may delete its branch; it refuses a tree with uncommitted tracked changes",
        ],
        fix: `cd ${shq(primary)} && flow-remove-worktree ${shq(e.path)}`,
      });
    }
  }
  if (checks.length === 0) {
    checks.push({
      id: "leftovers-worktrees",
      section: SECTION,
      title: "Stale worktrees",
      status: "pass",
      summary: `no stale worktrees in ${seenPrimaries.size} repo(s)`,
      details: [],
    });
  }
  return checks;
}
