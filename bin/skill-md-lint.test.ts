import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { NEXT_STEP_BY_PHASE } from "./flow-stop-guard";
import { STEP_PHASES } from "./lib/state";

/**
 * Structural lint for `skills/pipeline/flow-pipeline/SKILL.md`.
 *
 * The supervisor's "do not end the turn between sub-skills" contract
 * is now enforced by the `flow-stop-guard` Stop hook (see SKILL.md's
 * "Harness-level enforcement (Stop hook)" section). The previous
 * load-bearing layer was a leading "DO NOT END THE TURN" blockquote
 * at every step heading; that text-only defence proved insufficient
 * in the May 2026 chore-intent incident and was removed. The lint now
 * anchors on what the harness mechanism reads (the new pending-end
 * phase strings + a reference to the helper) so a doc rename can't
 * silently drift away from the guard's contract.
 *
 * Also lints two cross-doc invariants for the named Task-tool
 * exemptions: AGENTS.md `## Don'ts` and flow-pipeline/SKILL.md "Hard
 * rules" must list the same set of exemptions, and the JSON schema
 * for the Fix-Applier Subagent's artifact must match between
 * pr-review/SKILL.md and pr-review/references/fix-applier-instructions.md.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pipeline",
  "SKILL.md",
);
const AGENTS_MD_PATH = path.resolve(HERE, "..", "AGENTS.md");
const PR_REVIEW_SKILL_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "pr-review",
  "SKILL.md",
);
const FIX_APPLIER_INSTRUCTIONS_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "pr-review",
  "references",
  "fix-applier-instructions.md",
);
const CODER_SKILL_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "coder",
  "SKILL.md",
);
const CODER_INSTRUCTIONS_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "coder",
  "references",
  "coder-instructions.md",
);

const content = fs.readFileSync(SKILL_MD_PATH, "utf8");
const agentsContent = fs.readFileSync(AGENTS_MD_PATH, "utf8");
const prReviewContent = fs.readFileSync(PR_REVIEW_SKILL_MD_PATH, "utf8");
const fixApplierContent = fs.readFileSync(FIX_APPLIER_INSTRUCTIONS_PATH, "utf8");
const coderContent = fs.readFileSync(CODER_SKILL_MD_PATH, "utf8");
const coderInstructionsContent = fs.readFileSync(CODER_INSTRUCTIONS_PATH, "utf8");

/**
 * Strip markdown blockquote `> ` prefixes from line starts so cross-line
 * regexes can match contiguous prose. The "Hard rules" section in
 * flow-pipeline/SKILL.md is one big blockquote; without this preprocessing,
 * `\s+` in a regex doesn't match `\n> ` (the `>` isn't whitespace) and the
 * match silently falls through.
 */
function stripBlockquoteMarkers(text: string): string {
  return text.replace(/^>\s?/gm, "");
}

/**
 * Normalise an exemption's skill+heading text for cross-doc comparison.
 * Strips backticks, blockquote `> ` carryover, lowercases, collapses
 * whitespace, drops trailing punctuation. Two strings are "the same
 * exemption" iff their normalised forms match.
 */
