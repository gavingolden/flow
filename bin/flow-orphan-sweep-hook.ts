#!/usr/bin/env bun
/**
 * Claude Code PostToolUse hook (matcher `Bash`): in a flow pipeline session,
 * sweeps CPU-busy leftover processes from the pipeline's worktree at most
 * once per minute, so a leak inside one long turn is stopped within about
 * two minutes instead of waiting for a turn end.
 *
 * Fail-open: it never blocks a tool call, and any error, missing slug or
 * missing worktree exits 0 with no output. The throttle timestamp lives under
 * `<stateDir>/orphan-sweep/` (never a `*.json` at the state root, which
 * `listStates` would read as a phantom pipeline) and is written BEFORE the
 * sweep so concurrent calls do not double-run it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FLOW_STATE_DIR } from "./lib/paths";
import { resolveSlugFromEnv } from "./lib/session-identity";
import { readState } from "./lib/state";
import { syncKeepAwake } from "./lib/keep-awake";
import {
  ORPHAN_GUIDANCE,
  orphanNotice,
  recordOrphanStops,
  stoppedCount,
  sweepBusyLeftovers,
  type WorktreeOrphanSweepResult,
} from "./lib/worktree-orphans-run";

export const SWEEP_THROTTLE_MS = 60_000;
const STDIN_TIMEOUT_MS = 250;

export function shouldSweep(lastMs: number | null, nowMs: number): boolean {
  return lastMs === null || nowMs - lastMs >= SWEEP_THROTTLE_MS;
}

export type HookDeps = {
  env: Record<string, string | undefined>;
  loadWorktree: (slug: string) => string | null;
  readLast: (slug: string) => number | null;
  writeLast: (slug: string, ms: number) => void;
  sweep: (worktree: string) => WorktreeOrphanSweepResult | null;
  record: (slug: string, n: number) => void;
  nowMs: () => number;
  /** Re-syncs the keep-awake holder (a resume, mid-run reap or 4 h cap can drop it with no phase write). */
  syncKeepAwake?: (slug: string) => void;
};

export function runHook(input: unknown, deps: HookDeps): string | null {
  try {
    if (input !== null && typeof input === "object") {
      const tool = (input as { tool_name?: unknown }).tool_name;
      if (tool !== undefined && tool !== "Bash") return null;
    }
    const slug = resolveSlugFromEnv(deps.env as NodeJS.ProcessEnv);
    if (!slug) return null;
    const now = deps.nowMs();
    if (!shouldSweep(deps.readLast(slug), now)) return null;
    deps.writeLast(slug, now);
    try {
      deps.syncKeepAwake?.(slug);
    } catch {
      // fail open
    }
    const worktree = deps.loadWorktree(slug);
    if (!worktree) return null;
    const result = deps.sweep(worktree);
    const stopped = result ? stoppedCount(result) : 0;
    if (!result || stopped === 0) return null;
    deps.record(slug, stopped);
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: orphanNotice(result, { guidance: ORPHAN_GUIDANCE }),
      },
    });
  } catch {
    return null;
  }
}

const lastPath = (slug: string): string =>
  path.join(FLOW_STATE_DIR, "orphan-sweep", `${slug}.last`);

export function defaultHookDeps(): HookDeps {
  return {
    env: process.env,
    loadWorktree: (slug) => readState(slug)?.worktree ?? null,
    readLast: (slug) => {
      try {
        const n = Number(fs.readFileSync(lastPath(slug), "utf8").trim());
        return Number.isFinite(n) ? n : null;
      } catch {
        return null;
      }
    },
    writeLast: (slug, ms) => {
      fs.mkdirSync(path.dirname(lastPath(slug)), {
        recursive: true,
        mode: 0o700,
      });
      fs.writeFileSync(lastPath(slug), String(ms), { mode: 0o600 });
    },
    sweep: (worktree) => sweepBusyLeftovers(worktree),
    record: (slug, n) => recordOrphanStops(slug, n),
    nowMs: () => Date.now(),
    syncKeepAwake: (slug) => {
      const state = readState(slug);
      if (state) syncKeepAwake(state);
    },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    process.stdin.on("data", (c) => chunks.push(c as Uint8Array));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

if (import.meta.main) {
  (async () => {
    try {
      let input: unknown = null;
      try {
        input = JSON.parse(await readStdin());
      } catch {
        // payload is advisory only
      }
      const out = runHook(input, defaultHookDeps());
      if (out) process.stdout.write(out + "\n");
    } catch {
      // fail open
    }
    process.exit(0);
  })();
}
