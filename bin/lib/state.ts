/**
 * Per-pipeline state at ~/.flow/state/<slug>.json. Global (not per-worktree)
 * so `flow ls` reads one directory and state survives worktree cleanup.
 *
 * Schema is deliberately small. Writers:
 *   - `flow new`         creates with phase: "starting"
 *   - `flow-state-update` updates phase / pr / worktree at every transition
 *   - `flow done`        removes
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FLOW_STATE_DIR } from "./paths";

export type PipelineState = {
  slug: string;
  phase: string;
  pr?: number;
  repo: string;
  worktree?: string;
  /**
   * When false, `/flow-pipeline` step 9 routes every OPEN PR to gated
   * regardless of the Test Steps rubric. Absent ≡ true (the
   * documented happy-path default).
   */
  autoMerge?: boolean;
  updatedAt: string;
};

/**
 * Phases at which the supervisor is permitted to end its turn.
 * `flow-stop-guard` reads state.json and exits 0 for any phase in
 * `TERMINAL_PHASES ∪ PENDING_PHASES`; every other phase is blocked
 * with a stderr reminder.
 *
 * Terminal: pipeline is finished. Pending: legitimately waiting for
 * the user (plan approval, single clarifying question) or the
 * no-change branch of step 1.
 */
export const TERMINAL_PHASES = [
  "merged",
  "gated",
  "needs-human",
  "cancelled",
] as const;

export const PENDING_PHASES = [
  "plan-pending-review",
  "triaged-no-change",
  "triage-pending-clarification",
  "approval-pending-clarification",
] as const;

export const STEP_PHASES = [
  "starting",
  "triaging",
  "worktree-create",
  "planning",
  "implementing",
  "installing-skills",
  "verifying",
  "ci-wait",
  "reviewing",
  "gating",
  "merging",
] as const;

export const PIPELINE_PHASES = [
  ...STEP_PHASES,
  ...PENDING_PHASES,
  ...TERMINAL_PHASES,
] as const;

export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

export const PIPELINE_PHASE_SET: ReadonlySet<string> = new Set(PIPELINE_PHASES);

export function isPipelinePhase(value: string): value is PipelinePhase {
  return PIPELINE_PHASE_SET.has(value);
}

export function isLegitimateEndPhase(value: string): boolean {
  return (
    (TERMINAL_PHASES as readonly string[]).includes(value) ||
    (PENDING_PHASES as readonly string[]).includes(value)
  );
}

export function statePath(slug: string, dir = FLOW_STATE_DIR): string {
  return path.join(dir, `${slug}.json`);
}

function isPipelineState(x: unknown): x is PipelineState {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.slug !== "string") return false;
  if (typeof o.phase !== "string") return false;
  if (typeof o.repo !== "string") return false;
  if (typeof o.updatedAt !== "string") return false;
  if (o.pr !== undefined && typeof o.pr !== "number") return false;
  if (o.worktree !== undefined && typeof o.worktree !== "string") return false;
  if (o.autoMerge !== undefined && typeof o.autoMerge !== "boolean") return false;
  return true;
}

export function readState(slug: string, dir = FLOW_STATE_DIR): PipelineState | null {
  const file = statePath(slug, dir);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isPipelineState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeState(state: PipelineState, dir = FLOW_STATE_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath(state.slug, dir), JSON.stringify(state, null, 2) + "\n");
}

export function deleteState(slug: string, dir = FLOW_STATE_DIR): boolean {
  try {
    fs.unlinkSync(statePath(slug, dir));
    return true;
  } catch {
    return false;
  }
}

// Rejects legacy `<slug>.turn.json` (and any other `<slug>.X.json`) turn-tracking
// files that used to live at the state dir root before they moved to `turns/`.
export function isMainStateFile(name: string): boolean {
  return /^[^.]+\.json$/.test(name);
}

export function listStates(dir = FLOW_STATE_DIR): PipelineState[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const states: PipelineState[] = [];
  for (const e of entries) {
    if (!e.isFile() || !isMainStateFile(e.name)) continue;
    const slug = e.name.replace(/\.json$/, "");
    const state = readState(slug, dir);
    if (state) states.push(state);
  }
  return states;
}

export function nowIso(): string {
  return new Date().toISOString();
}
