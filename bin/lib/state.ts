/**
 * Per-pipeline state at ~/.flow/state/<slug>.json. Global (not per-worktree)
 * so `flow ls` reads one directory and state survives worktree cleanup.
 *
 * Schema is deliberately small. Writers:
 *   - `flow feature create`         creates with phase: "starting"
 *   - `flow-state-update` updates phase / pr / worktree at every transition
 *   - `flow done`        removes
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FLOW_STATE_DIR } from "./paths";
import { CHECKPOINT_SITES } from "./checkpoint-freshness";

/**
 * Reasoning-effort levels accepted by `claude --effort`. Single source of
 * truth: `feature.ts` imports this for `flow feature create --effort` validation; help text
 * and completion scripts necessarily restate the literals as plain strings.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Model aliases accepted by `claude --model`. Single source of truth: `feature.ts`
 * and `epic.ts` import this for `flow feature create --model` / `flow epic create --model`
 * validation; help text and completion scripts necessarily restate the literals
 * as plain strings. Absent ≡ the Claude Code default model (no `--model` flag
 * passed). flow forwards the alias verbatim — it does not translate to a full
 * model id.
 */
export const MODEL_ALIASES = ["opus", "haiku", "sonnet", "fable"] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

/**
 * The seven per-phase model override fields on `PipelineState`, paired with the
 * `flow feature create --model-<phase>` flag that sets each. Single source of
 * truth for the parse loop (`feature.ts`), the state validator
 * (`isPipelineState`), and the tests. The gatekeeper is deliberately absent —
 * it stays pinned to `model: "haiku"` and gets no flag. `scout`/`coder` are
 * config-only fine-grain (no flags), so they are not here either.
 */
