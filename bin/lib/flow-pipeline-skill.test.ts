/**
 * Regression test for the /flow-pipeline supervisor's "do not end the
 * turn between sub-skills" contract.
 *
 * Reproduced on PR #67 (slug fix-flow-new-tmux-target): the supervisor
 * paused after /product-planning returned and required a manual
 * "continue" to advance to /new-feature, even though intent was bug
 * (non-feature) and the contract is a single-turn walk from triage to
 * terminal end-state. The trigger was sub-skill tail messages that look
 * like natural turn-ends (e.g. /product-planning step 9 "share with
 * user and iterate" + /new-feature CTA).
 *
 * The fix lives in skills/pipeline/flow-pipeline/SKILL.md as (a) a Hard
 * rule enumerating the only legitimate turn-end points and (b) inline
 * "Continue immediately to step <N> in the same turn — do not end the
 * turn." sentences at each step boundary that follows a sub-skill
 * return. This test grep-asserts both pieces are present so a future
 * edit can't silently drop them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const skillPath = path.join(
  repoRoot,
  "skills",
  "pipeline",
  "flow-pipeline",
  "SKILL.md",
);

function readSkill(): string {
  return fs.readFileSync(skillPath, "utf8");
}

function sliceBetween(content: string, startMarker: string, endMarker: string): string {
  const start = content.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`start marker not found: ${startMarker}`);
  }
  const end = content.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    throw new Error(`end marker not found after start: ${endMarker}`);
  }
  return content.slice(start, end);
}

function sliceStep(content: string, step: string): string {
  // Steps are separated by `## Step` headings. We slice from one heading
  // up to the next (or to `# Resume mode` for step 10.5, which is the
  // last step).
  const stepHeadings = [
    "## Step 1 ",
    "## Step 2 ",
    "## Step 3 ",
    "## Step 4 ",
    "## Step 5 —",
    "## Step 5.5 ",
    "## Step 6 ",
    "## Step 7 ",
    "## Step 8 ",
    "## Step 9 ",
    "## Step 10 ",
    "## Step 10.5 ",
  ];
  const idx = stepHeadings.indexOf(step);
  if (idx === -1) throw new Error(`unknown step heading: ${step}`);
  const startIdx = content.indexOf(step);
  if (startIdx === -1) throw new Error(`step heading missing from SKILL.md: ${step}`);
  const nextHeading = stepHeadings[idx + 1] ?? "# Resume mode";
  const endIdx = content.indexOf(nextHeading, startIdx + step.length);
  if (endIdx === -1) {
    throw new Error(
      `next heading missing after ${step}: ${nextHeading}`,
    );
  }
  return content.slice(startIdx, endIdx);
}

describe("flow-pipeline supervisor SKILL.md", () => {
  describe("Hard rules — do-not-end-turn guard", () => {
    const hardRules = (() => sliceBetween(readSkill(), "# Hard rules", "# Notifications"))();

    it("Hard rules block contains the do-not-end-turn guard", () => {
      expect(hardRules).toMatch(
        /You never end the turn between sub-skills and the next step/,
      );
    });

    it("guard enumerates feature plan-pending-review as a legitimate turn-end", () => {
      expect(hardRules).toMatch(/plan-pending-review/);
    });

    it("guard enumerates the four terminal end-states", () => {
      expect(hardRules).toMatch(/\bMERGED\b/);
      expect(hardRules).toMatch(/\bGATED\b/);
      expect(hardRules).toMatch(/\bNEEDS HUMAN\b/);
      expect(hardRules).toMatch(/\bcancelled\b/);
    });

    it("guard enumerates the two ambiguous-clarifying-question turn-ends", () => {
      expect(hardRules).toMatch(/triage-ambiguous/);
      expect(hardRules).toMatch(/approval-ambiguous/);
    });
  });

  describe("inline continue-immediately sentences at audited step boundaries", () => {
    // Match the same-turn gloss while tolerating SKILL.md's hard line
    // wrapping — every word boundary is `\s+` so the phrase can wrap at
    // any space and still match. The em dash (U+2014) is required;
    // hyphens and en dashes won't match — that's intentional, since
    // sub-skills generate the very same "do not end the turn" phrasing
    // in printed text and we want the typographical em-dash variant
    // locked in for the supervisor contract.
    const SAME_TURN_GLOSS =
      /in\s+the\s+same\s+turn\s+—\s+do\s+not\s+end\s+the\s+turn/;

    // SKILL.md prose is hard-wrapped at ~70 chars, so the
    // "continue immediately to step N" phrase can wrap at any internal
    // word boundary. Build a wrapping-tolerant regex per step.
    const continueToStep = (n: string) =>
      new RegExp(`continue\\s+immediately\\s+to\\s+step\\s+${n}\\b`, "i");

    it("step 3 non-feature End-conditions branch tells supervisor to continue to step 5", () => {
      const step3 = sliceStep(readSkill(), "## Step 3 ");
      expect(step3).toMatch(continueToStep("5"));
      expect(step3).toMatch(SAME_TURN_GLOSS);
    });

    it("step 5.5 End-condition tells supervisor to continue to step 6", () => {
      const step55 = sliceStep(readSkill(), "## Step 5.5 ");
      expect(step55).toMatch(continueToStep("6"));
      expect(step55).toMatch(SAME_TURN_GLOSS);
    });

    it("step 6 End-condition tells supervisor to continue to step 7", () => {
      const step6 = sliceStep(readSkill(), "## Step 6 ");
      expect(step6).toMatch(continueToStep("7"));
      expect(step6).toMatch(SAME_TURN_GLOSS);
    });

    it("step 7 End-condition tells supervisor to continue to step 8 (proceed-to-review), step 10.5 (merged externally), and step 5 (ci-failed mode=fix), all in the same turn", () => {
      const step7 = sliceStep(readSkill(), "## Step 7 ");
      // proceed-to-review
      expect(step7).toMatch(continueToStep("8"));
      // merged externally → post-merge sweep
      expect(step7).toMatch(continueToStep("10.5"));
      // ci-failed → step 5 mode=fix (subject to fix-loop cap)
      expect(step7).toMatch(continueToStep("5"));
      // All three transitions need the same-turn gloss; counting
      // occurrences keeps the test honest if a future edit drops one.
      const matches = step7.match(new RegExp(SAME_TURN_GLOSS, "g")) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(3);
    });

    it("step 3 feature-intent branch still ends the turn at plan-pending-review (the do-not-end-turn rule must not break this)", () => {
      const step3 = sliceStep(readSkill(), "## Step 3 ");
      // The feature-intent branch must still write plan-pending-review
      // and end the turn. The do-not-end-turn fix is for non-feature
      // intents; feature intents are explicitly listed as a legitimate
      // turn-end in the Hard rule.
      expect(step3).toMatch(/plan-pending-review/);
      expect(step3).toMatch(/end\s+the\s+turn/i);
    });

    it("step 8 tells supervisor to continue to step 5 (mode=fix), step 7 (CI re-wait), and step 9 (clean)", () => {
      const step8 = sliceStep(readSkill(), "## Step 8 ");
      // mode=fix loop-back
      expect(step8).toMatch(continueToStep("5"));
      // CI re-wait after /pr-review commits + pushes
      expect(step8).toMatch(continueToStep("7"));
      // proceed to gating after clean review + green CI
      expect(step8).toMatch(continueToStep("9"));
      // The same-turn gloss must appear at least once for each of the
      // three transitions; counting occurrences keeps the test honest
      // if a future edit drops one of the three.
      const matches = step8.match(new RegExp(SAME_TURN_GLOSS, "g")) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(3);
    });
  });
});
