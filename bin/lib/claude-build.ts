/**
 * Detects the running Claude Code build and gates features on it. A
 * per-invocation sub-agent `effort` parameter needs Claude Code 2.1.292+;
 * `flow-spawn-effort` prints nothing on an older or undetectable build so a
 * spawn site never passes an argument the host may reject.
 *
 * Pure over an injected `env`. No semver dependency: a three-integer compare
 * is enough for `x.y.z`.
 */

import * as path from "node:path";
import { EFFORT_LEVELS, type EffortLevel } from "./state";

export const MIN_SUBAGENT_EFFORT_VERSION = "2.1.292";

function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The running build as `x.y.z`, or `null` when undetectable. Reads
 * `AI_AGENT` (`claude-code_<x>-<y>-<z>_agent`) first, else the basename of
 * `CLAUDE_CODE_EXECPATH` (`.../versions/<x.y.z>`).
 */
export function detectClaudeBuild(env: NodeJS.ProcessEnv): string | null {
  const agent = /^claude-code_(\d+)-(\d+)-(\d+)(?:_|$)/.exec(
    env.AI_AGENT ?? "",
  );
  if (agent) return `${agent[1]}.${agent[2]}.${agent[3]}`;
  const exec = env.CLAUDE_CODE_EXECPATH;
  if (exec) {
    const base = path.basename(exec);
    if (parseVersion(base)) return base;
  }
  return null;
}

export function supportsSubagentEffort(env: NodeJS.ProcessEnv): boolean {
  const build = detectClaudeBuild(env);
  const have = build ? parseVersion(build) : null;
  const need = parseVersion(MIN_SUBAGENT_EFFORT_VERSION);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

function asEffortLevel(v: unknown): EffortLevel | "" {
  return typeof v === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(v)
    ? (v as EffortLevel)
    : "";
}

/**
 * The session's effort for the per-spawn ceiling: `CLAUDE_EFFORT` (the live
 * session) when valid, else the pipeline's launch-frozen `state.effort`,
 * else `""` (unknown — the ceiling is then skipped).
 */
export function readSessionEffort(
  env: NodeJS.ProcessEnv,
  state: { effort?: unknown } | null | undefined,
): EffortLevel | "" {
  return asEffortLevel(env.CLAUDE_EFFORT) || asEffortLevel(state?.effort);
}
