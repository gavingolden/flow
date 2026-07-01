/**
 * `flow ls` — join state files (~/.flow/state/<slug>.json) with tmux
 * windows from the flow session and print a status table.
 *
 * State source: a single global JSON file per pipeline. The supervisor
 * (PR 2) updates `phase` + `updatedAt` (and `pr` after step 5, `worktree`
 * after step 2) at every transition via `flow-state-update`. PR 1 wrote
 * the initial state with `phase: "starting"` from `flow feature create`.
 *
 * Drift handling:
 *   - state file but no window → "(no window)" (likely a crashed session)
 *   - window but no state file → "(no state)" (manual creation)
 *   - both                     → no annotation
 */

import * as path from "node:path";

import {
  computeCost,
  defaultProjectsRoot,
  EMPTY_COST,
  type CostBreakdown,
} from "./cost";
import { friendlyName } from "./cost-pricing";
import { argsContainHelp, printVerbHelp } from "./help";
import { listStates, type PipelineState } from "./state";
import { reapStartingOrphans } from "./reap-orphans";
import { relativeTime } from "./time";
import { findWindowBySlug, listWindows, type TmuxWindow } from "./tmux";
import { dim } from "./color";
import {
  checkForUpdate,
  formatUpdateNotice,
  type UpdateCheckResult,
} from "./update-check";

export type LsOptions = {
  cost?: boolean;
  detail?: boolean;
  /** Override for tests; defaults to ~/.claude/projects/. */
  projectsRoot?: string;
  /** Injectable for tests; defaults to the real read-only update check. */
  checkUpdate?: () => UpdateCheckResult;
};

export type Row = {
  name: string;
  repo: string;
  phase: string;
  pr: string;
  lastActivity: string;
  annotation: "" | "(no window)" | "(no state)";
  waitForCopilot: boolean;
  cost?: CostBreakdown;
};

/**
 * CLI shim for `bin/flow`'s `ls` verb. Intercepts --help / -h before any
 * state/tmux read, then parses --cost / --detail and dispatches to
 * `runLs`. The previous inline `runLsVerb` lived in `bin/flow`.
 */
export async function runLsCli(args: string[]): Promise<number> {
  if (argsContainHelp(args)) {
    printVerbHelp("ls");
    return 0;
  }
  const allowed = new Set(["--cost", "--detail"]);
  for (const arg of args) {
    if (!allowed.has(arg)) {
      console.error(`flow ls: unknown option '${arg}'`);
      console.error("usage: flow ls [--cost [--detail]]");
      return 2;
    }
  }
  const cost = args.includes("--cost");
  const detail = args.includes("--detail");
  if (detail && !cost) {
    console.error("flow ls: --detail requires --cost");
    return 2;
  }
  return await runLs({ cost, detail });
}

/**
 * Grace window for the lazy never-started orphan sweep: a phase=`starting`
 * state with no live window older than this is reaped (see `reap-orphans.ts`).
 * ~60s leaves a just-launched, still cold-starting supervisor untouched.
 */
const REAP_GRACE_MS = 60_000;

export async function runLs(opts: LsOptions = {}): Promise<number> {
  const now = Date.now();
  const windows = listWindows();
  // Lazy orphan sweep BEFORE buildRows: reap never-started orphans (phase
  // `starting`, no live window, stale) so they are neither shown nor counted.
  // Conservative — past-`starting` (no window) crashes keep their resume hint.
  const allStates = listStates();
  const reaped = new Set(
    reapStartingOrphans(allStates, windows, now, REAP_GRACE_MS),
  );
  const states = allStates.filter((s) => !reaped.has(s.slug));
  const rows = await buildRows(states, windows, now, opts);

  if (rows.length === 0) {
    console.log(dim("flow ls: no active pipelines"));
    emitUpdateNotice(opts);
    return 0;
  }

  printTable(rows, opts);
  printOrphanRecovery(rows);
  if (opts.cost && opts.detail) printDetail(rows);
  warnUnknownModels(rows);
  emitUpdateNotice(opts);
  return 0;
}

/**
 * Prints a post-table recovery footnote for orphaned pipelines — state files
 * whose tmux window is gone (`(no window)`), typically a crashed `flow feature create`
 * whose window never stayed up. Each gets its one-command restart line. Kept
 * BELOW the table (not inlined into the NAME cell) because printTable derives
 * column widths from cell lengths, so a long `flow feature resume <slug>` string
 * in the cell would widen the whole table for every row. No-op when no orphan
 * rows exist, so healthy output is unchanged.
 */
function printOrphanRecovery(rows: Row[]): void {
  const orphans = rows.filter((r) => r.annotation === "(no window)");
  if (orphans.length === 0) return;
  console.log("");
  console.log(dim("orphaned pipelines (no tmux window) — resume with:"));
  for (const row of orphans) {
    console.log(dim(`  flow feature resume ${row.name}`));
  }
}

/** Print the staleness notice to STDERR so stdout stays a clean table. */
function emitUpdateNotice(opts: LsOptions): void {
  const notice = formatUpdateNotice((opts.checkUpdate ?? checkForUpdate)());
  if (notice) console.error(notice);
}

