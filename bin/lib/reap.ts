/**
 * Registry-driven kill-path reaper: verifies each row recorded in
 * `~/.flow/state/procs/<slug>.jsonl` against the live process table before
 * ever sending a signal, then dispatches a class-specific kill policy.
 *
 * Three "reap" surfaces exist in this codebase and are easy to conflate:
 *   - `bin/lib/reap-orphans.ts` reaps pipeline STATE FILES (`deleteState`)
 *     for supervisors that never got past `starting` — it sends no signals
 *     at all.
 *   - `runOrphanSweep` in `bin/flow-browser-teardown.ts` selects sessionless
 *     browser/MCP-server processes by SHAPE HEURISTICS (ppid 1, argv
 *     signatures, a profile-dir allowlist) — it has no registry to consult.
 *   - THIS module reaps processes recorded as rows in the process registry
 *     (`bin/lib/proc-registry.ts`), verified by pid+pgid+startEpoch
 *     identity rather than shape.
 *
 * Destructive by construction: every verification failure mode — an
 * unverifiable identity, an unreadable process table, an ambiguous group —
 * short-circuits to "do not signal". There is no path where an
 * unverifiable row is signalled "to be safe".
 */

import {
  readRows,
  type ProcClass,
  type ProcRegistryRow,
} from "./proc-registry";

export type ReapOutcome =
  | "reaped"
  | "would-reap"
  | "already-dead"
  | "skipped-epoch-mismatch"
  | "skipped-unsafe-pgid"
  | "skipped-foreign-member"
  | "skipped-dead-leader"
  | "still-alive"
  | "failed"
  | "deadline-exceeded";

export type ReapRowResult = {
  pid: number;
  pgid: number;
  class: ProcClass;
  outcome: ReapOutcome;
  signals: Array<"SIGTERM" | "SIGKILL">;
  error?: string;
};

export type ReapDeps = {
  kill: (target: number, signal: NodeJS.Signals) => void;
  alive: (target: number) => boolean;
  sleepMs: (ms: number) => void;
  startEpochOf: (pid: number) => number | null;
  groupMembers: (pgid: number) => number[] | null;
  nowMs: () => number;
  selfPid: number;
  selfPgid: number | null;
  sessionPgid?: number;
};

export type RowVerdict =
  | { action: "signal" }
  | {
      action: "skip";
      outcome:
        | "already-dead"
        | "skipped-epoch-mismatch"
        | "skipped-unsafe-pgid"
        | "skipped-foreign-member"
        | "skipped-dead-leader";
    };

/** Bounded grace window between SIGTERM and SIGKILL for the `default` class. */
export const GRACE_MS = 5000;
/** Bounded post-SIGKILL wait before a `default`-class row is reported `still-alive`. */
export const KILL_WAIT_MS = 2000;

/**
 * Verifies a row against the live process table. Verification order is
 * FIXED and asymmetric: a row is signalled only when every check below
 * passes, in order — there is no path where an unverifiable row is
 * signalled "to be safe".
 */
