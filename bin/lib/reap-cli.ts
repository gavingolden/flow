/**
 * `flow reap` — the user-facing verb backing a host-wide (or `--slug`
 * scoped) cleanup of processes left by dead pipelines. Composes FOUR
 * independently-authored sweeps behind one report:
 *
 *   - the registry sweep (`bin/lib/proc-sweep-run.ts`, verified pid+pgid+
 *     startEpoch identity via `bin/lib/reap.ts`'s frozen `verifyRow`
 *     ladder) — acted on by a bare `--yes`;
 *   - the shape-heuristic stray sweep (`runOrphanSweep` in
 *     `bin/flow-browser-teardown.ts`, no startEpoch re-verification and no
 *     session check) — gated behind the SEPARATE `--include-strays` flag,
 *     never widened by a bare `--yes` alone;
 *   - the agy stray sweep (`bin/lib/agy-strays.ts`, orphaned flow-launched
 *     agy runs, SIGTERM then SIGKILL with a start-time re-check before each
 *     signal) — behind the same `--include-strays` gate;
 *   - the worktree-leftover sweep (`bin/lib/worktree-orphans-run.ts`, every
 *     unrecorded orphan whose cwd is inside a pipeline's worktree and whose
 *     process-group leader is dead) — behind the same gate AND only for a
 *     pipeline whose session has positively ended. Busy leftovers outside
 *     every worktree are listed, never signalled.
 *
 * Report-only unless `--yes`. Never passes `--record` and never writes to
 * `~/.flow/state/<slug>.json` — a host-wide sweep touches OTHER pipelines'
 * slugs, and recording into a sibling's state file would corrupt that
 * pipeline's `flow-gate-summary --cleanup` CLEANUP row. The one carve-out is
 * `--worktrees --yes`: it removes folders through `flow-remove-worktree`,
 * whose guarded cleanup clears `worktree` on a finished (merged/cancelled)
 * record that owned the removed folder.
 */

import { argsContainHelp, printVerbHelp } from "./help";
import { isValidSlug } from "./slug";
import { listStates, readState } from "./state";
import { livenessOf, pidStartEpoch } from "./liveness";
import {
  defaultOrphanSweepDeps,
  snapshotOrphanDeps,
  findBusyOutsideWorktrees,
  renderOrphanSweepLine,
  stoppedCount,
  sweepWorktreeOrphans,
  type OrphanSweepDeps,
  type OutsideOrphan,
  type WorktreeOrphanSweepResult,
} from "./worktree-orphans-run";
import type { ReapDeps } from "./reap";
import { runProcSweep, type ProcSweepResult } from "./proc-sweep-run";
import {
  defaultAgySweepDeps,
  renderAgyStrayLine,
  sweepAgyStrays,
  type AgyStraySweepResult,
} from "./agy-strays";
import { runWorktreeSweep } from "./worktree-sweep";
import { defaultSweepDeps } from "./worktree-sweep-defaults";
import { renderWorktreeSweepText } from "./worktree-sweep-render";
import {
  buildDefaultDeps,
  runOrphanSweep,
  type Deps as BrowserTeardownDeps,
  type OrphanSweepResult,
} from "../flow-browser-teardown";

type ParsedReapCli = {
  slug?: string;
  yes: boolean;
  includeStrays: boolean;
  json: boolean;
  worktrees: boolean;
  auto: boolean;
  usageError?: string;
};

function worktreesUsageError(p: ParsedReapCli): string | undefined {
  if (p.auto && !p.worktrees) return "--auto only works with --worktrees";
  if (p.worktrees && p.slug)
    return "--worktrees cannot be combined with --slug";
  if (p.worktrees && p.includeStrays) {
    return "--worktrees cannot be combined with --include-strays";
  }
  return undefined;
}