export const PHASE_MODEL_FLAGS = [
  { flag: "--model-planning", field: "modelPlanning" },
  { flag: "--model-implement", field: "modelImplement" },
  { flag: "--model-review", field: "modelReview" },
  { flag: "--model-verify", field: "modelVerify" },
  { flag: "--model-fix-applier", field: "modelFixApplier" },
  { flag: "--model-consolidator", field: "modelConsolidator" },
  { flag: "--model-merge-resolver", field: "modelMergeResolver" },
] as const;
export const PHASE_MODEL_FIELDS = PHASE_MODEL_FLAGS.map(
  (f) => f.field,
) as readonly string[];

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
  /**
   * When true, `flow-ci-wait` waits the full 10-min Copilot timeout
   * even when the auto-detect signals (no Copilot review by the
   * claim-deadline, or self-dismissed on the current SHA) would skip.
   * Absent ≡ false (auto-detect ON — the documented default).
   */
  waitForCopilot?: boolean;
  /**
   * When true, discovery Step 1.5 forces the web-grounded research pre-check on
   * and bypasses the relevance gate (and the research.discovery config opt-in).
   * Absent ≡ not forced.
   */
  forceResearch?: boolean;
  /**
   * Tri-state opt-in for Copilot review on this pipeline's PR. `'always'`
   * always requests, `'never'` never requests, `'auto'` defers to the
   * hybrid glob/inline-judgment classifier. Set via `flow feature create
   * --copilot-review <auto|always|never>`. Absent ≡ `'auto'` (the
   * documented default).
   */
  copilotReview?: "auto" | "always" | "never";
  /**
   * Claude Code reasoning-effort level for this pipeline's claude session.
   * Set via `flow feature create --effort <low|medium|high|xhigh|max>` and re-applied
   * to the respawn argv on `flow feature resume`. Absent ≡ the Claude Code
   * default (no `--effort` flag passed).
   */
  effort?: EffortLevel;
  /**
   * Claude Code model alias for this pipeline's claude session. Set via
   * `flow feature create --model <opus|haiku|sonnet|fable>` (or `flow epic create
   * --model …`) and re-applied to the respawn argv on `--resume`. Absent ≡
   * the Claude Code default model (no `--model` flag passed).
   */
  model?: ModelAlias;
  /**
   * Per-phase Claude model overrides for this pipeline's fan-out sub-agents,
   * set via `flow feature create --model-<phase> <alias>`. Each is resolved by
   * the supervisor at its named Task-spawn site as
   * `state.<field> // config.models.<phase> // inherited session model`
   * (with the verify `sonnet`-default and scout/coder config-only-fine-grain
   * exceptions documented at their spawn sites). All optional-additive: absent
   * ≡ inherit (no migration; AGENTS.md forbids back-compat shims). The gatekeeper
   * has no field — it stays pinned to `model: "haiku"` by design.
   */
  modelPlanning?: ModelAlias;
  modelImplement?: ModelAlias;
  modelReview?: ModelAlias;
  modelVerify?: ModelAlias;
  modelFixApplier?: ModelAlias;
  modelConsolidator?: ModelAlias;
  modelMergeResolver?: ModelAlias;
  /**
   * Claude Code session ID captured by `flow-open-pr` at PR-open time.
   * Carries the ID to `/flow-pipeline` step 10, which emits it as a
   * `Claude-Code-Session-Id:` squash-commit trailer. Absent when the PR
   * was opened outside a Claude Code harness.
   */
  sessionId?: string;
  /**
   * The chat answer the supervisor gave the user on the no-change branch of
   * step 1, persisted by `flow-state-update --phase triaged-no-change
   * --answer`. A no-change pipeline has no worktree to store the answer under,
   * so it lives here to be re-surfaced by `flow-resume-decide` on resume.
   * Absent on every pipeline that never took the no-change branch.
   */
  answer?: string;
  /**
   * The persisted interview digest for the intent interview (adaptive),
   * written via `flow-state-update --interview-stdin` at the end of each
   * round (step 1's `triage-pending-interview` and step 3's
   * `plan-pending-interview`). Byte-verbatim, like `--answer-stdin`.
   * Re-rendered on resume by `flow-resume-decide`. Absent on every
   * pipeline that never triggered the interview.
   */
  interview?: string;
  /**
   * Per-run override for the intent interview trigger, set via
   * `flow feature create --interview` (force) or `--no-interview` (skip).
   * Mutually exclusive; absent when neither flag was passed, in which case
   * the trigger falls back to the `interview-playbook.md` judgment gate and
   * `config.json`'s `interview.enabled`.
   */
  interviewMode?: "force" | "skip";
  /**
   * Fresh-confirmation token for a gate override. Written by
   * `flow-merge-guard --record-override` after the user gives an
   * unambiguous, in-context instruction — confirmed via `AskUserQuestion`
   * — to merge a `gated` PR anyway. `flow-merge-guard` (check mode)
   * honours it only when `pr` matches the PR being merged and `confirmedAt`
   * is inside the freshness window (see `bin/flow-merge-guard.ts`). Absent
   * on every pipeline that never overrode a gate.
   */
  gateOverride?: { pr: number; confirmedAt: string };
  /**
   * Deterministic epic membership from `flow feature create --epic
   * <epic-slug>/<feature-id>` (set automatically by `flow epic launch`, or
   * directly by a human launching an epic feature manually). `/flow-pipeline`
   * step 3 reads this to thread an `EPIC: <slug>/<featureId>` marker into the
   * discovery spawn prompt — the primary epic-detection signal (the
   * description pointer and manifest scan are fallbacks). Optional-additive:
   * absent ≡ not epic-launched; no migration (AGENTS.md: no back-compat
   * shims).
   */
  epic?: { slug: string; featureId: string };
  /**
   * Append-only phase-transition history, one entry per `flow-state-update
   * --phase` write. Feeds the `## PIPELINE SNAPSHOT` block's PHASES section
   * (`flow-pipeline-summary`) with an authoritative trace instead of
   * supervisor-composed prose. `outcome` is the optional `--phase-outcome`
   * string (absent on phases with no short verdict). Absent on every
   * pipeline that predates the field — no migration (AGENTS.md: no
   * back-compat shims).
   */
  phaseLog?: Array<{ phase: string; outcome?: string; at: string }>;
  /**
   * Timestamp the `flow-seed-ingested-hook` (a Claude Code UserPromptSubmit
   * hook) stamps the instant the seed prompt is accepted inside a flow
   * session. The launcher's `consumed()` predicate treats its presence (plus a
   * live pane) as launch-time confirmation the seed was ingested, upgrading the
   * lazy orphan-reaper's eventual-consistency guarantee to a launch-time one;
   * the reaper remains the fallback when the marker is absent (old sessions,
   * hook-not-fired). Additive — no migration (AGENTS.md: no back-compat shims).
   */
  seedIngestedAt?: string;
  /**
   * Crash-safe liveness signal: the OS-level PID of the pane's foreground
   * process at launch time (see `tmux.panePid`), paired with `procStartedAt`
   * below. Together they let `livenessOf` (`bin/lib/liveness.ts`)
   * distinguish "still running", "crashed", and "PID recycled by an
   * unrelated process" without depending on the tmux window surviving.
   * Absent ≡ degrade to legacy `windowExists`/`isPaneAlive`-based behavior
   * (old-format state files, or a launch that predates this field).
   */
  pid?: number;
  /**
   * Absolute epoch seconds the process identified by `pid` started, from
   * `liveness.pidStartEpoch`. Combined with `pid`, this is what lets
   * `livenessOf` tell a still-alive original process apart from a different
   * process that was later assigned the same recycled PID: a mismatch
   * between the recorded and current start time flags the PID as reused,
   * not alive. Absent ≡ degrade to legacy `windowExists`/`isPaneAlive`-based
   * behavior, same as `pid`.
   */
  procStartedAt?: number;
  /**
   * The launcher backend this pipeline was created under. `flow feature
   * resume` reuses it (flag > state > config > default precedence).
   * Optional-additive: absent ≡ a legacy tmux-era pipeline (no migration;
   * AGENTS.md forbids back-compat shims).
   */
  launcher?: "plain" | "tmux";
  /**
   * Launch-breadcrumb pair (tmux-backed launches only): how many verified
   * launch attempts the create/resume took (1-based) and the outcome of the
   * attempt that succeeded. Optional-additive like `pid`/`procStartedAt`/
   * `launcher` above; absent ≡ unknown (no migration).
   */
  launchAttempts?: number;
  launchOutcome?: "started" | "launched-not-confirmed";
  /**
   * Freshness record for the `/flow-checkpoint` non-clobbering guard.
   * Written by `flow-checkpoint`'s arm path (a plain state write, never
   * `flow-state-update`, so `updatedAt` is deliberately NOT bumped — an
   * arm is not a pipeline phase transition). `site` names who armed it
   * (`"manual"` for the user-facing `/flow-checkpoint` skill's default, or
   * one of the auto sites); `phase` is the pipeline phase at arm time;
   * `armedAt` is the arm timestamp `probeFreshness` compares against
   * `phaseLog` to decide whether the body is still fresh. Absent ≡ no
   * recorded arm (a legacy body, or one written before this field existed;
   * `probeFreshness` falls back to mtime-vs-`phaseLog` in that case — no
   * migration, AGENTS.md forbids back-compat shims).
   */
  checkpoint?: { site: CheckpointSiteValue; phase: string; armedAt: string };
  /**
   * Durable outcome of the terminal-state `flow-browser-teardown --reap
   * --record` call. A plain state write (like `checkpoint` above), never a
   * `flow-state-update` phase transition — `updatedAt` is deliberately NOT
   * bumped by writing this field. `flow-gate-summary --cleanup` reads it to
   * render the CLEANUP row; absence means the reap never ran (or ran before
   * this field existed — no migration, AGENTS.md forbids back-compat shims).
   */
  reap?: ReapRecord;
  /**
   * Durable wall-clock anchors for the step-7 CI/Copilot wait, written by
   * `flow-ci-check` (`bin/flow-ci-check.ts`). A plain state write (like
   * `reap` above), never a `flow-state-update` phase transition —
   * `updatedAt` is deliberately NOT bumped by writing this field. Anchoring
   * `elapsedSec`/`ciTerminalAt` here (rather than an in-process clock) is
   * what makes a suspended/parked `flow-ci-check` invocation immune to
   * fabricating a false `ci-hang`: every call re-derives elapsed time from
   * `startedAt`/`ciTerminalAt`, never from how long the calling process
   * itself has been alive. Reset whenever `(pr, headSha)` changes.
   */
  ciWait?: CiWaitRecord;
  updatedAt: string;
};

