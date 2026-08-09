/**
 * `flow done <name>` — kill the window + remove the state file (after a
 * confirmation prompt unless --yes).
 *
 * `flow done --merged` — sweep all state files whose phase is `merged`
 * or `cancelled`, kill matching windows + remove their state. Confirms
 * once with the count + names before acting.
 *
 * `flow done --orphans` — sweep all state files whose tmux window is
 * gone (the rows `flow ls` annotates `(no window)`), regardless of
 * phase.
 *
 * `flow done --merged --orphans` — compose both filters in one sweep.
 * The preview tags each row `merged`, `orphan`, or `merged+orphan` so
 * an in-flight orphan a user meant to `flow feature resume` is visible
 * before confirming.
 */

import { spawnSync } from "node:child_process";
import { argsContainHelp, printVerbHelp } from "./help";
import { confirmStdin as confirm } from "./confirm";
import { livenessOf } from "./liveness";
import {
  findWindowBySlug,
  killWindow,
  listWindows,
  windowExists,
  FLOW_SESSION,
  type TmuxWindow,
} from "./tmux";
import {
  deleteState,
  listStates,
  readState,
  type PipelineState,
} from "./state";
import { deleteTurnTracking } from "./stop-turn-tracking";
import { plainTerminate } from "./launcher";
import { dim } from "./color";
import { compact, readRows } from "./proc-registry";

const TERMINAL_PHASES = new Set(["merged", "cancelled"]);

/**
 * Per-slug `spawnSync` backstop for `defaultRegistryReap`, sized just over
 * `runRegistryReap`'s own 30s `DEFAULT_REGISTRY_DEADLINE_MS`
 * (`bin/lib/reap.ts:361`) so the helper's internal deadline normally fires
 * first.
 */
export const REAP_TIMEOUT_MS = 35_000;

/**
 * Cumulative budget across a `--merged`/`--orphans` sweep so `flow done
 * --merged` over N stale pipelines can never become an O(N x 35s) stall.
 * Slugs past the budget skip the reap and print a one-line note naming
 * `flow reap --slug <s>` as the follow-up; the sweep still proceeds.
 */
const DONE_REAP_BUDGET_MS = 60_000;

export type DoneOptions = {
  merged?: boolean;
  orphans?: boolean;
  yes?: boolean;
  /** plainTerminate seam (test only) — defaults to the real SIGTERM path. */
  terminate?: typeof plainTerminate;
  /**
   * Session-scoped browser-teardown seam (test only) — defaults to
   * `defaultBrowserTeardown`, which shells out to `flow-browser-teardown
   * --session-pid <pid> --json` for the pipeline's recorded pid. Fires
   * best-effort, before the pipeline itself is terminated — a thrown or
   * missing-binary failure is always swallowed, never fails `flow done`.
   */
  browserTeardown?: (slug: string) => void;
  /**
   * Slug-scoped registry-reap seam (test only) — defaults to
   * `defaultRegistryReap`, which shells out to `flow-browser-teardown --reap
   * --slug <slug> --json` (no `--record`) and then compacts the registry
   * file. Fires best-effort, after the window-kill/plainTerminate branch and
   * before the state file is deleted — a thrown or missing-binary failure is
   * always swallowed, never fails `flow done`.
   */
  registryReap?: (slug: string) => void;
  /**
   * Clock seam for the `sweep()` cumulative registry-reap budget (test
   * only) — defaults to `Date.now`. Lets a test exercise the
   * `DONE_REAP_BUDGET_MS` skip branch deterministically instead of
   * needing a real 60-second wait.
   */
  now?: () => number;
};

/**
 * Default `browserTeardown`: reads the pipeline's recorded pid from state
 * and, only on an `alive` liveness verdict (recycled-PID-safe, mirroring
 * `plainTerminate`), shells out to `flow-browser-teardown --session-pid
 * <pid> --json` so THIS pipeline's own chrome-devtools-mcp server (never a
 * sibling's) is SIGTERMed and its shutdown() handler reaps its Chrome
 * subprocess. Silently no-ops when no pid is recorded (e.g. the
 * `runDoneMulti` window-only synthesized row) or the pid isn't `alive`.
 */
function defaultBrowserTeardown(slug: string): void {
  const state = readState(slug);
  if (!state || state.pid == null) return;
  if (livenessOf(state) !== "alive") return;
  spawnSync(
    "flow-browser-teardown",
    ["--session-pid", String(state.pid), "--json"],
    { stdio: "ignore" },
  );
}

/**
 * Fires `browserTeardown` best-effort. `flow done` must never fail because
 * a browser would not close — a thrown error (including a missing
 * `flow-browser-teardown` on PATH) is swallowed here, never propagated.
 */