function parseReapArgs(args: string[]): ParsedReapCli {
  const out: ParsedReapCli = {
    yes: false,
    includeStrays: false,
    json: false,
    worktrees: false,
    auto: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--yes") {
      out.yes = true;
    } else if (a === "--include-strays") {
      out.includeStrays = true;
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--worktrees") {
      out.worktrees = true;
    } else if (a === "--auto") {
      out.auto = true;
    } else if (a === "--slug") {
      const v = args[++i];
      if (v === undefined || v === "" || !isValidSlug(v)) {
        out.usageError = `--slug requires a valid slug value (got: ${v ?? ""})`;
      } else {
        out.slug = v;
      }
    } else {
      out.usageError = `unknown flag: ${a}`;
    }
  }
  if (!out.usageError) out.usageError = worktreesUsageError(out);
  return out;
}

/**
 * Bridges `bin/flow-browser-teardown.ts`'s `Deps` to `bin/lib/reap.ts`'s
 * `ReapDeps` — a small, LOCAL bridge (not a hand-rolled second `Deps`
 * construction: `listProcs`/`alive`/etc all still come from
 * `buildDefaultDeps`). Deliberately builds its own `startEpochOf` from
 * `pidStartEpoch` rather than forwarding `deps.startEpochMsOf`, mirroring
 * `bin/flow-browser-teardown.ts`'s own private `toReapDeps` (not exported,
 * so not reused directly): `startEpochMsOf` is MILLISECOND-scaled for the
 * `--orphans` `ageMs` display only, while `ProcRegistryRow.startEpoch` (and
 * every reap comparison) is SECONDS — forwarding the millisecond field
 * would epoch-mismatch every live row by a ~1000x scale error.
 */
function toReapCliDeps(deps: BrowserTeardownDeps): ReapDeps {
  return {
    kill: deps.kill,
    alive: deps.alive,
    sleepMs: deps.sleepMs,
    nowMs: deps.nowMs,
    selfPid: deps.selfPid,
    selfPgid: deps.selfPgid,
    sessionPgid: deps.sessionPgid,
    groupMembers: deps.groupMembers,
    startEpochOf: (pid) => pidStartEpoch(pid),
  };
}

export type ReapCliResult = {
  mode: "reap";
  yes: boolean;
  includeStrays: boolean;
  slug?: string;
  registry: ProcSweepResult;
  heuristic: OrphanSweepResult;
  agy: AgyStraySweepResult;
  /** One sweep per pipeline with a worktree; acted on only for an ended session. */
  worktreeOrphans: Array<{
    slug: string;
    sessionAlive: boolean;
    result: WorktreeOrphanSweepResult;
  }>;
  /** Busy leaderless orphans outside every worktree; report-only, never signalled. */
  outsideOrphans: OutsideOrphan[];
  /** Recorded phase of each pipeline whose session is still open. */
  phases: Record<string, string>;
};

const INVESTIGATE_OUTCOMES = [
  "skipped-epoch-mismatch",
  "skipped-unsafe-pgid",
  "skipped-foreign-member",
  "skipped-dead-leader",
  "still-alive",
  "failed",
] as const;

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/** Missing numeric fields default to 0 — callers (and tests) may pass partial results. */
function summarizeRegistry(result: ReapCliResult) {
  let dead = 0;
  let alive = 0;
  let unknown = 0;
  let deadlineSkipped = 0;
  let unreadable = 0;
  let withRows = 0;
  let hidden = 0;
  let removed = 0;
  let investigate = 0;
  let running = 0;
  let totalRows = 0;
  for (const s of result.registry.slugs) {
    if (s.compacted?.removed === true) removed++;
    for (const o of INVESTIGATE_OUTCOMES) {
      investigate += s.reap?.counts?.[o] ?? 0;
    }
    if (s.skipped === "deadline-exceeded") {
      deadlineSkipped++;
    } else if (s.classified.length > 0) {
      withRows++;
      for (const c of s.classified) {
        if (c.verdict === "dead") dead++;
        else if (c.verdict === "alive") alive++;
        else unknown++;
        totalRows++;
        if (c.ownPidAlive) running++;
      }
    } else if ((s.reap?.malformed ?? 0) > 0) {
      unreadable++;
    } else if (result.slug === undefined) {
      hidden++;
    }
  }
  return {
    dead,
    alive,
    unknown,
    deadlineSkipped,
    unreadable,
    withRows,
    hidden,
    removed,
    investigate: result.yes ? investigate : 0,
    reaped: result.registry.totals?.reaped ?? 0,
    alreadyDead: result.registry.totals?.["already-dead"] ?? 0,
    browsers: result.heuristic.found?.length ?? 0,
    servers: result.heuristic.foundServers?.length ?? 0,
    agyStrays: result.agy?.found?.length ?? 0,
    leftovers: (result.worktreeOrphans ?? []).reduce(
      (n, w) => n + (w.result.found?.length ?? 0),
      0,
    ),
    leftoversStopped: (result.worktreeOrphans ?? []).reduce(
      (n, w) => n + stoppedCount(w.result),
      0,
    ),
    running,
    totalRows,
  };
}