/**
 * Durable record of a terminal-state reap outcome, written by
 * `recordReapOutcome` in `bin/flow-browser-teardown.ts`.
 */
export type ReapRecord = {
  at: string;
  status: "ok" | "unclean";
  summary: string;
  ran: boolean;
  problems?: string[];
};

/**
 * Durable anchors for one CI/Copilot wait cycle, written by `flow-ci-check`.
 * Cycle identity is `(pr, headSha)`: a new head (ci-fix push, merge-resolver
 * push) resets `startedAt`/`ciTerminalAt`/`lastObservedAt`/`checks`/
 * `copilotRetriggered` automatically. `ciTerminalAt`/`lastObservedAt` are
 * ISO strings (null until first observed) rather than relative seconds so
 * the record survives a host restart between waits.
 */
export type CiWaitRecord = {
  pr: number;
  headSha: string;
  startedAt: string;
  ciTerminalAt: string | null;
  lastObservedAt: string | null;
  checks: number;
  copilotRetriggered: boolean;
  copilotRetriggeredAt?: string;
};

/**
 * The `/flow-checkpoint` arm sites. Derived from `CHECKPOINT_SITES` in
 * `./checkpoint-freshness` — that module has no import of `state.ts`, so
 * importing it here is not circular (only `flow-checkpoint.ts` imports both
 * `state.ts` and `./checkpoint-freshness`). One source of truth for the
 * literal set: `isCheckpointRecord` below reads `CHECKPOINT_SITES` directly
 * rather than restating it, so a new site added to `CHECKPOINT_SITES` can't
 * silently make `readState` reject every state file that records it.
 */