function safeBrowserTeardown(slug: string, options: DoneOptions): void {
  try {
    (options.browserTeardown ?? defaultBrowserTeardown)(slug);
  } catch {
    // Best-effort — see the doc comment above.
  }
}

/**
 * Default `registryReap`: reaps this slug's process-registry rows via
 * `flow-browser-teardown --reap --slug <slug> --json`, then compacts the
 * (now largely-dead) registry file. CRITICAL: no `--record` — it would write
 * `state.reap` into a state file this function's caller is about to delete.
 * Unlike `defaultBrowserTeardown`, there is no `livenessOf` gate and no
 * state read at all, so this also runs for a slug whose state file is
 * already missing.
 *
 * Two-safety-standards reconciliation: `flow reap`'s own CLI (`reap-cli.ts`)
 * only ever REPORTS on a bare `--yes` and defers to `--include-strays` for
 * anything host-wide-risky, because a host-wide sweep can't assume the
 * caller has session-scoped context on every slug it touches. This
 * `flow done` path is allowed to actually SIGNAL (via `--reap` here, no
 * `--dry-run`) because it is single-slug and the user has already
 * confirmed closing THIS pipeline — the confirmation IS the session-scoped
 * context a host-wide sweep lacks. Same `verifyRow` refusal ladder either
 * way; only the caller's confidence in scope differs.
 */
function defaultRegistryReap(slug: string): void {
  const result = spawnSync(
    "flow-browser-teardown",
    ["--reap", "--slug", slug, "--json"],
    { stdio: "ignore", timeout: REAP_TIMEOUT_MS },
  );
  // `spawnSync` never THROWS on a missing binary (ENOENT) or a timeout — it
  // returns `{error}` instead, which `safeRegistryReap`'s try/catch above
  // can't see (there's nothing to catch). Silently discarding that leaves
  // the operator with zero signal that this slug's leaked processes were
  // never actually signalled — the exact stranding this PR exists to close,
  // now permanent and invisible. Surface it once, best-effort (never
  // thrown), so it's at least visible in `flow done`'s own output.
  if (result?.error) {
    console.warn(
      `  (registry reap for '${slug}' did not run: ${result.error.message})`,
    );
  }
  compact(slug);
}

/**
 * Fires `registryReap` best-effort. `flow done` must never fail, hang, or
 * block because a reap did not run. A missing `flow-browser-teardown` on
 * PATH, a throw, and a timeout are all swallowed identically.
 */
function safeRegistryReap(slug: string, options: DoneOptions): void {
  try {
    (options.registryReap ?? defaultRegistryReap)(slug);
  } catch {
    // Best-effort — see the doc comment above.
  }
}

/**
 * CLI shim for `bin/flow`'s `done` verb. Intercepts --help / -h before any
 * tmux query or state read, then parses --merged / --orphans / --yes / -y
 * and dispatches to `runDone`. The previous inline `runDoneVerb` lived in
 * `bin/flow`.
 */
export function runDoneCli(args: string[]): number {
  if (argsContainHelp(args)) {
    printVerbHelp("done");
    return 0;
  }
  const merged = args.includes("--merged");
  const orphans = args.includes("--orphans");
  const yes = args.includes("--yes") || args.includes("-y");
  const positional = args.filter((a) => !a.startsWith("-"));
  // A sweep flag keeps today's predicate-driven behaviour regardless of how
  // many positional slugs were typed. With no sweep flag, exactly one slug
  // routes through the unchanged single-slug runDone (preserving the
  // `closed: flow:<name>` contract line); two or more route through the
  // multi-slug sweep below.
  if (!merged && !orphans) {
    const slugs = dedupe(positional);
    if (slugs.length > 1) return runDoneMulti(slugs, { yes });
  }
  return runDone(positional[0], { merged, orphans, yes });
}

/** A slug's registry (`~/.flow/state/procs/<slug>.jsonl`) has at least one
 * row — the plain-launcher crash shape that can outlive both the tmux
 * window and the state file. Never throws (mirrors `readRows`'s own ENOENT
 * -> `{rows: [], malformed: 0}` contract); an unreadable/missing registry
 * reads as "no rows" rather than propagating. */
function hasRegistryRows(slug: string): boolean {
  try {
    return readRows(slug).rows.length > 0;
  } catch {
    return false;
  }
}

function dedupe(slugs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of slugs) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Multi-slug `flow done a b c` — resolve each explicit slug to the same row
 * shape the --merged/--orphans sweeps build, then feed the EXISTING sweep()
 * (count+names preview, single confirm(), per-slug kill/delete/turn-track,
 * --yes bypass). Slugs with neither a window nor a state file are accumulated
 * as failures, warned about, and force a non-zero exit while the resolvable
 * slugs still close.
 */
