/**
 * Pure route planner for delegated review lenses. Decides, per lens, whether
 * it runs on agy or stays a Claude Task agent, and why. Precedence (first
 * match wins): delegation-off > not-in-delegated-set >
 * fable-session-keeps-task > agy-cooldown > agy.
 *
 * Does not import from a top-level bin/*.ts — the caller resolves the Task
 * model for each lens (`taskModelFor`) so this module stays pure.
 */

import type { DelegatableLens } from "./delegate-models";

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
