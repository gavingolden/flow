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
const REPORT_TEMPLATE_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "pr-review",
  "references",
  "report-template.md",
);
const MANUAL_TEST_RUBRIC_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "pr-review",
  "references",
  "manual-test-rubric.md",
);
const GATEKEEPER_SPAWN_PROMPT_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "pr-review",
  "references",
  "gatekeeper-spawn-prompt.md",
);
const FIX_APPLIER_SPAWN_PROMPT_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "pr-review",
  "references",
  "fix-applier-spawn-prompt.md",
);

const content = fs.readFileSync(SKILL_MD_PATH, "utf8");
const agentsContent = fs.readFileSync(AGENTS_MD_PATH, "utf8");
const prReviewContent = fs.readFileSync(PR_REVIEW_SKILL_MD_PATH, "utf8");
const fixApplierContent = fs.readFileSync(FIX_APPLIER_INSTRUCTIONS_PATH, "utf8");
const coderContent = fs.readFileSync(CODER_SKILL_MD_PATH, "utf8");
const coderInstructionsContent = fs.readFileSync(CODER_INSTRUCTIONS_PATH, "utf8");
const reportTemplateContent = fs.readFileSync(REPORT_TEMPLATE_PATH, "utf8");
const manualTestRubricContent = fs.readFileSync(MANUAL_TEST_RUBRIC_PATH, "utf8");
const gatekeeperSpawnPromptContent = fs.readFileSync(GATEKEEPER_SPAWN_PROMPT_PATH, "utf8");
const fixApplierSpawnPromptContent = fs.readFileSync(FIX_APPLIER_SPAWN_PROMPT_PATH, "utf8");

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

  it("flow-pipeline/SKILL.md Hard rules lists exactly 8 Task-tool exemptions", () => {
    const exemptions = extractSkillExemptions();
    expect(
      exemptions.length,
      "flow-pipeline/SKILL.md must list exactly 8 Task-tool exemption blocks " +
        "(one each for /pr-review Multi-Agent Review, /product-planning Discovery " +
        "Subagent, /new-feature Scout Subagent, /pr-review Fix-Applier Subagent, " +
        "/flow-pipeline step 10's Merge-Conflict Resolver Subagent, /coder " +
        "Edit-Applier Subagent, /pr-review Step 1.5 Gatekeeper Subagent, and " +
        "/pr-review Step 3.5 Consolidator-Validator Subagent). " +
        "Found: " + JSON.stringify(exemptions),
    ).toBe(8);
  });

  it("AGENTS.md ## Don'ts lists exactly 8 Task-tool exemption bullets", () => {
    const exemptions = extractAgentsExemptions();
    expect(
      exemptions.length,
      "AGENTS.md ## Don'ts must list exactly 8 Task-tool exemption bullets. " +
        "Found: " + JSON.stringify(exemptions),
    ).toBe(8);
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

  it("flow-pipeline/SKILL.md Hard rules preamble references eight exemptions", () => {
    expect(
      skillStripped.match(/the\s+\*\*only eight\*\*\s+authorised\s+Task-tool\s+fan-out\s+sites/),
      "flow-pipeline/SKILL.md Hard rules preamble must say 'the **only eight** authorised " +
        "Task-tool fan-out sites'. If you added or removed an exemption, update the count " +
        "in the preamble too — the count is bidirectional with the block list below.",
    ).toBeTruthy();
  });

  it("flow-pipeline/SKILL.md Hard rules opening references eight Task-tool exceptions", () => {
    expect(
      skillStripped.match(/the\s+eight\s+narrowly-named Task-tool exceptions that\s+follow/),
      "flow-pipeline/SKILL.md Hard rules opening must say 'the eight narrowly-named " +
        "Task-tool exceptions that follow'. Drift here means a future reader sees a count " +
        "that doesn't match the exemption blocks.",
    ).toBeTruthy();
  });

  it("AGENTS.md upstream prose references eight exceptions", () => {
    expect(
      agentsContent.match(/\*\*with eight narrowly-named exceptions\*\*/),
      "AGENTS.md ## Supervisor and sub-skills must say '**with eight narrowly-named exceptions**'. " +
        "The count must match the bullet list under ## Don'ts.",
    ).toBeTruthy();
    expect(
      agentsContent.match(/The eight\s+named exceptions are/),
      "AGENTS.md ## Don'ts parent bullet must say 'The eight named exceptions are'. " +
        "Drift here is the most likely landmine when adding a new exemption.",
    ).toBeTruthy();
    expect(
      agentsContent.match(/the\s+\*\*only eight\*\*\s+authorised\s+Task-tool\s+fan-out\s+sites/),
      "AGENTS.md ## Don'ts closer must say 'the **only eight** authorised Task-tool fan-out sites'. " +
        "Same count, same wording as flow-pipeline/SKILL.md's closer.",
    ).toBeTruthy();
  });

  it("flow-pipeline/SKILL.md Verification (this skill) lists all eight exemptions by name", () => {
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
        "/coder refactor; this list must enumerate all eight.",
    ).toBe(true);
    expect(
      verificationSection.includes("Independent Gatekeeper Subagent"),
      "flow-pipeline/SKILL.md Verification section must reference 'Independent Gatekeeper Subagent' " +
        "as one of the named Task-tool exemptions. The seventh exemption was added in the " +
        "/pr-review Step 1.5 Gatekeeper refactor; this list must enumerate all eight.",
    ).toBe(true);
    expect(
      verificationSection.includes("Independent Consolidator-Validator Subagent"),
      "flow-pipeline/SKILL.md Verification section must reference 'Independent Consolidator-Validator Subagent' " +
        "as one of the named Task-tool exemptions. The eighth exemption was added in the " +
        "/pr-review Step 3.5 Consolidator-Validator refactor; this list must enumerate all eight.",
    ).toBe(true);
  });
});

