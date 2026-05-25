import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AGENT_RUNTIMES,
  agentCommand,
  detectAgent,
  getAgentSessionId,
  isAgentRuntime,
  prewriteAgyTrust,
  type AgentRuntime,
} from "./agent";

describe(detectAgent, () => {
  it.each<[string, NodeJS.ProcessEnv, AgentRuntime]>([
    ["ANTIGRAVITY_CONVERSATION_ID set ⇒ antigravity", { ANTIGRAVITY_CONVERSATION_ID: "abc" }, "antigravity"],
    ["CLAUDE_CODE_SESSION_ID alone ⇒ claude", { CLAUDE_CODE_SESSION_ID: "xyz" }, "claude"],
    ["both env vars set ⇒ antigravity wins", { ANTIGRAVITY_CONVERSATION_ID: "abc", CLAUDE_CODE_SESSION_ID: "xyz" }, "antigravity"],
    ["neither env var ⇒ claude default", {}, "claude"],
    ["empty-string ANTIGRAVITY_CONVERSATION_ID ⇒ claude", { ANTIGRAVITY_CONVERSATION_ID: "" }, "claude"],
  ])("%s", (_label, env, expected) => {
    expect(detectAgent(env)).toBe(expected);
  });
});

describe(agentCommand, () => {
  it("returns ['claude', prompt] for claude (passes through unchanged)", () => {
    expect(agentCommand("claude", "hello")).toEqual(["claude", "hello"]);
  });

  it("rewrites /flow-pipeline skill activation to a Read instruction for antigravity", () => {
    // agy 1.0.2 doesn't surface skills as slash commands (see issue #223);
    // the prompt is transformed to instruct agy to Read the file directly.
    // --dangerously-skip-permissions bypasses the trust prompt; -i tells
    // agy to accept the positional as the initial interactive prompt
    // (without -i, agy ignores the positional and sits at an empty
    // prompt — verified live during PR #222 smoke testing).
    const cmd = agentCommand("antigravity", "Use the /flow-pipeline skill for: csv export", "/h");
    expect(cmd).toEqual([
      "agy",
      "--dangerously-skip-permissions",
      "-i",
      "Read the file at /h/.claude/skills/flow-pipeline/SKILL.md in full, then follow its instructions for: csv export",
    ]);
  });

  it("rewrites resume-mode activation the same way", () => {
    const cmd = agentCommand(
      "antigravity",
      "Use the /flow-pipeline skill in --resume mode for: my-slug",
      "/h",
    );
    expect(cmd).toEqual([
      "agy",
      "--dangerously-skip-permissions",
      "-i",
      "Read the file at /h/.claude/skills/flow-pipeline/SKILL.md in full, then follow its instructions in --resume mode for: my-slug",
    ]);
  });

  it("falls through (no rewrite) for non-skill prompts on antigravity", () => {
    expect(agentCommand("antigravity", "hello", "/h")).toEqual([
      "agy",
      "--dangerously-skip-permissions",
      "-i",
      "hello",
    ]);
  });
});

describe(getAgentSessionId, () => {
  it("returns CLAUDE_CODE_SESSION_ID for claude when set", () => {
    expect(getAgentSessionId("claude", { CLAUDE_CODE_SESSION_ID: "sess-1" })).toBe("sess-1");
  });

  it("returns undefined for claude when unset", () => {
    expect(getAgentSessionId("claude", {})).toBeUndefined();
  });

  it("returns ANTIGRAVITY_CONVERSATION_ID for antigravity when set", () => {
    expect(getAgentSessionId("antigravity", { ANTIGRAVITY_CONVERSATION_ID: "conv-2" })).toBe("conv-2");
  });

  it("returns undefined for antigravity when unset", () => {
    expect(getAgentSessionId("antigravity", {})).toBeUndefined();
  });

  it("returns undefined when env var is empty string", () => {
    expect(getAgentSessionId("claude", { CLAUDE_CODE_SESSION_ID: "" })).toBeUndefined();
    expect(getAgentSessionId("antigravity", { ANTIGRAVITY_CONVERSATION_ID: "" })).toBeUndefined();
  });
});

describe(isAgentRuntime, () => {
  it.each<[string, unknown, boolean]>([
    ["claude", "claude", true],
    ["antigravity", "antigravity", true],
    ["unknown string", "gpt", false],
    ["number", 42, false],
    ["undefined", undefined, false],
    ["null", null, false],
    ["empty string", "", false],
  ])("%s ⇒ %s", (_label, value, expected) => {
    expect(isAgentRuntime(value)).toBe(expected);
  });
});

