/**
 * Pure selection of leftover processes a pipeline owns, behind the worktree
 * sweep (`worktree-orphans-run.ts` reads the process table and signals).
 *
 * A leftover is a root whose parent is gone (PPID 1), same user, no
 * terminal, not recorded by `flow-spawn`, and whose process-group leader —
 * the Bash-tool shell that started it — has exited. Its owner is the
 * pipeline whose worktree is the longest path prefix of the root's working
 * directory. Command lines are never used for ownership: the supervisor's own
 * argv names its worktree.
 *
 * Browser and MCP-server shapes are excluded outright: the process-lifecycle
 * epic allows SIGTERM only for them, and the existing stray sweeps own them.
 */

export type OrphanProc = {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  tty: string | null;
  ageSec: number;
  cpuSec: number;
  command: string;
  cwd: string | null;
};

export type OwnedOrphan = {
  pid: number;
  pgid: number;
  ageSec: number;
  groupCpuRatio: number;
  busy: boolean;
  command0: string;
  descendants: number[];
};

export const BUSY_MIN_AGE_SEC = 120;
export const BUSY_MIN_CPU_RATIO = 0.25;

const PROTECTED_BINARY =
  /(?:^|\/)(?:google chrome|chromium(?:-browser)?|chrome)(?: helper(?: \([^)]*\))?)?(?=\s|$)/i;

export function isProtectedCommand(command: string): boolean {
  return (
    command.includes("chrome-devtools-mcp") ||
    command.includes("--user-data-dir") ||
    PROTECTED_BINARY.test(command)
  );
}

export function isUnderPath(p: string, root: string): boolean {
  return p === root || p.startsWith(root + "/");
}

/** Longest-prefix worktree owning `cwd`, or null (unreadable or outside all). */
export function ownerOf(
  cwd: string | null,
  worktrees: string[],
): string | null {
  if (cwd === null) return null;
  let best: string | null = null;
  for (const w of worktrees) {
    if (!isUnderPath(cwd, w)) continue;
    if (best === null || w.length > best.length) best = w;
  }
  return best;
}

export function leaderDead(proc: OrphanProc, livePids: Set<number>): boolean {
  return proc.pgid !== proc.pid && !livePids.has(proc.pgid);
}

export function commandZero(command: string): string {
  const first = command.trimStart().split(/\s+/, 1)[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1);
}

/** Roots only; the busy gate runs later, on the group sum with descendants. */
export function prefilterCandidates(
  procs: OrphanProc[],
  opts: {
    selfUid: number;
    registeredPids: Set<number>;
    registeredPgids: Set<number>;
    busyOnly: boolean;
  },
): OrphanProc[] {
  const live = new Set(procs.map((p) => p.pid));
  return procs.filter(
    (p) =>
      p.ppid === 1 &&
      p.uid === opts.selfUid &&
      p.tty === null &&
      !opts.registeredPids.has(p.pid) &&
      !opts.registeredPgids.has(p.pgid) &&
      !isProtectedCommand(p.command) &&
      leaderDead(p, live) &&
      // The oldest member of a group is its root; a younger root cannot make
      // the group old enough to be busy.
      (!opts.busyOnly || p.ageSec >= BUSY_MIN_AGE_SEC),
  );
}

function childrenIndex(table: OrphanProc[]): Map<number, OrphanProc[]> {
  const idx = new Map<number, OrphanProc[]>();
  for (const p of table) {
    const list = idx.get(p.ppid);
    if (list) list.push(p);
    else idx.set(p.ppid, [p]);
  }
  return idx;
}

function descendantsOf(
  root: OrphanProc,
  idx: Map<number, OrphanProc[]>,
): OrphanProc[] {
  const out: OrphanProc[] = [];
  const seen = new Set<number>([root.pid]);
  const stack = [root.pid];
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    for (const c of idx.get(cur) ?? []) {
      if (seen.has(c.pid) || isProtectedCommand(c.command)) continue;
      seen.add(c.pid);
      out.push(c);
      stack.push(c.pid);
    }
  }
  return out;
}

export type GroupStat = { ageSec: number; ratio: number; busy: boolean };

/** Per-pgid busy verdict over the summed CPU of every root and descendant. */
export function groupStats(
  roots: OrphanProc[],
  table: OrphanProc[],
): Map<number, GroupStat> {
  const idx = childrenIndex(table);
  const sums = new Map<number, { cpu: number; age: number }>();
  for (const r of roots) {
    const members = [r, ...descendantsOf(r, idx)];
    const cur = sums.get(r.pgid) ?? { cpu: 0, age: 0 };
    for (const m of members) cur.cpu += m.cpuSec;
    cur.age = Math.max(cur.age, r.ageSec);
    sums.set(r.pgid, cur);
  }
  const out = new Map<number, GroupStat>();
  for (const [pgid, { cpu, age }] of sums) {
    const ratio = age > 0 ? cpu / age : 0;
    out.set(pgid, {
      ageSec: age,
      ratio,
      busy: age >= BUSY_MIN_AGE_SEC && ratio >= BUSY_MIN_CPU_RATIO,
    });
  }
  return out;
}

/**
 * `candidates` are the prefiltered roots (cwd filled where it was read);
 * `table` is the full process table used to attach live descendants.
 */
export function selectWorktreeOrphans(
  candidates: OrphanProc[],
  table: OrphanProc[],
  opts: { worktree: string; allWorktrees: string[] },
): OwnedOrphan[] {
  const stats = groupStats(candidates, table);
  const idx = childrenIndex(table);
  const out: OwnedOrphan[] = [];
  for (const r of candidates) {
    if (ownerOf(r.cwd, opts.allWorktrees) !== opts.worktree) continue;
    const g = stats.get(r.pgid) as GroupStat;
    out.push({
      pid: r.pid,
      pgid: r.pgid,
      ageSec: r.ageSec,
      groupCpuRatio: g.ratio,
      busy: g.busy,
      command0: commandZero(r.command),
      descendants: descendantsOf(r, idx).map((d) => d.pid),
    });
  }
  return out;
}
