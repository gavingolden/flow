/**
 * Orchestrates a host-wide (or `--slug`-scoped) process-registry sweep over
 * `bin/lib/proc-sweep.ts`'s selection, reaching the kill engine ONLY through
 * `bin/lib/reap.ts`'s existing `runRegistryReap` via its `opts.readRows`
 * seam. Adds no kill code of its own — `bin/lib/reap.ts` is frozen
 * destructive-action code; this module adds selection UPSTREAM of its
 * `verifyRow` refusal ladder, never a permissive arm inside it.
 */

import { compact, readRows } from "./proc-registry";
import {
  runRegistryReap,
  type ReapDeps,
  type ReapOutcome,
  type RegistryReapResult,
} from "./reap";
import {
  listRegistrySlugs,
  selectDeadSessionRows,
  type ClassifiedRow,
  type SweepDeps,
} from "./proc-sweep";

/** Sweep-level aggregate wall-clock budget, shared across every enumerated
 * slug in one `runProcSweep` call — see `SweepSlugResult.skipped`. */
export const DEFAULT_SWEEP_DEADLINE_MS = 60_000;

export type SweepSlugResult = {
  slug: string;
  reap: RegistryReapResult;
  reported: { dead: number; alive: number; unknown: number };
  classified: ClassifiedRow[];
  compacted?: { kept: number; dropped: number };
  skipped?: "deadline-exceeded";
};

export type ProcSweepResult = {
  mode: "sweep";
  yes: boolean;
  slugs: SweepSlugResult[];
  totals: Record<ReapOutcome, number>;
  unknownRows: number;
  aliveRows: number;
};

function zeroReapCounts(): Record<ReapOutcome, number> {
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
 * Enumerates slugs (or scopes to `opts.slug`), classifies each slug's
 * registry rows via `selectDeadSessionRows`, and hands ONLY the `dead`
 * bucket to `runRegistryReap` via its `readRows` override — `alive` and
 * `unknown` rows never reach the kill engine at all. Report-only by
 * default: `dryRun` is the negation of `opts.yes`, and `compact` (the only
 * mutation this module performs directly) runs only on the `--yes` path,
 * for a slug whose registry actually had rows.
 *
 * A sweep-level `deadlineMs` (default `DEFAULT_SWEEP_DEADLINE_MS`) is
 * threaded down as each slug's remaining `registryDeadlineMs` — a slug
 * reached only after the budget is already exhausted is marked
 * `skipped: "deadline-exceeded"` rather than silently dropped; per CONTRACT
 * ADJUSTMENT #7, `runRegistryReap` returns `ran: false, skipReason:
 * "no-rows"` whenever the pre-filtered dead set is empty (the overwhelming
 * common case for a report-only host-wide sweep), so `totals` aggregation
 * must — and does — tolerate those zero-filled counts unconditionally; no
 * consumer may read `ran` as "the sweep ran".
 */
export function runProcSweep(
  deps: ReapDeps & SweepDeps,
  opts: { yes: boolean; slug?: string; baseDir?: string; deadlineMs?: number },
): ProcSweepResult {
  const slugs =
    opts.slug !== undefined ? [opts.slug] : listRegistrySlugs(opts.baseDir);
  const deadline =
    deps.nowMs() + (opts.deadlineMs ?? DEFAULT_SWEEP_DEADLINE_MS);

  const slugResults: SweepSlugResult[] = [];
  for (const slug of slugs) {
    if (deps.nowMs() >= deadline) {
      slugResults.push({
        slug,
        reap: {
          ran: false,
          dryRun: !opts.yes,
          slug,
          rows: [],
          counts: zeroReapCounts(),
          malformed: 0,
        },
        reported: { dead: 0, alive: 0, unknown: 0 },
        classified: [],
        skipped: "deadline-exceeded",
      });
      continue;
    }

    const { rows, malformed } = readRows(slug, opts.baseDir);
    const { dead, alive, unknown } = selectDeadSessionRows(rows, deps);
    const remaining = Math.max(0, deadline - deps.nowMs());

    const reap = runRegistryReap(slug, deps, {
      dryRun: !opts.yes,
      baseDir: opts.baseDir,
      readRows: () => ({ rows: dead.map((c) => c.row), malformed }),
      registryDeadlineMs: remaining,
    });

    // report-only must not mutate: compact only on --yes, and only for a
    // slug whose registry actually had rows to begin with.
    const compacted =
      opts.yes && rows.length > 0 ? compact(slug, opts.baseDir) : undefined;

    slugResults.push({
      slug,
      reap,
      reported: {
        dead: dead.length,
        alive: alive.length,
        unknown: unknown.length,
      },
      classified: [...dead, ...alive, ...unknown],
      ...(compacted !== undefined ? { compacted } : {}),
    });
  }

  const totals = zeroReapCounts();
  let unknownRows = 0;
  let aliveRows = 0;
  for (const s of slugResults) {
    for (const key of Object.keys(totals) as ReapOutcome[]) {
      totals[key] += s.reap.counts[key];
    }
    unknownRows += s.reported.unknown;
    aliveRows += s.reported.alive;
  }

  return {
    mode: "sweep",
    yes: opts.yes,
    slugs: slugResults,
    totals,
    unknownRows,
    aliveRows,
  };
}