export type CheckpointSiteValue = (typeof CHECKPOINT_SITES)[number];

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
  // Epic-designer (`/flow-epic-create`) approve-terminal. `cancelled` above is
  // reused for the epic cancel path (no separate epic-cancelled phase).
  "epic-approved",
] as const;

export const PENDING_PHASES = [
  "plan-pending-review",
  // Intent interview (adaptive), step 3's post-discovery question gate.
  // Re-renderable from `.flow-tmp/interview-questions.md`. Grouped next to
  // its sibling `plan-pending-review` (pipeline phases first, epic phases
  // last — order isn't load-bearing, but keeps the list readable).
  "plan-pending-interview",
  "triaged-no-change",
  "triage-pending-clarification",
  // Intent interview (adaptive), step 1. Distinct from
  // `triage-pending-clarification` (a single unpersisted ask): the interview
  // is multi-round and re-renderable from `state.interview` on resume.
  "triage-pending-interview",
  "approval-pending-clarification",
  "ci-wait-pending",
  // Auto-checkpoint at the approval → implement hand-off (step 4 affirmative
  // branch). The supervisor flushes conversational state to
  // `~/.flow/state/checkpoints/<slug>/checkpoint.md`, nudges "safe to
  // /clear", and ends the turn here — a legitimate turn-end so
  // `flow-stop-guard` permits the yield. On resume it resolves to step-5
  // (implement).
  "checkpoint-pending-clear",
  // Epic-designer review checkpoint (the open design PR). `flow-stop-guard`
  // must permit ending the turn here, so it is a pending phase.
  "epic-design-pending-review",
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
  // Epic-designer (`/flow-epic-create`) step phases. These are NOT /flow-pipeline
  // steps and have no `## Step N` heading in flow-pipeline/SKILL.md — the
  // NEXT_STEP_BY_PHASE cross-doc lint scopes them out via a startsWith("epic-")
  // filter.
  "epic-designing",
  "epic-validating",
  "epic-pr-open",
] as const;