export function verifyRow(row: ProcRegistryRow, deps: ReapDeps): RowVerdict {
  // 1. Unsafe-target guard, BEFORE any liveness or epoch work. POSIX
  // kill(2) treats a negative target as "signal every process in that
  // process GROUP", and two negative values are catastrophic: -1 signals
  // EVERY process the caller may signal, and 0 signals the caller's OWN
  // process group. `proc-registry.ts`'s `isValidRow` only type-checks
  // `pgid` as a number — it does not bound it — so a hand-edited or
  // corrupted registry line can legitimately carry 0, 1, or a negative
  // value and reach here. selfPgid/sessionPgid guard against signalling
  // the reaper's own group or the launching session's group; the
  // `class === "default" && selfPgid === null` arm refuses the group path
  // entirely when this process's own pgid could not be determined, since
  // an unknown selfPgid cannot be compared against row.pgid at all.
  if (
    row.pid <= 1 ||
    row.pgid <= 1 ||
    row.pid === deps.selfPid ||
    (deps.selfPgid !== null && row.pgid === deps.selfPgid) ||
    (deps.sessionPgid !== undefined && row.pgid === deps.sessionPgid) ||
    (row.class === "default" && deps.selfPgid === null)
  ) {
    return { action: "skip", outcome: "skipped-unsafe-pgid" };
  }

  // 2. An unverifiable identity (no start time was ever recorded) is never
  // signalled.
  if (row.startEpoch === null) {
    return { action: "skip", outcome: "skipped-epoch-mismatch" };
  }

  // 3. Liveness. A dead LEADER does not by itself prove a dead GROUP: the
  // `default` class's kill target is `-row.pgid` (reap.ts's reapDefaultRow),
  // and a `flow-spawn`ed leader that exits (crash, `npm` wrapper exiting
  // after handing off to its child) leaves surviving descendants in the
  // same group — precisely the reparented-orphan shape this feature exists
  // to close. That case is NOT signalled here (see the note below); it is
  // reported as the distinct, honestly-named `skipped-dead-leader` rather
  // than silently folded into `already-dead`, so the summary line does not
  // claim a leaked group was a clean no-op.
  //
  // Why this stays a refusal rather than becoming a permissive path: once
  // the leader is dead, its recorded `startEpoch` can no longer be
  // re-verified against a live process (step 4 needs a live pid to probe),
  // so the ONLY identity evidence left for the group is the group's own
  // current membership — which the membership check below establishes by
  // start-time ordering against `row.startEpoch`, not by re-proving the
  // leader. That is strictly weaker evidence than the leader-alive case
  // (there is no live leader to bind `row.pid` to `row.pgid` via
  // `members.includes`), so rather than let a weaker verification result in
  // a stronger action (an unattended kill), this path stops at "provably
  // worth a human's attention" and defers the actual signal to a future,
  // deliberately-scoped decision (see PR discussion / deferred[] entry).
  const leaderAlive = deps.alive(row.pid);
  if (!leaderAlive) {
    if (row.class === "default" && deps.alive(-row.pgid)) {
      return { action: "skip", outcome: "skipped-dead-leader" };
    }
    return { action: "skip", outcome: "already-dead" };
  }

  // 4. Epoch match. A null return (ps unavailable) skips every row rather
  // than risk signalling a pid the OS has recycled onto an unrelated
  // process.
  const currentEpoch = deps.startEpochOf(row.pid);
  if (currentEpoch !== row.startEpoch) {
    return { action: "skip", outcome: "skipped-epoch-mismatch" };
  }

  // 5. Group-membership check, DEFAULT CLASS ONLY — mcp-server rows never
  // take the group path, so a contaminated group can never block one.
  //
  // Membership is checked by START-TIME ORDERING against the recorded
  // leader, never by cross-referencing the registry itself. POSIX
  // setpgid(2) already prevents an unrelated process from joining a LIVE
  // group (a process may only set its own pgid, or a child's, within the
  // same session) — so the real contamination shape this guards against is
  // PGID RECYCLING, not foreign processes joining a live group. A registry
  // cross-check would wrongly refuse the legitimate grandchildren the
  // group kill exists to reach: a descendant NEWER than the leader is
  // exactly what a group kill is for, and it is deliberately never
  // required to appear in the registry itself.
  if (row.class === "default") {
    const members = deps.groupMembers(row.pgid);
    if (members === null || members.length === 0) {
      return { action: "skip", outcome: "skipped-foreign-member" };
    }
    // The verified `row.pid` must itself be a current member of the group
    // being signalled — otherwise the identity check above (alive + epoch
    // match on the LEADER) and the group actually reached by `-row.pgid`
    // are never bound together, and a corrupt/hand-edited row pairing a
    // verified decoy pid against an unrelated pgid would pass every guard.
    // Free on every legitimate row: every current writer sets `pgid ===
    // pid`, so the leader is always a member of its own group.
    if (!members.includes(row.pid)) {
      return { action: "skip", outcome: "skipped-foreign-member" };
    }
    for (const memberPid of members) {
      if (memberPid === row.pid) continue; // already verified above
      const memberEpoch = deps.startEpochOf(memberPid);
      if (memberEpoch === null) {
        // The member vanished between the `groupMembers` snapshot and this
        // probe (the snapshot is taken once at CLI start and closed over,
        // while `startEpochOf` forks a fresh `ps` per member — a window up
        // to GRACE_MS + KILL_WAIT_MS per PRECEDING default-class row). A
        // member that merely exited cannot be signalled and cannot be
        // foreign, so it only refuses the row when it is verified to still
        // be ALIVE but unverifiable — an unexplained-but-live member is the
        // case this guard exists for.
        if (deps.alive(memberPid)) {
          return { action: "skip", outcome: "skipped-foreign-member" };
        }
        continue;
      }
      if (memberEpoch < row.startEpoch) {
        return { action: "skip", outcome: "skipped-foreign-member" };
      }
    }
  }

  return { action: "signal" };
}

