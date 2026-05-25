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

/**
 * Returns the command argv launched in the tmux window. Claude is a
 * 2-tuple `[claude, prompt]` — claude's slash-command harness picks up
 * `/flow-pipeline` from the prompt and loads its `SKILL.md` as the
 * activation. agy 1.0.2 has no slash-command-as-skill discovery (only
 * `/goal`, `/schedule`, `/grill-me`, `/teamwork-preview` are built in;
 * see flow issue #223), so for antigravity we rewrite the prompt as a
 * Read-the-file instruction against the canonical install path. We also
 * pass `--dangerously-skip-permissions` to bypass agy's
 * first-directory-access trust prompt (which would otherwise hang every
 * `flow new` on a fresh worktree).
 */
export function agentCommand(
  agent: AgentRuntime,
  prompt: string,
  homeDir: string = require("os").homedir(),
): string[] {
  if (agent === "claude") return ["claude", prompt];
  // antigravity: rewrite "Use the /<name> skill <body>" → Read instruction.
  // The skill files are installed at ~/.claude/skills/<name>/SKILL.md by
  // `flow setup` (Claude Code's discovery path); agy doesn't care that
  // the dir name has "claude" in it — Read works against any absolute
  // path. Falling back to the raw prompt on a non-matching shape keeps
  // the function usable for ad-hoc agy invocations.
  //
  // The `-i` (short for `--prompt-interactive`) flag is load-bearing: it
  // tells agy to accept the positional prompt as the initial input and
  // continue the session interactively. Without it agy ignores the
  // positional and sits at an empty prompt — verified live during PR #222
  // smoke testing.
  const match = prompt.match(/^Use the \/(\S+) skill (.+)$/s);
  if (!match) {
    return ["agy", "--dangerously-skip-permissions", "-i", prompt];
  }
  const [, skillName, body] = match;
  const skillPath = `${homeDir}/.claude/skills/${skillName}/SKILL.md`;
  return [
    "agy",
    "--dangerously-skip-permissions",
    "-i",
    `Read the file at ${skillPath} in full, then follow its instructions ${body}`,
  ];
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
