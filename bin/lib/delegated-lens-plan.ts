/**
 * Pure route planner for delegated review lenses. Decides, per lens, whether
 * it runs on agy or stays a Claude Task agent, and why. Precedence (first
 * match wins): delegation-off > not-in-delegated-set >
 * fable-session-keeps-task > agy-cooldown > agy.
 *
 * Does not import from a top-level bin/*.ts — the caller resolves the Task
 * model for each lens (`taskModelFor`) so this module stays pure.
 */

import { DEADLINE_GRACE_MS, KILL_GRACE_MS } from "./agy-guard";
import {
  DELEGATED_LENS_TIMEOUT,
  type DelegatableLens,
} from "./delegate-models";

export type LensRoute =
  | { lens: DelegatableLens; route: "agy" }
  | {
      lens: DelegatableLens;
      route: "task";
      reason:
        | "delegation-off"
        | "not-in-delegated-set"
        | "fable-session-keeps-task"
        | "agy-cooldown";
    };

export function planLensRoutes(o: {
  lenses: DelegatableLens[];
  variant: string | null;
  delegated: readonly DelegatableLens[];
  taskModelFor: (l: DelegatableLens) => string | null;
  cooldownLive: boolean;
}): LensRoute[] {
  return o.lenses.map((lens): LensRoute => {
    if (o.variant === null || o.variant.trim() === "") {
      return { lens, route: "task", reason: "delegation-off" };
    }
    if (!o.delegated.includes(lens)) {
      return { lens, route: "task", reason: "not-in-delegated-set" };
    }
    // Fable bug-detection re-found measurably more than Opus
    // (docs/eval/fable-vs-opus-subagents.md); moving it to agy Opus would
    // undo that. An unknown model (null/empty — e.g. a standalone review
    // with no state) is treated as non-Fable.
    const model = o.taskModelFor(lens);
    if (model !== null && model.toLowerCase().includes("fable")) {
      return { lens, route: "task", reason: "fable-session-keeps-task" };
    }
    if (o.cooldownLive) {
      return { lens, route: "task", reason: "agy-cooldown" };
    }
    return { lens, route: "agy" };
  });
}

// The helper's whole-run ceiling (9.5 min) and the least time worth spending
// on a Gemini re-run.
export const HELPER_BUDGET_MS = 570_000;
export const MIN_REROUTE_MS = 180_000;
const BACKSTOP_MARGIN_MS = 5_000;
const SAFETY_MARGIN_MS = 10_000;
export const REROUTE_SLACK_MS =
  DEADLINE_GRACE_MS + KILL_GRACE_MS + BACKSTOP_MARGIN_MS + SAFETY_MARGIN_MS;
const REROUTE_CAP_MS = parseInt(DELEGATED_LENS_TIMEOUT, 10) * 60_000;

/** `--timeout` for the re-run, or null when too little of the budget is left. */
export function rerouteTimeout(elapsedMs: number): string | null {
  const remaining = HELPER_BUDGET_MS - elapsedMs - REROUTE_SLACK_MS;
  if (remaining < MIN_REROUTE_MS) return null;
  return `${Math.floor(Math.min(remaining, REROUTE_CAP_MS) / 1000)}s`;
}

// Only a Claude primary re-runs: a Gemini content-filter refusal on a Gemini
// primary would just repeat on the same family.
export function shouldReroute(primaryModel: string, reason: string): boolean {
  return reason === "agy-content-filtered" && /claude/i.test(primaryModel);
}

export function rerouteTask(lens: DelegatableLens): string {
  return `agy-reroute-${lens}`;
}
