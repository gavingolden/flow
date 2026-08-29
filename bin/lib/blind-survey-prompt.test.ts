import { describe, expect, it } from "vitest";
import {
  BLIND_FRAMING,
  briefLeaksCorpus,
  buildSurveyPrompt,
} from "./blind-survey-prompt";

const BASE_INPUT = {
  brief: "Ship a way to validate the user's method before building it.",
  worktreePath: "/repo",
};

describe("buildSurveyPrompt", () => {
  it("carries the brief verbatim under a '## Goal brief' heading", () => {
    const prompt = buildSurveyPrompt(BASE_INPUT);
    const headingIdx = prompt.indexOf("## Goal brief");
    expect(headingIdx).toBeGreaterThan(-1);
    expect(prompt.indexOf(BASE_INPUT.brief)).toBeGreaterThan(headingIdx);
  });

  it("opens with the BLIND_FRAMING sentence verbatim", () => {
    const prompt = buildSurveyPrompt(BASE_INPUT);
    expect(prompt.startsWith(BLIND_FRAMING)).toBe(true);
    expect(BLIND_FRAMING).toMatch(
      /you do not know what solution the requester has in mind, and you must not guess at it/,
    );
  });

  it("carries the read-only rules, including a .flow-tmp denial line", () => {
    const prompt = buildSurveyPrompt(BASE_INPUT);
    expect(prompt).toMatch(/Reach for it with your file-reading tools ONLY/);
    expect(prompt).toMatch(/Spot-check AT MOST 8 files/);
    expect(prompt).toMatch(
      /Do NOT spawn subagents or delegate this reading to other agents/,
    );
    expect(prompt).toMatch(/Do NOT shell out/);
    expect(prompt).toMatch(/Do NOT read the `\.flow-tmp\/` directory/);
    expect(prompt).toMatch(/Do NOT open `\.env\*` files/);
  });

  it("carries the worktree path", () => {
    const prompt = buildSurveyPrompt(BASE_INPUT);
    expect(prompt).toContain(BASE_INPUT.worktreePath);
  });

  it("carries the four output headings in order", () => {
    const prompt = buildSurveyPrompt(BASE_INPUT);
    const idx1 = prompt.indexOf("### 1. Goal as understood");
    const idx2 = prompt.indexOf("### 2. Recommended method");
    const idx3 = prompt.indexOf("### 3. Alternatives considered and why not");
    const idx4 = prompt.indexOf("### 4. Risks and what would change your mind");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
    expect(idx4).toBeGreaterThan(idx3);
  });

  it("never contains a caller-supplied description string that is not in the brief", () => {
    const prompt = buildSurveyPrompt(BASE_INPUT);
    const description =
      "Add a Task-tool judge sub-agent that reads the plan and vetoes it.";
    expect(prompt).not.toContain(description);
  });
});

describe("briefLeaksCorpus", () => {
  const corpus =
    "Add a Task subagent judge that reads the whole plan and vetoes bad methods before implementation starts.\n" +
    "Pause the pipeline and ask before proceeding.\n" +
    "ok\n" +
    "yes please";

  it("detects an 8-word verbatim run from the corpus in the brief", () => {
    const brief =
      "We should add a Task subagent judge that reads the whole plan and vetoes it.";
    expect(briefLeaksCorpus(brief, corpus)).toBe(true);
  });

  it("does not trip on the same brief with the run paraphrased", () => {
    const brief =
      "We should have an independent reviewer check the proposed approach before work begins.";
    expect(briefLeaksCorpus(brief, corpus)).toBe(false);
  });

  it("is not defeated by punctuation, case, or whitespace differences", () => {
    const brief =
      "ADD A Task-Subagent, judge  that   reads the WHOLE plan and vetoes it!!";
    expect(briefLeaksCorpus(brief, corpus)).toBe(true);
  });

  it("catches a 3-7 word corpus line copied verbatim", () => {
    const brief =
      "We should pause the pipeline and ask before proceeding today.";
    expect(briefLeaksCorpus(brief, corpus)).toBe(true);
  });

  it("never trips on a 1-2 word corpus line", () => {
    const brief = "We will say ok to every request and move fast.";
    expect(briefLeaksCorpus(brief, corpus)).toBe(false);
  });

  it("catches a leak from a later multi-line corpus entry (digest answers)", () => {
    const multiLineCorpus =
      "Ship a validator.\n" +
      "Desired behavior: pause the pipeline and ask the user to confirm before implementation starts.";
    const brief =
      "The plan should pause the pipeline and ask the user to confirm before implementation starts.";
    expect(briefLeaksCorpus(brief, multiLineCorpus)).toBe(true);
  });

  it("honours a custom shingleWords value", () => {
    const brief = "reads the whole plan and vetoes";
    expect(briefLeaksCorpus(brief, corpus, 4)).toBe(true);
    expect(briefLeaksCorpus(brief, corpus, 20)).toBe(false);
  });

  it("returns false for an empty brief", () => {
    expect(briefLeaksCorpus("", corpus)).toBe(false);
  });

  it("returns false for an empty corpus", () => {
    expect(briefLeaksCorpus("anything at all here", "")).toBe(false);
  });

  describe("length-boundary cases (shingleWords default = 8)", () => {
    it("an exactly-8-word corpus line copied verbatim ⇒ true (the shingle-loop branch, not the short-line branch)", () => {
      const line = "run two pinned judges over a goal only";
      const brief = "we should run two pinned judges over a goal only today";
      expect(briefLeaksCorpus(brief, line)).toBe(true);
    });

    it("an exactly-7-word corpus line copied verbatim ⇒ true (short-line rule, >= 3 words)", () => {
      const line = "ship a validator without any human review";
      const brief =
        "the plan is to ship a validator without any human review soon";
      expect(briefLeaksCorpus(brief, line)).toBe(true);
    });

    it("an exactly-3-word corpus line copied verbatim ⇒ true (short-line floor)", () => {
      const line = "ship a validator";
      const brief = "we should ship a validator now";
      expect(briefLeaksCorpus(brief, line)).toBe(true);
    });

    it("an exactly-2-word corpus line copied verbatim ⇒ false (below the short-line floor)", () => {
      const line = "ship it";
      const brief = "we should ship it now";
      expect(briefLeaksCorpus(brief, line)).toBe(false);
    });

    it("a 9-word corpus line where the brief only carries 7 of its words contiguously ⇒ false (neither 8-word shingle window matches)", () => {
      const line = "one two three four five six seven eight nine";
      const brief = "we should go two three four five six seven eight tomorrow";
      expect(briefLeaksCorpus(brief, line)).toBe(false);
    });

    it("a shingle split across two corpus lines never matches (per-line contract — shingles never span a newline)", () => {
      const twoLineCorpus =
        "the quick brown fox jumps over the lazy\n" +
        "dog runs fast through the green forest today";
      // Spans the line boundary: the last 4 words of line 1 plus the
      // first 4 words of line 2, contiguous in the brief but never a
      // shingle of either line on its own.
      const brief = "she jumps over the lazy dog runs fast through the yard";
      expect(briefLeaksCorpus(brief, twoLineCorpus)).toBe(false);
    });
  });
});
