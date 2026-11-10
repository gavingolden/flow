/**
 * Pure policy for the plan review's reviewer-2 Claude Code fallback: when the
 * agy route cannot serve reviewer 2, the same prompt re-runs on
 * `flow-claude-headless`. Spawn-free so every branch is unit-testable.
 */

export const FALLBACK_MODEL = "opus";
export const FALLBACK_EFFORT = "high";
export const FALLBACK_MAX_BUDGET_USD = 3;
export const FALLBACK_MAX_TURNS = 25;
export const FALLBACK_MIN_SEC = 300;
export const FALLBACK_CAP_MARGIN_SEC = 60;
export const FALLBACK_ALLOWED_TOOLS = "Read,Grep,Glob";

// No agy-cooldown: flow-delegate never reads the cooldown marker, so it cannot reach plan review.
export const FALLBACK_ELIGIBLE_SKIP_REASONS: ReadonlySet<string> = new Set([
  "agy-not-found",
  "agy-not-authenticated",
  "agy-model-unavailable",
  "agy-error",
  "agy-empty-artifact",
  "spawn-failed",
  "agy-timeout",
]);

export type ReviewerRoute = "agy" | "claude-headless";

export type FallbackSkipReason =
  | "fallback-disabled"
  | "fallback-reviewer-1-down"
  | "fallback-ineligible"
  | "fallback-no-budget";

export type FallbackDecision =
  | { run: true; timeoutSec: number }
  | { run: false; reason: FallbackSkipReason };

/** Tolerant opt-out gate: on unless `review.planReviewClaudeFallback === false`. */
export function isClaudeFallbackEnabled(rawConfigText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfigText);
  } catch {
    return true;
  }
  if (typeof parsed !== "object" || parsed === null) return true;
  const review = (parsed as Record<string, unknown>).review;
  if (typeof review !== "object" || review === null) return true;
  return (review as Record<string, unknown>).planReviewClaudeFallback !== false;
}

export function decideFallback(input: {
  enabled: boolean;
  reviewer1Engaged: boolean;
  agyEntry:
    | { ran?: boolean; skipReason?: string; durationMs?: number }
    | undefined;
  agyElapsedSecFallback: number;
  slotSec: number;
  capRemainingSec: number;
}): FallbackDecision {
  if (!input.enabled) return { run: false, reason: "fallback-disabled" };
  if (!input.reviewer1Engaged) {
    return { run: false, reason: "fallback-reviewer-1-down" };
  }
  const entry = input.agyEntry;
  if (
    entry === undefined ||
    entry.ran === true ||
    entry.skipReason === undefined ||
    !FALLBACK_ELIGIBLE_SKIP_REASONS.has(entry.skipReason)
  ) {
    return { run: false, reason: "fallback-ineligible" };
  }
  const agySec =
    typeof entry.durationMs === "number" && entry.durationMs >= 0
      ? Math.ceil(entry.durationMs / 1000)
      : Math.max(0, Math.ceil(input.agyElapsedSecFallback));
  const budget = Math.floor(
    Math.min(
      input.slotSec - agySec,
      input.capRemainingSec - FALLBACK_CAP_MARGIN_SEC,
    ),
  );
  if (budget < FALLBACK_MIN_SEC) {
    return { run: false, reason: "fallback-no-budget" };
  }
  return { run: true, timeoutSec: budget };
}

export function buildFallbackArgv(input: {
  promptPath: string;
  out: string;
  task: string;
  timeoutSec: number;
}): string[] {
  return [
    "--prompt-file",
    input.promptPath,
    "--model",
    FALLBACK_MODEL,
    "--effort",
    FALLBACK_EFFORT,
    "--tools",
    FALLBACK_ALLOWED_TOOLS,
    "--allowed-tools",
    FALLBACK_ALLOWED_TOOLS,
    "--max-budget-usd",
    String(FALLBACK_MAX_BUDGET_USD),
    "--max-turns",
    String(FALLBACK_MAX_TURNS),
    "--timeout-sec",
    String(input.timeoutSec),
    "--task",
    input.task,
    "--out",
    input.out,
  ];
}

export function mapFallbackSkipReason(
  headlessSkipReason: string | undefined,
): string {
  if (headlessSkipReason === undefined) return "claude-error";
  return headlessSkipReason === "claude-timeout"
    ? "reviewer-timeout"
    : headlessSkipReason;
}

// The executive precondition classifies a reviewer whose model fails /claude/i
// as the non-Claude one, so this label must always name Claude.
export function fallbackModelLabel(model: unknown): string {
  if (typeof model !== "string" || model === "") return "claude-opus";
  return /claude/i.test(model) ? model : `claude-${model}`;
}

export const FALLBACK_PROMPT_DIRECTIVE =
  "You are running under Claude Code, whose result keeps only your final message. " +
  "Make every Read, Grep and Glob call first, then write all seven lenses together in one single final message. " +
  "This overrides the later instruction in this prompt to emit each lens as it is finished: do not emit any lens before that final message.\n\n";

export function buildFallbackPrompt(reviewer2Prompt: string): string {
  return FALLBACK_PROMPT_DIRECTIVE + reviewer2Prompt;
}
