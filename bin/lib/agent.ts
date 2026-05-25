/**
 * Two AI runtimes supported by flow: Claude Code (default) and
 * Antigravity (`agy`). Detection is env-driven; persistence is per-pipeline
 * via state.json's optional `agent` field. Absent ≡ "claude".
 */

export const AGENT_RUNTIMES = ["claude", "antigravity"] as const;

export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return typeof value === "string" && (AGENT_RUNTIMES as readonly string[]).includes(value);
}

/**
 * Picks the runtime from environment. Antigravity wins when its
 * conversation-id env var is set (a non-empty string); otherwise claude.
 * The claude default also covers the no-env-vars-set case so non-harness
 * shells get a deterministic answer.
 */
export function detectAgent(env: NodeJS.ProcessEnv): AgentRuntime {
  const agy = env.ANTIGRAVITY_CONVERSATION_ID;
  if (typeof agy === "string" && agy.length > 0) return "antigravity";
  return "claude";
}

/** Two-tuple of [bin, prompt] launched in the tmux window. */
export function agentCommand(agent: AgentRuntime, prompt: string): [string, string] {
  return agent === "antigravity" ? ["agy", prompt] : ["claude", prompt];
}

/**
 * Resolves the per-runtime session/conversation id from environment.
 * Mirrors `flow-open-pr`'s `deps.sessionId` test seam — returns undefined
 * when the env var is unset or empty.
 */
export function getAgentSessionId(
  agent: AgentRuntime,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const raw =
    agent === "antigravity"
      ? env.ANTIGRAVITY_CONVERSATION_ID
      : env.CLAUDE_CODE_SESSION_ID;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return raw;
}