export const PIPELINE_PHASES = [
  ...STEP_PHASES,
  ...PENDING_PHASES,
  ...TERMINAL_PHASES,
] as const;

export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

export const PIPELINE_PHASE_SET: ReadonlySet<string> = new Set(PIPELINE_PHASES);

export const TERMINAL_PHASE_SET: ReadonlySet<string> = new Set(TERMINAL_PHASES);

/**
 * Terminal phases where the run is over and a dead supervisor is the
 * EXPECTED end state — nothing further to do, nobody waiting on it.
 *
 * Hand-listed, not derived from TERMINAL_PHASES.filter(...): a derived
 * split would silently auto-enroll a future terminal phase into
 * whichever bucket the filter defaults to, and no bucket is
 * safe-by-construction for an unknown phase. See the parity test in
 * bin/lib/state.test.ts's "phase constants" describe block, which fails
 * the suite until a new TERMINAL_PHASES entry is explicitly classified
 * into one of these two buckets.
 */
export const FINISHED_PHASES = [
  "merged",
  "cancelled",
  "epic-approved",
] as const;

/**
 * Terminal for the supervisor (it has stopped and will not resume on
 * its own) but a human decision is still outstanding — the pipeline is
 * not "done" in the sense flow-ls should label it (done).
 */
export const AWAITING_HUMAN_PHASES = ["gated", "needs-human"] as const;

export const FINISHED_PHASE_SET: ReadonlySet<string> = new Set(FINISHED_PHASES);

/**
 * The subset of FINISHED_PHASES where `flow-remove-worktree` has already run
 * and `state.worktree` is stale (points at a deleted sibling dir — issue
 * #632). Hand-listed rather than derived (`FINISHED_PHASES` minus
 * `"epic-approved"`): a derived split would silently reclassify a future
 * `FINISHED_PHASES` entry into "worktree gone" by default, which is the
 * unsafe direction — telling a still-live worktree that it is gone is a
 * user-facing lie. See the parity test in `bin/lib/state.test.ts`'s "phase
 * constants" describe block, which fails until a new FINISHED_PHASES entry
 * is explicitly classified here too.
 */
export const WORKTREE_REMOVED_PHASES = ["merged", "cancelled"] as const;

export const WORKTREE_REMOVED_PHASE_SET: ReadonlySet<string> = new Set(
  WORKTREE_REMOVED_PHASES,
);

export const AWAITING_HUMAN_PHASE_SET: ReadonlySet<string> = new Set(
  AWAITING_HUMAN_PHASES,
);

/**
 * Named allowlist of the only terminal -> non-terminal writes
 * flow-state-update accepts without --force. It exists for two legitimate
 * paths out of `gated`: the gated-feedback loop's re-verify (step 6) /
 * re-gate (step 9), and the gate-override merge (step 10). It still blocks
 * everything else, in particular `<any terminal> -> triaging` — the
 * ambient-pane slug race from PR #369 / commit 00a67fa. The table has only
 * one entry because the guard fires only on the FIRST write out of a
 * terminal phase: once an allowlisted write lands the phase is no longer
 * terminal, so downstream phases (implementing, ci-wait, reviewing) are
 * reachable without their own entry. Consequence: that same mechanic means
 * an allowlisted write raced onto the WRONG pipeline's state file (e.g. a
 * leaked FLOW_SLUG mid-flight) permanently disarms this guard for that
 * file — every subsequent write lands unguarded, not just the allowlisted
 * one. `checkWorktreeBranch` still runs on every write but is a no-op in
 * that race: it reads the victim's own worktree marker, which is
 * internally consistent regardless of which pipeline is writing.
 */