function normaliseExemption(raw: string): string {
  return raw
    .replace(/[`*]/g, "")
    .replace(/^>\s?/gm, "")
    .replace(/\s+/g, " ")
    .replace(/[.,>]+$/, "")
    .trim()
    .toLowerCase();
}

function findStepHeadings(lines: string[]): string[] {
  return lines.filter((line) => /^## Step /.test(line));
}

describe("flow-pipeline SKILL.md structural lint", () => {
  it("ships exactly 12 numbered step headings (1, 2, 3, 4, 5, 5.5, 6, 7, 8, 9, 10, 11)", () => {
    const headings = findStepHeadings(content.split("\n"));
    expect(headings.length).toBe(12);
  });

  it.each([
    "triaged-no-change",
    "triage-pending-clarification",
    "approval-pending-clarification",
  ])("references the new pending-end phase '%s'", (phase) => {
    expect(
      content.includes(phase),
      `SKILL.md must reference '${phase}' so flow-stop-guard's contract ` +
        `stays anchored in the doc. Add a write-this-phase note in the ` +
        `relevant step's End conditions if you removed it.`,
    ).toBe(true);
  });

  it("references flow-stop-guard so the harness mechanism is documented", () => {
    expect(
      content.includes("flow-stop-guard"),
      "SKILL.md must reference 'flow-stop-guard'. The Stop hook is the " +
        "load-bearing defence behind the never-end-the-turn contract; the " +
        "doc must link to it by name so future readers can find it.",
    ).toBe(true);
  });

  it("documents the --no-hooks opt-out", () => {
    expect(
      content.includes("--no-hooks"),
      "SKILL.md must document the '--no-hooks' opt-out so users who " +
        "manage settings.json by hand know how to skip the merge.",
    ).toBe(true);
  });

  it("references PIPELINE_PHASES so the canonical set is discoverable", () => {
    expect(
      content.includes("PIPELINE_PHASES"),
      "SKILL.md must reference 'PIPELINE_PHASES' so future readers can " +
        "find the canonical phase set in bin/lib/state.ts.",
    ).toBe(true);
  });

  it("step 4 references AskUserQuestion + the candidate-issues section", () => {
    expect(
      content.includes("AskUserQuestion"),
      "flow-pipeline SKILL.md must reference 'AskUserQuestion' — the " +
        "primitive the supervisor calls in step 4's candidate-issues " +
        "sub-step is the only authorised AskUserQuestion site.",
    ).toBe(true);
    expect(
      content.includes("# Candidate follow-up issues"),
      "flow-pipeline SKILL.md must reference '# Candidate follow-up issues' " +
        "so step 4 and step 10 stay anchored on the plan.md section name.",
    ).toBe(true);
  });

  it("step 10 references flow-create-issue + the post-merge sweep", () => {
    expect(
      content.includes("flow-create-issue"),
      "flow-pipeline SKILL.md must reference 'flow-create-issue' — the " +
        "step 10 post-merge sweep fires it once per ticked candidate.",
    ).toBe(true);
    expect(
      content.includes("Post-merge follow-up sweep"),
      "flow-pipeline SKILL.md must include a 'Post-merge follow-up sweep' " +
        "heading or block in step 10 so the named exemption stays anchored.",
    ).toBe(true);
  });

  it("post-merge sweep block precedes flow-remove-worktree in step 10", () => {
    const sweepIdx = content.indexOf("Post-merge follow-up sweep");
    const removeIdx = content.indexOf("flow-remove-worktree", sweepIdx);
    expect(sweepIdx, "Post-merge follow-up sweep heading is missing").toBeGreaterThan(0);
    expect(
      removeIdx,
      "flow-remove-worktree must appear AFTER the post-merge sweep block " +
        "in step 10 — running it first would delete plan.md before the " +
        "sweep can read the candidate-issue list.",
    ).toBeGreaterThan(sweepIdx);
  });
});

describe("pr-review deferral-tracker lint", () => {
  it("the wrapper SKILL.md still references the helper + fallback by name", () => {
    expect(
      prReviewContent.includes("flow-create-issue"),
      "pr-review SKILL.md must reference 'flow-create-issue' (even when the " +
        "actual deferral logic lives in the Fix-Applier Subagent's instructions, " +
        "the wrapper must name the helper so a doc-only reader sees the path).",
    ).toBe(true);
    expect(
      prReviewContent.includes("ROADMAP.md"),
      "pr-review SKILL.md must mention the 'ROADMAP.md' fallback so projects " +
        "without GH Issues know how the deferral path degrades.",
    ).toBe(true);
  });

  it("the Fix-Applier Subagent's instructions wire the flow-create-issue invocation", () => {
    expect(
      fixApplierContent.includes("flow-create-issue"),
      "fix-applier-instructions.md must contain a runnable 'flow-create-issue' " +
        "invocation in the deferral path. PR #100 moved Step 6 into the subagent; " +
        "this wiring lives there now.",
    ).toBe(true);
    expect(
      fixApplierContent.includes("flow-agent,deferred-review"),
      "fix-applier-instructions.md must use the 'flow-agent,deferred-review' " +
        "label combo so deferred findings are filterable via " +
        "`gh issue list --label deferred-review`.",
    ).toBe(true);
    expect(
      fixApplierContent.includes("ROADMAP.md"),
      "fix-applier-instructions.md must document the ROADMAP.md fallback for " +
        "projects without GH Issues — removing it would strand non-GH-Issues " +
        "projects when the helper exits non-zero.",
    ).toBe(true);
  });
});

