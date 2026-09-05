import { describe, expect, it } from "vitest";
import { agyReadRules } from "./agy-read-rules";
import { buildBatteryPrompt } from "./plan-review-prompt";
import { buildSurveyPrompt } from "./blind-survey-prompt";
import { buildPrompt as buildLensPrompt } from "../flow-gemini-lens";
import { buildPrompt as buildIntentGuessPrompt } from "../flow-gemini-intent-guess";

const BASE_INPUT = {
  worktreePath: "/repo",
  readPurpose: "ground your recommendation in what already exists",
  fileCap: 6,
  outputNoun: "run",
};

describe("agyReadRules", () => {
  it("contains every required clause, with the fileCap/outputNoun/readPurpose/worktreePath interpolated", () => {
    const block = agyReadRules(BASE_INPUT);
    expect(block).toContain(
      "/repo is the readable repository root — READ it to ground your recommendation in what already exists.",
    );
    expect(block).toContain(
      "Reach for it with your file-reading tools ONLY (read a file, list a directory).",
    );
    expect(block).toContain("Spot-check AT MOST 6 files");
    expect(block).toContain(
      "Do NOT spawn subagents or delegate this reading to other agents — read the files yourself.",
    );
    expect(block).toContain(
      "Spend at most a third of your run reading, then STOP.",
    );
    expect(block).toContain(
      "Do NOT shell out — no `grep`, `find`, `ls`, `cat`, or `git` commands: this is a headless run in which shell commands need a permission nothing can grant mid-run, so they are auto-denied and your run ends silently with no output at all.",
    );
  });

  it("orders 'Reach for it with your file-reading tools ONLY' before 'Do NOT shell out'", () => {
    const block = agyReadRules(BASE_INPUT);
    expect(
      block.indexOf("Reach for it with your file-reading tools ONLY"),
    ).toBeLessThan(block.indexOf("Do NOT shell out"));
  });

  it("honors a readVerb/pacingPhrase override (needed only by plan-review-prompt.ts's pre-existing 'verification' wording)", () => {
    const block = agyReadRules({
      ...BASE_INPUT,
      readVerb: "verification",
      pacingPhrase: "on verification",
    });
    expect(block).toContain(
      "Do NOT spawn subagents or delegate this verification to other agents",
    );
    expect(block).toContain(
      "Spend at most a third of your run on verification, then STOP.",
    );
  });
});

// Task 3: pin all four --add-dir prompt sites to this one source of truth.
describe("agy-read-rules composition across the four --add-dir prompt sites", () => {
  it("buildBatteryPrompt (flow-plan-review) composes the shared block", () => {
    const prompt = buildBatteryPrompt({
      planText: "# PRD\n\n**Goal:** ship the thing.\n",
      goalLine: "**Goal:** ship the thing.",
      worktreePath: "/repo",
    });
    expect(prompt).toContain("Reach for it with your file-reading tools ONLY");
    expect(prompt).toContain("Do NOT shell out");
  });

  it("buildSurveyPrompt (flow-blind-survey) composes the shared block", () => {
    const prompt = buildSurveyPrompt({
      brief: "Ship a way to validate the user's method before building it.",
      worktreePath: "/repo",
    });
    expect(prompt).toContain("Reach for it with your file-reading tools ONLY");
    expect(prompt).toContain("Do NOT shell out");
  });

  it("buildPrompt (flow-gemini-lens) composes the shared block", () => {
    const diff = "diff --git a/x.ts b/x.ts\n+1\n";
    const prompt = buildLensPrompt(diff, "/repo");
    expect(prompt).toContain("Reach for it with your file-reading tools ONLY");
    expect(prompt).toContain("Do NOT shell out");
  });

  it("buildPrompt (flow-gemini-intent-guess) composes the shared block", () => {
    const diff = "diff --git a/x.ts b/x.ts\n+1\n";
    const prompt = buildIntentGuessPrompt(diff, "x.ts\n", "/repo");
    expect(prompt).toContain("Reach for it with your file-reading tools ONLY");
    expect(prompt).toContain("Do NOT shell out");
  });
});
