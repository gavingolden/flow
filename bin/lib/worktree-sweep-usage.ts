/**
 * The once-per-run usage index: processes with a working directory inside a
 * path, and Docker containers bind-mounting a path. Both readers fail closed:
 * an unreadable process table or Docker is a named skip the rules turn into a
 * hold, never "nothing is using it".
 */

import * as path from "node:path";
import { isUnderPath } from "./worktree-orphans";
import type { OrphanProc } from "./worktree-orphans";
import {
  canonicalizeWorktree,
  listOrphanProcs,
  readCwds as readCwdsFromHost,
} from "./worktree-orphans-ps";
import type { FactDeps } from "./worktree-sweep-facts";
import type { ProcFact } from "./worktree-sweep-rules";

export type ContainerMount = { container: string; sources: string[] };

export type UsageIndex = {
  processesInside(p: string): ProcFact[];
  containersMounting(p: string): string[];
  mounts: ContainerMount[];
  dockerSkipped?: "docker-not-installed" | "docker-unresponsive";
  processesSkipped?: "ps-unavailable" | "lsof-unavailable";
};

/** Default process-table reader; `undefined` under Node/vitest or on `ps` failure. */
export const defaultListProcs = (): OrphanProc[] | undefined =>
  listOrphanProcs();

/** `lsof` failure is indistinguishable from "no processes" in the host reader, so an empty answer for a non-empty pid list counts as a failure. */
export const defaultReadCwds = (
  pids: number[],
): Map<number, string> | undefined => {
  const m = readCwdsFromHost(pids);
  return pids.length > 0 && m.size === 0 ? undefined : m;
};

function ancestorsOf(procs: OrphanProc[], pids: number[]): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p.ppid]));
  const out = new Set(pids);
  for (const pid of pids) {
    let cur = byPid.get(pid);
    while (cur !== undefined && cur > 1 && !out.has(cur)) {
      out.add(cur);
      cur = byPid.get(cur);
    }
  }
  return out;
}

function readMounts(deps: FactDeps): {
  mounts: ContainerMount[];
  skipped?: UsageIndex["dockerSkipped"];
} {
  const ps = deps.run("docker", ["ps", "-q"], { timeoutMs: 5_000 });
  if (ps.timedOut) return { mounts: [], skipped: "docker-unresponsive" };
  if (ps.status === null)
    return { mounts: [], skipped: "docker-not-installed" };
  if (ps.status !== 0) return { mounts: [], skipped: "docker-unresponsive" };
  const ids = ps.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (ids.length === 0) return { mounts: [] };
  const fmt =
    '{{.Name}} {{range .Mounts}}{{if eq .Type "bind"}}{{.Source}} {{end}}{{end}}';
  const insp = deps.run("docker", ["inspect", "--format", fmt, ...ids], {
    timeoutMs: 5_000,
  });
  if (insp.status !== 0 || insp.timedOut) {
    return { mounts: [], skipped: "docker-unresponsive" };
  }
  const mounts = insp.stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/).filter(Boolean))
    .filter((parts) => parts.length > 0)
    .map(([name, ...sources]) => ({
      container: name.replace(/^\//, ""),
      sources,
    }));
  return { mounts };
}

export function buildUsageIndex(deps: FactDeps): UsageIndex {
  const { mounts, skipped } = readMounts(deps);
  const procs = deps.listProcs();
  let processesSkipped: UsageIndex["processesSkipped"];
  let inside: Array<{ proc: OrphanProc; cwd: string }> = [];
  if (!procs) {
    processesSkipped = "ps-unavailable";
  } else {
    const skip = ancestorsOf(procs, deps.selfPids);
    const cwds = deps.readCwds(procs.map((p) => p.pid));
    if (!cwds) {
      processesSkipped = "lsof-unavailable";
    } else {
      inside = procs
        .filter((p) => !skip.has(p.pid) && cwds.has(p.pid))
        .map((proc) => ({
          proc,
          cwd: canonicalizeWorktree(cwds.get(proc.pid) as string),
        }));
    }
  }
  return {
    mounts,
    ...(skipped ? { dockerSkipped: skipped } : {}),
    ...(processesSkipped ? { processesSkipped } : {}),
    processesInside: (p) =>
      inside
        .filter((x) => isUnderPath(x.cwd, p))
        .map((x) => ({
          pid: x.proc.pid,
          command: x.proc.command.split("\n")[0],
        })),
    containersMounting: (p) =>
      mounts
        .filter((m) => m.sources.some((s) => isUnderPath(s, p)))
        .map((m) => m.container),
  };
}

/**
 * Containers bind-mounting a flow-style sibling folder (`<repo>-*` beside a
 * known repo) that no longer exists or is a leftover folder: Docker recreates
 * the folder on start, which is how leftovers keep coming back.
 */
export function danglingContainerMounts(
  usage: UsageIndex,
  repos: string[],
  existing: (p: string) => boolean,
  leftovers: string[],
): Array<{ container: string; source: string }> {
  const siblingRoots = repos.map((r) => ({
    parent: path.dirname(r),
    prefix: `${path.basename(r)}-`,
  }));
  const isSibling = (s: string) =>
    siblingRoots.some((r) => {
      const rel = path.relative(r.parent, s);
      return !rel.startsWith("..") && rel.split("/")[0].startsWith(r.prefix);
    });
  const out: Array<{ container: string; source: string }> = [];
  for (const m of usage.mounts) {
    for (const source of m.sources) {
      if (!isSibling(source)) continue;
      if (!existing(source) || leftovers.some((l) => isUnderPath(source, l))) {
        out.push({ container: m.container, source });
      }
    }
  }
  return out;
}
