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

/**
 * Pre-writes agy's workspace trust state so the first run in a new
 * worktree doesn't hang on the interactive "Do you trust this folder?"
 * TUI prompt. `--dangerously-skip-permissions` is misleadingly named —
 * it bypasses tool-permission requests but does NOT bypass this
 * workspace-level trust prompt (verified live during PR #222 smoke
 * testing — see flow issue #223).
 *
 * The load-bearing state is the `trustedWorkspaces` array at
 * `~/.gemini/antigravity-cli/settings.json`. agy writes the workspace
 * path to this array after the user confirms the trust prompt
 * interactively; appending it ourselves before the spawn short-circuits
 * the prompt entirely.
 *
 * Also pre-creates the per-project record at
 * `~/.gemini/config/projects/<uuid>.json` and the matching breadcrumb
 * symlink at `<worktree>/.antigravitycli/<uuid>.json`. agy creates
 * these on its own when missing, but pre-writing them gives flow a
 * stable UUID for the worktree (handy for future tooling that wants
 * to correlate agy conversations back to a pipeline).
 *
 * No-op when agy isn't installed (heuristic: `~/.gemini/` absent).
 * Returns the uuid written for the project record, or null on no-op.
 * Idempotent — both the `trustedWorkspaces` append and the project
 * record creation are guarded by existing-membership checks.
 */
export function prewriteAgyTrust(
  worktreePath: string,
  homeDir: string = require("os").homedir(),
): string | null {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const crypto = require("node:crypto") as typeof import("node:crypto");

  const geminiHome = path.join(homeDir, ".gemini");
  // agy not installed (no ~/.gemini/) — no-op silently.
  if (!fs.existsSync(geminiHome)) return null;

  // The settings file is the workspace-trust source of truth. Create
  // the parent dir if missing (agy itself does this on first run).
  const settingsPath = path.join(geminiHome, "antigravity-cli", "settings.json");
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    let settings: { trustedWorkspaces?: string[]; [k: string]: unknown } = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      // Missing or malformed — start fresh. agy validates on its end.
    }
    const trusted = Array.isArray(settings.trustedWorkspaces)
      ? settings.trustedWorkspaces
      : [];
    if (!trusted.includes(worktreePath)) {
      settings.trustedWorkspaces = [...trusted, worktreePath];
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
  } catch {
    // Couldn't write settings — the spawn will fall back to the trust
    // prompt, but won't crash.
  }

  // Project record. Idempotency: scan for an existing record matching
  // this worktree path before generating a fresh UUID.
  const projectsDir = path.join(geminiHome, "config", "projects");
  let uuid: string | null = null;
  try {
    fs.mkdirSync(projectsDir, { recursive: true });
    for (const entry of fs.readdirSync(projectsDir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(projectsDir, entry), "utf8"));
        if (parsed?.name === worktreePath) {
          uuid = entry.replace(/\.json$/, "");
          break;
        }
      } catch {
        // Skip malformed records — they're agy's problem, not ours.
      }
    }
  } catch {
    // Directory unreadable — fall through and try to write fresh.
  }

  if (!uuid) uuid = crypto.randomUUID();

  const projectFile = path.join(projectsDir, `${uuid}.json`);
  const record = {
    id: uuid,
    name: worktreePath,
    projectResources: {
      resources: [{ gitFolder: { folderUri: `file://${worktreePath}`, allowWrite: true } }],
    },
  };
  try {
    fs.writeFileSync(projectFile, JSON.stringify(record, null, 2));
  } catch {
    return null;
  }

  // Symlink the worktree-side breadcrumb so agy can rediscover the
  // record via the workspace dir on subsequent runs.
  const breadcrumbDir = path.join(worktreePath, ".antigravitycli");
  const breadcrumb = path.join(breadcrumbDir, `${uuid}.json`);
  try {
    fs.mkdirSync(breadcrumbDir, { recursive: true });
    try {
      fs.unlinkSync(breadcrumb);
    } catch {
      // Wasn't there — fine.
    }
    fs.symlinkSync(projectFile, breadcrumb);
  } catch {
    // Worktree may be read-only or removed — the project file alone
    // is enough; swallow rather than fail.
  }

  return uuid;
}
