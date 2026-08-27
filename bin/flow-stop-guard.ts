#!/usr/bin/env bun
/**
 * Claude Code Stop hook for the /flow-pipeline supervisor.
 *
 * Reads `~/.flow/state/<slug>.json` (slug resolved env-first from
 * `FLOW_SLUG`, falling back to the tmux window's `@flow-slug` user
 * option) at every turn-end and blocks the stop
 * (exit 2 + stderr reminder) when the phase is non-terminal-non-pending
 * — the supervisor is mid-pipeline and the contract says "do not end
 * the turn between sub-skills." This is the structural defence the
 * three text-layer reminders (leading blockquote, inline continue-
 * immediately sentences, flow-checkpoint) could not provide: those all
 * fire only after the model has already chosen to keep going; this hook
 * fires *at* the model's turn-end signal.
 *
 * Self-detection: the hook exits 0 when NO flow slug resolves (no
 * `FLOW_SLUG` env var, and no tmux pane carrying `@flow-slug`), or when
 * state.json is missing — making it safe to install in a global
 * Stop-hook list. A normal coding session sees no behaviour change.
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
import { resolveSlugFromEnv } from "./lib/session-identity";
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
import {
  dirtyEpicMetadata as defaultDirtyEpicPaths,
  repoCommitState as defaultRepoCommitState,
  type RepoState,
} from "./lib/epic-metadata-commit";

type HookInput = {
  stop_hook_active?: boolean;
};

export type Deps = {
  readStdin: () => Promise<string>;
  /** FLOW_SLUG env value (env-first ambient slug; both launcher backends set it). */
  flowSlugEnv?: string | undefined;
  tmuxPane: string | undefined;
  showFlowSlug: (pane: string) => string;
  loadState: (slug: string) => PipelineState | null;
  writeErr: (s: string) => void;
  readTurn: (slug: string) => TurnTracking | null;
  writeTurn: (tracking: TurnTracking) => void;
  nowIso: () => string;
  /** `.flow/epics/**` dirty-path probe (test seam; production: epic-metadata-commit.ts). */
  dirtyEpicPaths: (repoRoot: string) => string[];
  /** Repo commit-state probe (test seam; production: epic-metadata-commit.ts). */
  repoCommitState: (repoRoot: string) => RepoState;
};

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}

/**
 * SATISFIABLE-ROUTE INVARIANT: may only name routes the session can execute
 * IN THIS TURN. A status.json board is committable on the base branch via
 * the v4 allowlist (`flow-epic-sync --commit --push`); any other
 * `.flow/epics/**` path (manifest.json, design.md, ...) needs the full
 * switch-commit-switch-back sequence — the base-branch guard refuses only
 * when HEAD IS the default branch, so switching off it first makes the
 * commit legal, and switching back is MANDATORY or the primary checkout is
 * left parked on a feature branch, silently breaking every downstream
 * base-branch assumption.
 */