function summaryLine(
  result: ReapCliResult,
  m: ReturnType<typeof summarizeRegistry>,
): string {
  const parts: string[] = [];
  if (result.yes) {
    if (m.reaped > 0) parts.push(`reaped ${m.reaped}`);
    // A dead row --yes neither resolved (reaped / already-dead) nor routed to
    // an investigate outcome must still surface, or the verdict would
    // falsely read clean.
    const unaccounted = m.dead - m.reaped - m.alreadyDead - m.investigate;
    if (unaccounted > 0) parts.push(`${unaccounted} dead not reaped`);
    const notRemoved = m.hidden - m.removed;
    if (notRemoved > 0) {
      parts.push(
        `${plural(notRemoved, "empty registry", "empty registries")} not removed`,
      );
    }
  } else if (m.dead > 0) {
    parts.push(`${m.dead} dead (reapable with --yes)`);
  }
  if (m.unknown > 0) parts.push(`${m.unknown} unknown (held)`);
  if (m.deadlineSkipped > 0) {
    parts.push(
      `${plural(m.deadlineSkipped, "pipeline", "pipelines")} skipped (deadline)`,
    );
  }
  if (m.unreadable > 0) {
    parts.push(
      `${plural(m.unreadable, "pipeline", "pipelines")} with unreadable lines`,
    );
  }
  if (m.browsers > 0)
    parts.push(plural(m.browsers, "stray browser", "stray browsers"));
  if (m.servers > 0)
    parts.push(plural(m.servers, "stray mcp server", "stray mcp servers"));
  if (m.agyStrays > 0)
    parts.push(plural(m.agyStrays, "stray agy run", "stray agy runs"));
  if (result.yes && m.leftoversStopped > 0) {
    parts.push(
      `stopped ${plural(m.leftoversStopped, "leftover process", "leftover processes")}`,
    );
  } else if (m.leftovers > 0) {
    parts.push(
      `${plural(m.leftovers, "leftover process", "leftover processes")} in pipeline worktrees`,
    );
  }
  if (m.investigate > 0)
    parts.push(
      `${m.investigate} ${m.investigate === 1 ? "needs" : "need"} investigation`,
    );
  if (parts.length === 0) {
    return `Summary: no leaked processes recorded — ${m.running} of ${m.totalRows} recorded processes still running, across ${m.withRows} pipelines with recorded processes`;
  }
  return `Summary: ${parts.join(", ")}`;
}

