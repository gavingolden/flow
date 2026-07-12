/**
 * File-signal process liveness: was the process recorded at launch
 * (`PipelineState.pid` / `procStartedAt`, see `bin/lib/state.ts`) still the
 * one running, or has it crashed / been replaced by an unrelated process
 * that reused the same PID?
 *
 * Why a start-time pair instead of a bare PID: PIDs are recycled by the OS,
 * so "is `pid` alive" alone can't distinguish the original process from a
 * later, unrelated one that happens to reuse the same number. Pairing the
 * PID with its start time (read once at launch, re-read on every liveness
 * check) closes that gap — a mismatch means the PID was recycled.
 */

import type { PipelineState } from "./state";

export type Liveness = "alive" | "dead" | "stale" | "unknown";

export type PidStartEpochDeps = {
  /**
   * Full `ps` invocation seam. Given a pid and the (already LC_ALL=C
   * pinned) child env to invoke it with, returns the raw `ps -o lstart=`
   * stdout, or null when the pid has no matching process / `ps` fails.
   * Tests inject a fixture string (or a recording spy, to assert the env
   * `pidStartEpoch` builds) instead of spawning a real `ps`.
   */
  spawnPs?: (pid: number, env: NodeJS.ProcessEnv) => string | null;
};

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

// `ps -o lstart=` format under an English/POSIX locale (LC_ALL=C):
// "Www Mmm  d hh:mm:ss yyyy" — e.g. "Thu Jul  9 14:16:50 2026" (note the
// double space before a single-digit day). A non-English locale renders
// different weekday/month names and fails this pattern, so `parseLstart`
// returns null rather than mis-parsing.
const LSTART_RE =
  /^\w{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/;

function parseLstart(raw: string): number | null {
  const m = LSTART_RE.exec(raw.trim());
  if (!m) return null;
  const [, monAbbr, dayStr, hh, mm, ss, yyyy] = m;
  const month = MONTHS[monAbbr];
  if (month === undefined) return null;
  // `lstart` reports the process start time in the host's LOCAL timezone
  // (not UTC), so building the Date from local components — rather than
  // `Date.UTC` — reproduces the same instant on this same host regardless
  // of its timezone offset.
  const d = new Date(
    Number(yyyy),
    month,
    Number(dayStr),
    Number(hh),
    Number(mm),
    Number(ss),
  );
  if (Number.isNaN(d.getTime())) return null;
  // One-second resolution: `lstart` has no sub-second precision, so a PID
  // recycled by a different process that happens to start within the same
  // wall-clock second as the original would false-match here.
  return Math.floor(d.getTime() / 1000);
}

function defaultSpawnPs(pid: number, env: NodeJS.ProcessEnv): string | null {
  const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  if (r.exitCode !== 0) return null;
  const out = r.stdout.toString().trim();
  return out.length > 0 ? out : null;
}

/**
 * The epoch-seconds start time of `pid`, or null when the pid is absent or
 * its `ps` output is unparseable (including a non-English locale leaking
 * through despite the LC_ALL=C pin). LC_ALL=C is pinned in the spawned
 * child's env only — built as a fresh object layered over `process.env`,
 * never mutating the parent process's own env — because `ps`'s `lstart`
 * format is locale-dependent (month/weekday names) and the parser above
 * only understands the English form. Deliberately parsed in TypeScript
 * rather than shelled out to `date`, whose flag set differs between BSD
 * (macOS) and GNU (Linux) coreutils.
 */
export function pidStartEpoch(
  pid: number,
  deps: PidStartEpochDeps = {},
): number | null {
  const spawnPs = deps.spawnPs ?? defaultSpawnPs;
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  const raw = spawnPs(pid, env);
  if (raw === null) return null;
  return parseLstart(raw);
}

/**
 * Local reimplementation of the ESRCH/EPERM 3-way process-existence probe.
 * Mirrors `lock.ts`'s private `isProcessAlive` for reference (not
 * imported — it's unexported there), and deliberately does NOT reuse
 * `tmux.ts`'s private `pidIsAlive`, which collapses ESRCH and EPERM into a
 * single `false` and would misclassify a permission-denied-but-alive
 * process (owned by another user) as dead.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw e;
  }
}

export type LivenessDeps = {
  /** Process-existence probe seam — defaults to the local ESRCH/EPERM check. */
  isAlive?: (pid: number) => boolean;
  /** Start-time probe seam — defaults to the real `pidStartEpoch`. */
  pidStartEpoch?: (pid: number, deps?: PidStartEpochDeps) => number | null;
};

/**
 * Classifies a state's recorded process against reality:
 *   - `unknown` — `pid` or `procStartedAt` absent (old-format state file,
 *     or a launch that predates this signal). Callers degrade to legacy
 *     window-existence-based behavior in this case.
 *   - `stale`   — the pid is not alive (process exited / crashed).
 *   - `dead`    — the pid IS alive, but its current start time doesn't
 *     match the recorded one — the OS recycled the pid onto an unrelated
 *     process.
 *   - `alive`   — the pid is alive and its start time matches.
 */
export function livenessOf(
  state: Pick<PipelineState, "pid" | "procStartedAt">,
  deps: LivenessDeps = {},
): Liveness {
  if (state.pid === undefined || state.procStartedAt === undefined) {
    return "unknown";
  }
  const isAlive = deps.isAlive ?? isProcessAlive;
  const getStartEpoch = deps.pidStartEpoch ?? pidStartEpoch;
  if (!isAlive(state.pid)) return "stale";
  const currentStart = getStartEpoch(state.pid);
  if (currentStart !== state.procStartedAt) return "dead";
  return "alive";
}

/** Convenience predicate: true only for the `alive` verdict. */
export function isLive(
  state: Pick<PipelineState, "pid" | "procStartedAt">,
  deps: LivenessDeps = {},
): boolean {
  return livenessOf(state, deps) === "alive";
}
