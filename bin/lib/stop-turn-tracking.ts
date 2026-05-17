/**
 * Per-turn block tracking for `flow-stop-guard`, persisted at
 * `~/.flow/state/<slug>.turn.json` (sibling to `<slug>.json`). The hook
 * owns its own counter so it can distinguish a legitimate phase-advance
 * loop-break from stagnation (phase has not advanced for N consecutive
 * stops) — Claude Code's `stop_hook_active` payload flag is treated as
 * advisory rather than authoritative budget.
 *
 * Shape mirrors `state.ts` exactly: `<slug>.turn.json` lives in
 * `FLOW_STATE_DIR`, `dir?` parameter same default + override pattern,
 * read returns null on missing, write is synchronous with recursive
 * mkdir, delete is best-effort try/unlink/catch.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FLOW_STATE_DIR } from "./paths";

export { nowIso } from "./state";

export type TurnTracking = {
  slug: string;
  turnId: string;
  blockCount: number;
  lastPhase: string;
  lastStopAt: string;
};

/**
 * Number of standard blocks the hook will emit per turn before flipping
 * to phase-advance / stagnation routing. Set to 1 — the original
 * single-block loop-break budget.
 */
export const TURN_BLOCK_LIMIT = 1;

/**
 * Number of consecutive same-phase blocks after the budget is exhausted
 * that triggers stagnation routing. Exported alongside `TURN_BLOCK_LIMIT`
 * so tests pin against a named constant rather than a literal.
 */
export const STAGNATION_THRESHOLD = 2;

export function turnTrackingPath(slug: string, dir = FLOW_STATE_DIR): string {
  return path.join(dir, `${slug}.turn.json`);
}

export function readTurnTracking(
  slug: string,
  dir = FLOW_STATE_DIR,
): TurnTracking | null {
  const file = turnTrackingPath(slug, dir);
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as TurnTracking;
  } catch {
    return null;
  }
}

export function writeTurnTracking(
  tracking: TurnTracking,
  dir = FLOW_STATE_DIR,
): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    turnTrackingPath(tracking.slug, dir),
    JSON.stringify(tracking, null, 2) + "\n",
  );
}

export function deleteTurnTracking(slug: string, dir = FLOW_STATE_DIR): boolean {
  try {
    fs.unlinkSync(turnTrackingPath(slug, dir));
    return true;
  } catch {
    return false;
  }
}
