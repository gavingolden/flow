/**
 * `flow reap` — the user-facing verb backing a host-wide (or `--slug`
 * scoped) cleanup of processes left by dead pipelines. Composes TWO
 * independently-authored sweeps behind one report:
 *
 *   - the registry sweep (`bin/lib/proc-sweep-run.ts`, verified pid+pgid+
 *     startEpoch identity via `bin/lib/reap.ts`'s frozen `verifyRow`
 *     ladder) — acted on by a bare `--yes`;
 *   - the shape-heuristic stray sweep (`runOrphanSweep` in
 *     `bin/flow-browser-teardown.ts`, no startEpoch re-verification and no
 *     session check) — gated behind the SEPARATE `--include-strays` flag,
 *     never widened by a bare `--yes` alone.
 *
 * Report-only unless `--yes`. Never passes `--record` and never writes to
 * `~/.flow/state/<slug>.json` — a host-wide sweep touches OTHER pipelines'
 * slugs, and recording into a sibling's state file would corrupt that
 * pipeline's `flow-gate-summary --cleanup` CLEANUP row.
 */

import { argsContainHelp, printVerbHelp } from "./help";
import { isValidSlug } from "./slug";
import { readState } from "./state";
import { pidStartEpoch } from "./liveness";
import type { ReapDeps } from "./reap";
import { runProcSweep, type ProcSweepResult } from "./proc-sweep-run";
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
  usageError?: string;
};

function parseReapArgs(args: string[]): ParsedReapCli {
  const out: ParsedReapCli = { yes: false, includeStrays: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--yes") {
      out.yes = true;
    } else if (a === "--include-strays") {
      out.includeStrays = true;
    } else if (a === "--json") {
      out.json = true;
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
  if (m.investigate > 0)
    parts.push(
      `${m.investigate} ${m.investigate === 1 ? "needs" : "need"} investigation`,
    );
  if (parts.length === 0) {
    return `Summary: no leaked processes recorded — ${m.alive} alive across ${m.withRows} pipelines with recorded processes`;
  }
  return `Summary: ${parts.join(", ")}`;
}

function renderTextReport(result: ReapCliResult): string {
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
    const action = result.yes ? "acted on" : "held (report-only)";
    printedCounts = true;
    lines.push(
      `  ${s.slug}: ${dead.length} dead (${action}), ${alive.length} alive, ${unknown.length} unknown`,
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
      `  dead = ${result.yes ? "acted on (verified before any signal)" : "held (report-only) until --yes"}; alive = never signalled; unknown = held — absence of evidence is never evidence of death`,
    );
  }

  lines.push("");
  lines.push(
    result.includeStrays
      ? "Shape-heuristic strays (--include-strays: acted on with --yes; no startEpoch re-verification, no session check):"
      : "Shape-heuristic strays (report-only — pass --include-strays to act; no startEpoch re-verification, no session check):",
  );
  if (result.heuristic.skipReason === "ps-unavailable") {
    lines.push("  (ps unavailable — stray sweep did not run)");
  } else {
    lines.push(
      `  browsers: ${result.heuristic.found.length} found, ${result.heuristic.signalled.length} signalled`,
    );
    lines.push(`  mcp servers: ${result.heuristic.foundServers.length} found`);
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
              // SIGTERMs strays across the whole host.
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

  return {
    mode: "reap",
    yes,
    includeStrays,
    slug: opts.slug,
    registry,
    heuristic,
  };
}

/**
 * `flow reap [--slug <s>] [--yes] [--include-strays] [--json]` — see the
 * module doc comment above for the composed-sweep + safety contract.
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
