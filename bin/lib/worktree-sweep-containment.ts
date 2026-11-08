/**
 * Per-folder proofs the sweep needs before removing a finished worktree:
 * is every local commit already on GitHub, and is any git-ignored local
 * config the only copy. Every subprocess goes through the injected `run`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SYMLINK_FILES } from "./worktree-fs";
import type { SweepRun } from "./worktree-sweep-facts";
import type { PrFact } from "./worktree-sweep-rules";

const ok = (r: ReturnType<SweepRun>): boolean => r.status === 0 && !r.timedOut;

export function defaultBranchOf(
  repo: string,
  run: SweepRun,
): string | undefined {
  const sym = run("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
    cwd: repo,
    timeoutMs: 5_000,
  });
  if (ok(sym) && sym.stdout.trim()) {
    return sym.stdout.trim().replace("refs/remotes/origin/", "");
  }
  for (const name of ["main", "master"]) {
    const r = run(
      "git",
      ["rev-parse", "--verify", `refs/remotes/origin/${name}`],
      {
        cwd: repo,
        timeoutMs: 5_000,
      },
    );
    if (ok(r)) return name;
  }
  return undefined;
}

export type PrIndex = Map<string, PrFact[]> | "unreachable";

export function listPrs(repo: string, run: SweepRun): PrIndex {
  const r = run(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "all",
      "--limit",
      "500",
      "--json",
      "number,state,headRefName,headRefOid,isCrossRepository",
    ],
    { cwd: repo, timeoutMs: 15_000 },
  );
  if (!ok(r)) return "unreachable";
  try {
    const rows = JSON.parse(r.stdout) as Array<{
      number: number;
      state: PrFact["state"];
      headRefName: string;
      headRefOid: string;
      isCrossRepository?: boolean;
    }>;
    const index = new Map<string, PrFact[]>();
    for (const row of rows) {
      // A fork PR can share a branch name with a local branch it has nothing to do with.
      if (row.isCrossRepository === true) continue;
      const list = index.get(row.headRefName) ?? [];
      list.push({
        number: row.number,
        state: row.state,
        headOid: row.headRefOid,
      });
      index.set(row.headRefName, list);
    }
    return index;
  } catch {
    return "unreachable";
  }
}

/**
 * True when HEAD is an ancestor of origin/<default> (fast path, covers a
 * regular merge) or of the PR head commit (covers a squash merge, where the
 * branch tip is never an ancestor of the default branch). A PR head missing
 * locally is fetched once from `refs/pull/<n>/head`.
 */
export function headContained(
  wt: string,
  repo: string,
  defaultBranch: string | undefined,
  pr: { number: number; headOid: string },
  run: SweepRun,
): boolean | "unknown" {
  const isAncestor = (target: string) =>
    run("git", ["merge-base", "--is-ancestor", "HEAD", target], {
      cwd: wt,
      timeoutMs: 10_000,
    });
  if (defaultBranch) {
    const r = isAncestor(`origin/${defaultBranch}`);
    if (ok(r)) return true;
  }
  let r = isAncestor(pr.headOid);
  if (ok(r)) return true;
  if (!r.timedOut && r.status === 1) return false;
  const fetched = run(
    "git",
    ["fetch", "--quiet", "origin", `refs/pull/${pr.number}/head`],
    { cwd: repo, timeoutMs: 20_000 },
  );
  if (!ok(fetched)) return "unknown";
  r = isAncestor(pr.headOid);
  if (ok(r)) return true;
  return !r.timedOut && r.status === 1 ? false : "unknown";
}

function realFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * True when a git-ignored local config file in the worktree is a real
 * (non-symlink) file that is absent from, or differs from, the main
 * checkout's copy: the worktree's copy may be the only one.
 */
export function localConfigDiffers(
  wt: string,
  primary: string,
  run: SweepRun,
): boolean {
  let rootEnv: string[] = [];
  try {
    rootEnv = fs.readdirSync(wt).filter((n) => n.startsWith(".env"));
  } catch {
    return true;
  }
  const rels = [...new Set([...SYMLINK_FILES, ...rootEnv])];
  for (const rel of rels) {
    const local = path.join(wt, rel);
    if (!realFile(local)) continue;
    const ignored = run("git", ["check-ignore", "-q", rel], {
      cwd: wt,
      timeoutMs: 5_000,
    });
    // Exit 1 = not ignored: tracked or visible files are caught by the dirty
    // check. Any other outcome (error, timeout) falls through to the compare.
    if (ignored.status === 1 && !ignored.timedOut) continue;
    try {
      const main = path.join(primary, rel);
      if (!fs.existsSync(main)) return true;
      if (!fs.readFileSync(local).equals(fs.readFileSync(main))) return true;
    } catch {
      return true;
    }
  }
  return false;
}