describe("AGENT_RUNTIMES", () => {
  it("contains both supported runtimes", () => {
    expect(AGENT_RUNTIMES).toEqual(["claude", "antigravity"]);
  });
});

describe(prewriteAgyTrust, () => {
  let homeDir: string;
  let worktree: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agent-trust-"));
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agent-wt-"));
    // Simulate agy installed: the function gates on the existence of
    // ~/.gemini/.
    fs.mkdirSync(path.join(homeDir, ".gemini"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it("appends worktree to trustedWorkspaces, writes project record + breadcrumb symlink", () => {
    const uuid = prewriteAgyTrust(worktree, homeDir);
    expect(uuid).not.toBeNull();

    // Workspace-trust source of truth: trustedWorkspaces in agy settings.
    const settingsPath = path.join(homeDir, ".gemini", "antigravity-cli", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.trustedWorkspaces).toContain(worktree);

    // Project record (created for UUID tracking even though it's not
    // the trust mechanism).
    const projectFile = path.join(homeDir, ".gemini", "config", "projects", `${uuid}.json`);
    expect(fs.existsSync(projectFile)).toBe(true);
    const record = JSON.parse(fs.readFileSync(projectFile, "utf8"));
    expect(record.id).toBe(uuid);
    expect(record.name).toBe(worktree);

    const breadcrumb = path.join(worktree, ".antigravitycli", `${uuid}.json`);
    expect(fs.lstatSync(breadcrumb).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(breadcrumb)).toBe(projectFile);
  });

  it("preserves prior trustedWorkspaces entries and other settings keys", () => {
    const settingsPath = path.join(homeDir, ".gemini", "antigravity-cli", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        model: "Claude Opus 4.6 (Thinking)",
        trustedWorkspaces: ["/some/other/path"],
      }),
    );
    prewriteAgyTrust(worktree, homeDir);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.model).toBe("Claude Opus 4.6 (Thinking)");
    expect(settings.trustedWorkspaces).toEqual(["/some/other/path", worktree]);
  });

  it("does not duplicate a trustedWorkspaces entry on repeat calls", () => {
    prewriteAgyTrust(worktree, homeDir);
    prewriteAgyTrust(worktree, homeDir);
    const settings = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, ".gemini", "antigravity-cli", "settings.json"),
        "utf8",
      ),
    );
    const occurrences = settings.trustedWorkspaces.filter((p: string) => p === worktree);
    expect(occurrences).toHaveLength(1);
  });

  it("is idempotent — reuses the existing uuid when the project record already names this worktree", () => {
    const first = prewriteAgyTrust(worktree, homeDir);
    const second = prewriteAgyTrust(worktree, homeDir);
    expect(second).toBe(first);
    // Still exactly one project file.
    const projectsDir = path.join(homeDir, ".gemini", "config", "projects");
    expect(fs.readdirSync(projectsDir)).toHaveLength(1);
  });

  it("is a no-op when ~/.gemini/ does not exist (agy not installed)", () => {
    const cleanHome = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agent-clean-"));
    try {
      const uuid = prewriteAgyTrust(worktree, cleanHome);
      expect(uuid).toBeNull();
      // No project file, no breadcrumb dir.
      expect(fs.existsSync(path.join(cleanHome, ".gemini"))).toBe(false);
      expect(fs.existsSync(path.join(worktree, ".antigravitycli"))).toBe(false);
    } finally {
      fs.rmSync(cleanHome, { recursive: true, force: true });
    }
  });

  it("replaces a stale breadcrumb symlink without crashing", () => {
    fs.mkdirSync(path.join(worktree, ".antigravitycli"), { recursive: true });
    // Pre-existing symlink pointing nowhere useful.
    const stale = path.join(worktree, ".antigravitycli", "stale.json");
    fs.symlinkSync("/nowhere", stale);
    const uuid = prewriteAgyTrust(worktree, homeDir);
    expect(uuid).not.toBeNull();
    // New symlink exists alongside the stale one — function only
    // removes the file at its own target path, not pre-existing entries.
    expect(fs.existsSync(path.join(worktree, ".antigravitycli", `${uuid}.json`))).toBe(true);
    expect(fs.lstatSync(stale).isSymbolicLink()).toBe(true);
  });
});