export async function buildRows(
  states: PipelineState[],
  windows: TmuxWindow[],
  nowMs: number,
  opts: LsOptions = {},
): Promise<Row[]> {
  const projectsRoot = opts.projectsRoot ?? defaultProjectsRoot();

  const rows: Row[] = [];

  // Compute costs for all pipelines in parallel — each call streams a JSONL
  // and reads a directory, so sequential awaits would scale linearly with
  // active pipelines (six concurrent windows is an expected case).
  const costs = opts.cost
    ? await Promise.all(states.map((s) => computeCost(s, projectsRoot)))
    : null;

  // The state↔window join keys off the @flow-slug user option (with a
  // name fallback for pre-upgrade windows). Joining by display name
  // would silently drop after a `tmux ,` rename.
  const matchedWindowIds = new Set<string>();
  for (let i = 0; i < states.length; i++) {
    const state = states[i];
    const window = findWindowBySlug(windows, state.slug);
    if (window) matchedWindowIds.add(window.id);
    rows.push({
      name: state.slug,
      repo: path.basename(state.repo),
      phase: state.phase || "—",
      pr: state.pr ? `#${state.pr}` : "—",
      lastActivity: lastActivityFrom(state.updatedAt, nowMs),
      annotation: window ? "" : "(no window)",
      waitForCopilot: state.waitForCopilot === true,
      cost: costs ? costs[i] : undefined,
    });
  }

  // Surface windows that no state row claimed. They're not pipelines
  // flow owns, so fall back to the tmux-reported activity so the user
  // still sees something. Display the user-visible window name (the
  // slug column would be empty for unmanaged windows).
  for (const window of windows) {
    if (matchedWindowIds.has(window.id)) continue;
    rows.push({
      name: window.name,
      repo: "",
      phase: "—",
      pr: "—",
      lastActivity:
        window.activity > 0 ? relativeTime(window.activity * 1000, nowMs) : "—",
      annotation: "(no state)",
      waitForCopilot: false,
      cost: opts.cost ? EMPTY_COST : undefined,
    });
  }

  return rows;
}

function lastActivityFrom(
  updatedAt: string | undefined,
  nowMs: number,
): string {
  if (!updatedAt) return "—";
  const ms = Date.parse(updatedAt);
  if (!Number.isFinite(ms)) return "—";
  return relativeTime(ms, nowMs);
}

export function formatCostCell(cost: CostBreakdown | undefined): string {
  if (!cost || !cost.hasData) return "—";
  const prefix = cost.unknownModels.length > 0 ? "~" : "";
  return `${prefix}$${cost.total.toFixed(2)}`;
}

/** Renders the REPO column cell — an unmanaged `(no state)` row has no
 * repo, so the empty string falls back to the em-dash placeholder. */
export function formatRepoCell(repo: string): string {
  return repo || "—";
}

/** Composes the NAME cell: base name, then any drift annotation, then a
 * `(wait-copilot)` marker — the two coexist rather than excluding each other. */
export function formatNameCell(row: Row): string {
  let cell = row.name;
  if (row.annotation) cell += ` ${row.annotation}`;
  if (row.waitForCopilot) cell += " (wait-copilot)";
  return cell;
}

function printTable(rows: Row[], opts: LsOptions): void {
  type Col = { header: string; get: (r: Row) => string };
  const cols: Col[] = [
    { header: "NAME", get: (r) => formatNameCell(r) },
    { header: "REPO", get: (r) => formatRepoCell(r.repo) },
    { header: "PHASE", get: (r) => r.phase },
    { header: "PR", get: (r) => r.pr },
    { header: "LAST ACTIVITY", get: (r) => r.lastActivity },
  ];
  if (opts.cost)
    cols.push({ header: "$ COST", get: (r) => formatCostCell(r.cost) });

  const widths = cols.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => c.get(r).length)),
  );

  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]))
      .join("  ")
      .trimEnd();

  console.log(line(cols.map((c) => c.header)));
  for (const row of rows) console.log(line(cols.map((c) => c.get(row))));
}

function printDetail(rows: Row[]): void {
  const detailRows = rows.filter(
    (r) => r.cost?.hasData && Object.keys(r.cost.byModel).length > 0,
  );
  if (detailRows.length === 0) return;
  console.log("");
  for (const row of detailRows) {
    const parts = Object.entries(row.cost!.byModel)
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a)
      .map(
        ([model, dollars]) => `${friendlyName(model)} $${dollars.toFixed(2)}`,
      );
    console.log(`${row.name}: ${parts.join(" · ")}`);
  }
}

function warnUnknownModels(rows: Row[]): void {
  const unknown = new Set<string>();
  for (const row of rows) {
    for (const m of row.cost?.unknownModels ?? []) unknown.add(m);
  }
  if (unknown.size === 0) return;
  console.error(
    `flow ls: unknown model(s) — cost may be undercount: ${[...unknown].sort().join(", ")}`,
  );
}
