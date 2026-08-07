/**
 * Pure read/classify layer for the host-wide process-registry sweep: owns
 * registry enumeration and the B4 positive-evidence dead-session criterion.
 * No signals, no spawning — `bin/lib/proc-sweep-run.ts` is the only
 * consumer, and it reaches the kill engine exclusively through
 * `bin/lib/reap.ts`'s existing `runRegistryReap` (that module's `verifyRow`
 * refusal ladder is frozen destructive-action code; this module adds
 * selection UPSTREAM of it, never a permissive arm inside it).
 */

import * as fs from "node:fs";
import { procsDir, type ProcRegistryRow } from "./proc-registry";
import { isValidSlug } from "./slug";
import { readState as defaultReadState, type PipelineState } from "./state";
import {
  livenessOf as defaultLivenessOf,
  pidStartEpoch as defaultPidStartEpoch,
  type Liveness,
  type LivenessDeps,
  type PidStartEpochDeps,
} from "./liveness";

export type SessionVerdict = "alive" | "dead" | "unknown";

export type SweepDeps = {
  readState?: (slug: string) => PipelineState | null;
  livenessOf?: typeof defaultLivenessOf;
  livenessDeps?: LivenessDeps;
};

/**
 * Enumerates every `*.jsonl` basename (slug portion, extension stripped)
 * under `procsDir(baseDir)` that passes `isValidSlug`. Copies the
 * enumeration shape of `listStates` (`bin/lib/state.ts:661`) — readdirSync +
 * withFileTypes + try/catch -> [] — never throws, returns [] on a
 * missing/unreadable directory.
 */