export const TERMINAL_EXIT_TRANSITIONS: Readonly<
  Record<string, readonly PipelinePhase[]>
> = {
  gated: ["verifying", "gating", "merging"],
};

export function isAllowedTerminalExit(from: string, to: string): boolean {
  return Object.hasOwn(TERMINAL_EXIT_TRANSITIONS, from)
    ? (TERMINAL_EXIT_TRANSITIONS[from] as readonly string[]).includes(to)
    : false;
}

export function isPipelinePhase(value: string): value is PipelinePhase {
  return PIPELINE_PHASE_SET.has(value);
}

export function isLegitimateEndPhase(value: string): boolean {
  return (
    (TERMINAL_PHASES as readonly string[]).includes(value) ||
    (PENDING_PHASES as readonly string[]).includes(value)
  );
}

/**
 * Phases that belong to the epic-designer (`/flow-epic-create`) lifecycle,
 * derived from `PIPELINE_PHASES` rather than hand-listed so a future
 * `epic-*` phase joins automatically. Two ambiguities this predicate does
 * NOT resolve, both left to callers:
 *
 * - `starting` is shared with feature pipelines; reaching it via
 *   `bin/flow-session-start-hook.ts` requires an armed checkpoint marker,
 *   same as any other phase (the state-dir checkpoint location is
 *   worktree-independent, so `starting` is no longer categorically
 *   unreachable the way it was before checkpoint storage moved).
 * - The shared terminals `cancelled` / `needs-human` are feature-or-epic
 *   ambiguous; callers must apply the terminal guard (`TERMINAL_PHASE_SET`)
 *   before consulting `isEpicPhase` for anything.
 *
 * `isEpicPhase` also cannot tell an epic-**design** window from an
 * epic-**run** window sharing the same slug/state — that disambiguation is
 * `@flow-kind`'s job (`bin/lib/tmux.ts`); this predicate is only its
 * phase-derived fallback when the pane option is absent.
 */
export const EPIC_PHASES: readonly PipelinePhase[] = PIPELINE_PHASES.filter(
  (phase) => phase.startsWith("epic-"),
);

export const EPIC_PHASE_SET: ReadonlySet<string> = new Set(EPIC_PHASES);

export function isEpicPhase(phase: string): boolean {
  return EPIC_PHASE_SET.has(phase);
}

/**
 * Which supervisor kind a window's pane is running. Published as `@flow-kind`
 * (`bin/lib/tmux.ts`) and re-exported as `ResumeKind`
 * (`bin/flow-session-start-hook.ts`).
 *
 * The literals live here ONCE and every runtime validator derives from
 * `isPipelineKind` — the same derive-don't-hand-list discipline `EPIC_PHASES`
 * uses above. Hand-listing them per validator is how a fourth kind would get
 * silently rejected at one site and accepted at another, and the only
 * compiler-enforced part is the type, not the runtime checks.
 */
export const PIPELINE_KINDS = ["feature", "epic-design", "epic-run"] as const;

export type PipelineKind = (typeof PIPELINE_KINDS)[number];

export const PIPELINE_KIND_SET: ReadonlySet<string> = new Set(PIPELINE_KINDS);

export function isPipelineKind(value: string): value is PipelineKind {
  return PIPELINE_KIND_SET.has(value);
}

/**
 * Whether the `SessionStart:clear` hook auto-resumes a window at `phase`
 * for a supervisor of the given `kind`. Encodes
 * `bin/flow-session-start-hook.ts`'s terminal guard: an `epic-run` window
 * resumes regardless of phase (its shared `state.json` describes the
 * *design* lifecycle, not run progress — see `bin/lib/epic.ts`'s "no
 * per-machine phase machine" comment on the run path); every other kind
 * resumes unless `phase` is terminal, with the `gated` carve-out
 * (feedback-resume stays live even though `gated` is terminal).
 */