export function buildEpicMetadataReminder(
  paths: string[],
  ctx: { onBaseBranch: boolean; repoState: RepoState },
): string[] {
  const lines = [
    `flow-stop-guard: uncommitted .flow/epics/** metadata: ${paths.join(", ")}.`,
    "This must never leave the epic — commit it THIS TURN via the sanctioned route below, then continue.",
  ];
  for (const p of paths) {
    const match = p.match(/^\.flow\/epics\/([^/]+)\/status\.json$/);
    if (match) {
      lines.push(
        `  ${p}: run \`flow-epic-sync --epic-slug ${match[1]} --commit --push\`.`,
      );
    } else {
      const epicMatch = p.match(/^\.flow\/epics\/([^/]+)\//);
      const epic = epicMatch ? epicMatch[1] : "the epic";
      lines.push(
        `  ${p}: run \`git switch -c flow-epic-amend/${epic}\`, commit it there, ` +
          "then `git switch -` to return the checkout to the base branch — " +
          "the base-branch guard refuses this path on the base branch directly.",
      );
    }
  }
  if (ctx.onBaseBranch) {
    lines.push(
      "(the repo is currently on the base branch — the status.json route above applies directly there)",
    );
  }
  return lines;
}

export async function run(deps: Deps): Promise<number> {
  let input: HookInput = {};
  try {
    const raw = (await deps.readStdin()).trim();
    if (raw.length > 0) input = JSON.parse(raw) as HookInput;
  } catch {
    // Malformed JSON from the harness shouldn't break turn-end. Treat
    // as "no hook input" and fall through to the rest of the checks.
  }

  // Env-first slug resolution: FLOW_SLUG (shape-validated) wins; only when
  // NO slug resolves from either source is this a non-flow session (exit 0).
  let slug =
    resolveSlugFromEnv({ FLOW_SLUG: deps.flowSlugEnv } as NodeJS.ProcessEnv) ??
    "";
  if (slug.length === 0) {
    const pane = deps.tmuxPane;
    if (pane) slug = deps.showFlowSlug(pane).trim();
  }
  if (slug.length === 0) return 0;

  const state = deps.loadState(slug);
  if (!state) return 0;

  const now = deps.nowIso();
  const prior = deps.readTurn(slug);
  const turnBoundary = input.stop_hook_active === false || prior === null;
  let tracking: TurnTracking = turnBoundary
    ? {
        slug,
        turnId: now,
        blockCount: 0,
        lastPhase: state.phase,
        lastStopAt: now,
      }
    : prior!;

  if (turnBoundary) deps.writeTurn(tracking);

  // Fires BEFORE the terminal-phase early return below — the epic-run
  // window shares a state file whose phase is already terminal, so a check
  // placed after that return would never fire for the exact session that
  // produced this bug.
  const repoRoots = dedupe(
    [state.repo, state.worktree].filter(
      (r): r is string => typeof r === "string" && r.length > 0,
    ),
  );
  const dirtyByRoot = repoRoots.map((r) => ({
    root: r,
    paths: deps.dirtyEpicPaths(r),
  }));
  const dirty = dedupe(dirtyByRoot.flatMap((r) => r.paths));
  if (dirty.length > 0) {
    // ZERO-COST GUARANTEE: repoCommitState is called ONLY here, inside the
    // dirty-detected branch, so a clean/non-epic repo spawns nothing extra.
    const repoState = deps.repoCommitState(state.repo);
    if (repoState !== "clean") {
      deps.writeErr(
        `flow-stop-guard: .flow/epics/** is dirty (${dirty.join(", ")}) but the repo is mid-${repoState}; not safe to commit this turn. Resolve the ${repoState} first.\n`,
      );
      return 0; // diagnostic only — no block slot consumed
    }
    if (tracking.blockCount >= TURN_BLOCK_LIMIT) {
      deps.writeErr(
        `flow-stop-guard: loop-break consumed with .flow/epics/** still dirty (${dirty.join(", ")}); subsequent stops will exit 0. Continue per AGENTS.md "Auto-commit exemption: flow-epic-sync --commit".\n`,
      );
      tracking = { ...tracking, lastStopAt: now };
      deps.writeTurn(tracking);
      return 0;
    }
    tracking = {
      ...tracking,
      blockCount: tracking.blockCount + 1,
      lastStopAt: now,
    };
    deps.writeTurn(tracking);
    // state.repo is the canonical base-branch checkout in flow's
    // architecture (state.worktree is the per-pipeline feature branch), so
    // a dirty path reported against state.repo means the repo IS on (or
    // very near) the base branch.
    const onBaseBranch = dirtyByRoot.some(
      (r) => r.root === state.repo && r.paths.length > 0,
    );
    deps.writeErr(
      buildEpicMetadataReminder(dirty, { onBaseBranch, repoState }).join("\n") +
        "\n",
    );
    return 2;
  }

  if (isLegitimateEndPhase(state.phase)) {
    tracking = { ...tracking, lastStopAt: now };
    deps.writeTurn(tracking);
    return 0;
  }

  if (
    tracking.blockCount >= TURN_BLOCK_LIMIT &&
    state.phase !== tracking.lastPhase
  ) {
    deps.writeErr(
      `flow-stop-guard: loop-break consumed at phase=${state.phase}; subsequent stops will exit 0 only if phase keeps advancing — stalling at this phase re-engages the stagnation reminder. Continue per /flow-pipeline SKILL.md.\n`,
    );
    tracking = { ...tracking, lastPhase: state.phase, lastStopAt: now };
    deps.writeTurn(tracking);
    return 0;
  }

  if (
    tracking.blockCount >= TURN_BLOCK_LIMIT &&
    state.phase === tracking.lastPhase
  ) {
    const reminder = buildStagnationReminder(
      state.phase,
      tracking.blockCount + 1,
    );
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
  starting:
    "step 1 (triage) — first action should be flow-state-update --phase triaging",
  triaging: "step 2 (worktree-create)",
  "worktree-create": "step 3 (plan)",
  planning: "step 4 (approval) for feature intent, else step 5 (implement)",
  implementing: "step 5.5 (installing-skills)",
  "installing-skills": "step 6 (verify)",
  verifying: "step 7 (ci-wait)",
  "ci-wait": "step 8 (review)",
  "ci-wait-pending":
    "step 7 (ci-wait) — run flow-ci-check and branch on .status/.decision",
  reviewing: "step 9 (gate)",
  gating: "step 10 (merge)",
  merging:
    "step 10 → step 11 (finalize merge, run local follow-ups, then MERGED)",
};

export function nextStepLabel(phase: string): string {
  return (
    NEXT_STEP_BY_PHASE[phase] ?? "the next step in /flow-pipeline SKILL.md"
  );
}

export function buildReminder(phase: string, next: string): string[] {
  const pendingList = PENDING_PHASES.join(", ");
  return [
    `flow-stop-guard: phase=${phase}; the supervisor must continue to ${next} per /flow-pipeline SKILL.md.`,
    `Legitimate end-states are MERGED, GATED, NEEDS HUMAN, cancelled, and the pending phases (${pendingList}).`,
    "DO NOT END THE TURN — proceed to the next step now.",
  ];
}

export function buildStagnationReminder(
  phase: string,
  count: number,
): string[] {
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
    flowSlugEnv: process.env.FLOW_SLUG,
    tmuxPane: process.env.TMUX_PANE,
    showFlowSlug: defaultShowFlowSlug,
    loadState: (slug) => readState(slug),
    writeErr: (s) => process.stderr.write(s),
    readTurn: (slug) => readTurnTracking(slug),
    writeTurn: (t) => writeTurnTracking(t),
    nowIso: defaultNowIso,
    dirtyEpicPaths: (repoRoot) => defaultDirtyEpicPaths({ repoRoot }),
    repoCommitState: (repoRoot) => defaultRepoCommitState({ repoRoot }),
  }).then((code) => process.exit(code));
}
