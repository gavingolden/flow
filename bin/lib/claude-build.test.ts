import { describe, expect, it } from "vitest";
import {
  detectClaudeBuild,
  MIN_SUBAGENT_EFFORT_VERSION,
  readSessionEffort,
  supportsSubagentEffort,
} from "./claude-build";

describe("detectClaudeBuild", () => {
  it("parses AI_AGENT", () => {
    expect(detectClaudeBuild({ AI_AGENT: "claude-code_2-1-303_agent" })).toBe(
      "2.1.303",
    );
  });

  it("falls back to the CLAUDE_CODE_EXECPATH basename", () => {
    expect(
      detectClaudeBuild({
        CLAUDE_CODE_EXECPATH: "/home/u/.local/share/claude/versions/2.1.300",
      }),
    ).toBe("2.1.300");
  });

  it("returns null when undetectable", () => {
    expect(detectClaudeBuild({})).toBeNull();
    expect(detectClaudeBuild({ AI_AGENT: "other" })).toBeNull();
    expect(
      detectClaudeBuild({ CLAUDE_CODE_EXECPATH: "/usr/bin/claude" }),
    ).toBeNull();
  });
});

describe("supportsSubagentEffort", () => {
  const at = (v: string) => ({
    AI_AGENT: `claude-code_${v.replace(/\./g, "-")}_agent`,
  });
  it("compares the three integers numerically", () => {
    expect(MIN_SUBAGENT_EFFORT_VERSION).toBe("2.1.292");
    expect(supportsSubagentEffort(at("2.1.292"))).toBe(true);
    expect(supportsSubagentEffort(at("2.1.303"))).toBe(true);
    expect(supportsSubagentEffort(at("2.2.0"))).toBe(true);
    expect(supportsSubagentEffort(at("3.0.0"))).toBe(true);
    expect(supportsSubagentEffort(at("2.1.291"))).toBe(false);
    expect(supportsSubagentEffort(at("2.0.999"))).toBe(false);
    expect(supportsSubagentEffort(at("1.9.999"))).toBe(false);
  });

  it("is false when the build is undetectable", () => {
    expect(supportsSubagentEffort({})).toBe(false);
  });
});

describe("readSessionEffort", () => {
  it("prefers CLAUDE_EFFORT, then state.effort, else empty", () => {
    expect(
      readSessionEffort({ CLAUDE_EFFORT: "high" }, { effort: "low" }),
    ).toBe("high");
    expect(readSessionEffort({}, { effort: "low" })).toBe("low");
    expect(
      readSessionEffort({ CLAUDE_EFFORT: "bogus" }, { effort: "low" }),
    ).toBe("low");
    expect(readSessionEffort({}, null)).toBe("");
    expect(readSessionEffort({ CLAUDE_EFFORT: "bogus" }, { effort: "x" })).toBe(
      "",
    );
  });
});
