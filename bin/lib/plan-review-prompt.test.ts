import { describe, expect, it } from "vitest";
import { buildBatteryPrompt, extractGoalLine } from "./plan-review-prompt";

const BASE_INPUT = {
  planText: "# PRD\n\n**Goal:** ship the thing.\n",
  goalLine: "**Goal:** ship the thing.",
  worktreePath: "/repo",
};

describe("buildBatteryPrompt — bounded verification clauses", () => {
  for (const sameFamilyAsAuthor of [true, false]) {
    it(`carries the file-cap, no-subagent, budget-fraction and incremental-emission bounds (sameFamilyAsAuthor: ${sameFamilyAsAuthor})`, () => {
      const prompt = buildBatteryPrompt({ ...BASE_INPUT, sameFamilyAsAuthor });

      expect(prompt).toMatch(/Spot-check AT MOST 8 files/);
      expect(prompt).toMatch(
        /Do NOT spawn subagents or delegate this verification to other agents/,
      );
      expect(prompt).toMatch(/at most a third of your run on verification/);
      expect(prompt).toMatch(
        /Emit each of the six lenses below as it is finished, never buffering the whole review to the end/,
      );
    });
  }

  it("keeps the bounds between the file-reading-tools sentence and the Do NOT shell out clause", () => {
    const prompt = buildBatteryPrompt(BASE_INPUT);
    const toolsIdx = prompt.indexOf(
      "Reach for it with your file-reading tools ONLY",
    );
    const boundsIdx = prompt.indexOf("Spot-check AT MOST 8 files");
    const shellOutIdx = prompt.indexOf("Do NOT shell out");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(boundsIdx).toBeGreaterThan(toolsIdx);
    expect(shellOutIdx).toBeGreaterThan(boundsIdx);
  });

  it("does not change the lens headings", () => {
    const prompt = buildBatteryPrompt(BASE_INPUT);
    expect(prompt).toMatch(/\*\*Goal-anchored verdicts\.\*\*/);
    expect(prompt).toMatch(/\*\*Preference challenge\.\*\*/);
    expect(prompt).toMatch(/\*\*Per-option user-flow walkthrough\.\*\*/);
    expect(prompt).toMatch(/\*\*Structurally-different alternatives\.\*\*/);
    expect(prompt).toMatch(/\*\*Failure-modes battery\.\*\*/);
    expect(prompt).toMatch(/\*\*Independent cut list\.\*\*/);
  });
});

describe("extractGoalLine", () => {
  it("extracts the verbatim Goal line", () => {
    expect(extractGoalLine(BASE_INPUT.planText)).toBe(
      "**Goal:** ship the thing.",
    );
  });
});
