import { describe, expect, it } from "vitest";
import {
  AGENT_RUNTIMES,
  agentCommand,
  detectAgent,
  getAgentSessionId,
  isAgentRuntime,
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