describe("/coder caller-list symmetry (AGENTS.md ↔ flow-pipeline/SKILL.md ↔ coder/SKILL.md)", () => {
  /**
   * The /coder skill is invoked by three callers via the wider-scope path of
   * each caller's hybrid threshold: /new-feature step 5, /verify step 3, and
   * /refactoring step 3. The caller list is documented in three places:
   *
   *   - AGENTS.md `## Don'ts` — /coder Task-tool exemption bullet body prose.
   *   - flow-pipeline/SKILL.md "Hard rules" — Task-tool exemption #6 block.
   *   - coder/SKILL.md frontmatter `description:` field.
   *
   * If a future change adds or removes a caller (e.g. a new skill starts
   * invoking /coder, or one of the existing three stops doing so), all three
   * documents must update in lockstep. This lint anchors the three sets so a
   * unilateral edit on any one side fails fast with a message that names the
   * divergent file AND the missing/extra caller.
   *
   * Extraction strategy: within each anchor section, match backticked
   * `/skill-name` tokens that appear immediately before a `step <N>` body-
   * prose marker. The `/flow-pipeline` token is filtered out — it's the
   * supervisor, not a /coder caller (and appears in two of the three sections
   * as "When `/flow-pipeline` step 5 loads ..." framing prose).
   */

  /**
   * Slice the /coder Task-tool exemption bullet from AGENTS.md, bounded by
   * the next `**Task-tool exemption` marker or end-of-string.
   */
  function sliceAgentsCoderSection(): string {
    const startMarker =
      "**Task-tool exemption: `/flow-pipeline` → `/coder` Independent";
    const startIdx = agentsContent.indexOf(startMarker);
    if (startIdx === -1) return "";
    const rest = agentsContent.slice(startIdx + startMarker.length);
    const nextMarkerIdx = rest.indexOf("**Task-tool exemption");
    return nextMarkerIdx === -1 ? rest : rest.slice(0, nextMarkerIdx);
  }

  /**
   * Slice the Task-tool exemption #6 block from flow-pipeline/SKILL.md,
   * bounded by the next `**Task-tool exemption` marker. Strip blockquote
   * `> ` prefixes so cross-line regexes match contiguous prose.
   */
  function slicePipelineCoderSection(): string {
    const stripped = stripBlockquoteMarkers(content);
    const startMarker =
      "**Task-tool exemption #6: `/coder` Independent Edit-Applier Subagent.**";
    const startIdx = stripped.indexOf(startMarker);
    if (startIdx === -1) return "";
    const rest = stripped.slice(startIdx + startMarker.length);
    const nextMarkerIdx = rest.indexOf("**Task-tool exemption");
    return nextMarkerIdx === -1 ? rest : rest.slice(0, nextMarkerIdx);
  }

  /**
   * Slice the frontmatter `description:` block from coder/SKILL.md, bounded
   * by the closing `---` frontmatter delimiter. The canonical text names all
   * three callers via the `<caller> step N` pattern.
   */
  function sliceCoderFrontmatter(): string {
    const lines = coderContent.split("\n");
    if (lines[0] !== "---") return "";
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === "---") {
        endIdx = i;
        break;
      }
    }
    if (endIdx === -1) return "";
    return lines.slice(1, endIdx).join("\n");
  }

  /**
   * Extract `/skill-name` tokens that appear immediately before a `step <N>`
   * body-prose marker. Normalise: strip backticks, strip leading slash,
   * lowercase. Filter out `/flow-pipeline` (the supervisor, not a /coder
   * caller). Dedupe + sort.
   */
  function extractCallers(section: string): string[] {
    const re = /`\/([a-z][a-z-]+)`\s+step\s+\d+/g;
    const raw = [...section.matchAll(re)].map((m) => m[1].toLowerCase());
    const filtered = raw.filter((name) => name !== "flow-pipeline");
    return [...new Set(filtered)].sort();
  }

  function extractAgentsCallers(): string[] {
    return extractCallers(sliceAgentsCoderSection());
  }

  function extractPipelineCallers(): string[] {
    return extractCallers(slicePipelineCoderSection());
  }

  function extractCoderCallers(): string[] {
    return extractCallers(sliceCoderFrontmatter());
  }

  it("AGENTS.md, flow-pipeline/SKILL.md, and coder/SKILL.md each list exactly 3 /coder callers", () => {
    const agentsCallers = extractAgentsCallers();
    const pipelineCallers = extractPipelineCallers();
    const coderCallers = extractCoderCallers();
    expect(
      agentsCallers.length,
      `AGENTS.md /coder exemption section must list exactly 3 callers ` +
        `(/new-feature, /verify, /refactoring). Found: ${JSON.stringify(agentsCallers)}. ` +
        `If you are intentionally adding a 4th caller, update this assertion in lockstep with the three docs.`,
    ).toBe(3);
    expect(
      pipelineCallers.length,
      `flow-pipeline/SKILL.md Task-tool exemption #6 block must list exactly 3 callers ` +
        `(/new-feature, /verify, /refactoring). Found: ${JSON.stringify(pipelineCallers)}. ` +
        `If you are intentionally adding a 4th caller, update this assertion in lockstep with the three docs.`,
    ).toBe(3);
    expect(
      coderCallers.length,
      `coder/SKILL.md frontmatter description must list exactly 3 callers ` +
        `(/new-feature, /verify, /refactoring). Found: ${JSON.stringify(coderCallers)}. ` +
        `If you are intentionally adding a 4th caller, update this assertion in lockstep with the three docs.`,
    ).toBe(3);
  });

  it("AGENTS.md, flow-pipeline/SKILL.md, and coder/SKILL.md list the same set of /coder callers", () => {
    const agentsCallers = extractAgentsCallers();
    const pipelineCallers = extractPipelineCallers();
    const coderCallers = extractCoderCallers();

    const onlyInAgents = agentsCallers.filter(
      (c) => !pipelineCallers.includes(c) || !coderCallers.includes(c),
    );
    const onlyInPipeline = pipelineCallers.filter(
      (c) => !agentsCallers.includes(c) || !coderCallers.includes(c),
    );
    const onlyInCoder = coderCallers.filter(
      (c) => !agentsCallers.includes(c) || !pipelineCallers.includes(c),
    );

    expect(
      onlyInAgents,
      `Callers in AGENTS.md but missing from flow-pipeline/SKILL.md or coder/SKILL.md: ${JSON.stringify(onlyInAgents)}. ` +
        `The three documents enumerate /coder's callers bidirectionally; if you add one to one ` +
        `side, you must add it to the other two.`,
    ).toEqual([]);
    expect(
      onlyInPipeline,
      `Callers in flow-pipeline/SKILL.md but missing from AGENTS.md or coder/SKILL.md: ${JSON.stringify(onlyInPipeline)}. ` +
        `The three documents enumerate /coder's callers bidirectionally; if you add one to one ` +
        `side, you must add it to the other two.`,
    ).toEqual([]);
    expect(
      onlyInCoder,
      `Callers in coder/SKILL.md but missing from AGENTS.md or flow-pipeline/SKILL.md: ${JSON.stringify(onlyInCoder)}. ` +
        `The three documents enumerate /coder's callers bidirectionally; if you add one to one ` +
        `side, you must add it to the other two.`,
    ).toEqual([]);
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

  it("pr-review/references/fix-applier-spawn-prompt.md instructs the subagent on negative-findings slots", () => {
    const hasNegativeFindings =
      fixApplierSpawnPromptContent.includes("rejected_alternatives") &&
      fixApplierSpawnPromptContent.includes("anti_patterns_found") &&
      fixApplierSpawnPromptContent.includes("silence is not the default");
    expect(
      hasNegativeFindings,
      "pr-review/references/fix-applier-spawn-prompt.md must affirmatively instruct the subagent to " +
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
          `Missing the key here means a downstream consumer (/new-feature step 5, /verify step 3, /refactoring step 3) ` +
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

describe("Gatekeeper artifact JSON schema drift (pr-review/SKILL.md)", () => {
  // skip_kind is intentionally NOT in the required-keys list — it's emitted
  // only on `decision: "skip"` and omitted on `decision: "proceed"`. The
  // sibling Fix-Applier and Edit-Applier schemas list every key as required;
  // the Gatekeeper's optional skip_kind diverges from that pattern by design.
  const GATEKEEPER_REQUIRED_KEYS = ["decision", "reason", "summary"];

  it.each(GATEKEEPER_REQUIRED_KEYS)(
    "pr-review/references/gatekeeper-spawn-prompt.md declares the '%s' top-level key for the gatekeeper artifact",
    (key) => {
      expect(
        gatekeeperSpawnPromptContent.includes(`\`${key}\``),
        `pr-review/references/gatekeeper-spawn-prompt.md must reference '\`${key}\`' as one of the gatekeeper ` +
          `artifact's typed fields. Drift here means the wrapper's branch-on-.decision ` +
          `logic at Step 1.5 silently falls through if the Haiku subagent renames a ` +
          `field. Mirrors the parallel Fix-Applier and Edit-Applier schema-drift lints ` +
          `above.`,
      ).toBe(true);
    },
  );

  it("pr-review/references/gatekeeper-spawn-prompt.md documents the optional 'skip_kind' field for the gatekeeper artifact", () => {
    expect(
      gatekeeperSpawnPromptContent.includes("`skip_kind`") ||
        gatekeeperSpawnPromptContent.includes('"skip_kind"'),
      "pr-review/references/gatekeeper-spawn-prompt.md must reference 'skip_kind' (as `skip_kind` or \"skip_kind\") " +
        "in the Gatekeeper subagent's documented artifact shape. The field is optional " +
        "(emitted only on decision: \"skip\") but the prose must still surface it so the " +
        "wrapper's reader knows to expect it on skip verdicts.",
    ).toBe(true);
  });

  it("pr-review/SKILL.md has an Independent Gatekeeper Subagent section", () => {
    expect(
      prReviewContent.includes("# Independent Gatekeeper Subagent"),
      "pr-review/SKILL.md must have a top-level '# Independent Gatekeeper Subagent' " +
        "section. The exemption in flow-pipeline/SKILL.md Hard rules and AGENTS.md " +
        "## Don'ts is anchored on this heading name.",
    ).toBe(true);
  });

  it("pr-review-last-sha: read-site lives in the Gatekeeper spawn prompt reference AND write-site lives in pr-review/SKILL.md Step 13", () => {
    // The marker file is the load-bearing input to the Gatekeeper's
    // "no-new-commits" skip rule. Without a write site on the clean Step 13
    // completion path, the most cost-effective skip rule is permanently
    // unreachable — every invocation falls through to the full Sonnet fan-out
    // even when the PR head SHA is unchanged since the last clean review.
    // After the spawn-prompt extraction, the read-site moved to the new
    // reference file while the write-site stayed in SKILL.md's Step 13
    // clean-completion block. This lint asserts both sides of the paired
    // contract so a future drift can't silently break the skip rule.
    expect(
      gatekeeperSpawnPromptContent.includes("pr-review-last-sha"),
      `pr-review/references/gatekeeper-spawn-prompt.md must reference ` +
        `'pr-review-last-sha' as the read-site for the no-new-commits skip rule. ` +
        `A missing read means the skip rule is dead code.`,
    ).toBe(true);
    expect(
      prReviewContent.includes("pr-review-last-sha"),
      `pr-review/SKILL.md must reference 'pr-review-last-sha' as the write-site ` +
        `in Step 13's clean-completion block. A missing write means the marker is ` +
        `never created and the skip rule's metadata check always falls through.`,
    ).toBe(true);
  });
});

describe("Consolidator artifact JSON schema drift (pr-review/SKILL.md)", () => {
  // The Consolidator-Validator subagent's artifact at
  // <worktree>/.flow-tmp/consolidator-result.json has five top-level keys.
  // All five are required (no optional fields, unlike the Gatekeeper's
  // skip_kind). The runtime validator at bin/lib/agent-finding-schema.ts
  // enforces the same shape; this lint pins the prose contract in
  // pr-review/SKILL.md and references/consolidator-instructions.md so a
  // field rename can't silently drift away from the runtime check.
  const CONSOLIDATOR_REQUIRED_KEYS = [
    "consolidated_findings",
    "dropped_by_validation",
    "rejected_alternatives",
    "anti_patterns_found",
    "summary",
  ];

  const CONSOLIDATOR_INSTRUCTIONS_PATH = path.resolve(
    HERE,
    "..",
    "skills",
    "pipeline",
    "pr-review",
    "references",
    "consolidator-instructions.md",
  );
  const consolidatorInstructionsContent = fs.readFileSync(
    CONSOLIDATOR_INSTRUCTIONS_PATH,
    "utf8",
  );

  it.each(CONSOLIDATOR_REQUIRED_KEYS)(
    "pr-review/SKILL.md declares the '%s' top-level key for the consolidator artifact",
    (key) => {
      expect(
        prReviewContent.includes(`\`${key}\``),
        `pr-review/SKILL.md must reference '\`${key}\`' as one of the ` +
          `consolidator artifact's typed fields. Drift here means a field ` +
          `rename in bin/lib/agent-finding-schema.ts could silently drift ` +
          `away from the prose contract — Step 4's reader would silently ` +
          `read the wrong key.`,
      ).toBe(true);
    },
  );

  it.each(CONSOLIDATOR_REQUIRED_KEYS)(
    "references/consolidator-instructions.md declares the '%s' top-level key in the artifact schema",
    (key) => {
      expect(
        consolidatorInstructionsContent.includes(key),
        `references/consolidator-instructions.md must include '${key}' in ` +
          `the artifact schema documentation. Drift between this file and ` +
          `pr-review/SKILL.md silently breaks the wrapper-subagent contract.`,
      ).toBe(true);
    },
  );

  it("pr-review/SKILL.md has an Independent Consolidator-Validator Subagent section", () => {
    expect(
      prReviewContent.includes("# Independent Consolidator-Validator Subagent"),
      "pr-review/SKILL.md must have a top-level '# Independent Consolidator-Validator Subagent' " +
        "section. The exemption in flow-pipeline/SKILL.md Hard rules and AGENTS.md " +
        "## Don'ts is anchored on this heading name.",
    ).toBe(true);
  });

  it("pr-review/SKILL.md declares the Step 3.5 label and the consolidator-result.json path", () => {
    expect(
      prReviewContent.includes("3.5"),
      "pr-review/SKILL.md must reference '3.5' as a canonical step label so " +
        "the result-artifact step enumeration stays in sync with the new step.",
    ).toBe(true);
    expect(
      prReviewContent.includes("consolidator-result.json"),
      "pr-review/SKILL.md must reference 'consolidator-result.json' so the " +
        "artifact path is grep-discoverable. Drift here means the Step 3.5 " +
        "post-spawn existence check could silently fall through.",
    ).toBe(true);
  });
});

describe("pr-review result-artifact contract lint", () => {
  it("pr-review SKILL.md frontmatter does not include `context: fork`", () => {
    expect(
      prReviewContent.includes("context: fork"),
      "pr-review SKILL.md frontmatter must NOT include 'context: fork'. " +
        "The directive was removed so the skill runs in the supervisor's " +
        "in-process Skill load, which is the prerequisite for both the " +
        "Multi-Agent Review and Fix-Applier Subagent Task-tool exemptions " +
        "to reach the supervisor's session.",
    ).toBe(false);
  });

  it.each([
    ".flow-tmp/pr-review-result.json",
    '"clean"',
    '"partial"',
    '"escalated"',
  ])("pr-review SKILL.md documents the result-artifact literal '%s'", (literal) => {
    expect(
      prReviewContent.includes(literal),
      `pr-review SKILL.md must include the literal '${literal}' so the ` +
        `result-artifact contract is grep-discoverable. The /flow-pipeline ` +
        `step 8 reader branches on these exact strings; drift here means ` +
        `the supervisor's parser falls through to the escalation path.`,
    ).toBe(true);
  });

  it.each([
    '"clean"',
    '"partial"',
    '"escalated"',
    "--resume-from",
  ])("flow-pipeline SKILL.md Step 8 documents the result-artifact literal '%s'", (literal) => {
    expect(
      content.includes(literal),
      `flow-pipeline SKILL.md Step 8 must include the literal '${literal}' ` +
        `so the supervisor's branch-on-status logic stays anchored on the ` +
        `same string the /pr-review wrapper writes. A drift means the ` +
        `partial-retry path silently falls through to the escalation arm.`,
    ).toBe(true);
  });

  const PR_REVIEW_REQUIRED_KEYS = [
    "status",
    "completed_steps",
    "missed_steps",
    "escalation_tag",
    "summary",
  ];

  it.each(PR_REVIEW_REQUIRED_KEYS)(
    "pr-review/SKILL.md declares the '%s' top-level key for the result artifact",
    (key) => {
      expect(
        prReviewContent.includes(`\`${key}\``),
        `pr-review/SKILL.md must reference '\`${key}\`' as one of the ` +
          `result-artifact's typed fields. Missing the key here means a ` +
          `field rename in bin/lib/pr-review-result-schema.ts could silently ` +
          `drift away from the prose contract — the supervisor reading the ` +
          `renamed field from a JSON that still uses the old key would ` +
          `silently fall through to the wrong branch. Mirrors the parallel ` +
          `Fix-Applier and Edit-Applier schema-drift lints above.`,
      ).toBe(true);
    },
  );
});

describe("Task-tool ToolSearch-load preamble at all eight spawn sites", () => {
  const SITES: ReadonlyArray<{ file: string; exemption_name: string }> = [
    {
      file: "skills/pipeline/pr-review/SKILL.md",
      exemption_name: "pr-review-multi-agent-review",
    },
    {
      file: "skills/pipeline/pr-review/SKILL.md",
      exemption_name: "pr-review-fix-applier",
    },
    {
      file: "skills/pipeline/pr-review/SKILL.md",
      exemption_name: "pr-review-gatekeeper",
    },
    {
      file: "skills/pipeline/pr-review/SKILL.md",
      exemption_name: "pr-review-consolidator-validator",
    },
    {
      file: "skills/pipeline/product-planning/SKILL.md",
      exemption_name: "product-planning-discovery",
    },
    {
      file: "skills/pipeline/new-feature/SKILL.md",
      exemption_name: "new-feature-scout",
    },
    {
      file: "skills/pipeline/coder/SKILL.md",
      exemption_name: "coder-edit-applier",
    },
    {
      file: "skills/pipeline/flow-pipeline/SKILL.md",
      exemption_name: "flow-pipeline-merge-resolver",
    },
  ];

  it.each(SITES)(
    "$file carries the 'Load the Task tool before spawning' preamble and escalation tag for $exemption_name",
    ({ file, exemption_name }) => {
      const absPath = path.resolve(HERE, "..", ...file.split("/"));
      const fileContent = fs.readFileSync(absPath, "utf8");
      expect(
        fileContent.includes("Load the Task tool before spawning"),
        `${file} must include the literal 'Load the Task tool before spawning' anchor at ` +
          `the spawn site for '${exemption_name}'. PR #124 was the inaugural silent-fallback ` +
          `regression: in Claude Code sessions where Task is a deferred capability, an ` +
          `unguarded Task call silently falls through to in-line execution and breaks the ` +
          `context-isolation contract each Task-tool exemption is justified by. Each spawn ` +
          `site must instruct the supervisor to load Task via ToolSearch first.`,
      ).toBe(true);
      const escalationTag = `task-tool-unavailable: ${exemption_name}`;
      expect(
        fileContent.includes(escalationTag),
        `${file} must include the literal '${escalationTag}' escalation tag at the spawn ` +
          `site for '${exemption_name}'. On missing Task schema, the supervisor escalates ` +
          `'NEEDS HUMAN: ${escalationTag}' rather than falling back to in-line execution. ` +
          `PR #124 is the regression precedent; bin/skill-md-lint.test.ts pins the contract.`,
      ).toBe(true);
    },
  );

  // Sites refactored to include-by-reference: the alias-tolerance literals
  // live in skills/pipeline/pr-review/references/task-tool-exemption-preamble.md
  // rather than at the spawn site. For these sites, fall back to the reference
  // file when the literals are not present in SKILL.md directly. The other
  // three sites continue to carry the literals at the spawn site as before.
  const REFACTORED_SITES = new Set([
    "pr-review-multi-agent-review",
    "pr-review-fix-applier",
    "pr-review-consolidator-validator",
    "flow-pipeline-merge-resolver",
  ]);
  const PREAMBLE_REF_PATH = path.resolve(
    HERE,
    "..",
    "skills",
    "pipeline",
    "pr-review",
    "references",
    "task-tool-exemption-preamble.md",
  );

  it.each(SITES)(
    "$file names both Task and Agent aliases at the spawn site for $exemption_name",
    ({ file, exemption_name }) => {
      const absPath = path.resolve(HERE, "..", ...file.split("/"));
      const fileContent = fs.readFileSync(absPath, "utf8");
      const hasTaskInSkill = fileContent.includes('"name": "Task"');
      const hasAgentInSkill = fileContent.includes('"name": "Agent"');

      const isRefactored = REFACTORED_SITES.has(exemption_name);
      const refContent = isRefactored
        ? fs.readFileSync(PREAMBLE_REF_PATH, "utf8")
        : "";
      const hasTask =
        hasTaskInSkill || (isRefactored && refContent.includes('"name": "Task"'));
      const hasAgent =
        hasAgentInSkill || (isRefactored && refContent.includes('"name": "Agent"'));

      expect(
        hasTask,
        `${file} (or its include-by-reference preamble at ` +
          `skills/pipeline/pr-review/references/task-tool-exemption-preamble.md ` +
          `for refactored sites) must include the literal '"name": "Task"' ` +
          `alias-tolerance literal at the spawn site for '${exemption_name}'. ` +
          `The preamble's literal-string check must succeed via at least the Task ` +
          `clause; econ-data PR #218 is the real-world repro — in sessions where ` +
          `the harness surfaces the same one-shot subagent-spawn primitive under ` +
          `the 'Agent' name with identical subagent_type/prompt/description schema, ` +
          `a preamble that only names 'Task' regresses to the false-negative ` +
          `escalation that surfaced in PR #218. Both literals must appear so the ` +
          `preamble matches whichever alias the harness exposes.`,
      ).toBe(true);
      expect(
        hasAgent,
        `${file} (or its include-by-reference preamble at ` +
          `skills/pipeline/pr-review/references/task-tool-exemption-preamble.md ` +
          `for refactored sites) must include the literal '"name": "Agent"' ` +
          `alias-tolerance literal at the spawn site for '${exemption_name}'. ` +
          `The preamble's literal-string check must also succeed via the Agent ` +
          `clause; econ-data PR #218 is the real-world repro — in sessions where ` +
          `the harness surfaces the one-shot subagent-spawn primitive under the ` +
          `'Agent' alias (identical subagent_type/prompt/description schema), a ` +
          `preamble that only names 'Task' regresses to a false-negative escalation. ` +
          `Both literals must appear so the preamble matches whichever alias the ` +
          `harness exposes.`,
      ).toBe(true);
    },
  );
});

describe("pr-review include-by-reference structure", () => {
  const PR_REVIEW_REFS_DIR = path.resolve(
    HERE,
    "..",
    "skills",
    "pipeline",
    "pr-review",
    "references",
  );
  const PREAMBLE_REF_PATH = path.resolve(
    PR_REVIEW_REFS_DIR,
    "task-tool-exemption-preamble.md",
  );
  const ESCALATION_RECIPES_PATH = path.resolve(
    PR_REVIEW_REFS_DIR,
    "escalation-recipes.md",
  );

  it("references/task-tool-exemption-preamble.md exists and is non-empty", () => {
    expect(
      fs.existsSync(PREAMBLE_REF_PATH),
      `skills/pipeline/pr-review/references/task-tool-exemption-preamble.md ` +
        `must exist. The refactor extracted the ~250-word "Load the Task tool ` +
        `before spawning" preamble out of SKILL.md into this reference file; ` +
        `dropping the file regresses every spawn-site link.`,
    ).toBe(true);
    const stat = fs.statSync(PREAMBLE_REF_PATH);
    expect(
      stat.size,
      `references/task-tool-exemption-preamble.md must be non-empty.`,
    ).toBeGreaterThan(0);
  });

  it("references/task-tool-exemption-preamble.md carries the canonical preamble literals", () => {
    const content = fs.readFileSync(PREAMBLE_REF_PATH, "utf8");
    expect(
      content.includes('"name": "Task"'),
      `references/task-tool-exemption-preamble.md must contain the literal ` +
        `'"name": "Task"' alias-tolerance anchor.`,
    ).toBe(true);
    expect(
      content.includes('"name": "Agent"'),
      `references/task-tool-exemption-preamble.md must contain the literal ` +
        `'"name": "Agent"' alias-tolerance anchor.`,
    ).toBe(true);
    expect(
      content.includes("Load the Task tool before spawning"),
      `references/task-tool-exemption-preamble.md must contain the literal ` +
        `'Load the Task tool before spawning' anchor.`,
    ).toBe(true);
    expect(
      content.includes("<exemption-name>"),
      `references/task-tool-exemption-preamble.md must contain the ` +
        `'<exemption-name>' placeholder so each spawn site can substitute its ` +
        `own escalation tag verbatim.`,
    ).toBe(true);
  });

  it("references/escalation-recipes.md exists and is non-empty", () => {
    expect(
      fs.existsSync(ESCALATION_RECIPES_PATH),
      `skills/pipeline/pr-review/references/escalation-recipes.md must exist.`,
    ).toBe(true);
    const stat = fs.statSync(ESCALATION_RECIPES_PATH);
    expect(
      stat.size,
      `references/escalation-recipes.md must be non-empty.`,
    ).toBeGreaterThan(0);
  });

  it("references/escalation-recipes.md carries all six escalation-tag literals", () => {
    const content = fs.readFileSync(ESCALATION_RECIPES_PATH, "utf8");
    for (const tag of [
      "task-tool-unavailable: pr-review-multi-agent-review",
      "task-tool-unavailable: pr-review-fix-applier",
      "task-tool-unavailable: pr-review-consolidator-validator",
      "fix-applier-missing-artifact",
      "consolidator-schema-failure",
      "consolidator-missing-artifact",
    ]) {
      expect(
        content.includes(tag),
        `references/escalation-recipes.md must contain the literal escalation ` +
          `tag '${tag}'. The supervisor's branch-on-status logic at /flow-pipeline ` +
          `step 8 reads these tags verbatim from the result artifact.`,
      ).toBe(true);
    }
  });

  it("skills/pipeline/pr-review/SKILL.md links to both reference files", () => {
    const prReviewSkillPath = path.resolve(
      HERE,
      "..",
      "skills",
      "pipeline",
      "pr-review",
      "SKILL.md",
    );
    const content = fs.readFileSync(prReviewSkillPath, "utf8");
    const preambleLinks = (
      content.match(/references\/task-tool-exemption-preamble\.md/g) ?? []
    ).length;
    expect(
      preambleLinks,
      `pr-review/SKILL.md must link to references/task-tool-exemption-preamble.md ` +
        `at least three times (once per spawn site: Fix-Applier, Multi-Agent ` +
        `Review, and Consolidator-Validator).`,
    ).toBeGreaterThanOrEqual(3);
    const recipesLinks = (
      content.match(/references\/escalation-recipes\.md/g) ?? []
    ).length;
    expect(
      recipesLinks,
      `pr-review/SKILL.md must link to references/escalation-recipes.md at least ` +
        `five times (once per escalation path: multi-agent-review, fix-applier, ` +
        `missing-artifact, consolidator-schema-failure, consolidator-missing-artifact). ` +
        `consolidator-validator's spawn-preamble references the recipe via the ` +
        `task-tool-exemption-preamble link, so its link count is not counted here.`,
    ).toBeGreaterThanOrEqual(5);
  });

  it("skills/pipeline/pr-review/SKILL.md line count stays under the post-refactor budget", () => {
    const prReviewSkillPath = path.resolve(
      HERE,
      "..",
      "skills",
      "pipeline",
      "pr-review",
      "SKILL.md",
    );
    const content = fs.readFileSync(prReviewSkillPath, "utf8");
    const lineCount = content.split("\n").length;
    // Budget bumped to 1850 to absorb the Step 3.5 Consolidator-Validator
    // refactor: new pointer section (~25 lines), new Step 3.5 step body
    // (~40 lines), expanded Step 3 fan-out (agent-output-<lens>.json
    // write instructions + lengthened table), renamed Step 4 prose, two
    // new escalated rows in the result-artifact table, and the
    // read-before-overwrite guard inlined at Steps 1.5 and 13. This
    // raise sits on top of the earlier include-by-reference pass that
    // extracted the Gatekeeper and Fix-Applier spawn-prompt templates
    // to dedicated reference files and collapsed the redundant
    // fix-applier-missing-artifact heredoc (1708 → ~1556 before this
    // step landed); the new ceiling reflects the new step's scope, not
    // a regrowth of previously-trimmed prose.
    expect(
      lineCount,
      `pr-review/SKILL.md line count must stay under the post-Consolidator ` +
        `budget of 1850 lines. Material regrowth past this ceiling would ` +
        `indicate unrelated bloat creeping back in.`,
    ).toBeLessThan(1850);
  });

  it("skills/pipeline/pr-review/SKILL.md Result artifact section carries the exit-path table header", () => {
    const prReviewSkillPath = path.resolve(
      HERE,
      "..",
      "skills",
      "pipeline",
      "pr-review",
      "SKILL.md",
    );
    const content = fs.readFileSync(prReviewSkillPath, "utf8");
    expect(
      content.includes("| Status | Escalation tag |"),
      `pr-review/SKILL.md must contain the result-artifact markdown table ` +
        `header '| Status | Escalation tag |'. The table consolidates the ` +
        `five exit-path prose bullets the refactor replaced.`,
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

describe("pr-review Step 11e inversion contract", () => {
  // Isolate just the **Fail (automatable)**: body. The slice is bounded on a
  // blank line followed by a non-indented bold marker (e.g. `**If 0 criteria
  // fail...**`, `**IMPORTANT**`, `**After any 11e edit...**`) so unrelated
  // sibling prose downstream of the last `**Fail (...)**` marker doesn't bleed
  // into the body. Without this bound, the lint silently inspects prose that
  // follows the Fail-subtype list and would false-fail on legitimate edits to
  // adjacent IMPORTANT/After blocks.
  function isolateFailAutomatableBody(): string {
    const stepSlice = prReviewContent.split("### 11e. Resolution")[1]?.split(/^## /m)[0] ?? "";
    const failAutoMarker = "**Fail (automatable)**:";
    const failAutoStart = stepSlice.indexOf(failAutoMarker);
    expect(
      failAutoStart,
      "Step 11e slice must contain the '**Fail (automatable)**:' marker. " +
        "If this assertion fails, the marker has been renamed and the lint " +
        "can no longer isolate the body.",
    ).toBeGreaterThanOrEqual(0);
    const afterMarker = stepSlice.slice(failAutoStart + failAutoMarker.length);
    const nextSiblingIdx = afterMarker.search(/\*\*Fail \(/);
    const beforeNextSibling =
      nextSiblingIdx >= 0 ? afterMarker.slice(0, nextSiblingIdx) : afterMarker;
    // Bound on a blank line followed by a non-indented bold marker — this
    // catches the `**If 0 criteria fail...**` / `**IMPORTANT**` /
    // `**After any 11e edit...**` blocks that sit after the last Fail subtype.
    const endIdx = beforeNextSibling.search(/\n\n\*\*[A-Z]/);
    return endIdx >= 0 ? beforeNextSibling.slice(0, endIdx) : beforeNextSibling;
  }

  it("Step 11e Fail (automatable) body forbids confirmation-gate phrases", () => {
    const body = isolateFailAutomatableBody();
    const normalised = body.replace(/\s+/g, " ");
    expect(
      normalised,
      "Step 11e Fail (automatable) body must NOT contain 'Show the user the list'. " +
        "The inverted resolution is default-on — the user redirects via reply after " +
        "the fact, not via upfront confirmation.",
    ).not.toContain("Show the user the list");
    expect(
      normalised,
      "Step 11e Fail (automatable) body must NOT contain 'On confirmation, write the tests'. " +
        "The inverted resolution writes tests by default; the confirmation-gate phrasing " +
        "is the regression this lint guards against.",
    ).not.toContain("On confirmation, write the tests");
  });

  it("Step 11e Fail (automatable) body retains the substantive inverted contract", () => {
    const body = isolateFailAutomatableBody();
    const normalised = body.replace(/\s+/g, " ");
    // Paired positive assertion: an absence-only lint passes vacuously if the
    // entire Fail (automatable) body is wiped or rewritten without the banned
    // phrases (e.g. `**Fail (automatable)**: TODO.`). Require the body to
    // contain at least two of the three substantive contract markers verbatim;
    // any wholesale rewrite that drops them must explicitly opt in by updating
    // this lint.
    const markers = ["default-on", "Auto-push exemption", "redirects via reply"];
    const present = markers.filter((m) => normalised.includes(m));
    expect(
      present.length,
      "Step 11e Fail (automatable) body must contain at least two of the " +
        "substantive inverted-contract markers: 'default-on', 'Auto-push exemption', " +
        "'redirects via reply'. A wholesale rewrite that drops these markers " +
        "silently re-introduces confirmation-gate semantics without ever using the " +
        "banned phrases the absence-only assertions above guard against. " +
        `Found markers: ${JSON.stringify(present)}.`,
    ).toBeGreaterThanOrEqual(2);
  });

  it("report-template Status: enum lists Manual items auto-converted", () => {
    expect(
      reportTemplateContent.includes("Manual items auto-converted"),
      "report-template.md PR Description Quality Status: enum must include " +
        "'Manual items auto-converted' as one of the pipe-separated values. " +
        "Step 11e's inverted Fail (automatable) resolution records its disposition " +
        "via this status value; drift here means the report omits the auto-conversion " +
        "audit trail.",
    ).toBe(true);
  });

  it("manual-test-rubric.md cross-reference names the conversion as default-on", () => {
    // PR #135's manual-test-rubric.md cross-reference (lines 28-32) describes
    // the Step 11e Fail (automatable) conversion as default-on with "redirects
    // via reply" semantics. Without a lint anchor, a future edit could revert
    // the rubric to its pre-PR wording without anything in the suite catching
    // it — the only verification before this lint was a one-time grep in the
    // PR's Test Steps section, which doesn't recur post-merge.
    expect(
      manualTestRubricContent.includes("default-on"),
      "manual-test-rubric.md must contain 'default-on' to anchor the " +
        "cross-reference to Step 11e's inverted Fail (automatable) resolution. " +
        "Drift here means the rubric describes the conversion as confirmation-gated " +
        "while SKILL.md describes it as default-on.",
    ).toBe(true);
    expect(
      manualTestRubricContent.includes("redirects via reply") ||
        manualTestRubricContent.includes("redirect by replying"),
      "manual-test-rubric.md must contain 'redirects via reply' (or the " +
        "report-template variant 'redirect by replying') to anchor the cross-" +
        "reference to Step 11e's default-on disposition. Drift here means the " +
        "rubric omits the after-the-fact redirect semantics.",
    ).toBe(true);
  });

  it("SKILL.md Step 12 names the Auto-converted line and the Status enum value verbatim", () => {
    // PR #135 documents the Step 12 auto-converted line authoritatively in
    // SKILL.md (the line spec + the cross-reference to the Status enum value).
    // Without a paired assertion against prReviewContent, SKILL.md can drift
    // while report-template.md stays correct and the lint above keeps passing.
    expect(
      prReviewContent.includes("Auto-converted N items per rubric:"),
      "SKILL.md Step 12 must contain the literal line spec " +
        "'Auto-converted N items per rubric:'. This is the report-side line " +
        "that fires when Step 11e's Fail (automatable) branch converts at least " +
        "one item; drift here means the report's per-item detail line is " +
        "undocumented on the SKILL.md side even if report-template.md is intact.",
    ).toBe(true);
    expect(
      prReviewContent.includes("Manual items auto-converted (N items, redirect by replying)"),
      "SKILL.md Step 12 must contain the verbatim cross-reference " +
        "'Manual items auto-converted (N items, redirect by replying)' so the " +
        "Step 12 prose and the report-template.md Status enum stay in lock-step. " +
        "Drift here means SKILL.md and report-template.md describe different " +
        "Status enum values for the same auto-conversion disposition.",
    ).toBe(true);
  });
});