function runDoneMulti(slugs: string[], options: DoneOptions): number {
  const rows: PipelineState[] = [];
  const missing: string[] = [];
  for (const slug of slugs) {
    const state = readState(slug);
    if (state) {
      rows.push(state);
    } else if (windowExists(slug)) {
      // Window exists but no state file (the window-only path the single-slug
      // runDone warns about). Synthesize a minimal row so sweep() kills the
      // window; deleteState/deleteTurnTracking are no-ops without a state file.
      rows.push({ slug, phase: "unknown", repo: "", updatedAt: "" });
    } else if (hasRegistryRows(slug)) {
      // Registry-rows-only (the plain-launcher crash shape `hasRows` guards
      // in single-slug runDone below) — synthesize the same minimal row so
      // sweep()'s safeRegistryReap still runs for this slug instead of
      // bouncing it into `missing`.
      rows.push({ slug, phase: "unknown", repo: "", updatedAt: "" });
    } else {
      missing.push(slug);
    }
  }

  // Surface unresolvable slugs up front so they're visible alongside the
  // sweep preview before the user confirms.
  for (const slug of missing) {
    console.error(`flow done: no window or state for '${slug}'.`);
  }

  if (rows.length === 0) {
    // Every requested slug was unresolvable: nothing to confirm, nothing to
    // close. The missing warnings above already fired; exit non-zero.
    return 1;
  }

  // A declined confirm inside sweep() aborts the whole batch (logs "aborted",
  // returns 0). Treat that as a clean abort regardless of the missing slugs —
  // the user closed nothing, so it isn't a partial failure. We detect it by
  // observing whether any state was actually deleted via a wrapping flag.
  let proceeded = false;
  const code = sweep(
    rows,
    options,
    (s) => `  ${s.slug} (${s.phase})`,
    () => {
      proceeded = true;
    },
  );
  if (code !== 0) return code;
  if (!proceeded) return 0; // declined → clean abort
  return missing.length > 0 ? 1 : 0;
}

export function runDone(
  name: string | undefined,
  options: DoneOptions = {},
): number {
  if (options.merged && options.orphans) return runDoneCombined(options);
  if (options.orphans) return runDoneOrphans(options);
  if (options.merged) return runDoneMerged(options);

  if (!name) {
    console.error(
      "flow done: <name> is required (or pass --merged / --orphans).",
    );
    return 1;
  }

  const hasWindow = windowExists(name);
  const hasState = readState(name) !== null;
  // A registry row can outlive both the window and the state file (the
  // plain-launcher crash shape this feature exists for) — a slug with rows
  // but neither of the other two signals must still be reachable so its
  // registry gets reaped rather than bouncing off this guard.
  const hasRows = hasRegistryRows(name);

  if (!hasWindow && !hasState && !hasRows) {
    console.error(`flow done: no window or state for '${name}'.`);
    return 1;
  }

  if (!options.yes) {
    if (!confirm(`close pipeline '${name}'?`)) {
      console.log(dim("flow done: aborted — nothing closed"));
      return 0;
    }
  }

  safeBrowserTeardown(name, options);

  let warned = false;
  if (hasWindow) {
    killWindow(name);
  } else {
    // No window matched — a plain-launched pipeline lives as a bare process.
    // plainTerminate SIGTERMs only on an `alive` liveness verdict, so a
    // recycled PID or a legacy no-signal state is never signalled.
    const state = readState(name);
    const terminated =
      state != null && (options.terminate ?? plainTerminate)(state).terminated;
    if (terminated) {
      console.log(dim(`  terminated plain-launcher process for '${name}'`));
    } else if (hasState) {
      console.warn(
        `  (no tmux window for '${name}' — state file existed alone)`,
      );
      warned = true;
    } else {
      // No window, no state file, and terminated is always false here (a
      // null state never terminates) — the only way this branch was
      // reached at all is the relaxed hasRows guard above. Worded as an
      // in-progress action, not a completed one: `safeRegistryReap` below
      // is best-effort and swallows its own failures, so this line cannot
      // promise the reap actually succeeded.
      console.log(
        dim(`  reaping registry rows for '${name}' (no window or state file)`),
      );
      warned = true;
    }
  }
  safeRegistryReap(name, options);
  if (hasState) {
    deleteState(name);
    deleteTurnTracking(name);
  } else if (!warned) {
    console.warn(`  (no state file for '${name}' — window existed alone)`);
  }

  console.log(`closed: ${FLOW_SESSION}:${name}`);
  return 0;
}

