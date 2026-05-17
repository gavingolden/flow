#!/usr/bin/env bun
/**
 * Claude Code Stop hook for the /flow-pipeline supervisor.
 *
 * Reads `~/.flow/state/<slug>.json` (slug from the tmux window's
 * `@flow-slug` user option) at every turn-end and blocks the stop
 * (exit 2 + stderr reminder) when the phase is non-terminal-non-pending
 * — the supervisor is mid-pipeline and the contract says "do not end
 * the turn between sub-skills." This is the structural defence the
 * three text-layer reminders (leading blockquote, inline continue-
 * immediately sentences, flow-checkpoint) could not provide: those all
 * fire only after the model has already chosen to keep going; this hook
 * fires *at* the model's turn-end signal.
 *
 * Self-detection: the hook exits 0 when not in tmux, when the current
 * window has no `@flow-slug` option, or when state.json is missing —
 * making it safe to install in a global Stop-hook list. A normal
 * coding session sees no behaviour change.
 *
 * Per-turn tracking: the hook owns its own block counter at
 * `~/.flow/state/turns/<slug>.json` (a sibling subdirectory so
 * `state.ts`'s `listStates()` does not pick the file up as a phantom
 * pipeline). After one block this turn (TURN_BLOCK_LIMIT), subsequent
 * stops exit 0 only when phase has advanced since the block (phase-
 * advance loop-break, emits a stderr breadcrumb); otherwise stagnation
 * re-engages with a "phase has not advanced" reminder. `stop_hook_active`
 * is treated as advisory (used to detect turn boundaries) rather than
 * authoritative budget.
 */

import { spawnSync } from "node:child_process";
import {
  isLegitimateEndPhase,
  nowIso as defaultNowIso,
  PENDING_PHASES,
  readState,
  type PipelineState,
} from "./lib/state";
import {
  readTurnTracking,
  TURN_BLOCK_LIMIT,
  writeTurnTracking,
  type TurnTracking,
} from "./lib/stop-turn-tracking";

type HookInput = {
  stop_hook_active?: boolean;
};

export type Deps = {
  readStdin: () => Promise<string>;
  tmuxPane: string | undefined;
  showFlowSlug: (pane: string) => string;
  loadState: (slug: string) => PipelineState | null;
  writeErr: (s: string) => void;
  readTurn: (slug: string) => TurnTracking | null;
  writeTurn: (tracking: TurnTracking) => void;
  nowIso: () => string;
};

export async function run(deps: Deps): Promise<number> {
  let input: HookInput = {};
  try {
    const raw = (await deps.readStdin()).trim();
    if (raw.length > 0) input = JSON.parse(raw) as HookInput;
  } catch {
    // Malformed JSON from the harness shouldn't break turn-end. Treat
    // as "no hook input" and fall through to the rest of the checks.
  }

  const pane = deps.tmuxPane;
  if (!pane) return 0;

  const slug = deps.showFlowSlug(pane).trim();
  if (slug.length === 0) return 0;

  const state = deps.loadState(slug);
  if (!state) return 0;

  const now = deps.nowIso();
  const prior = deps.readTurn(slug);
  const turnBoundary = input.stop_hook_active === false || prior === null;
  let tracking: TurnTracking = turnBoundary
    ? { slug, turnId: now, blockCount: 0, lastPhase: state.phase, lastStopAt: now }
    : prior!;

  if (turnBoundary) deps.writeTurn(tracking);

  if (isLegitimateEndPhase(state.phase)) {
    tracking = { ...tracking, lastStopAt: now };
    deps.writeTurn(tracking);
    return 0;
  }

  if (tracking.blockCount >= TURN_BLOCK_LIMIT && state.phase !== tracking.lastPhase) {
    deps.writeErr(
      `flow-stop-guard: loop-break consumed at phase=${state.phase}; subsequent stops will exit 0 only if phase keeps advancing — stalling at this phase re-engages the stagnation reminder. Continue per /flow-pipeline SKILL.md.\n`,
    );
    tracking = { ...tracking, lastPhase: state.phase, lastStopAt: now };
    deps.writeTurn(tracking);
    return 0;
  }

  if (tracking.blockCount >= TURN_BLOCK_LIMIT && state.phase === tracking.lastPhase) {
    const reminder = buildStagnationReminder(state.phase, tracking.blockCount + 1);
    for (const line of reminder) deps.writeErr(`${line}\n`);
    tracking = {
      ...tracking,
      blockCount: tracking.blockCount + 1,
      lastStopAt: now,
    };
    deps.writeTurn(tracking);
    return 2;
  }

  const next = nextStepLabel(state.phase);
  const reminder = buildReminder(state.phase, next);
  for (const line of reminder) deps.writeErr(`${line}\n`);
  tracking = {
    ...tracking,
    blockCount: tracking.blockCount + 1,
    lastPhase: state.phase,
    lastStopAt: now,
  };
  deps.writeTurn(tracking);
  return 2;
}