export function listRegistrySlugs(baseDir?: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(procsDir(baseDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const slugs: string[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const slug = e.name.replace(/\.jsonl$/, "");
    if (isValidSlug(slug)) slugs.push(slug);
  }
  return slugs;
}

/** Real process-existence probe local reimplementation — mirrors
 * `bin/lib/liveness.ts`'s private `isProcessAlive` (ESRCH -> false, EPERM ->
 * true). Not imported: that module documents this exact
 * local-reimplementation-over-import precedent for its own reasons (it
 * deliberately doesn't reuse `tmux.ts`'s private `pidIsAlive` either). Used
 * here only as `ownPidAlive`'s fallback when no `livenessDeps.isAlive`
 * override is supplied. */
function defaultIsAlive(pid: number): boolean {
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

/**
 * Wraps `base` in a per-call cache keyed by pid so `pidStartEpoch` — the
 * only call in `livenessOf`'s path that forks a real `ps` (`isAlive` is a
 * bare, fork-free `process.kill(pid, 0)`) — runs at most ONCE per distinct
 * pid across an entire `selectDeadSessionRows` sweep, rather than once per
 * row. `isAlive` is passed through unmemoized: it never forks, so there is
 * nothing to batch.
 */
function batchedLivenessDeps(base: LivenessDeps | undefined): LivenessDeps {
  const epochFn = base?.pidStartEpoch ?? defaultPidStartEpoch;
  const epochCache = new Map<number, number | null>();
  return {
    isAlive: base?.isAlive,
    pidStartEpoch: (pid: number, deps?: PidStartEpochDeps) => {
      if (!epochCache.has(pid)) epochCache.set(pid, epochFn(pid, deps));
      return epochCache.get(pid) ?? null;
    },
  };
}

export type UnknownReason =
  | "no-state-file"
  | "wrapper-unreadable"
  | "state-unknown";

export type ClassifiedRow = {
  row: ProcRegistryRow;
  verdict: SessionVerdict;
  stateVerdict: Liveness;
  wrapperVerdict: Liveness;
  ownPidAlive: boolean;
  reason?: UnknownReason;
};

/**
 * Classifies one registry row against two independent liveness channels and
 * applies the POSITIVE-EVIDENCE RULE (Decision B4).
 */
function classify(
  row: ProcRegistryRow,
  deps: SweepDeps | undefined,
  livenessDeps: LivenessDeps | undefined,
): ClassifiedRow {
  const readState = deps?.readState ?? defaultReadState;
  const liveness = deps?.livenessOf ?? defaultLivenessOf;
  const isAlive = livenessDeps?.isAlive ?? defaultIsAlive;

  const state = readState(row.slug);
  const stateVerdict = liveness(state ?? {}, livenessDeps);
  const wrapperVerdict = liveness(
    {
      pid: row.sessionPid ?? undefined,
      procStartedAt: row.sessionStartEpoch ?? undefined,
    },
    livenessDeps,
  );
  const ownPidAlive = isAlive(row.pid);

  let verdict: SessionVerdict;
  if (stateVerdict === "alive" || wrapperVerdict === "alive") {
    // Either channel may veto a "dead"/"unknown" state-only reading — an
    // alive wrapper (or an alive recorded state pid) is positive evidence
    // the session is still running.
    verdict = "alive";
  } else if (stateVerdict === "dead" || stateVerdict === "stale") {
    // The state channel is the ONLY channel that can positively establish
    // death (wrapperVerdict has already been confirmed not "alive" above,
    // by the branch order — it can only veto, never confirm).
    verdict = "dead";
  } else {
    // stateVerdict === "unknown" — no state file, or a state file with no
    // pid/procStartedAt signal. Absence of session evidence must NEVER be
    // read as evidence of session death, no matter how dead the wrapper
    // channel looks (see the LOAD-BEARING note below).
    verdict = "unknown";
  }

  let reason: UnknownReason | undefined;
  if (verdict === "unknown") {
    if (state === null) {
      reason = "no-state-file";
    } else if (row.sessionPid === null) {
      reason = "wrapper-unreadable";
    } else {
      reason = "state-unknown";
    }
  }

  return { row, verdict, stateVerdict, wrapperVerdict, ownPidAlive, reason };
}

/**
 * Computes one registry row's session verdict against TWO independent
 * channels — the pipeline's own state file, and the flow-spawn wrapper's
 * recorded pid — via the POSITIVE-EVIDENCE RULE (Decision B4):
 *
 *   - "alive" if EITHER channel is "alive" (either channel may veto);
 *   - "dead" ONLY IF the state channel is "dead" or "stale" AND the wrapper
 *     channel is not "alive". The state channel is the ONLY channel that
 *     can positively establish death; the wrapper channel can only veto.
 *   - "unknown" in every other case — INCLUDING a state verdict of
 *     "unknown" (no state file: a post-`flow done` slug, or a synthetic
 *     `untracked-<pid>-<ms>` slug), REGARDLESS of how dead the wrapper
 *     looks.
 *
 * LOAD-BEARING: `bin/flow-spawn.ts:208` records `sessionPid` as the
 * flow-spawn WRAPPER's own pid (and `:325` awaits `child.exited`, so the
 * wrapper's death does not imply the recording session died). A rule of the
 * form "neither channel alive AND at least one dead" would classify
 * state=unknown + wrapper=dead as dead — the B1 hole re-opened for every
 * untracked-* row and every post-`flow done` row. A live session whose
 * wrapper was killed while its detached child survived would be selected
 * and signalled. Absence of session evidence must NEVER be read as evidence
 * of session death.
 *
 * NOTE the counter-intuitive `Liveness` semantics (`bin/lib/liveness.ts`):
 * `stale` = pid not alive; `dead` = pid alive but start-time mismatch (a
 * recycled pid). The `Liveness` union is
 * `"alive" | "dead" | "stale" | "unknown"`.
 */
export function sessionVerdictFor(
  row: ProcRegistryRow,
  deps?: SweepDeps,
): SessionVerdict {
  return classify(row, deps, deps?.livenessDeps).verdict;
}

/**
 * Partitions every row into `dead` / `alive` / `unknown` buckets via
 * `sessionVerdictFor`'s B4 rule, batching the (fork-costly) `pidStartEpoch`
 * probe across the whole call — see `batchedLivenessDeps`. Every returned
 * row carries both channel verdicts, its own pid's liveness, and (for the
 * `unknown` bucket) the specific reason it could not be classified, so a
 * report can explain each non-action rather than silently listing it.
 */
export function selectDeadSessionRows(
  rows: ProcRegistryRow[],
  deps?: SweepDeps,
): { dead: ClassifiedRow[]; alive: ClassifiedRow[]; unknown: ClassifiedRow[] } {
  const livenessDeps = batchedLivenessDeps(deps?.livenessDeps);
  const dead: ClassifiedRow[] = [];
  const alive: ClassifiedRow[] = [];
  const unknown: ClassifiedRow[] = [];
  for (const row of rows) {
    const classified = classify(row, deps, livenessDeps);
    if (classified.verdict === "dead") dead.push(classified);
    else if (classified.verdict === "alive") alive.push(classified);
    else unknown.push(classified);
  }
  return { dead, alive, unknown };
}