describe("Task-tool exemption symmetry (AGENTS.md ↔ flow-pipeline/SKILL.md)", () => {
  /**
   * Pre-strip blockquote markers so cross-line regexes match. The "Hard
   * rules" section is one large blockquote; preserving the raw form for
   * other tests in this file means we strip locally for these tests.
   */
  const skillStripped = stripBlockquoteMarkers(content);

  /**
   * Extract exemption keys from flow-pipeline/SKILL.md "Hard rules" section.
   * Format: `**Task-tool exemption #N: <skill-and-heading>.**`
   */
  function extractSkillExemptions(): string[] {
    const re = /\*\*Task-tool exemption #\d+:\s*([^*]+?)\.\*\*/g;
    return [...skillStripped.matchAll(re)].map((m) => normaliseExemption(m[1]));
  }

  /**
   * Extract exemption keys from AGENTS.md `## Don'ts` section. Format:
   * `**Task-tool exemption: \`/flow-pipeline\` → <skill-and-heading>.**`
   * The `/flow-pipeline` → prefix is stripped so the keys align with
   * the SKILL.md side (which doesn't include the `/flow-pipeline →` prefix).
   */
  function extractAgentsExemptions(): string[] {
    const re = /\*\*Task-tool exemption:\s*`\/flow-pipeline`\s*→\s*([^*]+?)\.\*\*/g;
    return [...agentsContent.matchAll(re)].map((m) => normaliseExemption(m[1]));
  }

  it("flow-pipeline/SKILL.md Hard rules lists exactly 6 Task-tool exemptions", () => {
    const exemptions = extractSkillExemptions();
    expect(
      exemptions.length,
      "flow-pipeline/SKILL.md must list exactly 6 Task-tool exemption blocks " +
        "(one each for /pr-review Multi-Agent Review, /product-planning Discovery " +
        "Subagent, /new-feature Scout Subagent, /pr-review Fix-Applier Subagent, " +
        "/flow-pipeline step 10's Merge-Conflict Resolver Subagent, and /coder " +
        "Edit-Applier Subagent). Found: " + JSON.stringify(exemptions),
    ).toBe(6);
  });

  it("AGENTS.md ## Don'ts lists exactly 6 Task-tool exemption bullets", () => {
    const exemptions = extractAgentsExemptions();
    expect(
      exemptions.length,
      "AGENTS.md ## Don'ts must list exactly 6 Task-tool exemption bullets. " +
        "Found: " + JSON.stringify(exemptions),
    ).toBe(6);
  });

  it("AGENTS.md and flow-pipeline/SKILL.md list the same set of exemptions", () => {
    const skill = new Set(extractSkillExemptions());
    const agents = new Set(extractAgentsExemptions());
    const onlyInSkill = [...skill].filter((x) => !agents.has(x));
    const onlyInAgents = [...agents].filter((x) => !skill.has(x));
    expect(
      onlyInSkill.length,
      `Exemptions in flow-pipeline/SKILL.md but missing from AGENTS.md: ${JSON.stringify(onlyInSkill)}. ` +
        "The two files document the same set of exemptions bidirectionally; if you add one to one " +
        "side, you must add it to the other.",
    ).toBe(0);
    expect(
      onlyInAgents.length,
      `Exemptions in AGENTS.md but missing from flow-pipeline/SKILL.md: ${JSON.stringify(onlyInAgents)}. ` +
        "Add the matching `**Task-tool exemption #N: ...**` block to flow-pipeline/SKILL.md " +
        "Hard rules so the bidirectional contract holds.",
    ).toBe(0);
  });

  it("flow-pipeline/SKILL.md Hard rules preamble references six exemptions", () => {
    expect(
      skillStripped.match(/the\s+\*\*only six\*\*\s+authorised\s+Task-tool\s+fan-out\s+sites/),
      "flow-pipeline/SKILL.md Hard rules preamble must say 'the **only six** authorised " +
        "Task-tool fan-out sites'. If you added or removed an exemption, update the count " +
        "in the preamble too — the count is bidirectional with the block list below.",
    ).toBeTruthy();
  });

  it("flow-pipeline/SKILL.md Hard rules opening references six Task-tool exceptions", () => {
    expect(
      skillStripped.match(/the\s+six\s+narrowly-named Task-tool exceptions that\s+follow/),
      "flow-pipeline/SKILL.md Hard rules opening must say 'the six narrowly-named " +
        "Task-tool exceptions that follow'. Drift here means a future reader sees a count " +
        "that doesn't match the exemption blocks.",
    ).toBeTruthy();
  });

  it("AGENTS.md upstream prose references six exceptions", () => {
    expect(
      agentsContent.match(/\*\*with six narrowly-named exceptions\*\*/),
      "AGENTS.md ## Supervisor and sub-skills must say '**with six narrowly-named exceptions**'. " +
        "The count must match the bullet list under ## Don'ts.",
    ).toBeTruthy();
    expect(
      agentsContent.match(/The six\s+named exceptions are/),
      "AGENTS.md ## Don'ts parent bullet must say 'The six named exceptions are'. " +
        "Drift here is the most likely landmine when adding a new exemption.",
    ).toBeTruthy();
    expect(
      agentsContent.match(/the\s+\*\*only six\*\*\s+authorised\s+Task-tool\s+fan-out\s+sites/),
      "AGENTS.md ## Don'ts closer must say 'the **only six** authorised Task-tool fan-out sites'. " +
        "Same count, same wording as flow-pipeline/SKILL.md's closer.",
    ).toBeTruthy();
  });

  it("flow-pipeline/SKILL.md Verification (this skill) lists all six exemptions by name", () => {
    const verificationSection =
      content.split("# Verification")[1] ?? content.split("# Verification (this skill)")[1] ?? "";
    expect(
      verificationSection.includes("Independent Multi-Agent Review"),
      "flow-pipeline/SKILL.md Verification section must reference 'Independent Multi-Agent Review' " +
        "as one of the named Task-tool exemptions.",
    ).toBe(true);
    expect(
      verificationSection.includes("Independent Discovery Subagent"),
      "flow-pipeline/SKILL.md Verification section must reference 'Independent Discovery Subagent' " +
        "as one of the named Task-tool exemptions.",
    ).toBe(true);
    expect(
      verificationSection.includes("Independent Scout Subagent"),
      "flow-pipeline/SKILL.md Verification section must reference 'Independent Scout Subagent' " +
        "as one of the named Task-tool exemptions.",
    ).toBe(true);
    expect(
      verificationSection.includes("Independent Fix-Applier Subagent"),
      "flow-pipeline/SKILL.md Verification section must reference 'Independent Fix-Applier Subagent' " +
        "as one of the named Task-tool exemptions.",
    ).toBe(true);
    expect(
      verificationSection.includes("Merge-Conflict Resolver Subagent"),
      "flow-pipeline/SKILL.md Verification section must reference 'Merge-Conflict Resolver Subagent' " +
        "as one of the named Task-tool exemptions.",
    ).toBe(true);
    expect(
      verificationSection.includes("Independent Edit-Applier Subagent"),
      "flow-pipeline/SKILL.md Verification section must reference 'Independent Edit-Applier Subagent' " +
        "as one of the named Task-tool exemptions. The sixth exemption was added in the " +
        "/coder refactor; this list must enumerate all six.",
    ).toBe(true);
  });
});

