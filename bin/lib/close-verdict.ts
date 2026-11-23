/**
 * The single close-readiness verdict for a feature pipeline window. Every
 * surface (gate block, tab badge, `flow ls`, `flow done`, the turn-end hook,
 * `flow-untracked verdict`) calls `closeVerdict` so none can disagree; the
 * tab badge (`badgeShort`) is built on it too.
 *
 * Input is the phase (or a gate render's target phase) plus the recorded
 * `untracked` ledger — nothing else. Imports only `state.ts`: tmux.ts imports
 * this module, so a heavier import here would create a runtime cycle.
 */
import {
  PENDING_PHASES,
  resolveStateKind,
  type PipelinePhase,
  type PipelineState,
  type UntrackedItem,
} from "./state";

export type CloseVerdictKind =
  | "safe-to-close"
  | "needs-you"
  | "working"
  | "n/a";

export type CloseVerdict = {
  kind: CloseVerdictKind;
  reason: string;
  openItems: UntrackedItem[];
  steps: string[];
  /** Why a `needs-you` verdict is not ready — lets `flow ls` pick its cell without parsing `reason`. */
  cause?: "gated" | "stalled" | "waiting" | "open-items";
};

const FINISHED_FEATURE_PHASES: ReadonlySet<string> = new Set([
  "merged",
  "cancelled",
]);
const PENDING_PHASE_SET: ReadonlySet<string> = new Set(PENDING_PHASES);
// Pending phases where the pipeline is progressing on its own (CI or a
// detached reviewer) and owes the user nothing.
const SELF_RUNNING_PENDING: ReadonlySet<string> = new Set([
  "ci-wait-pending",
  "plan-review-pending",
  "epic-plan-review-pending",
]);

/** Phases whose window carries a recorded verdict; the hook and `flow done` both key off this. */
export const VERDICT_PHASES: ReadonlySet<string> = new Set([
  "merged",
  "cancelled",
  "gated",
  "needs-human",
]);

export function isOpenItem(item: UntrackedItem): boolean {
  return (
    item.filedAs === undefined &&
    item.droppedAt === undefined &&
    item.doneAt === undefined &&
    item.launchedAs === undefined
  );
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function openItemsStep(openItems: UntrackedItem[]): string {
  const hasWork = openItems.some((i) => i.kind !== "manual");
  const hasManual = openItems.some((i) => i.kind === "manual");
  if (hasWork && !hasManual)
    return "Reply file all, drop all, or per item (file #N · drop #N · launch #N)";
  if (!hasWork)
    return "Reply done all, drop all, or per item (done #N · drop #N)";
  return "Reply file all, done all, drop all, or per item (file #N · drop #N · launch #N · done #N)";
}

export function closeVerdict(
  state: Pick<
    PipelineState,
    "slug" | "phase" | "kind" | "phaseLog" | "untracked"
  >,
  opts: { gatedChecks?: number; phase?: PipelinePhase } = {},
): CloseVerdict {
  const openItems = (state.untracked ?? []).filter(isOpenItem);
  const phase: string = opts.phase ?? state.phase;
  const undecided = `${plural(openItems.length, "item")} undecided`;

  if (resolveStateKind(state) !== "feature") {
    return { kind: "n/a", reason: "", openItems, steps: [] };
  }
  if (phase === "gated") {
    const checks = opts.gatedChecks;
    const base =
      checks === undefined
        ? "PR not merged"
        : `PR not merged; ${plural(checks, "check")} to tick`;
    return {
      kind: "needs-you",
      cause: "gated",
      reason: openItems.length > 0 ? `${base} · ${undecided}` : base,
      openItems,
      steps: [],
    };
  }
  if (phase === "needs-human") {
    return {
      kind: "needs-you",
      cause: "stalled",
      reason: "pipeline stalled; nothing is lost — see the block above",
      openItems,
      steps: [],
    };
  }
  if (PENDING_PHASE_SET.has(phase) && !SELF_RUNNING_PENDING.has(phase)) {
    return {
      kind: "needs-you",
      cause: "waiting",
      reason: "waiting on your reply",
      openItems,
      steps: [],
    };
  }
  if (!FINISHED_FEATURE_PHASES.has(phase)) {
    return {
      kind: "working",
      reason: "pipeline running",
      openItems,
      steps: [],
    };
  }
  const done = `flow done ${state.slug}`;
  if (openItems.length > 0) {
    return {
      kind: "needs-you",
      cause: "open-items",
      reason: undecided,
      openItems,
      steps: [openItemsStep(openItems), done],
    };
  }
  return {
    kind: "safe-to-close",
    reason: "nothing recorded as open",
    openItems,
    steps: [done],
  };
}

/** The gate-grammar WINDOW row; empty for `working` / `n/a` (no row shown). */
export function windowLine(v: CloseVerdict): string {
  if (v.kind === "safe-to-close")
    return `WINDOW: ✓ safe to close — ${v.reason}`;
  if (v.kind === "needs-you") return `WINDOW: ✗ not ready — ${v.reason}`;
  return "";
}

export function verdictWord(line: string): "safe" | "not-ready" | null {
  if (/✓\s*safe to close/.test(line)) return "safe";
  if (/✗\s*not ready/.test(line)) return "not-ready";
  return null;
}

/**
 * Close-aware short-phase value: `merged?` / `cancel?` when a finished feature
 * window still has open items (ASCII, <= 7 columns). `null` otherwise — the
 * caller falls back to `shortPhase(phase)`, so a clean window reads `merged`.
 */
export function badgeShort(
  state: Pick<PipelineState, "phase" | "kind" | "phaseLog" | "untracked">,
): string | null {
  if (closeVerdict({ ...state, slug: "" }).cause !== "open-items") return null;
  return state.phase === "merged" ? "merged?" : "cancel?";
}
