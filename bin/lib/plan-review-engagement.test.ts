import { describe, expect, it } from "vitest";
import {
  MIN_LENSES_ENGAGED,
  SUBSTANCE_FLOOR_CHARS,
  classifyEngagement,
  countLensesEngaged,
} from "./plan-review-engagement";
import { buildBatteryPrompt } from "./plan-review-prompt";

describe("classifyEngagement — substance floor", () => {
  it("empty string is reviewer-empty", () => {
    expect(classifyEngagement("")).toEqual({
      engaged: false,
      lensesEngaged: 0,
      reason: "reviewer-empty",
    });
  });

  it("whitespace-only is reviewer-empty", () => {
    expect(classifyEngagement("   \n\t  ")).toEqual({
      engaged: false,
      lensesEngaged: 0,
      reason: "reviewer-empty",
    });
  });

  it("a 39-char string (below the floor) is reviewer-empty", () => {
    const prose = "a".repeat(SUBSTANCE_FLOOR_CHARS - 1);
    expect(prose.length).toBe(39);
    expect(classifyEngagement(prose)).toEqual({
      engaged: false,
      lensesEngaged: 0,
      reason: "reviewer-empty",
    });
  });

  it("a 40-char string (at the floor) is scored past the floor, not reviewer-empty", () => {
    const prose = "a".repeat(SUBSTANCE_FLOOR_CHARS);
    expect(prose.length).toBe(40);
    const result = classifyEngagement(prose);
    expect(!result.engaged && result.reason).not.toBe("reviewer-empty");
  });
});

describe("classifyEngagement — lens floor", () => {
  it("prose engaging 0 lenses is reviewer-not-engaged", () => {
    const prose =
      "This plan looks fine overall and I have nothing further to add here.";
    expect(classifyEngagement(prose)).toEqual({
      engaged: false,
      lensesEngaged: 0,
      reason: "reviewer-not-engaged",
    });
  });

  it("prose engaging 1 lens is reviewer-not-engaged", () => {
    const prose =
      "Considering the failure-mode battery, nothing else stands out as worth flagging in this plan.";
    expect(countLensesEngaged(prose)).toBe(1);
    expect(classifyEngagement(prose)).toEqual({
      engaged: false,
      lensesEngaged: 1,
      reason: "reviewer-not-engaged",
    });
  });

  it("prose engaging 2 lenses is engaged:true with lensesEngaged 2", () => {
    const prose =
      "Judged against the stated goal, the plan holds up. The preference the author elicited mid-discovery does conflict slightly, though.";
    expect(countLensesEngaged(prose)).toBe(2);
    const result = classifyEngagement(prose);
    expect(result.engaged).toBe(true);
    expect(result.lensesEngaged).toBe(2);
    expect("reason" in result).toBe(false);
  });

  it("prose engaging all 6 lenses is engaged:true with lensesEngaged 6", () => {
    const prose = [
      "Judged against the stated goal, the plan holds up.",
      "The preference the author elicited does conflict with it.",
      "Walking through the user-flow for each option: 0 interruptions per run.",
      "A structurally different alternative is worth ranking here.",
      "The failure-mode enumeration is thin and needs a mitigation.",
      "My independent cut-list found nothing the author's cut list missed.",
    ].join(" ");
    expect(countLensesEngaged(prose)).toBe(6);
    expect(classifyEngagement(prose)).toEqual({
      engaged: true,
      lensesEngaged: 6,
    });
  });
});

describe("countLensesEngaged — case-insensitivity and dedup", () => {
  it("is case-insensitive", () => {
    expect(countLensesEngaged("GOAL-ANCHORED verdicts look solid.")).toBe(1);
    expect(countLensesEngaged("Goal-Anchored verdicts look solid.")).toBe(1);
  });

  it("a lens mentioned twice still counts once", () => {
    const prose =
      "The preference conflicts with the plan. This preference issue recurs throughout.";
    expect(countLensesEngaged(prose)).toBe(1);
  });
});

describe("MIN_LENSES_ENGAGED / SUBSTANCE_FLOOR_CHARS constants", () => {
  it("pins the documented values", () => {
    expect(SUBSTANCE_FLOOR_CHARS).toBe(40);
    expect(MIN_LENSES_ENGAGED).toBe(2);
  });
});

// --- Parity test: the prompt's authored lens headings must all be matched
// by their corresponding regex, so a future reword of the prompt cannot
// silently start demoting real reviews. Derives the headings from the
// GENERATED prompt text (buildBatteryPrompt's actual output) rather than a
// hardcoded duplicate list, so the two cannot drift.
describe("battery-prompt / matcher parity", () => {
  const prompt = buildBatteryPrompt({
    planText: "# PRD\n**Goal:** Ship the thing.\n",
    goalLine: "**Goal:** Ship the thing.",
    worktreePath: "/tmp/wt",
  });

  // Authored, in lens order, exactly as buildBatteryPrompt emits them.
  const LENS_HEADINGS = [
    "**Goal-anchored verdicts.**",
    "**Preference challenge.**",
    "**Per-option user-flow walkthrough.**",
    "**Structurally-different alternatives.**",
    "**Failure-modes battery.**",
    "**Independent cut list.**",
  ];

  it.each(LENS_HEADINGS)(
    "the generated prompt still carries the authored heading %s",
    (heading) => {
      expect(prompt).toContain(heading);
    },
  );

  // Route through the module's REAL classifier, not a hand-copied regex
  // list — a copy can drift silently (tightening the real regex leaves a
  // stale local copy green while real reviews get demoted). Each authored
  // heading must engage exactly its own lens.
  it.each(LENS_HEADINGS)(
    "heading %s is matched by exactly one real lens (countLensesEngaged)",
    (heading) => {
      expect(countLensesEngaged(heading)).toBe(1);
    },
  );

  // Also catches two headings collapsing onto the same matcher: if that
  // happened, the concatenation would engage fewer than 6 distinct lenses.
  it("all 6 authored headings together engage all 6 real lenses", () => {
    expect(countLensesEngaged(LENS_HEADINGS.join("\n"))).toBe(6);
  });
});