describe("Fix-Applier artifact JSON schema drift (pr-review/SKILL.md ↔ references/fix-applier-instructions.md)", () => {
  const REQUIRED_KEYS = [
    "commits",
    "deferred",
    "rejected_alternatives",
    "anti_patterns_found",
    "summary",
  ];

  it.each(REQUIRED_KEYS)(
    "pr-review/SKILL.md declares the '%s' top-level key for the fix-applier artifact",
    (key) => {
      expect(
        prReviewContent.includes(`\`${key}\``),
        `pr-review/SKILL.md must reference '\`${key}\`' as one of the artifact's typed fields. ` +
          `Missing the key here means a downstream Step (9/10/11/12) consumer drifts away from ` +
          `the schema documented in references/fix-applier-instructions.md.`,
      ).toBe(true);
    },
  );

  it.each(REQUIRED_KEYS)(
    "references/fix-applier-instructions.md declares the '%s' top-level key in the artifact schema",
    (key) => {
      expect(
        fixApplierContent.includes(`"${key}"`),
        `references/fix-applier-instructions.md step 9 must include '"${key}"' in the JSON schema fenced block. ` +
          `Drift between this file and pr-review/SKILL.md silently breaks the wrapper-subagent contract.`,
      ).toBe(true);
    },
  );

  it("pr-review/SKILL.md has a Fix-Applier Subagent section", () => {
    expect(
      prReviewContent.includes("# Fix-Applier Subagent"),
      "pr-review/SKILL.md must have a top-level '# Fix-Applier Subagent' section that " +
        "documents the spawn procedure and prompt template. The exemption in flow-pipeline/SKILL.md " +
        "Hard rules and AGENTS.md ## Don'ts is anchored on this heading name.",
    ).toBe(true);
  });

  it("pr-review/SKILL.md spawn-prompt template instructs the subagent on negative-findings slots", () => {
    const hasNegativeFindings =
      prReviewContent.includes("rejected_alternatives") &&
      prReviewContent.includes("anti_patterns_found") &&
      prReviewContent.includes("silence is not the default");
    expect(
      hasNegativeFindings,
      "pr-review/SKILL.md's spawn prompt template must affirmatively instruct the subagent to " +
        "populate 'rejected_alternatives' and 'anti_patterns_found' (and warn that 'silence is " +
        "not the default'). Without this, the subagent defaults to leaving the slots empty and " +
        "the user-redirect contract is silently broken.",
    ).toBe(true);
  });
});