function runDoneMerged(options: DoneOptions): number {
  const states = listStates().filter((s) => TERMINAL_PHASES.has(s.phase));
  if (states.length === 0) {
    console.log("flow done: no merged or cancelled pipelines to close.");
    return 0;
  }
  return sweep(states, options, (s) => `  ${s.slug} (${s.phase})`);
}

/**
 * Canonical orphan predicate for the `--orphans` sweep: a dead/stale
 * file-signal liveness verdict is orphaned regardless of whether its tmux
 * window still exists (a window can outlive the process that owned it).
 * An `unknown` verdict (old-format state, no pid/procStartedAt) falls back
 * to the legacy window-existence check so pre-this-PR state files keep
 * their exact prior `--orphans` selection. An `alive` verdict is never
 * orphaned.
 */
function isOrphan(state: PipelineState, windows: TmuxWindow[]): boolean {
  const verdict = livenessOf(state);
  if (verdict === "dead" || verdict === "stale") return true;
  if (verdict === "unknown") return !findWindowBySlug(windows, state.slug);
  return false;
}

function runDoneOrphans(options: DoneOptions): number {
  const windows = listWindows();
  const states = listStates().filter((s) => isOrphan(s, windows));
  if (states.length === 0) {
    console.log("flow done: no orphan pipelines to close.");
    return 0;
  }
  return sweep(states, options, (s) => {
    const pr = s.pr ? ` #${s.pr}` : "";
    return `  ${s.slug} (${s.phase}${pr})`;
  });
}

function runDoneCombined(options: DoneOptions): number {
  const windows = listWindows();
  const reasons = new Map<
    string,
    { state: PipelineState; tag: "merged" | "orphan" | "merged+orphan" }
  >();

  for (const s of listStates()) {
    const isMerged = TERMINAL_PHASES.has(s.phase);
    const orphaned = isOrphan(s, windows);
    if (!isMerged && !orphaned) continue;
    const tag =
      isMerged && orphaned ? "merged+orphan" : isMerged ? "merged" : "orphan";
    reasons.set(s.slug, { state: s, tag });
  }

  if (reasons.size === 0) {
    console.log(
      "flow done: no merged, cancelled, or orphan pipelines to close.",
    );
    return 0;
  }

  const states = [...reasons.values()].map((r) => r.state);
  return sweep(states, options, (s) => {
    const pr = s.pr ? ` #${s.pr}` : "";
    return `  ${s.slug} (${s.phase}${pr}) [${reasons.get(s.slug)!.tag}]`;
  });
}

function sweep(
  states: PipelineState[],
  options: DoneOptions,
  format: (s: PipelineState) => string,
  onProceed?: () => void,
): number {
  console.log(`will close ${states.length} pipeline(s):`);
  for (const s of states) console.log(format(s));

  if (!options.yes) {
    if (!confirm("proceed?")) {
      console.log(dim("flow done: aborted — nothing closed"));
      return 0;
    }
  }
  onProceed?.();

  const windows = listWindows();
  const now = options.now ?? Date.now;
  // Cumulative wall-clock budget for this whole sweep's registry reaps —
  // without it, N stale pipelines ahead of a slow reap could stall the
  // sweep for up to N x REAP_TIMEOUT_MS.
  const reapDeadline = now() + DONE_REAP_BUDGET_MS;
  for (const s of states) {
    safeBrowserTeardown(s.slug, options);
    if (findWindowBySlug(windows, s.slug)) {
      killWindow(s.slug);
    } else {
      // Windowless (plain-launched, or the window already died): SIGTERM the
      // recorded process, but only on an `alive` verdict — plainTerminate is
      // recycled-PID-safe by construction.
      (options.terminate ?? plainTerminate)(s);
    }
    if (now() < reapDeadline) {
      safeRegistryReap(s.slug, options);
    } else {
      // `deleteState` below removes this slug's state file a few lines
      // down, so a `flow reap --slug <s>` follow-up (which reads the
      // registry through `flow-browser-teardown --reap`, a state-file-free
      // path — see `defaultRegistryReap` above) still works. But naming
      // `flow reap` here would be misleading advice for a DIFFERENT reason:
      // `flow reap` sweeps ALL registered slugs by default and requires an
      // explicit `--slug` to scope to just this one, so name the narrower,
      // always-correct form directly.
      console.log(
        dim(
          `  skipped registry reap for '${s.slug}' (sweep budget exceeded) — run 'flow-browser-teardown --reap --slug ${s.slug} --record'`,
        ),
      );
    }
    deleteState(s.slug);
    deleteTurnTracking(s.slug);
    console.log(`closed: ${s.slug}`);
  }
  return 0;
}