export function renderTextReport(result: ReapCliResult): string {
  const lines: string[] = [];
  const m = summarizeRegistry(result);

  lines.push(summaryLine(result, m));
  lines.push("");
  lines.push("Registry rows (verified pid+pgid+startEpoch identity):");
  if (result.registry.slugs.length === 0) {
    lines.push("  (no registered slugs found)");
  }
  let printedCounts = false;
  for (const s of result.registry.slugs) {
    if (s.skipped === "deadline-exceeded") {
      lines.push(
        `  ${s.slug}: skipped (sweep deadline exceeded) — run 'flow reap --slug ${s.slug}'`,
      );
      continue;
    }
    if (s.classified.length === 0) {
      const malformed = s.reap?.malformed ?? 0;
      if (malformed > 0) {
        lines.push(
          `  ${s.slug}: no readable rows (${malformed} unreadable lines — left untouched)`,
        );
      } else if (result.slug !== undefined) {
        lines.push(`  ${s.slug}: no recorded processes`);
      }
      continue;
    }
    const dead = s.classified.filter((c) => c.verdict === "dead");
    const alive = s.classified.filter((c) => c.verdict === "alive");
    const unknown = s.classified.filter((c) => c.verdict === "unknown");
    printedCounts = true;
    const running = s.classified.filter((c) => c.ownPidAlive).length;
    // Phase is only collected for slugs with an open-session row, so it is
    // only ever printed in that clause.
    const phase = result.phases?.[s.slug] ?? "phase unrecorded";
    const clauses: string[] = [];
    if (dead.length > 0) {
      clauses.push(
        `${dead.length} from an ended pipeline (${result.yes ? "acted on" : "held, report-only"})`,
      );
    }
    if (alive.length > 0) {
      clauses.push(
        `${alive.length} from a pipeline whose session is still open (${phase}, left alone)`,
      );
    }
    if (unknown.length > 0) clauses.push(`${unknown.length} unknown (held)`);
    lines.push(
      `  ${s.slug}: ${s.classified.length} recorded processes, ${running} still running — ${clauses.join("; ")}`,
    );
    if (unknown.length > 0) {
      const byReason = new Map<string, number>();
      for (const c of unknown) {
        const key = c.reason ?? "unspecified";
        byReason.set(key, (byReason.get(key) ?? 0) + 1);
      }
      for (const [reason, count] of byReason) {
        lines.push(`    unknown/${reason}: ${count}`);
      }
    }
  }
  if (result.yes) {
    if (m.removed > 0) {
      lines.push(
        `  removed ${plural(m.removed, "empty registry", "empty registries")}`,
      );
    }
    if (m.hidden - m.removed > 0) {
      lines.push(
        `  ${plural(m.hidden - m.removed, "empty registry", "empty registries")} could not be removed — run 'flow reap --json' to see which`,
      );
    }
  } else if (m.hidden > 0) {
    lines.push(
      `  ${plural(m.hidden, "empty registry", "empty registries")} hidden — flow reap --yes removes them; --json lists every pipeline` +
        (m.dead > 0
          ? ` (that run also reaps the ${m.dead} dead rows above)`
          : ""),
    );
  }
  if (printedCounts) {
    lines.push(
      `  ended pipeline = ${result.yes ? "acted on (verified before any signal)" : "held (report-only) until --yes"}; session still open = never signalled (it says nothing about the processes themselves); unknown = held — absence of evidence is never evidence of death`,
    );
  }

  lines.push("");
  lines.push(
    result.includeStrays
      ? "Shape-heuristic strays (--include-strays: acted on with --yes; browsers/MCP servers: no startEpoch re-verification, no session check; agy runs: start time re-checked, SIGKILL after grace):"
      : "Shape-heuristic strays (report-only — pass --include-strays to act; browsers/MCP servers: no startEpoch re-verification, no session check; agy runs: start time re-checked, SIGKILL after grace):",
  );
  if (result.heuristic.skipReason === "ps-unavailable") {
    lines.push("  (ps unavailable — stray sweep did not run)");
  } else {
    lines.push(
      `  browsers: ${result.heuristic.found.length} found, ${result.heuristic.signalled.length} signalled`,
    );
    lines.push(`  mcp servers: ${result.heuristic.foundServers.length} found`);
  }
  if (result.agy) lines.push(renderAgyStrayLine(result.agy));

  lines.push("");
  lines.push(
    "Leftover processes in pipeline worktrees (unrecorded orphans whose working directory is in the worktree and whose launching shell has exited; acted on only with --yes --include-strays, and never while the pipeline's session is open):",
  );
  const withFindings = (result.worktreeOrphans ?? []).filter(
    (w) => !w.result.ran || w.result.found.length > 0,
  );
  if (withFindings.length === 0) lines.push("  (none found)");
  for (const w of withFindings) {
    const held = w.sessionAlive
      ? ", left to the live pipeline (session not confirmed ended)"
      : "";
    lines.push(
      `  ${w.slug}: ${renderOrphanSweepLine(w.result, { held: w.sessionAlive })}${held}`,
    );
  }
  for (const o of result.outsideOrphans ?? []) {
    lines.push(
      `  outside every worktree (report-only, never signalled): pid ${o.pid} ${o.command0}, ${Math.round(o.groupCpuRatio * 100)}% of a core, running ${Math.round(o.ageSec / 60)} min`,
    );
  }

  lines.push("");
  lines.push(
    result.yes
      ? "Ran with --yes."
      : `Report-only. To act on registered rows: flow reap${result.slug ? ` --slug ${result.slug}` : ""} --yes` +
          (result.includeStrays
            ? ""
            : // SAFETY: --include-strays is ALWAYS host-wide, even on a
              // --slug-scoped run — the shape-heuristic stray sweep has no
              // per-slug identity to scope by. Naming it here without that
              // caveat would read as "still scoped to --slug", which is
              // false: following this exact suggestion on a --slug run
              // signals strays (SIGTERM; SIGKILL for overdue agy runs)
              // across the whole host.
              ` (add --include-strays to also act on shape-heuristic strays — always host-wide, not scoped by --slug)`),
  );
  return lines.join("\n");
}

