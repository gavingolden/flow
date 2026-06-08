/**
 * Per-turn block tracking for `flow-stop-guard`, persisted at
 * `~/.flow/state/turns/<slug>.json` (a sibling subdirectory of the
 * per-pipeline state files at `~/.flow/state/<slug>.json`). The hook
 * owns its own counter so it can distinguish a legitimate phase-advance
 * loop-break from stagnation (phase has not advanced for N consecutive
 * stops) — Claude Code's `stop_hook_active` payload flag is treated as
 * advisory rather than authoritative budget.
 *
 * Files live in the `turns/` subdirectory rather than alongside
 * `<slug>.json` so `state.ts`'s `listStates()` — which reads
 * `FLOW_STATE_DIR` non-recursively and filters by `.endsWith('.json')`
 * — does not pick them up as phantom pipelines.
 *
 * Shape mirrors `state.ts`'s primitives otherwise: `dir?` default-from-
 * `FLOW_STATE_DIR` parameter, read returns null on missing, write is
 * synchronous with recursive mkdir of the `turns/` subdirectory, delete
 * is best-effort try/unlink/catch.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FLOW_STATE_DIR } from "./paths";

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

export function turnTrackingPath(slug: string, dir = FLOW_STATE_DIR): string {
  return path.join(dir, "turns", `${slug}.json`);
}

function isTurnTracking(x: unknown): x is TurnTracking {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.slug !== "string") return false;
  if (typeof o.turnId !== "string") return false;
  if (typeof o.blockCount !== "number") return false;
  if (typeof o.lastPhase !== "string") return false;
  if (typeof o.lastStopAt !== "string") return false;
  return true;
}

export function readTurnTracking(
  slug: string,
  dir = FLOW_STATE_DIR,
): TurnTracking | null {
  const file = turnTrackingPath(slug, dir);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isTurnTracking(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeTurnTracking(
  tracking: TurnTracking,
  dir = FLOW_STATE_DIR,
): void {
  fs.mkdirSync(path.join(dir, "turns"), { recursive: true });
  fs.writeFileSync(
    turnTrackingPath(tracking.slug, dir),
    JSON.stringify(tracking, null, 2) + "\n",
  );
}

export function deleteTurnTracking(
  slug: string,
  dir = FLOW_STATE_DIR,
): boolean {
  try {
    fs.unlinkSync(turnTrackingPath(slug, dir));
    return true;
  } catch {
    return false;
  }
}