describe("Edit-Applier artifact JSON schema drift (coder/SKILL.md ↔ references/coder-instructions.md)", () => {
  const CODER_REQUIRED_KEYS = [
    "edits",
    "verify_status",
    "rejected_alternatives",
    "anti_patterns_found",
    "summary",
  ];

  it.each(CODER_REQUIRED_KEYS)(
    "coder/SKILL.md declares the '%s' top-level key for the edit-applier artifact",
    (key) => {
      expect(
        coderContent.includes(`\`${key}\``),
        `coder/SKILL.md must reference '\`${key}\`' as one of the artifact's typed fields. ` +
          `Missing the key here means a downstream consumer (/new-feature step 5, /verify step 3) ` +
          `drifts away from the schema documented in references/coder-instructions.md.`,
      ).toBe(true);
    },
  );

  it.each(CODER_REQUIRED_KEYS)(
    "references/coder-instructions.md declares the '%s' top-level key in the artifact schema",
    (key) => {
      expect(
        coderInstructionsContent.includes(`"${key}"`),
        `references/coder-instructions.md step 4 must include '"${key}"' in the JSON schema fenced block. ` +
          `Drift between this file and coder/SKILL.md silently breaks the wrapper-subagent contract.`,
      ).toBe(true);
    },
  );

  it("coder/SKILL.md has an Independent Edit-Applier Subagent section", () => {
    expect(
      coderContent.includes("## Independent Edit-Applier Subagent"),
      "coder/SKILL.md must have an '## Independent Edit-Applier Subagent' section that " +
        "documents the spawn procedure and prompt template. The exemption in flow-pipeline/SKILL.md " +
        "Hard rules and AGENTS.md ## Don'ts is anchored on this heading name.",
    ).toBe(true);
  });

  it("coder/SKILL.md spawn-prompt template instructs the subagent on negative-findings slots", () => {
    const hasNegativeFindings =
      coderContent.includes("rejected_alternatives") &&
      coderContent.includes("anti_patterns_found") &&
      coderContent.includes("silence is not the default");
    expect(
      hasNegativeFindings,
      "coder/SKILL.md's spawn prompt template must affirmatively instruct the subagent to " +
        "populate 'rejected_alternatives' and 'anti_patterns_found' (and warn that 'silence is " +
        "not the default'). Without this, the subagent defaults to leaving the slots empty and " +
        "the user-redirect contract is silently broken.",
    ).toBe(true);
  });

  it("coder/SKILL.md cross-references AGENTS.md and flow-pipeline/SKILL.md", () => {
    expect(
      coderContent.includes("AGENTS.md"),
      "coder/SKILL.md must reference 'AGENTS.md' so the bidirectional contract is discoverable.",
    ).toBe(true);
    expect(
      coderContent.includes("skills/pipeline/flow-pipeline/SKILL.md"),
      "coder/SKILL.md must reference 'skills/pipeline/flow-pipeline/SKILL.md' so the named " +
        "exemption pointer is discoverable.",
    ).toBe(true);
  });

  it("AGENTS.md cross-references coder/SKILL.md", () => {
    expect(
      agentsContent.includes("skills/pipeline/coder/SKILL.md"),
      "AGENTS.md must reference 'skills/pipeline/coder/SKILL.md' inside the fifth Task-tool " +
        "exemption block so the bidirectional contract holds.",
    ).toBe(true);
  });
});