/**
 * Builds the composed registry + stray report. Signals only when `yes` is
 * set (strays additionally need `includeStrays`), so `{ yes: false }` is a
 * pure read. `baseDir`, `stateDir` and `deadlineMs` are seams for a caller
 * (the doctor) that needs a hermetic registry and state directory and a
 * bounded sweep.
 */
export function collectReapReport(opts: {
  slug?: string;
  yes?: boolean;
  includeStrays?: boolean;
  baseDir?: string;
  stateDir?: string;
  deadlineMs?: number;
  orphanDeps?: OrphanSweepDeps;
}): ReapCliResult {
  const yes = opts.yes ?? false;
  const includeStrays = opts.includeStrays ?? false;
  const browserDeps = buildDefaultDeps({ includeReapExtras: true });
  const reapDeps = toReapCliDeps(browserDeps);

  const stateDir = opts.stateDir;
  const registry = runProcSweep(
    stateDir === undefined
      ? reapDeps
      : { ...reapDeps, readState: (slug: string) => readState(slug, stateDir) },
    {
      yes,
      slug: opts.slug,
      baseDir: opts.baseDir,
      deadlineMs: opts.deadlineMs,
    },
  );

  // SAFETY (load-bearing): a bare --yes must never widen into signalling a
  // stray — runOrphanSweep's signalling path does a bare SIGTERM with no
  // startEpoch re-verification and no session check, materially weaker
  // discipline than verifyRow's registry-row ladder.
  const heuristic = runOrphanSweep(browserDeps, {
    yes: yes && includeStrays,
    homeDir: browserDeps.homeDir,
    tmpDir: browserDeps.tmpDir,
  });

  // Same gate as the browser/MCP strays: a bare --yes never reaches this.
  const agy = sweepAgyStrays(defaultAgySweepDeps(), {
    yes: yes && includeStrays,
  });

  // One read of the process table, registries and pipeline states for the
  // whole report, however many pipelines it sweeps.
  const orphanDeps = snapshotOrphanDeps(orphanDepsFor(opts));
  const worktreeOrphans = sweepWorktrees(
    opts,
    orphanDeps,
    yes && includeStrays,
  );
  const outsideOrphans =
    opts.slug === undefined ? outsideWorktrees(orphanDeps) : [];

  const phases: Record<string, string> = {};
  for (const s of registry.slugs) {
    if (!s.classified.some((c) => c.verdict === "alive")) continue;
    const state = isValidSlug(s.slug) ? readState(s.slug, stateDir) : null;
    phases[s.slug] = state?.phase ?? "phase unrecorded";
  }

  return {
    mode: "reap",
    yes,
    includeStrays,
    slug: opts.slug,
    registry,
    heuristic,
    agy,
    worktreeOrphans,
    outsideOrphans,
    phases,
  };
}

function orphanDepsFor(opts: {
  baseDir?: string;
  stateDir?: string;
  orphanDeps?: OrphanSweepDeps;
}): OrphanSweepDeps {
  return (
    opts.orphanDeps ??
    defaultOrphanSweepDeps({ stateDir: opts.stateDir, baseDir: opts.baseDir })
  );
}

