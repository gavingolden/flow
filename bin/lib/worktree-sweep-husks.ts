/**
 * Leftover-folder scan: `<repo>-*` directories (beside the repo or in its
 * `flow-worktrees.noindex` container) with no `.git` entry,
 * walked without following symlinks, with the facts the husk rules need.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isUnderPath } from "./worktree-orphans";
import { canonicalizeWorktree } from "./worktree-orphans-ps";
import { FINISHED_PHASE_SET } from "./state";
import { WORKTREE_CONTAINER_NAME, worktreeContainerDir } from "./worktree-slot";
import { listWorktrees, type FactDeps } from "./worktree-sweep-facts";
import { HUSK_SCAN_CAP, type HuskFacts } from "./worktree-sweep-rules";
import type { UsageIndex } from "./worktree-sweep-usage";

type Walk = {
  files: string[];
  topLevel: string[];
  truncated: boolean;
  newestMtimeMs: number;
};

/** Walks without following symlinks; mtime is the max over files AND every directory (root included) so a just-created empty folder is "recent". */
function walk(root: string): Walk {
  const out: Walk = {
    files: [],
    topLevel: [],
    truncated: false,
    newestMtimeMs: 0,
  };
  const touch = (p: string) => {
    try {
      out.newestMtimeMs = Math.max(out.newestMtimeMs, fs.lstatSync(p).mtimeMs);
    } catch {
      // vanished mid-scan
    }
  };
  touch(root);
  let seen = 0;
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > HUSK_SCAN_CAP) {
        out.truncated = true;
        return out;
      }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (rel === "") out.topLevel.push(e.name);
      touch(path.join(root, r));
      if (e.isDirectory()) stack.push(r);
      else out.files.push(r);
    }
  }
  return out;
}

const exists = (p: string): boolean => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

export function gatherHuskFacts(
  repos: string[],
  deps: FactDeps,
  usage: UsageIndex,
): HuskFacts[] {
  const registered = new Set<string>();
  for (const repo of repos) {
    for (const e of listWorktrees(repo, deps) ?? []) {
      registered.add(canonicalizeWorktree(e.path));
    }
  }
  const reserved = new Set<string>();
  for (const s of deps.listStates()) {
    const lv = deps.liveness(s);
    const active =
      lv === "alive" ||
      deps.windowOpen(s.slug) ||
      (lv === "unknown" && !FINISHED_PHASE_SET.has(s.phase));
    if (!active) continue;
    for (const p of [s.worktree, s.reservedWorktree]) {
      if (p) reserved.add(canonicalizeWorktree(p));
    }
  }

  const launchDir = canonicalizeWorktree(deps.cwd);
  const seen = new Set<string>();
  const out: HuskFacts[] = [];
  for (const repo of repos) {
    const prefix = `${path.basename(repo)}-`;
    for (const root of [path.dirname(repo), worktreeContainerDir(repo)]) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(root);
      } catch {
        continue;
      }
      for (const name of names.filter(
        (n) => n.startsWith(prefix) && n !== WORKTREE_CONTAINER_NAME,
      )) {
        const dir = path.join(root, name);
        let st: fs.Stats;
        try {
          st = fs.lstatSync(dir);
        } catch {
          continue;
        }
        if (!st.isDirectory() || exists(path.join(dir, ".git"))) continue;
        const canon = canonicalizeWorktree(dir);
        if (seen.has(canon)) continue;
        seen.add(canon);
        const w = walk(dir);
        out.push({
          path: canon,
          repo,
          files: w.files,
          topLevel: w.topLevel,
          scanTruncated: w.truncated,
          newestMtimeMs: w.newestMtimeMs,
          nowMs: deps.nowMs(),
          registered: registered.has(canon),
          reservedByActive: reserved.has(canon),
          processesInside: usage.processesInside(canon),
          processesUnknown: usage.processesSkipped !== undefined,
          containsLaunchDir: isUnderPath(launchDir, canon),
          containersMounting: usage.containersUnknown
            ? "unknown"
            : usage.containersMounting(canon),
        });
      }
    }
  }
  return out;
}