describe("flow-pipeline SKILL.md ↔ flow-stop-guard NEXT_STEP_BY_PHASE cross-doc lint", () => {
  it.each(STEP_PHASES.map((phase) => [phase]))(
    "every `step N(.M)?` reference in NEXT_STEP_BY_PHASE['%s'] maps to a `## Step N — ` heading in SKILL.md",
    (phase) => {
      const label = NEXT_STEP_BY_PHASE[phase];
      expect(
        label,
        `flow-stop-guard NEXT_STEP_BY_PHASE is missing an entry for ` +
          `STEP_PHASES value '${phase}'. Every step phase needs a "next step" ` +
          `reminder so the Stop hook can tell the supervisor where to go next.`,
      ).toBeDefined();

      const refs = [...label!.matchAll(/step (\d+(?:\.\d+)?)/gi)].map((m) => m[1]);
      expect(
        refs.length,
        `NEXT_STEP_BY_PHASE['${phase}'] = ${JSON.stringify(label)} contains ` +
          `no \`step N\` reference; the helper's "continue to ..." reminder ` +
          `would be uninformative.`,
      ).toBeGreaterThan(0);

      for (const n of refs) {
        const needle = `## Step ${n} `;
        expect(
          content.includes(needle),
          `NEXT_STEP_BY_PHASE['${phase}'] = ${JSON.stringify(label)} ` +
            `references 'step ${n}', but SKILL.md has no '${needle}— ' heading. ` +
            `A step renumber/rename in SKILL.md has drifted the helper's ` +
            `reminder text away from the doc.`,
        ).toBe(true);
      }
    },
  );
});