export function autoResumesAfterClear(
  phase: string,
  kind: PipelineKind = "feature",
): boolean {
  if (kind === "epic-run") {
    return true;
  }
  return !TERMINAL_PHASE_SET.has(phase) || phase === "gated";
}

/**
 * Compact, single-source-of-truth abbreviations for each pipeline phase,
 * published onto flow's own windows as the `@flow-phase-short` tmux option
 * (see `bin/lib/tmux.ts`) so a user's status-bar format can render a compact
 * `[repo phase]` badge without restating flow's phase vocabulary in their own
 * config. Typed `Record<PipelinePhase, string>` so adding a phase to
 * `PIPELINE_PHASES` without an abbreviation fails `typecheck:scripts`; the
 * runtime drift-guard in `state.test.ts` asserts the same on the test side.
 */
export const PHASE_SHORT: Record<PipelinePhase, string> = {
  starting: "start",
  triaging: "triage",
  "worktree-create": "wktree",
  planning: "plan",
  implementing: "impl",
  "installing-skills": "skills",
  verifying: "verify",
  "ci-wait": "ci",
  reviewing: "review",
  gating: "gate",
  merging: "merge",
  "plan-pending-review": "plan?",
  "plan-pending-interview": "planq?",
  "triaged-no-change": "no-chg",
  "triage-pending-clarification": "triage?",
  "triage-pending-interview": "intq?",
  "approval-pending-clarification": "appr?",
  "ci-wait-pending": "ci?",
  "checkpoint-pending-clear": "ckpt?",
  merged: "merged",
  gated: "gated",
  "needs-human": "human",
  cancelled: "cancel",
  "epic-designing": "e-dsgn",
  "epic-validating": "e-val",
  "epic-pr-open": "e-pr",
  "epic-design-pending-review": "e-rvw?",
  "epic-approved": "e-ok",
};

/**
 * Maps a phase to its compact abbreviation, falling through to the raw phase
 * string for any unknown/future phase. The fall-through keeps the published
 * `@flow-phase-short` option best-effort: a phase added without an entry
 * (caught by typecheck + the drift-guard test) still renders its raw string
 * rather than blank.
 */
export function shortPhase(phase: string): string {
  return (PHASE_SHORT as Record<string, string | undefined>)[phase] ?? phase;
}

export function statePath(slug: string, dir = FLOW_STATE_DIR): string {
  return path.join(dir, `${slug}.json`);
}

function isGateOverride(x: unknown): x is { pr: number; confirmedAt: string } {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  return typeof o.pr === "number" && typeof o.confirmedAt === "string";
}

function isEpicMembership(
  x: unknown,
): x is { slug: string; featureId: string } {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  return typeof o.slug === "string" && typeof o.featureId === "string";
}

function isCheckpointRecord(
  x: unknown,
): x is { site: CheckpointSiteValue; phase: string; armedAt: string } {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  if (
    typeof o.site !== "string" ||
    !(CHECKPOINT_SITES as readonly string[]).includes(o.site)
  )
    return false;
  if (typeof o.phase !== "string") return false;
  if (typeof o.armedAt !== "string") return false;
  return true;
}

function isReapRecord(x: unknown): x is ReapRecord {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.at !== "string") return false;
  if (o.status !== "ok" && o.status !== "unclean") return false;
  if (typeof o.summary !== "string") return false;
  if (typeof o.ran !== "boolean") return false;
  if (o.problems !== undefined) {
    if (!Array.isArray(o.problems)) return false;
    for (const p of o.problems) {
      if (typeof p !== "string") return false;
    }
  }
  return true;
}

