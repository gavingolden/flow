/**
 * Regression test for the /flow-pipeline supervisor's "do not end the
 * turn between sub-skills" contract.
 *
 * The contract was originally defended by three text-only layers
 * (leading blockquote, inline continue-immediately sentences,
 * `flow-checkpoint` reminders). Those layers proved insufficient in the
 * May 2026 chore-intent incident — the supervisor stopped at
 * `/new-feature`'s tail despite every layer being in place. The
 * structural defence is now `flow-stop-guard` (a Claude Code Stop hook
 * registered by `flow setup`), which intercepts the turn-end signal
 * itself.
 *
 * This test grep-asserts what the new contract requires: the Hard rule
 * still enumerates the legitimate turn-ends (now expressed as phase
 * names so the helper can read them), and the steps that perform a
 * legitimate turn-end write the corresponding phase to state.json
 * before ending.
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
  ];
  const idx = stepHeadings.indexOf(step);
  if (idx === -1) throw new Error(`unknown step heading: ${step}`);
  const startIdx = content.indexOf(step);
  if (startIdx === -1) throw new Error(`step heading missing from SKILL.md: ${step}`);
  const nextHeading = stepHeadings[idx + 1] ?? "# Resume mode";
  const endIdx = content.indexOf(nextHeading, startIdx + step.length);
  if (endIdx === -1) {
    throw new Error(`next heading missing after ${step}: ${nextHeading}`);
  }
  return content.slice(startIdx, endIdx);
}

describe("flow-pipeline supervisor SKILL.md", () => {
  describe("Hard rules — do-not-end-turn guard", () => {
    const hardRules = sliceBetween(readSkill(), "# Hard rules", "# Harness-level enforcement");

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

    it("guard enumerates the new pending-end phase names", () => {
      // These are the phase strings flow-stop-guard reads to decide
      // whether to allow a turn-end. If they drift here, the helper's
      // contract drifts with them.
      expect(hardRules).toMatch(/triaged-no-change/);
      expect(hardRules).toMatch(/triage-pending-clarification/);
      expect(hardRules).toMatch(/approval-pending-clarification/);
    });

    it("guard names the harness-level enforcement mechanism (flow-stop-guard)", () => {
      expect(hardRules).toMatch(/flow-stop-guard/);
    });
  });

  describe("Harness-level enforcement section", () => {
    const section = sliceBetween(
      readSkill(),
      "# Harness-level enforcement (Stop hook)",
      "# Notifications",
    );

    it("documents that the helper is registered by flow setup", () => {
      expect(section).toMatch(/flow setup/);
    });

    it("documents the --no-hooks opt-out", () => {
      expect(section).toMatch(/--no-hooks/);
    });

    it("documents the loop-break behaviour around stop_hook_active", () => {
      expect(section).toMatch(/stop_hook_active/);
    });
  });

  describe("step boundary phase writes", () => {
    it("step 1 no-change branch writes triaged-no-change before ending the turn", () => {
      const step1 = sliceStep(readSkill(), "## Step 1 ");
      expect(step1).toMatch(/triaged-no-change/);
    });

    it("step 1 ambiguous branch writes triage-pending-clarification before ending the turn", () => {
      const step1 = sliceStep(readSkill(), "## Step 1 ");
      expect(step1).toMatch(/triage-pending-clarification/);
    });

    it("step 3 feature-intent branch still ends the turn at plan-pending-review", () => {
      const step3 = sliceStep(readSkill(), "## Step 3 ");
      expect(step3).toMatch(/plan-pending-review/);
      expect(step3).toMatch(/end\s+the\s+turn/i);
    });

    it("step 4 ambiguous branch writes approval-pending-clarification before ending the turn", () => {
      const step4 = sliceStep(readSkill(), "## Step 4 ");
      expect(step4).toMatch(/approval-pending-clarification/);
    });

    it("step 7 still names the merged-externally inline cleanup steps", () => {
      const step7 = sliceStep(readSkill(), "## Step 7 ");
      expect(step7).toMatch(/merged externally/i);
      expect(step7).toMatch(/flow-remove-worktree/);
      expect(step7).toMatch(/print `MERGED`/);
    });
  });
});
