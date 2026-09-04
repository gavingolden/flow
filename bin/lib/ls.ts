/**
 * `flow ls` — join state files (~/.flow/state/<slug>.json) with tmux
 * windows from the flow session and print a status table.
 *
 * State source: a single global JSON file per pipeline. The supervisor
 * (PR 2) updates `phase` + `updatedAt` (and `pr` after step 5, `worktree`
 * after step 2) at every transition via `flow-state-update`. PR 1 wrote
 * the initial state with `phase: "starting"` from `flow feature create`.
 *
 * Annotation rule (phase-first, then liveness):
 *   - a TERMINAL phase (see `bin/lib/state.ts`) is checked FIRST, ahead of
 *     any liveness read: a dead/absent supervisor process is the EXPECTED
 *     end state there, not a crash. A FINISHED phase (merged, cancelled,
 *     epic-approved) renders "(done)"; an AWAITING_HUMAN phase (gated,
 *     needs-human) renders no annotation — the PHASE column already says
 *     what's outstanding. Carve-out: a row whose KIND is "epic-run" renders
 *     no "(done)" even at a FINISHED phase — its shared state.json's phase
 *     describes the *design* lifecycle, not run progress, so a live run
 *     window can sit at `epic-approved` (see `resolveRowKind` below).
 *   - otherwise, drift handling by liveness/window presence:
 *     - state file but no window → "(no window)" (likely a crashed session)
 *     - window but no state file → "(no state)" (manual creation)
 *     - both, and the recorded process is dead/stale → "(crashed)" (the
 *       file-signal liveness check — see `bin/lib/liveness.ts` — caught a
 *       window whose owning process died without the window itself closing)
 *     - both, and the process is alive (or no liveness signal is recorded)
 *       → no annotation
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
import {
  listStates,
  TERMINAL_PHASE_SET,
  FINISHED_PHASE_SET,
  AWAITING_HUMAN_PHASE_SET,
  isEpicPhase,
  type PipelineState,
  type PipelineKind,
} from "./state";
import { livenessOf } from "./liveness";
import { reapStartingOrphans } from "./reap-orphans";
import { relativeTime } from "./time";
import { findWindowBySlug, listWindows, type TmuxWindow } from "./tmux";
import { dim, dimStderr } from "./color";
import {
  checkForUpdate,
  formatUpdateNotice,
  type UpdateCheckResult,
} from "./update-check";
import {
  checkInstallDrift,
  formatDriftNotice,
  type InstallDriftResult,
} from "./install-drift";

export type LsOptions = {
  cost?: boolean;
  detail?: boolean;
  /** Override for tests; defaults to ~/.claude/projects/. */
  projectsRoot?: string;
  /** Injectable for tests; defaults to the real read-only update check. */
  checkUpdate?: () => UpdateCheckResult;
  /** Required (no default): the real read-only install-drift check. */
  checkDrift: () => InstallDriftResult;
};

export type Row = {
  name: string;
  repo: string;
  /**
   * Which supervisor kind this row is: `feature` / `epic-design` /
   * `epic-run`, sourced from `state.kind` (falling back to
   * `resolveRowKind`'s phase-derived default) — NEVER from the `@flow-kind`
   * tmux pane option. Empty ONLY for the unmanaged "(no state)" rows built
   * from a window with no state file, which have no PipelineState to read.
   */
  kind: PipelineKind | "";
  /** Epic slug from state.epic, or "" when this pipeline isn't epic-launched. */
  epic: string;
  phase: string;
  pr: string;
  lastActivity: string;
  annotation: "" | "(no window)" | "(no state)" | "(crashed)" | "(done)";
  /** True only when this row is a genuine crashed/orphaned session the user
   * should resume — derived once here in buildRows so the footer (below)
   * never has to re-infer eligibility from the display string. */
  needsResumeHint: boolean;
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
  return await runLs({ cost, detail, checkDrift: checkInstallDrift });
}

/**
 * Grace window for the lazy never-started orphan sweep: a phase=`starting`
 * state with no live window older than this is reaped (see `reap-orphans.ts`).
 * ~60s leaves a just-launched, still cold-starting supervisor untouched.
 */
const REAP_GRACE_MS = 60_000;