/** True when `e` is the ESRCH errno — the target no longer exists. */
function isEsrch(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === "ESRCH";
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type SignalOutcome =
  | { ok: true }
  | { ok: false; esrch: true }
  | { ok: false; esrch: false; message: string };

/**
 * Sends one signal and records it in `signals` only on success. An ESRCH
 * thrown here is a benign race — the target exited between verification
 * and the syscall — never a `failed` outcome.
 */
function trySignal(
  deps: ReapDeps,
  target: number,
  signal: "SIGTERM" | "SIGKILL",
  signals: Array<"SIGTERM" | "SIGKILL">,
): SignalOutcome {
  try {
    deps.kill(target, signal);
    signals.push(signal);
    return { ok: true };
  } catch (e) {
    if (isEsrch(e)) return { ok: false, esrch: true };
    return { ok: false, esrch: false, message: errorMessage(e) };
  }
}

/**
 * Polls `deps.alive(target)` in `deps.sleepMs`-sized increments (bounded by
 * `deps.nowMs`) and returns whether the target is STILL alive once the
 * window elapses.
 *
 * `deps.alive` maps EPERM to true (see `flow-browser-teardown.ts`'s
 * `defaultAlive`) — on a group target that becomes a CONTROL-FLOW input
 * here, not merely a report field: a group holding one unsignallable
 * process reports alive forever, so the default class escalates to
 * SIGKILL and then reports `still-alive`. That is bounded and safe (there
 * is no signal past SIGKILL to escalate to), and it is a named tested
 * case below.
 */
function stillAliveAfterWait(
  deps: ReapDeps,
  target: number,
  windowMs: number,
): boolean {
  const deadline = deps.nowMs() + windowMs;
  let alive = deps.alive(target);
  while (alive && deps.nowMs() < deadline) {
    deps.sleepMs(200);
    alive = deps.alive(target);
  }
  return alive;
}

function reapDefaultRow(
  row: ProcRegistryRow,
  deps: ReapDeps,
  opts: ReapOptions,
): ReapRowResult {
  const signals: Array<"SIGTERM" | "SIGKILL"> = [];
  const base = { pid: row.pid, pgid: row.pgid, class: row.class };
  // NEGATIVE target: signals the whole process GROUP, never the leader pid
  // alone.
  const target = -row.pgid;

  const term = trySignal(deps, target, "SIGTERM", signals);
  if (!term.ok) {
    return term.esrch
      ? { ...base, outcome: "already-dead", signals }
      : { ...base, outcome: "failed", signals, error: term.message };
  }

  if (!stillAliveAfterWait(deps, target, opts.graceMs ?? GRACE_MS)) {
    return { ...base, outcome: "reaped", signals };
  }

  const kill = trySignal(deps, target, "SIGKILL", signals);
  if (!kill.ok) {
    return kill.esrch
      ? { ...base, outcome: "reaped", signals }
      : { ...base, outcome: "failed", signals, error: kill.message };
  }

  const stillAlive = stillAliveAfterWait(
    deps,
    target,
    opts.killWaitMs ?? KILL_WAIT_MS,
  );
  return { ...base, outcome: stillAlive ? "still-alive" : "reaped", signals };
}

/**
 * mcp-server class: exactly one SIGTERM to the POSITIVE pid, never a
 * negative (group) target, and NEVER escalated — a harder signal or a
 * group kill skips the server's own `shutdown()` handler and orphans
 * Chrome (the PR #491 failure mode `flow-browser-teardown.ts`'s header
 * documents).
 */
function reapMcpServerRow(
  row: ProcRegistryRow,
  deps: ReapDeps,
  opts: ReapOptions,
): ReapRowResult {
  const signals: Array<"SIGTERM" | "SIGKILL"> = [];
  const base = { pid: row.pid, pgid: row.pgid, class: row.class };
  const target = row.pid; // POSITIVE — never the group.

  const term = trySignal(deps, target, "SIGTERM", signals);
  if (!term.ok) {
    return term.esrch
      ? { ...base, outcome: "already-dead", signals }
      : { ...base, outcome: "failed", signals, error: term.message };
  }

  const stillAlive = stillAliveAfterWait(
    deps,
    target,
    opts.graceMs ?? GRACE_MS,
  );
  return { ...base, outcome: stillAlive ? "still-alive" : "reaped", signals };
}

export type ReapOptions = {
  dryRun: boolean;
  graceMs?: number;
  killWaitMs?: number;
  /**
   * Aggregate wall-clock budget for `runRegistryReap`'s whole per-slug pass
   * (NOT per-row — `graceMs`/`killWaitMs` above already bound a single
   * `default`-class row's SIGTERM→SIGKILL window). Without this, N `default`
   * rows ahead of a slow one in the same registry file can stall the
   * process's terminal state for up to N × (GRACE_MS + KILL_WAIT_MS) ≈ N ×
   * 7s. `reapRow` itself is unaware of this budget (it has no loop to
   * bound); only `runRegistryReap`'s row loop reads it. Injectable here
   * (rather than hardcoded) so tests can exercise the cap in milliseconds,
   * not real wall-clock seconds.
   */
  registryDeadlineMs?: number;
};

/** Default aggregate wall-clock budget for one `runRegistryReap` pass. See
 * `ReapOptions.registryDeadlineMs`. */
export const DEFAULT_REGISTRY_DEADLINE_MS = 30_000;

/**
 * Verifies then, on a `signal` verdict, dispatches by `row.class`. Under
 * `opts.dryRun`, a `signal` verdict reports `would-reap` with an empty
 * `signals` array and sends ZERO kill calls; a `skip` verdict reports its
 * skip outcome unchanged.
 */
export function reapRow(
  row: ProcRegistryRow,
  deps: ReapDeps,
  opts: ReapOptions,
): ReapRowResult {
  const verdict = verifyRow(row, deps);
  const base = { pid: row.pid, pgid: row.pgid, class: row.class };

  if (verdict.action === "skip") {
    return { ...base, outcome: verdict.outcome, signals: [] };
  }

  if (opts.dryRun) {
    return { ...base, outcome: "would-reap", signals: [] };
  }

  return row.class === "mcp-server"
    ? reapMcpServerRow(row, deps, opts)
    : reapDefaultRow(row, deps, opts);
}

export type RegistryReapResult = {
  ran: boolean;
  dryRun: boolean;
  slug?: string;
  skipReason?: "no-slug" | "no-rows";
  rows: ReapRowResult[];
  counts: Record<ReapOutcome, number>;
  malformed: number;
};

function zeroCounts(): Record<ReapOutcome, number> {
  return {
    reaped: 0,
    "would-reap": 0,
    "already-dead": 0,
    "skipped-epoch-mismatch": 0,
    "skipped-unsafe-pgid": 0,
    "skipped-foreign-member": 0,
    "skipped-dead-leader": 0,
    "still-alive": 0,
    failed: 0,
    "deadline-exceeded": 0,
  };
}

/**
 * Orchestrates a full-registry reap for one slug: resolves rows via
 * `readRows` (or an injected override), then maps every row through
 * `reapRow`, aggregating outcome counts.
 */
export function runRegistryReap(
  slug: string | undefined,
  deps: ReapDeps,
  opts: ReapOptions & { baseDir?: string; readRows?: typeof readRows },
): RegistryReapResult {
  if (slug === undefined) {
    return {
      ran: false,
      dryRun: opts.dryRun,
      skipReason: "no-slug",
      rows: [],
      counts: zeroCounts(),
      malformed: 0,
    };
  }

  const read = opts.readRows ?? readRows;
  const { rows, malformed } = read(slug, opts.baseDir);

  if (rows.length === 0) {
    return {
      ran: false,
      dryRun: opts.dryRun,
      slug,
      skipReason: "no-rows",
      rows: [],
      counts: zeroCounts(),
      malformed,
    };
  }

  const deadline =
    deps.nowMs() + (opts.registryDeadlineMs ?? DEFAULT_REGISTRY_DEADLINE_MS);
  const counts = zeroCounts();
  const results: ReapRowResult[] = [];
  for (const row of rows) {
    // Rows not reached before the aggregate deadline get an honest,
    // distinct outcome — never silently dropped from `results`/`counts`,
    // and never signalled without having gone through `verifyRow`.
    if (deps.nowMs() >= deadline) {
      const result: ReapRowResult = {
        pid: row.pid,
        pgid: row.pgid,
        class: row.class,
        outcome: "deadline-exceeded",
        signals: [],
      };
      results.push(result);
      counts[result.outcome]++;
      continue;
    }
    const result = reapRow(row, deps, opts);
    results.push(result);
    counts[result.outcome]++;
  }

  return {
    ran: true,
    dryRun: opts.dryRun,
    slug,
    rows: results,
    counts,
    malformed,
  };
}