export function isCiWaitRecord(x: unknown): x is CiWaitRecord {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.pr !== "number") return false;
  if (typeof o.headSha !== "string") return false;
  if (typeof o.startedAt !== "string") return false;
  if (o.ciTerminalAt !== null && typeof o.ciTerminalAt !== "string")
    return false;
  if (o.lastObservedAt !== null && typeof o.lastObservedAt !== "string")
    return false;
  if (typeof o.checks !== "number") return false;
  if (typeof o.copilotRetriggered !== "boolean") return false;
  if (
    o.copilotRetriggeredAt !== undefined &&
    typeof o.copilotRetriggeredAt !== "string"
  )
    return false;
  return true;
}

function isPhaseLog(
  x: unknown,
): x is Array<{ phase: string; outcome?: string; at: string }> {
  if (!Array.isArray(x)) return false;
  for (const e of x) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) return false;
    const o = e as Record<string, unknown>;
    if (typeof o.phase !== "string") return false;
    if (typeof o.at !== "string") return false;
    if (o.outcome !== undefined && typeof o.outcome !== "string") return false;
  }
  return true;
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
  if (o.autoMerge !== undefined && typeof o.autoMerge !== "boolean")
    return false;
  if (o.waitForCopilot !== undefined && typeof o.waitForCopilot !== "boolean")
    return false;
  if (o.forceResearch !== undefined && typeof o.forceResearch !== "boolean")
    return false;
  if (
    o.copilotReview !== undefined &&
    o.copilotReview !== "auto" &&
    o.copilotReview !== "always" &&
    o.copilotReview !== "never"
  )
    return false;
  if (
    o.effort !== undefined &&
    !(EFFORT_LEVELS as readonly string[]).includes(o.effort as string)
  )
    return false;
  if (
    o.model !== undefined &&
    !(MODEL_ALIASES as readonly string[]).includes(o.model as string)
  )
    return false;
  for (const field of PHASE_MODEL_FIELDS) {
    const v = o[field];
    if (
      v !== undefined &&
      !(MODEL_ALIASES as readonly string[]).includes(v as string)
    )
      return false;
  }
  if (o.sessionId !== undefined && typeof o.sessionId !== "string")
    return false;
  if (o.answer !== undefined && typeof o.answer !== "string") return false;
  if (o.interview !== undefined && typeof o.interview !== "string")
    return false;
  if (
    o.interviewMode !== undefined &&
    o.interviewMode !== "force" &&
    o.interviewMode !== "skip"
  )
    return false;
  if (o.gateOverride !== undefined && !isGateOverride(o.gateOverride))
    return false;
  if (o.epic !== undefined && !isEpicMembership(o.epic)) return false;
  if (o.phaseLog !== undefined && !isPhaseLog(o.phaseLog)) return false;
  if (o.checkpoint !== undefined && !isCheckpointRecord(o.checkpoint))
    return false;
  if (o.reap !== undefined && !isReapRecord(o.reap)) return false;
  if (o.ciWait !== undefined && !isCiWaitRecord(o.ciWait)) return false;
  if (o.seedIngestedAt !== undefined && typeof o.seedIngestedAt !== "string")
    return false;
  if (o.pid !== undefined && typeof o.pid !== "number") return false;
  if (o.procStartedAt !== undefined && typeof o.procStartedAt !== "number")
    return false;
  if (
    o.launcher !== undefined &&
    o.launcher !== "plain" &&
    o.launcher !== "tmux"
  )
    return false;
  if (o.launchAttempts !== undefined && typeof o.launchAttempts !== "number")
    return false;
  if (
    o.launchOutcome !== undefined &&
    o.launchOutcome !== "started" &&
    o.launchOutcome !== "launched-not-confirmed"
  )
    return false;
  return true;
}

export function readState(
  slug: string,
  dir = FLOW_STATE_DIR,
): PipelineState | null {
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
  fs.writeFileSync(
    statePath(state.slug, dir),
    JSON.stringify(state, null, 2) + "\n",
  );
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
