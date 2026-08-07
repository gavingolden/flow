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

type ReapCliResult = {
  mode: "reap";
  yes: boolean;
  includeStrays: boolean;
  slug?: string;
  registry: ProcSweepResult;
  heuristic: OrphanSweepResult;
};

function renderTextReport(result: ReapCliResult): string {
  const lines: string[] = [];

  lines.push(
    "Registry rows (verified pid+pgid+startEpoch identity via bin/lib/reap.ts):",
  );
  if (result.registry.slugs.length === 0) {
    lines.push("  (no registered slugs found)");
  }
  for (const s of result.registry.slugs) {
    if (s.skipped === "deadline-exceeded") {
      lines.push(
        `  ${s.slug}: skipped (sweep deadline exceeded) — run 'flow reap --slug ${s.slug}'`,
      );
      continue;
    }
    if (s.classified.length === 0) {
      lines.push(`  ${s.slug}: no registry rows`);
      continue;
    }
    const dead = s.classified.filter((c) => c.verdict === "dead");
    const alive = s.classified.filter((c) => c.verdict === "alive");
    const unknown = s.classified.filter((c) => c.verdict === "unknown");
    const action = result.yes ? "acted on" : "held (report-only)";
    lines.push(
      `  ${s.slug}: ${dead.length} dead (${action}), ${alive.length} alive (never signalled), ${unknown.length} unknown (held — absence of evidence is never evidence of death)`,
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
            : ` (add --include-strays to also act on shape-heuristic strays)`),
  );
  return lines.join("\n");
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
    process.stderr.write(`flow reap: ${parsed.usageError}\n`);
    return 1;
  }

  const browserDeps = buildDefaultDeps({ includeReapExtras: true });
  const reapDeps = toReapCliDeps(browserDeps);

  const registry = runProcSweep(reapDeps, {
    yes: parsed.yes,
    slug: parsed.slug,
  });

  // SAFETY (load-bearing): a bare --yes must never widen into signalling a
  // stray — runOrphanSweep's signalling path does a bare SIGTERM with no
  // startEpoch re-verification and no session check, materially weaker
  // discipline than verifyRow's registry-row ladder.
  const heuristic = runOrphanSweep(browserDeps, {
    yes: parsed.yes && parsed.includeStrays,
    homeDir: browserDeps.homeDir,
    tmpDir: browserDeps.tmpDir,
  });

  const result: ReapCliResult = {
    mode: "reap",
    yes: parsed.yes,
    includeStrays: parsed.includeStrays,
    slug: parsed.slug,
    registry,
    heuristic,
  };

  if (parsed.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderTextReport(result));
  }
  return 0;
}