export async function runLs(opts: LsOptions): Promise<number> {
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
 * Prints a post-table recovery footnote for orphaned pipelines — rows whose
 * `needsResumeHint` is true (state file with no tmux window, typically a
 * crashed `flow feature create` whose window never stayed up, OR a window
 * that survived but the recorded process is dead/stale). Each gets its
 * one-command restart line. Kept BELOW the table (not inlined into the NAME
 * cell) because printTable derives column widths from cell lengths, so a
 * long `flow feature resume <slug>` string in the cell would widen the
 * whole table for every row. No-op when no orphan rows exist, so healthy
 * output is unchanged.
 *
 * Eligibility is read from `needsResumeHint`, a logical property set once
 * in `buildRows`, deliberately NOT inferred here from the `(crashed)` /
 * `(no window)` display strings. Decoupling the two is what makes the
 * phase-first branch (the fix for the mislabeling bug this PR addresses)
 * safe to add: footer eligibility stays a logical property computed
 * alongside the display string rather than re-derived from it, so a future
 * change to either one can't silently desync the other.
 */
export function printOrphanRecovery(rows: Row[]): void {
  const orphans = rows.filter((r) => r.needsResumeHint);
  if (orphans.length === 0) return;
  console.log("");
  console.log(
    dim("pipelines needing resume (no window, or crashed) — resume with:"),
  );
  for (const row of orphans) {
    console.log(dim(`  flow feature resume ${row.name}`));
  }
}

/** Print the staleness + drift notices to STDERR so stdout stays a clean table. */
function emitUpdateNotice(opts: LsOptions): void {
  const notice = formatUpdateNotice((opts.checkUpdate ?? checkForUpdate)());
  if (notice) console.error(notice);
  const driftNotice = formatDriftNotice(opts.checkDrift());
  if (driftNotice) console.error(dimStderr(driftNotice));
}

export async function buildRows(
  states: PipelineState[],
  windows: TmuxWindow[],
  nowMs: number,
  opts: LsOptions,
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
    // Phase-first, THEN liveness: a terminal phase means a dead supervisor
    // process is the EXPECTED end state, so the label is independent of
    // whether the state file even carries a pid — checking liveness first
    // would otherwise read a finished pipeline's absent process as a
    // "crash". Only a non-terminal phase falls through to the liveness
    // check below (the file-signal verdict outranks window existence there,
    // so a live PLAIN pipeline — no tmux window by design — is never
    // reaped-looking: `alive` ⇒ healthy "" (window or not); `dead`/`stale`
    // ⇒ "(crashed)"; only `unknown` — no pid signal, a legacy tmux-era
    // state — degrades to the window-existence check).
    //
    // needsResumeHint is derived exactly once, right here, alongside
    // annotation, so the two can never disagree — the footer below merely
    // reads it rather than re-deriving eligibility from the phase or the
    // display string.
    const rowKind = resolveRowKind(state);
    let annotation: Row["annotation"];
    let needsResumeHint: boolean;
    if (TERMINAL_PHASE_SET.has(state.phase)) {
      // Two buckets, both with a real call site: FINISHED -> "(done)",
      // AWAITING_HUMAN (gated/needs-human) -> no annotation (the pipeline
      // isn't "done" in the sense flow-ls should label it). An "epic-run"
      // row is a THIRD, sibling carve-out, but ONLY while its run window is
      // still live: its shared state.json describes the *design*
      // lifecycle's phase, not the run's — `phase` can sit at a FINISHED
      // value (e.g. `epic-approved`) while the run window is still live, so
      // "(done)" would mislabel it. Once the window is gone (finished or
      // never launched), there is nothing left to distinguish from a truly
      // finished row, so "(done)" is correct again — suppress only when a
      // window is actually present. Mirrors `autoResumesAfterClear`'s
      // `kind === "epic-run"` carve-out (`bin/lib/state.ts:643`) — the two
      // predicates answer different questions (whether to auto-resume vs.
      // how to label) and only happen to agree here, so this is a
      // documented sibling, not a shared helper. Deliberately does NOT fall
      // through to `livenessOf` below: no pid is recorded for the run
      // window, so a live run would misread as "(crashed)".
      annotation =
        FINISHED_PHASE_SET.has(state.phase) &&
        !(rowKind === "epic-run" && window)
          ? "(done)"
          : AWAITING_HUMAN_PHASE_SET.has(state.phase)
            ? ""
            : "";
      needsResumeHint = false;
    } else {
      const verdict = livenessOf(state);
      if (verdict === "alive") {
        annotation = "";
        needsResumeHint = false;
      } else if (verdict === "dead" || verdict === "stale") {
        annotation = "(crashed)";
        needsResumeHint = true;
      } else {
        annotation = window ? "" : "(no window)";
        needsResumeHint = !window;
      }
    }
    rows.push({
      name: state.slug,
      repo: path.basename(state.repo),
      kind: rowKind,
      // A non-feature row (epic-design/epic-run) has no `state.epic`
      // membership of its own — it falls back to its OWN slug, mirroring
      // `epic.ts`'s `setWindowEpic(slug, slug)` self-publish rationale, so
      // an epic supervisor's row still shows something under EPIC. A
      // feature row's absent membership stays "" (not epic-launched).
      epic: state.epic?.slug ?? (rowKind === "feature" ? "" : state.slug),
      phase: state.phase || "—",
      pr: state.pr ? `#${state.pr}` : "—",
      lastActivity: lastActivityFrom(state.updatedAt, nowMs),
      annotation,
      needsResumeHint,
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
      kind: "",
      epic: "",
      phase: "—",
      pr: "—",
      lastActivity:
        window.activity > 0 ? relativeTime(window.activity * 1000, nowMs) : "—",
      annotation: "(no state)",
      needsResumeHint: false,
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

/** Renders the EPIC column cell — empty when this pipeline isn't
 * epic-launched (never derived from tmux; state.json is the source). */
export function formatEpicCell(epic: string): string {
  return epic || "—";
}

/**
 * Which supervisor kind a managed row is. Prefers the persisted
 * `state.kind` (Task 2); absent (a pre-existing state file, or a legacy one
 * from before this field existed) falls back to the phase-derived default —
 * `isEpicPhase` cannot itself distinguish epic-design from epic-run sharing
 * one state file (`bin/lib/state.ts`'s `isEpicPhase` doc comment), so the
 * fallback can only ever resolve to "epic-design", never "epic-run".
 */
export function resolveRowKind(state: PipelineState): PipelineKind {
  return state.kind ?? (isEpicPhase(state.phase) ? "epic-design" : "feature");
}

/** Renders the KIND column cell — mirrors `formatEpicCell`. */
export function formatKindCell(kind: Row["kind"]): string {
  return kind || "—";
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
    { header: "KIND", get: (r) => formatKindCell(r.kind) },
    { header: "REPO", get: (r) => formatRepoCell(r.repo) },
    { header: "EPIC", get: (r) => formatEpicCell(r.epic) },
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
