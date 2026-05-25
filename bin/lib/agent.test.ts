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
  it("returns ['claude', prompt] for claude", () => {
    expect(agentCommand("claude", "hello")).toEqual(["claude", "hello"]);
  });

  it("returns ['agy', prompt] for antigravity", () => {
    expect(agentCommand("antigravity", "hello")).toEqual(["agy", "hello"]);
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
