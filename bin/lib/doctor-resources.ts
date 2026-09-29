/**
 * `flow doctor` leftover checks: stale worktrees. The pipeline-record checks
 * live in `doctor-pipelines.ts`, the process checks in `doctor-processes.ts`.
 * Read-only: nothing here removes a worktree, deletes a record, or signals a
 * process — each warning prints the command that does.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseWorktreeListOutput } from "../flow-remove-worktree";
import type { DoctorCheck, DoctorDeps } from "./doctor";
import { shq } from "./doctor-util";
import {
  listStates,
  WORKTREE_REMOVED_PHASE_SET,
  type PipelineState,
} from "./state";
import { BRANCH_MARKER_FILENAME } from "./worktree-marker";

const SECTION = "leftovers" as const;
export const STALE_WORKTREES_META = {
  id: "leftovers-worktrees",
  section: SECTION,
  title: "Stale worktrees",
} as const;
const GIT_TIMEOUT_MS = 5000;

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

  const ownersByPath = new Map<string, PipelineState[]>();
  for (const s of states) {
    if (s.worktree === undefined) continue;
    const key = real(s.worktree);
    ownersByPath.set(key, [...(ownersByPath.get(key) ?? []), s]);
  }

  const checks: DoctorCheck[] = [];
  const seenPrimaries = new Set<string>();
  for (const [repo, slug] of repos) {
    const list = fs.existsSync(repo)
      ? deps.run("git", ["-C", repo, "worktree", "list", "--porcelain"], {
          timeoutMs: GIT_TIMEOUT_MS,
        })
      : null;
    if (list === null || list.status !== 0 || list.timedOut) {
      const gone = list === null;
      checks.push({
        id: `leftovers-worktrees:unreadable-${checks.length}`,
        section: SECTION,
        title: "Worktree scan",
        status: "warn",
        summary: `could not inspect repo at ${repo}`,
        details: [
          gone
            ? "the recorded repo path no longer exists"
            : "git worktree list failed or timed out, so no worktree was judged stale",
        ],
        fix: gone
          ? slug === ""
            ? undefined
            : `flow done ${slug}`
          : `git -C ${shq(repo)} worktree list`,
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
      const owners = ownersByPath.get(real(e.path)) ?? [];
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
      ...STALE_WORKTREES_META,
      status: "pass",
      summary: `no stale worktrees in ${seenPrimaries.size} repo(s)`,
      details: [],
    });
  }
  return checks;
}