function outsideWorktrees(deps: OrphanSweepDeps): OutsideOrphan[] {
  try {
    return findBusyOutsideWorktrees(deps);
  } catch {
    return [];
  }
}

/**
 * One sweep per pipeline that recorded a worktree (one with `--slug`). Acts
 * only when `act` and the state channel positively shows the session ended
 * ("dead"/"stale"); an alive or unverifiable session is reported and held.
 * Never writes any state file.
 */
function sweepWorktrees(
  opts: {
    slug?: string;
    stateDir?: string;
    deadlineMs?: number;
  },
  deps: OrphanSweepDeps,
  act: boolean,
): ReapCliResult["worktreeOrphans"] {
  const started = Date.now();
  const out: ReapCliResult["worktreeOrphans"] = [];
  for (const state of listStates(opts.stateDir)) {
    if (!state.worktree) continue;
    if (opts.slug !== undefined && state.slug !== opts.slug) continue;
    const remainingMs =
      opts.deadlineMs === undefined
        ? undefined
        : opts.deadlineMs - (Date.now() - started);
    if (remainingMs !== undefined && remainingMs <= 0) break;
    const liveness = livenessOf(state);
    const sessionAlive = liveness !== "dead" && liveness !== "stale";
    try {
      out.push({
        slug: state.slug,
        sessionAlive,
        result: sweepWorktreeOrphans(deps, {
          worktree: state.worktree,
          act: act && !sessionAlive,
          busyOnly: false,
          deadlineMs: remainingMs,
        }),
      });
    } catch {
      // one pipeline's failed read must not hide the others
    }
  }
  return out;
}

/**
 * `flow reap [--slug <s>] [--yes] [--include-strays] [--json]` — see the
 * module doc comment above for the composed-sweep + safety contract.
 * `flow reap --worktrees [--yes] [--json]` previews (or with --yes performs)
 * the finished-worktree and leftover-folder cleanup instead; `--auto` is the
 * silent form `flow feature create` starts in the background.
 */
export function runReapCli(args: string[]): number {
  if (argsContainHelp(args)) {
    printVerbHelp("reap");
    return 0;
  }

  const parsed = parseReapArgs(args);
  if (parsed.usageError) {
    console.error(`flow reap: ${parsed.usageError}`);
    return 1;
  }

  if (parsed.worktrees) {
    const swept = runWorktreeSweep(
      { act: parsed.yes, auto: parsed.auto },
      defaultSweepDeps(),
    );
    if (!parsed.auto) {
      console.log(
        parsed.json ? JSON.stringify(swept) : renderWorktreeSweepText(swept),
      );
    }
    return 0;
  }

  const result = collectReapReport({
    yes: parsed.yes,
    slug: parsed.slug,
    includeStrays: parsed.includeStrays,
  });

  if (parsed.json) {
    console.log(JSON.stringify(redactArgvForJson(result)));
  } else {
    console.log(renderTextReport(result));
  }
  return 0;
}

/**
 * SAFETY: `bin/lib/proc-registry.ts` chmods the registry file `0o600`
 * because a row's `argv` is persisted verbatim and "routinely carries
 * secrets passed as flags" (see that module's own comment at its
 * `mkdirSync`/`writeFileSync` call site). `flow reap --json`'s
 * `registry.slugs[].classified[]` rows carry that same raw `argv` straight
 * through to stdout, host-wide, with none of that file's access controls —
 * a caller piping `--json` output to a log, a CI artifact, or a teammate
 * would leak whatever secrets the ORIGINAL launcher passed as flags. Redact
 * down to `argv[0]` (the command name — needed to identify the process)
 * before the one `JSON.stringify` call above; never redact the text report,
 * which never printed raw argv to begin with.
 */
function redactArgvForJson(result: ReapCliResult): ReapCliResult {
  return {
    ...result,
    registry: {
      ...result.registry,
      slugs: result.registry.slugs.map((s) => ({
        ...s,
        classified: s.classified.map((c) => ({
          ...c,
          row: {
            ...c.row,
            argv: c.row.argv.slice(0, 1),
            argvTruncated: true as const,
          },
        })),
      })),
    },
  };
}