export const NEXT_STEP_BY_PHASE: Record<string, string> = {
  starting: "step 1 (triage) — first action should be flow-state-update --phase triaging",
  triaging: "step 2 (worktree-create)",
  "worktree-create": "step 3 (plan)",
  planning: "step 4 (approval) for feature intent, else step 5 (implement)",
  implementing: "step 5.5 (installing-skills)",
  "installing-skills": "step 6 (verify)",
  verifying: "step 7 (ci-wait)",
  "ci-wait": "step 8 (review)",
  reviewing: "step 9 (gate)",
  gating: "step 10 (merge)",
  merging: "step 10 → step 11 (finalize merge, run local follow-ups, then MERGED)",
};

export function nextStepLabel(phase: string): string {
  return NEXT_STEP_BY_PHASE[phase] ?? "the next step in /flow-pipeline SKILL.md";
}

export function buildReminder(phase: string, next: string): string[] {
  const pendingList = PENDING_PHASES.join(", ");
  return [
    `flow-stop-guard: phase=${phase}; the supervisor must continue to ${next} per /flow-pipeline SKILL.md.`,
    `Legitimate end-states are MERGED, GATED, NEEDS HUMAN, cancelled, and the pending phases (${pendingList}).`,
    "DO NOT END THE TURN — proceed to the next step now.",
  ];
}

export function buildStagnationReminder(phase: string, count: number): string[] {
  return [
    `flow-stop-guard: phase has not advanced for ${count} consecutive stops; phase=${phase}.`,
    "The supervisor must continue to the next step per /flow-pipeline SKILL.md, or transition to a legitimate end-state if blocked.",
    "DO NOT END THE TURN — proceed to the next step now.",
  ];
}

export function defaultShowFlowSlug(pane: string): string {
  const r = spawnSync(
    "tmux",
    ["show-options", "-w", "-t", pane, "-q", "-v", "@flow-slug"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return "";
  return r.stdout ?? "";
}

async function defaultReadStdin(): Promise<string> {
  // Bun.stdin.text() reads stdin to EOF; on a TTY (no piped input) this
  // can hang, so the helper bails after a short wait. Claude Code always
  // pipes JSON when invoking a Stop hook, so the hang case is only hit
  // when a developer runs the helper by hand.
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    process.stdin.on("data", (c) => chunks.push(c as Uint8Array));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    setTimeout(finish, 250);
  });
}

if (import.meta.main) {
  run({
    readStdin: defaultReadStdin,
    tmuxPane: process.env.TMUX_PANE,
    showFlowSlug: defaultShowFlowSlug,
    loadState: (slug) => readState(slug),
    writeErr: (s) => process.stderr.write(s),
    readTurn: (slug) => readTurnTracking(slug),
    writeTurn: (t) => writeTurnTracking(t),
    nowIso: defaultNowIso,
  }).then((code) => process.exit(code));
}
