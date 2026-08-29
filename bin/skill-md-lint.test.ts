import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { NEXT_STEP_BY_PHASE } from "./flow-stop-guard";
import { STEP_PHASES, TERMINAL_EXIT_TRANSITIONS } from "./lib/state";
import { AGENT_LENS_MAP } from "./flow-pr-agent-lens";
import { CHECKPOINT_SITES } from "./flow-checkpoint";

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
 * flow-pr-review/SKILL.md and flow-pr-review/references/fix-applier-instructions.md.
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
const EXEMPTION_CONTRACTS_PATH = path.resolve(
  HERE,
  "..",
  "references",
  "exemption-contracts.md",
);
const PR_REVIEW_SKILL_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pr-review",
  "SKILL.md",
);
const FIX_APPLIER_INSTRUCTIONS_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pr-review",
  "references",
  "fix-applier-instructions.md",
);
const CODER_SKILL_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-coder",
  "SKILL.md",
);
const CODER_INSTRUCTIONS_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-coder",
  "references",
  "coder-instructions.md",
);
const PRODUCT_PLANNING_TOP_SKILL_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-product-planning",
  "SKILL.md",
);
const REPORT_TEMPLATE_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pr-review",
  "references",
  "report-template.md",
);
const MANUAL_TEST_RUBRIC_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pr-review",
  "references",
  "manual-test-rubric.md",
);
const AUTO_MERGE_RUBRIC_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pipeline",
  "references",
  "auto-merge-rubric.md",
);
const REDIRECT_HANDLING_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pipeline",
  "references",
  "redirect-handling.md",
);
const FAILURE_RECOVERY_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pipeline",
  "references",
  "failure-recovery.md",
);
const POLLING_PROTOCOL_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pipeline",
  "references",
  "polling-protocol.md",
);
const GATEKEEPER_SPAWN_PROMPT_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pr-review",
  "references",
  "gatekeeper-spawn-prompt.md",
);
const FIX_APPLIER_SPAWN_PROMPT_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pr-review",
  "references",
  "fix-applier-spawn-prompt.md",
);
const MERGE_RESOLVER_SPAWN_PROMPT_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pipeline",
  "references",
  "merge-resolver-spawn-prompt.md",
);
const MERGE_RESOLVER_INSTRUCTIONS_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pipeline",
  "references",
  "merge-resolver-instructions.md",
);
const DISCOVERY_INSTRUCTIONS_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-product-planning",
  "references",
  "discovery-instructions.md",
);
const EPIC_DISCOVERY_INSTRUCTIONS_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-product-planning",
  "references",
  "epic-discovery-instructions.md",
);
const DISCOVERY_PLAYBOOK_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-product-planning",
  "references",
  "discovery-playbook.md",
);
const PRD_TEMPLATE_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-product-planning",
  "templates",
  "prd-template.md",
);
const EXAMPLE_PRD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-product-planning",
  "references",
  "example-prd.md",
);
const NEW_FEATURE_SKILL_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-new-feature",
  "SKILL.md",
);
const SCOUT_INSTRUCTIONS_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-new-feature",
  "references",
  "scout-instructions.md",
);
const PR_DESCRIPTION_AUTHORING_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-new-feature",
  "references",
  "pr-description-authoring.md",
);
const PULL_REQUEST_TEMPLATE_PATH = path.resolve(
  HERE,
  "..",
  ".github",
  "PULL_REQUEST_TEMPLATE.md",
);
const AGENT_PROMPTS_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pr-review",
  "references",
  "agent-prompts.md",
);
const VERIFY_SKILL_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-verify",
  "SKILL.md",
);
const UI_UX_SKILL_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "universal",
  "flow-ui-ux",
  "SKILL.md",
);
const CHECKPOINT_SKILL_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "universal",
  "flow-checkpoint",
  "SKILL.md",
);
const SVELTE_SKILL_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "stacks",
  "flow-svelte",
  "SKILL.md",
);
const TAILWIND_SHADCN_SKILL_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "stacks",
  "flow-tailwind-shadcn",
  "SKILL.md",
);
const AGENTS_TEMPLATE_PATH = path.resolve(
  HERE,
  "..",
  "templates",
  "AGENTS.md.template",
);
const UI_VALIDATION_EVIDENCE_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pr-review",
  "references",
  "ui-validation-evidence.md",
);
const UI_SMOKE_PASS_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pipeline",
  "references",
  "ui-smoke-pass.md",
);
const FLOW_UI_VALIDATE_PATH = path.resolve(HERE, "flow-ui-validate.ts");
const UI_VALIDATION_SCHEMA_PATH = path.resolve(
  HERE,
  "lib",
  "ui-validation-schema.ts",
);

const content = fs.readFileSync(SKILL_MD_PATH, "utf8");
const agentsContent = fs.readFileSync(AGENTS_MD_PATH, "utf8");
const exemptionContractsContent = fs.readFileSync(
  EXEMPTION_CONTRACTS_PATH,
  "utf8",
);
const prReviewContent = fs.readFileSync(PR_REVIEW_SKILL_MD_PATH, "utf8");
const fixApplierContent = fs.readFileSync(
  FIX_APPLIER_INSTRUCTIONS_PATH,
  "utf8",
);
const coderContent = fs.readFileSync(CODER_SKILL_MD_PATH, "utf8");
const coderInstructionsContent = fs.readFileSync(
  CODER_INSTRUCTIONS_PATH,
  "utf8",
);
const reportTemplateContent = fs.readFileSync(REPORT_TEMPLATE_PATH, "utf8");
const manualTestRubricContent = fs.readFileSync(
  MANUAL_TEST_RUBRIC_PATH,
  "utf8",
);
const autoMergeRubricContent = fs.readFileSync(AUTO_MERGE_RUBRIC_PATH, "utf8");
const redirectHandlingContent = fs.readFileSync(REDIRECT_HANDLING_PATH, "utf8");
const failureRecoveryContent = fs.readFileSync(FAILURE_RECOVERY_PATH, "utf8");
const pollingProtocolContent = fs.readFileSync(POLLING_PROTOCOL_PATH, "utf8");
const checkpointSkillContent = fs.readFileSync(
  CHECKPOINT_SKILL_MD_PATH,
  "utf8",
);
const gatekeeperSpawnPromptContent = fs.readFileSync(
  GATEKEEPER_SPAWN_PROMPT_PATH,
  "utf8",
);
const fixApplierSpawnPromptContent = fs.readFileSync(
  FIX_APPLIER_SPAWN_PROMPT_PATH,
  "utf8",
);
const mergeResolverSpawnPromptContent = fs.readFileSync(
  MERGE_RESOLVER_SPAWN_PROMPT_PATH,
  "utf8",
);
const mergeResolverInstructionsContent = fs.readFileSync(
  MERGE_RESOLVER_INSTRUCTIONS_PATH,
  "utf8",
);
const discoveryPlaybookContent = fs.readFileSync(
  DISCOVERY_PLAYBOOK_PATH,
  "utf8",
);
const discoveryInstructionsContent = fs.readFileSync(
  DISCOVERY_INSTRUCTIONS_PATH,
  "utf8",
);
const epicDiscoveryInstructionsContent = fs.readFileSync(
  EPIC_DISCOVERY_INSTRUCTIONS_PATH,
  "utf8",
);
const productPlanningTopContent = fs.readFileSync(
  PRODUCT_PLANNING_TOP_SKILL_MD_PATH,
  "utf8",
);
const prdTemplateContent = fs.readFileSync(PRD_TEMPLATE_PATH, "utf8");
const examplePrdContent = fs.readFileSync(EXAMPLE_PRD_PATH, "utf8");
const newFeatureContent = fs.readFileSync(NEW_FEATURE_SKILL_MD_PATH, "utf8");
const scoutInstructionsContent = fs.readFileSync(
  SCOUT_INSTRUCTIONS_PATH,
  "utf8",
);
const prDescriptionAuthoringContent = fs.readFileSync(
  PR_DESCRIPTION_AUTHORING_PATH,
  "utf8",
);
const pullRequestTemplateContent = fs.readFileSync(
  PULL_REQUEST_TEMPLATE_PATH,
  "utf8",
);
const agentPromptsContent = fs.readFileSync(AGENT_PROMPTS_PATH, "utf8");
const verifyContent = fs.readFileSync(VERIFY_SKILL_MD_PATH, "utf8");
const uiUxContent = fs.readFileSync(UI_UX_SKILL_MD_PATH, "utf8");
const svelteContent = fs.readFileSync(SVELTE_SKILL_MD_PATH, "utf8");
const tailwindShadcnContent = fs.readFileSync(
  TAILWIND_SHADCN_SKILL_MD_PATH,
  "utf8",
);
const agentsTemplateContent = fs.readFileSync(AGENTS_TEMPLATE_PATH, "utf8");
const uiValidationEvidenceContent = fs.readFileSync(
  UI_VALIDATION_EVIDENCE_PATH,
  "utf8",
);
const uiSmokePassContent = fs.readFileSync(UI_SMOKE_PASS_PATH, "utf8");
const flowUiValidateContent = fs.readFileSync(FLOW_UI_VALIDATE_PATH, "utf8");
const uiValidationSchemaContent = fs.readFileSync(
  UI_VALIDATION_SCHEMA_PATH,
  "utf8",
);

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

  it("references AskUserQuestion + the candidate-issues section", () => {
    expect(
      content.includes("AskUserQuestion"),
      "flow-pipeline SKILL.md must reference 'AskUserQuestion' — the " +
        "primitive the supervisor calls for its one authorised form: " +
        "step 9's gate-override sub-step. There is no candidate-issues " +
        "form; the plan-review checkpoint's --details disclosure and " +
        "mechanical reply verbs (pull/drop/defer) are the curation " +
        "surface instead.",
    ).toBe(true);
    expect(
      content.includes("# Candidate follow-up issues"),
      "flow-pipeline SKILL.md must reference '# Candidate follow-up issues' " +
        "so step 3/4's --details disclosure and step 10's post-merge sweep " +
        "stay anchored on the plan.md section name.",
    ).toBe(true);
  });

  it("documents the step-3 non-feature advance-to-step-5 route and its disclosure obligation", () => {
    // advance-to-step-5 fires NO candidate-issues checkpoint (the plan
    // still exists on disk but the user is never asked to ratify it on
    // this fully-autonomous path) — disclosure instead happens later, via
    // the PR body's `Bundled:` bullets and the terminal recap. Anchor on
    // the co-occurrence of the route value and the helper name so this
    // no-checkpoint branch, and the disclosure obligation it substitutes,
    // can't be silently dropped without tripping this lint.
    expect(
      content.includes("advance-to-step-5"),
      "flow-pipeline SKILL.md must reference 'advance-to-step-5' — the " +
        "non-feature route on which no candidate-issues checkpoint fires; " +
        "disclosure instead happens via the PR body and terminal recap.",
    ).toBe(true);
    expect(
      content.includes("flow-candidate-issues"),
      "flow-pipeline SKILL.md must reference 'flow-candidate-issues' — the " +
        "LLM-free helper that owns the candidate-issues decision, called " +
        "from the feature-intent End condition and the non-feature " +
        "route-to-step-4 branch (never from advance-to-step-5, which has " +
        "no checkpoint to call it from).",
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
    expect(
      sweepIdx,
      "Post-merge follow-up sweep heading is missing",
    ).toBeGreaterThan(0);
    expect(
      removeIdx,
      "flow-remove-worktree must appear AFTER the post-merge sweep block " +
        "in step 10 — running it first would delete plan.md before the " +
        "sweep can read the candidate-issue list.",
    ).toBeGreaterThan(sweepIdx);
  });

  it("step 1 documents the goal-framing sub-step (ladder up to the ultimate goal)", () => {
    // The triage goal-framing sub-step is the skill-side entry point for the
    // AGENTS.md `## Output style` rule **Understand the ultimate goal behind the
    // request, not just the literal ask.** — step 1 ladders up from the surface
    // request to the inferred ultimate goal before the worktree exists. Anchor on
    // the sub-heading text (a single includes-check, not a brittle regex count) so
    // the sub-step can't be silently dropped.
    expect(
      content.includes("Goal-framing: ladder up to the ultimate goal"),
      "flow-pipeline SKILL.md step 1 must include the 'Goal-framing: ladder up " +
        "to the ultimate goal' sub-step so the triage altitude pass stays " +
        "anchored in the doc (AGENTS.md `## Output style` ultimate-goal rule).",
    ).toBe(true);
  });
});

describe("pipeline-snapshot wiring lint", () => {
  // Pins the four post-review terminal `flow-pipeline-summary` call sites so
  // a future edit cannot silently drop the snapshot. The helper renders the
  // `## PIPELINE SNAPSHOT` block ABOVE the gate-summary block; the ordering
  // anchor below enforces "snapshot precedes gate-summary precedes the
  // terminal state transition" at the canonical MERGED block.

  it("wires flow-pipeline-summary at each of the three post-review terminal statuses", () => {
    for (const status of ["merged", "gated", "needs-human"] as const) {
      expect(
        content.includes(`flow-pipeline-summary --status ${status}`),
        `flow-pipeline SKILL.md must call 'flow-pipeline-summary --status ${status}' ` +
          "at the corresponding post-review terminal site so the snapshot " +
          "renders above the gate-summary block.",
      ).toBe(true);
    }
  });

  it("the MERGED snapshot precedes the MERGED gate-summary, which precedes worktree removal + the phase transition", () => {
    const snapIdx = content.indexOf("flow-pipeline-summary --status merged");
    const gateIdx = content.indexOf(
      "flow-gate-summary --status merged",
      snapIdx,
    );
    const removeIdx = content.indexOf("flow-remove-worktree", gateIdx);
    const phaseIdx = content.indexOf(
      "flow-state-update --phase merged",
      gateIdx,
    );
    expect(
      snapIdx,
      "flow-pipeline-summary --status merged is missing from the MERGED block",
    ).toBeGreaterThan(0);
    expect(
      gateIdx,
      "flow-gate-summary --status merged must appear AFTER the snapshot — " +
        "the snapshot prints above the sentinel-bearing gate block.",
    ).toBeGreaterThan(snapIdx);
    expect(
      removeIdx,
      "flow-remove-worktree must appear AFTER the merged gate-summary render — " +
        "removing the worktree first deletes the artifacts the snapshot reads.",
    ).toBeGreaterThan(gateIdx);
    expect(
      phaseIdx,
      "flow-state-update --phase merged must appear AFTER the merged gate-summary " +
        "render — a render failure must leave state.json non-terminal so " +
        "flow-stop-guard keeps nudging.",
    ).toBeGreaterThan(gateIdx);
  });

  it("the step-10 sweep writes filed-issues.txt for the snapshot's FOLLOW-UP ISSUES source", () => {
    expect(
      content.includes("filed-issues.txt"),
      "flow-pipeline SKILL.md step-10 sweep must redirect filed/unfiled URLs to " +
        "filed-issues.txt — the flat-file source the snapshot reads as " +
        "--filed-issues-file.",
    ).toBe(true);
  });
});

describe("gate-stage echo-verbatim recap wiring lint", () => {
  // Pins the `--echo-prose` echo-verbatim contract: the supervisor must echo
  // the helper-computed recap block VERBATIM as assistant prose (not tool
  // output, which Claude Code truncates) at every gate site, the delimiter
  // markers must match the helper's emitted markers, and the bounded field set
  // must stay pinned so the recap can't grow into a second snapshot. Mirrors
  // the `pipeline-snapshot wiring lint` describe above.

  it("documents the echo-verbatim contract subsection (prose, not tool output)", () => {
    expect(
      content.includes("echo it VERBATIM"),
      "flow-pipeline SKILL.md must instruct the supervisor to 'echo it VERBATIM' — " +
        "the recap block is mirrored, not restated from memory.",
    ).toBe(true);
    expect(
      content.includes("prose, not tool output"),
      "flow-pipeline SKILL.md must name the 'prose, not tool output' rationale — " +
        "Claude Code truncates Bash tool results, so the recap must render as " +
        "assistant prose.",
    ).toBe(true);
    expect(
      content.includes("Gate-stage echo-verbatim recap"),
      "flow-pipeline SKILL.md must carry the single-source-of-truth " +
        "'Gate-stage echo-verbatim recap' subsection that the per-site " +
        "references point at.",
    ).toBe(true);
  });

  it("names both echo-recap delimiter markers so the extraction can't drift from the helper", () => {
    for (const marker of [
      "<!-- flow-echo-recap:start -->",
      "<!-- flow-echo-recap:end -->",
    ] as const) {
      expect(
        content.includes(marker),
        `flow-pipeline SKILL.md must name the delimiter marker '${marker}' so the ` +
          "extraction instruction stays in sync with bin/lib/echo-recap.ts's " +
          "emitted markers.",
      ).toBe(true);
    }
  });

  it("wires --echo-prose at the post-review gate sites and the awaiting-approval gate", () => {
    expect(
      /flow-pipeline-summary[^\n]*--echo-prose/.test(content),
      "flow-pipeline SKILL.md must pass '--echo-prose' to flow-pipeline-summary " +
        "at the post-review gate sites (MERGED / GATED / NEEDS HUMAN / " +
        "merged-externally).",
    ).toBe(true);
    expect(
      content.includes(
        "flow-gate-summary --status awaiting-approval --echo-prose",
      ),
      "flow-pipeline SKILL.md must pass '--echo-prose' to " +
        "'flow-gate-summary --status awaiting-approval' for the plan-approval gate.",
    ).toBe(true);
  });

  it("pins the bounded recap field set so the recap can't grow open-ended", () => {
    // Anchor on the `### ` heading (not the earlier cross-reference links that
    // share the title), and slice to the subsection's end (`# Resume mode`).
    const subsectionIdx = content.indexOf("### Gate-stage echo-verbatim recap");
    expect(
      subsectionIdx,
      "the '### Gate-stage echo-verbatim recap' subsection must exist to anchor " +
        "the bounded field set.",
    ).toBeGreaterThan(0);
    const subsectionEnd = content.indexOf("# Resume mode", subsectionIdx);
    const subsection = content.slice(subsectionIdx, subsectionEnd);
    for (const field of [
      "PR URL",
      "plan-file path",
      "branch",
      "PR number",
      "PR title",
      "current phase",
      "CI verdict",
      "review verdict",
      "finding count",
      "follow-up count",
    ] as const) {
      expect(
        subsection.includes(field),
        `the echo-verbatim contract subsection must pin the bounded field '${field}' ` +
          "so the recap stays a concise re-orientation block, not a second snapshot.",
      ).toBe(true);
    }
  });
});

describe("tab-delimited @tsv read must set IFS=$'\\t'", () => {
  // Guards against the PR #333 recap-garbling regression: a `read` that
  // parses a `jq ... @tsv` line splits on the default IFS (space, tab,
  // newline) unless prefixed with `IFS=$'\t'`, so a space-bearing PR title
  // spills across the following variable(s). Every documented `read -r`
  // whose process-substitution body emits `@tsv` must carry the
  // `IFS=$'\t'` command-prefix so the split is tab-only. The regex matches
  // a `read -r` and the `@tsv` on the same logical line (the table rows are
  // single long lines; the fenced blocks keep read+jq on one line), with an
  // optional leading IFS-prefix capture group.
  const tsvReadRe = /(IFS=\$'\\t'\s+)?read\s+-r\b[^\n]*?<\s*<\([^\n]*?@tsv/g;

  it("prefixes every @tsv-sourced read with IFS=$'\\t' (no bare split)", () => {
    const matches = [...content.matchAll(tsvReadRe)];
    expect(
      matches.length,
      "expected at least the five documented recap reads sourcing a jq @tsv " +
        "stream; if this dropped to zero the anchor is matching nothing and " +
        "must be repaired.",
    ).toBeGreaterThanOrEqual(5);
    const bare = matches
      .filter((m) => m[1] === undefined)
      .map((m) => m[0].slice(0, 60));
    expect(
      bare,
      "every `read -r ... < <(jq ... @tsv ...)` in flow-pipeline SKILL.md must " +
        "be prefixed with `IFS=$'\\t'` so the recap line splits on the tab " +
        "only — an un-prefixed read garbles space-bearing PR titles across " +
        "the PR_TITLE/PR_BRANCH variables (PR #333 regression).",
    ).toEqual([]);
  });
});

describe("pr-review deferral-tracker lint", () => {
  it("the wrapper SKILL.md names flow-create-issue and no ROADMAP.md fallback", () => {
    expect(
      prReviewContent.includes("flow-create-issue"),
      "pr-review SKILL.md must reference 'flow-create-issue' (even when the " +
        "actual deferral logic lives in the Fix-Applier Subagent's instructions, " +
        "the wrapper must name the helper so a doc-only reader sees the path).",
    ).toBe(true);
    expect(
      prReviewContent.includes("ROADMAP.md"),
      "pr-review SKILL.md must NOT name a 'ROADMAP.md' fallback tracker — " +
        "GitHub Issues via flow-create-issue is the single canonical durable " +
        "tracker; the no-GH-Issues path surfaces the deferral loudly instead " +
        "of silently appending to a file that may not exist.",
    ).toBe(false);
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
      "fix-applier-instructions.md must NOT name a 'ROADMAP.md' fallback " +
        "tracker — when the helper exits non-zero or no GH Issues surface " +
        "exists, the deferral is surfaced loudly with an empty tracker_entry_url " +
        "rather than written to a file that may not exist.",
    ).toBe(false);
  });

  it("the Fix-Applier Subagent's instructions mandate no commit on the merged-mid-review path", () => {
    expect(
      fixApplierContent.includes(
        "do NOT commit anywhere and do NOT switch branches",
      ),
      "fix-applier-instructions.md's already-merged branch of step 7 must " +
        "carry the explicit no-commit prohibition — this pins the prose's " +
        "presence, not just its absence elsewhere, so a future edit can't " +
        "silently drop the mandate while the surrounding structure survives.",
    ).toBe(true);
  });

  it("the report template names no ROADMAP.md deferral-tracker fallback", () => {
    expect(
      reportTemplateContent.includes("ROADMAP.md"),
      "report-template.md must NOT name a 'ROADMAP.md' anchor as a deferral " +
        "tracker — the deferred-finding annotation cites the flow-create-issue " +
        "URL, or surfaces the deferral loudly with no tracker URL when the repo " +
        "has no GH Issues surface.",
    ).toBe(false);
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
    const re =
      /\*\*Task-tool exemption:\s*`\/flow-pipeline`\s*→\s*([^*]+?)\.\*\*/g;
    return [...agentsContent.matchAll(re)].map((m) => normaliseExemption(m[1]));
  }

  /**
   * Extract exemption keys from references/exemption-contracts.md — the
   * offload target for the per-exemption contract bodies. Each exemption
   * is a `## <skill-and-heading>` section whose heading text matches the
   * AGENTS.md opener name (minus the `/flow-pipeline → ` prefix). The
   * file-level `# Task-tool exemption contracts` title is an h1 and is
   * not matched. This guards the offloaded file against silent drift
   * (a section deleted, renamed, or a ninth added) — the same drift
   * class the AGENTS.md ↔ SKILL.md symmetry above prevents.
   */
  function extractContractsExemptions(): string[] {
    const re = /^## (.+)$/gm;
    return [...exemptionContractsContent.matchAll(re)].map((m) =>
      normaliseExemption(m[1]),
    );
  }

  it("flow-pipeline/SKILL.md Hard rules lists exactly 9 Task-tool exemptions", () => {
    const exemptions = extractSkillExemptions();
    expect(
      exemptions.length,
      "flow-pipeline/SKILL.md must list exactly 9 Task-tool exemption blocks " +
        "(one each for /flow-pr-review Multi-Agent Review, /flow-product-planning Discovery " +
        "Subagent, /flow-new-feature Scout Subagent, /flow-pr-review Fix-Applier Subagent, " +
        "/flow-pipeline step 10's Merge-Conflict Resolver Subagent, /flow-coder " +
        "Edit-Applier Subagent, /flow-pr-review Step 1.5 Gatekeeper Subagent, " +
        "/flow-pr-review Step 3.5 Consolidator-Validator Subagent, and /flow-pipeline " +
        "step 6's Verify-Retry-Loop Subagent). " +
        "Found: " +
        JSON.stringify(exemptions),
    ).toBe(9);
  });

  it("AGENTS.md ## Don'ts lists exactly 9 Task-tool exemption bullets", () => {
    const exemptions = extractAgentsExemptions();
    expect(
      exemptions.length,
      "AGENTS.md ## Don'ts must list exactly 9 Task-tool exemption bullets. " +
        "Found: " +
        JSON.stringify(exemptions),
    ).toBe(9);
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

  it("references/exemption-contracts.md lists exactly 9 contract sections", () => {
    const exemptions = extractContractsExemptions();
    expect(
      exemptions.length,
      "references/exemption-contracts.md must hold exactly 9 `## ` contract " +
        "sections (one per Task-tool exemption). Found: " +
        JSON.stringify(exemptions),
    ).toBe(9);
  });

  it("references/exemption-contracts.md matches the AGENTS.md exemption set", () => {
    const contracts = new Set(extractContractsExemptions());
    const agents = new Set(extractAgentsExemptions());
    const onlyInContracts = [...contracts].filter((x) => !agents.has(x));
    const onlyInAgents = [...agents].filter((x) => !contracts.has(x));
    expect(
      onlyInContracts.length,
      `Sections in references/exemption-contracts.md but missing from AGENTS.md openers: ${JSON.stringify(onlyInContracts)}. ` +
        "The offloaded contract file and the AGENTS.md `## Don'ts` openers enumerate the same " +
        "nine exemptions; a section heading must match its AGENTS.md opener name (minus the " +
        "`/flow-pipeline → ` prefix) so a reader hopping AGENTS.md → references lands on the right section.",
    ).toBe(0);
    expect(
      onlyInAgents.length,
      `AGENTS.md openers but missing from references/exemption-contracts.md: ${JSON.stringify(onlyInAgents)}. ` +
        "Every offloaded exemption needs its full contract body in the references file so the " +
        "trimmed AGENTS.md bullet stays discoverable in ≤2 hops.",
    ).toBe(0);
  });

  it("flow-pipeline/SKILL.md Hard rules preamble references nine exemptions", () => {
    expect(
      skillStripped.match(
        /the\s+\*\*only nine\*\*\s+authorised\s+Task-tool\s+fan-out\s+sites/,
      ),
      "flow-pipeline/SKILL.md Hard rules preamble must say 'the **only nine** authorised " +
        "Task-tool fan-out sites'. If you added or removed an exemption, update the count " +
        "in the preamble too — the count is bidirectional with the block list below.",
    ).toBeTruthy();
  });

  it("flow-pipeline/SKILL.md Hard rules opening references nine Task-tool exceptions", () => {
    expect(
      skillStripped.match(
        /the\s+nine\s+narrowly-named Task-tool exceptions that\s+follow/,
      ),
      "flow-pipeline/SKILL.md Hard rules opening must say 'the nine narrowly-named " +
        "Task-tool exceptions that follow'. Drift here means a future reader sees a count " +
        "that doesn't match the exemption blocks.",
    ).toBeTruthy();
  });

  it("AGENTS.md upstream prose references nine exceptions", () => {
    expect(
      agentsContent.match(/\*\*with nine narrowly-named exceptions\*\*/),
      "AGENTS.md ## Supervisor and sub-skills must say '**with nine narrowly-named exceptions**'. " +
        "The count must match the bullet list under ## Don'ts.",
    ).toBeTruthy();
    expect(
      agentsContent.match(/The nine\s+named exceptions are/),
      "AGENTS.md ## Don'ts parent bullet must say 'The nine named exceptions are'. " +
        "Drift here is the most likely landmine when adding a new exemption.",
    ).toBeTruthy();
    expect(
      agentsContent.match(
        /the\s+\*\*only nine\*\*\s+authorised\s+Task-tool\s+fan-out\s+sites/,
      ),
      "AGENTS.md ## Don'ts closer must say 'the **only nine** authorised Task-tool fan-out sites'. " +
        "Same count, same wording as flow-pipeline/SKILL.md's closer.",
    ).toBeTruthy();
  });

  it("flow-pipeline/SKILL.md Verification (this skill) lists all nine exemptions by name", () => {
    const verificationSection =
      content.split("# Verification")[1] ??
      content.split("# Verification (this skill)")[1] ??
      "";
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
      verificationSection.includes("Fix-Applier Subagent"),
      "flow-pipeline/SKILL.md Verification section must reference 'Fix-Applier Subagent' " +
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
        "/flow-coder refactor; this list must enumerate all eight.",
    ).toBe(true);
    expect(
      verificationSection.includes("Independent Gatekeeper Subagent"),
      "flow-pipeline/SKILL.md Verification section must reference 'Independent Gatekeeper Subagent' " +
        "as one of the named Task-tool exemptions. The seventh exemption was added in the " +
        "/flow-pr-review Step 1.5 Gatekeeper refactor; this list must enumerate all eight.",
    ).toBe(true);
    expect(
      verificationSection.includes(
        "Independent Consolidator-Validator Subagent",
      ),
      "flow-pipeline/SKILL.md Verification section must reference 'Independent Consolidator-Validator Subagent' " +
        "as one of the named Task-tool exemptions. The eighth exemption was added in the " +
        "/flow-pr-review Step 3.5 Consolidator-Validator refactor; this list must enumerate all nine.",
    ).toBe(true);
    expect(
      verificationSection.includes("Verify-Retry-Loop Subagent"),
      "flow-pipeline/SKILL.md Verification section must reference 'Verify-Retry-Loop Subagent' " +
        "as one of the named Task-tool exemptions. The ninth exemption was added in the " +
        "step 6 verify-retry-loop refactor; this list must enumerate all nine.",
    ).toBe(true);
  });

  // Pins references/task-tool-exemption-preamble.md's "all <N> Task-tool"
  // numeral to the count derived from extractAgentsExemptions() (the same
  // helper the exactly-9 assertions above use) rather than a hardcoded
  // literal, so a tenth exemption landing without updating the preamble's
  // prose goes red here instead of silently drifting (the six → nine drift
  // this case guards against recurring).
  const NUMBER_WORDS = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
  ];
  const numberToEnglish = (n: number): string => NUMBER_WORDS[n] ?? String(n);

  it("references/task-tool-exemption-preamble.md's exemption-count numeral matches AGENTS.md's derived count", () => {
    const expectedCount = extractAgentsExemptions().length;
    const expectedNumeral = numberToEnglish(expectedCount);
    const preambleContent = fs.readFileSync(
      path.resolve(
        HERE,
        "..",
        "skills",
        "pipeline",
        "flow-pr-review",
        "references",
        "task-tool-exemption-preamble.md",
      ),
      "utf8",
    );
    expect(
      preambleContent.includes(`all ${expectedNumeral} Task-tool`),
      "references/task-tool-exemption-preamble.md must say " +
        `'all ${expectedNumeral} Task-tool' — derived from AGENTS.md's ` +
        `${expectedCount} exemption bullets (extractAgentsExemptions()), not ` +
        "a hardcoded numeral. This is the count-drift guard for the six → " +
        "nine correction: if a tenth exemption lands, this numeral must " +
        "move to 'ten' in the same PR.",
    ).toBe(true);
  });
});

describe("AGENTS.md char-count budget (guards Claude Code's 40k per-session warning)", () => {
  /**
   * AGENTS.md grows ~10k chars/quarter as new Task-tool exemptions land,
   * and once cleared Claude Code's 40k per-session performance warning with
   * little headroom (PR #218). #219 added this guard so the budget is
   * enforced on every PR via `npm run verify` rather than relying on a
   * one-time PR-body checkbox. The budget stays below the 40_000
   * warning threshold: it locks in the headroom won by offloading the nine
   * exemption contract bodies to references/exemption-contracts.md (#220)
   * instead of letting the file silently regrow back toward 40k. It was
   * raised from 34_000 to fund one new first-class Output-style rule
   * (**Treat every request as production-bound, not a hobby project.**),
   * whose full bar is offloaded to templates/AGENTS.md.template so only the
   * lean anchored summary lives here — a deliberate addition, not silent
   * regrowth. New contracts still offload-then-trim (dedup an equivalent
   * volume or move the body to a references/ file) rather than raise this
   * budget again. Raised again from 36_000 to 38_000 to fund two deliberate
   * additions: the `## Compact Instructions` compaction-steering section and
   * the 9th Task-tool exemption opener (Verify-Retry-Loop Subagent), whose
   * full body is offloaded to references/exemption-contracts.md per the
   * offload-then-trim playbook so only the lean opener costs bytes here.
   * Raised again from 38_000 to 39_000 to fund one more deliberate addition:
   * the new `## Output style` principle **Understand the ultimate goal behind
   * the request, not just the literal ask.**, whose full technique is offloaded
   * to skills/pipeline/flow-product-planning/references/discovery-playbook.md so only
   * the lean anchored summary costs bytes here — a deliberate addition, not
   * silent regrowth. Raised once more from 39_000 to 39_700 to fund the
   * `/flow-epic-run` separate-supervisor-session bullet (the epic-orchestrator
   * judgment layer), whose full contract — the four hard invariants, the
   * `epic.judgment` / `epic.maxRetries` config gate, the event-driven judgment
   * surface — is offloaded to skills/pipeline/flow-epic-run/SKILL.md so only a lean
   * pointer bullet (gated ⇒ escalate-only + never-merge inline) costs bytes
   * here. Headroom to the 40k warning is now thin (~370 chars): the NEXT
   * contract must offload-then-trim (dedup an equivalent volume), not raise
   * this budget again. Raised once more from 39_700 to 39_950 to fund the lean
   * one-line `agents/` static-agent-type-definition note (the `effort: low`
   * pinning of the two mechanical fan-outs). Per the AGY cross-model plan
   * review, a small documented raise was preferred over trimming load-bearing,
   * lint-anchored AGENTS.md prose; the note was kept minimal and part-funded by
   * non-destructive word-level tightening, and the file still sits 76 chars
   * clear of the hard 40k warning (raising the budget PAST 40k was explicitly
   * rejected — the guard exists to keep the file under it). The NEXT contract
   * must offload-then-trim: there is no longer room to raise without crossing 40k.
   * Dropped from 39_950 to 24_000 by the p5-context-diet pass (#431's
   * follow-up): `## Output style`'s full rule bodies moved to
   * references/output-style.md, `## Consumer-repo notes`' full surface area
   * moved to references/consumer-repo-contract.md, and the session-marker /
   * trailer + inline-intent-annotation mechanics plus several `## Don'ts`
   * bullet bodies (Shared rationale, the one AskUserQuestion form, the
   * auto-merge and auto-issue-create exemptions, the epic-create/epic-run
   * detail) moved to references/git-workflow.md — each replaced in AGENTS.md
   * by its anchored opener/binding-bar plus a relative link. Measured
   * post-diet size is ~19_978 chars
   * (`bin/flow-transcript-audit.ts --static AGENTS.md`); 24_000 keeps
   * headroom for incremental additions without inviting the regrowth back
   * toward 40k the offload-then-trim discipline exists to prevent.
   * Raised once more from 24_000 to 24_300 to fund one deliberate
   * addition: the `## Output style` rule **Explain problems
   * impact-first in plain language.**, whose full rule body is
   * offloaded to references/output-style.md and whose applied contract
   * lives in
   * skills/pipeline/flow-pipeline/references/pause-output-contract.md,
   * so only the lean anchored one-line summary costs bytes here, per
   * the offload-then-trim playbook. Pre-raise headroom was 128 chars
   * against a ~226-char lean opener; trimming lint-anchored
   * `## Output style` prose to make room was rejected on the same
   * grounds as the 39_700 → 39_950 precedent above (a small documented
   * raise over trimming load-bearing prose). The file remains far below
   * Claude Code's 40k per-session warning.
   * Raised once more from 24_300 to 24_600 to fund the `## Output style`
   * rule **Emit instructions as scannable numbered steps.**, whose full
   * rule body is offloaded to references/output-style.md and whose
   * enforceable form lives in
   * skills/pipeline/flow-pipeline/references/pause-output-contract.md
   * `## Step contract`, so only the lean anchored one-line summary costs
   * bytes here, per the offload-then-trim playbook. Pre-raise headroom
   * was 61 chars against a ~225-char lean opener; trimming lint-anchored
   * `## Output style` prose to make room was rejected on the same
   * grounds as the two precedents above (a small documented raise over
   * trimming load-bearing prose). The file remains far below Claude
   * Code's 40k per-session warning.
   * Raised once more from 24_600 to 24_700 to fund the
   * `/flow-backlog-triage` separate-sanctioned-standalone-session bullet
   * (one Task-tool fan-out for Phase-1 verification, zero
   * `AskUserQuestion` forms), whose full contract is offloaded to
   * `skills/universal/flow-backlog-triage/SKILL.md` so only the lean
   * pointer bullet costs bytes here. Measured this bullet's chars via
   * `wc -m AGENTS.md` (code units, NOT `wc -c` bytes — AGENTS.md carries
   * non-ASCII em-dash/arrow glyphs that make the two counts diverge).
   * Post-edit size is 24_591 chars against the prior 24_600 budget —
   * technically still clears, but leaves only 9 chars of headroom, a
   * red-build trap for the next editor; raised to the next round value
   * instead of leaving that trap in place.
   * Raised again from 24_700 to 24_900 after merging `main` in. The
   * 24_700 figure was measured against this branch alone (24_591), but
   * CI evaluates the PR merge-ref, where #559's own `## Don'ts`
   * additions stack on top of this branch's pointer bullet for a
   * combined 24_760. Neither branch overran the budget in isolation —
   * the overrun is purely additive across two concurrently-open
   * branches, which is exactly the case a local-only `wc -m` on one
   * branch cannot see. Raised to the next round value (140 chars of
   * headroom) rather than trimming either branch's lint-anchored prose,
   * on the same grounds as the precedents above.
   * Raised once more from 24_900 to 25_300 to fund the `## Output style`
   * rule **Frame every explanation impact-first for a product-lens
   * reader.**, whose full rule body (worked examples, exclusion list,
   * per-stage focus table) is offloaded to references/output-style.md,
   * so only the lean anchored one-line summary costs bytes here, per
   * the offload-then-trim playbook. Pre-raise headroom was 22 chars
   * (24_878 measured in code units via String.prototype.length, not
   * `wc -c` bytes) against a ~247-char lean opener; post-edit size is
   * 25_125. 25_200 was rejected — 75 chars of headroom is closer to the
   * 9-char red-build trap called out two raises above than to the
   * 136–202-char headroom the three most recent deliberate raises landed
   * with (202, 136, 140) — so the budget
   * goes to 25_300 (175 chars of headroom) instead, and trimming
   * lint-anchored `## Output style` prose to make room was rejected on
   * the same grounds as the precedents above.
   * Raised once more from 25_300 to 25_900 to fund two deliberate
   * additions for the intent interview (adaptive) feature: a
   * `## Compact Instructions` KEEP bullet for `state.interview`, and a
   * `## Don'ts` bullet naming the two interview pending phases as
   * ordinary chat pauses, NOT `AskUserQuestion` (no new exemption). Both
   * bullets were already tightened to lean anchored openers with the
   * full round contract offloaded to
   * skills/pipeline/flow-pipeline/references/interview-playbook.md, per
   * the offload-then-trim playbook; post-edit size is 25_749, so 25_900
   * (151 chars of headroom) matches the 136-202-char range the recent
   * precedents above landed with, rather than the tighter traps rejected
   * earlier in this history.
   */
  it("AGENTS.md stays under the char budget", () => {
    const CHAR_BUDGET = 25_900;
    expect(
      agentsContent.length,
      `AGENTS.md is ${agentsContent.length} chars; budget is ${CHAR_BUDGET}. ` +
        `To add a new contract, dedup an equivalent volume first or offload it ` +
        `to a references/ file (see references/exemption-contracts.md for the ` +
        `offload-then-trim playbook landed in #220) rather than raising this ` +
        `budget — the budget keeps AGENTS.md clear of Claude Code's 40k ` +
        `per-session performance warning.`,
    ).toBeLessThan(CHAR_BUDGET);
  });
});

describe("low-effort fan-out subagent_type wiring lint", () => {
  // Pins the two always-cheap fan-out spawn sites to their low-effort agent
  // definitions (agents/flow-verify.md, agents/flow-fix-applier.md) with a
  // general-purpose fallback, and confirms each site still passes its
  // per-spawn model: override so the per-phase model flags keep working. A
  // future edit that reverts either site to a bare `subagent_type:
  // general-purpose` (dropping the effort: low pinning) goes red here.

  // Shared negation vocabulary + clause-splitting helper for the two
  // "never mandates an X" prose-detector lints below (force-push,
  // base-branch-write). A mention naming the pattern as something to AVOID
  // (a NEVER-prohibition, or otherwise negated prose) is not a mandate.
  // Scope the negation to the CLAUSE holding the match rather than to a
  // character window around it: a Troubleshooting-table row keeps its whole
  // entry on one physical line, so both "anywhere on the line" and a fixed
  // ±N-char window let a real mandate hide behind an unrelated NEVER clause
  // in the same row. Splitting on sentence/table-cell boundaries makes the
  // prohibition have to govern the mention itself.
  const NEGATION = /\b(never|not|don't|do not|avoid)\b/i;
  const mandatesClause = (
    pattern: RegExp,
    text: string,
    extra?: (clause: string) => boolean,
  ): boolean =>
    text
      .split("\n")
      .some((line) =>
        line
          .split(/[.;|]/)
          .some(
            (clause) =>
              pattern.test(clause) &&
              (extra ? extra(clause) : true) &&
              !NEGATION.test(clause),
          ),
      );

  it("the flow-pipeline verify-loop spawn site names flow-verify with a general-purpose fallback", () => {
    expect(
      content.includes("subagent_type: $VERIFY_SUBAGENT"),
      "flow-pipeline SKILL.md step-6 spawn must use `subagent_type: $VERIFY_SUBAGENT` " +
        "so the resolved low-effort agent (or the general-purpose fallback) is passed.",
    ).toBe(true);
    expect(
      content.includes("VERIFY_SUBAGENT=flow-module-core:flow-verify"),
      "flow-pipeline SKILL.md must resolve VERIFY_SUBAGENT to " +
        "`flow-module-core:flow-verify` — the agents/flow-verify.md definition " +
        "that pins effort: low (plugin-qualified resolution asserted in full " +
        "by the SITES it.each below).",
    ).toBe(true);
    expect(
      /VERIFY_SUBAGENT=general-purpose/.test(content),
      "flow-pipeline SKILL.md verify site must fall back to `general-purpose` when " +
        "the flow-verify definition is not symlinked, so the spawn never fails on an " +
        "unknown agent type.",
    ).toBe(true);
    expect(
      content.includes('model: "$VERIFY_MODEL"'),
      "flow-pipeline SKILL.md verify site must still pass the per-spawn " +
        '`model: "$VERIFY_MODEL"` override so the per-phase model flags keep working.',
    ).toBe(true);
  });

  it("the pr-review fix-applier spawn site names flow-fix-applier with a general-purpose fallback", () => {
    expect(
      prReviewContent.includes("subagent_type: $FIX_APPLIER_SUBAGENT"),
      "pr-review SKILL.md Fix-Applier spawn must use `subagent_type: $FIX_APPLIER_SUBAGENT` " +
        "so the resolved low-effort agent (or the general-purpose fallback) is passed.",
    ).toBe(true);
    expect(
      prReviewContent.includes(
        "FIX_APPLIER_SUBAGENT=flow-module-core:flow-fix-applier",
      ),
      "pr-review SKILL.md must resolve FIX_APPLIER_SUBAGENT to " +
        "`flow-module-core:flow-fix-applier` — the agents/flow-fix-applier.md " +
        "definition that pins effort: low.",
    ).toBe(true);
    expect(
      /FIX_APPLIER_SUBAGENT=general-purpose/.test(prReviewContent),
      "pr-review SKILL.md fix-applier site must fall back to `general-purpose` when the " +
        "flow-fix-applier definition is not symlinked.",
    ).toBe(true);
    expect(
      prReviewContent.includes("modelFixApplier"),
      "pr-review SKILL.md fix-applier site must still resolve the per-spawn fixApplier " +
        "model override so the per-phase model flags keep working.",
    ).toBe(true);
    // Guard the actual per-spawn wiring — not just the state field name —
    // mirroring the verify site's `model: "$VERIFY_MODEL"` pass-through check.
    // The fixApplier resolution puts the model in FIX_APPLIER_MODEL and passes
    // it as the Task call's per-spawn `model:`; a future edit that drops the
    // pass-through while keeping the `state.modelFixApplier` field reference
    // would otherwise leave the weaker `modelFixApplier`-only check green.
    expect(
      prReviewContent.includes("FIX_APPLIER_MODEL="),
      "pr-review SKILL.md fix-applier site must resolve the per-spawn model into " +
        "FIX_APPLIER_MODEL so it can be passed at the Task call.",
    ).toBe(true);
    expect(
      /FIX_APPLIER_MODEL[\s\S]{0,500}per-spawn `model:`/.test(prReviewContent),
      "pr-review SKILL.md fix-applier site must pass the resolved FIX_APPLIER_MODEL as " +
        "the Task call's per-spawn `model:` — mirroring the verify site's literal " +
        '`model: "$VERIFY_MODEL"` pass-through guard, not just naming the state field.',
    ).toBe(true);
  });

  it("neither low-effort agent definition pins a model (per-spawn override must win)", () => {
    for (const name of ["flow-verify.md", "flow-fix-applier.md"] as const) {
      const agentPath = path.resolve(HERE, "..", "agents", "core", name);
      expect(
        fs.existsSync(agentPath),
        `agents/${name} must exist — it is the low-effort definition the spawn site resolves.`,
      ).toBe(true);
      const body = fs.readFileSync(agentPath, "utf8");
      const frontmatter = body.split("---")[1] ?? "";
      expect(
        /^effort:\s*low\s*$/m.test(frontmatter),
        `agents/${name} frontmatter must declare 'effort: low'.`,
      ).toBe(true);
      expect(
        /^model:/m.test(frontmatter),
        `agents/${name} frontmatter must NOT pin a 'model:' — the per-spawn model: ` +
          "override must win so the per-phase model flags keep working.",
      ).toBe(false);
    }
  });

  // Frontmatter policy for the full fourteen-definition set
  // (p4-review-agents + p4-pipeline-agents): mechanical roles pin
  // `effort: low` (checked above and re-checked here), the gatekeeper
  // pins `model: haiku` as the declarative cost-routing record, and
  // every judgment role omits both so session effort and the spawn
  // site's per-spawn/config-threaded model always win. flow-discovery
  // is the one row with `inheritsAllTools: true` — plan Decision
  // analysis 2 deliberately leaves it with no `tools:` allowlist
  // (discovery's research + design-artifact passes span Bash/WebFetch/
  // MCP surfaces a fixed allowlist would silently break), so the
  // tools-presence assert below is skipped for that row only.
  const AGENT_FRONTMATTER_POLICY: Array<{
    file: string;
    wantModel?: string;
    wantEffort?: string;
    wantTools?: string;
    inheritsAllTools?: boolean;
  }> = [
    {
      file: "flow-verify.md",
      wantEffort: "low",
      wantTools:
        "Bash, Read, Edit, Write, Grep, ToolSearch, Task, mcp__chrome-devtools__\\*",
    },
    { file: "flow-fix-applier.md", wantEffort: "low" },
    { file: "flow-gatekeeper.md", wantModel: "haiku" },
    { file: "flow-consolidator.md" },
    {
      file: "flow-review-bug-detection.md",
      wantTools: "Read, Grep, Glob, Write",
    },
    {
      file: "flow-review-intent-guess.md",
      wantTools: "Read, Grep, Glob, Write",
    },
    { file: "flow-review-security.md", wantTools: "Read, Grep, Glob, Write" },
    {
      file: "flow-review-pattern-consistency.md",
      wantTools: "Read, Grep, Glob, Write",
    },
    {
      file: "flow-review-performance.md",
      wantTools: "Read, Grep, Glob, Write",
    },
    {
      file: "flow-review-supply-chain.md",
      wantTools: "Read, Grep, Glob, Write",
    },
    {
      file: "flow-review-test-coverage.md",
      wantTools: "Read, Grep, Glob, Write",
    },
    { file: "flow-scout.md", wantTools: "Bash, Read, Grep, Glob, Write" },
    { file: "flow-discovery.md", inheritsAllTools: true },
    {
      file: "flow-merge-resolver.md",
      wantTools: "Bash, Read, Edit, Write, Grep",
    },
    {
      file: "flow-edit-applier.md",
      wantTools: "Bash, Read, Edit, Write, Grep, Glob, NotebookEdit",
    },
    { file: "flow-backlog-verifier.md", wantTools: "Bash, Read, Grep, Glob" },
  ];

  it("AGENT_FRONTMATTER_POLICY covers exactly the agents/ directory, with inheritsAllTools confined to flow-discovery.md", () => {
    const onDisk = fs
      .readdirSync(path.resolve(HERE, "..", "agents", "core"))
      .filter((f) => f.endsWith(".md"))
      .sort();
    expect(AGENT_FRONTMATTER_POLICY.map((r) => r.file).sort()).toEqual(onDisk);
    expect(
      AGENT_FRONTMATTER_POLICY.filter((r) => r.inheritsAllTools).map(
        (r) => r.file,
      ),
    ).toEqual(["flow-discovery.md"]);
  });

  it("every agents/*.md definition exists and follows the frontmatter policy", () => {
    for (const {
      file,
      wantModel,
      wantEffort,
      wantTools,
      inheritsAllTools,
    } of AGENT_FRONTMATTER_POLICY) {
      const agentPath = path.resolve(HERE, "..", "agents", "core", file);
      expect(
        fs.existsSync(agentPath),
        `agents/${file} must exist — a spawn site resolves it by name.`,
      ).toBe(true);
      const frontmatter =
        fs.readFileSync(agentPath, "utf8").split("---")[1] ?? "";
      if (inheritsAllTools) {
        expect(
          /^tools:/m.test(frontmatter),
          `agents/${file} frontmatter must NOT declare a 'tools:' allowlist ` +
            "— plan Decision analysis 2 deliberately leaves this row inheriting " +
            "every session tool; a later edit that pins one must go red, not " +
            "silently narrow discovery's research surface.",
        ).toBe(false);
      } else {
        expect(
          /^tools:\s*\S/m.test(frontmatter),
          `agents/${file} frontmatter must declare a 'tools:' allowlist — ` +
            "tool containment is the point of the named definition.",
        ).toBe(true);
      }
      if (wantTools) {
        expect(
          new RegExp(`^tools:\\s*${wantTools}\\s*$`, "m").test(frontmatter),
          `agents/${file} frontmatter must declare exactly 'tools: ${wantTools}' ` +
            "— a later edit that adds Bash/Task back must go red, not silently " +
            "restore the injection surface this PR closes.",
        ).toBe(true);
      }
      if (wantModel) {
        expect(
          new RegExp(`^model:\\s*${wantModel}\\s*$`, "m").test(frontmatter),
          `agents/${file} frontmatter must pin 'model: ${wantModel}' — the ` +
            "declarative cost-routing record.",
        ).toBe(true);
      } else {
        expect(
          /^model:/m.test(frontmatter),
          `agents/${file} frontmatter must NOT pin 'model:' — the per-spawn ` +
            "model: override / config threading must win.",
        ).toBe(false);
      }
      if (wantEffort) {
        expect(
          new RegExp(`^effort:\\s*${wantEffort}\\s*$`, "m").test(frontmatter),
          `agents/${file} frontmatter must pin 'effort: ${wantEffort}'.`,
        ).toBe(true);
      } else {
        expect(
          /^effort:/m.test(frontmatter),
          `agents/${file} frontmatter must NOT pin 'effort:' — judgment ` +
            "roles scale with session effort (gatekeeper: already bounded by haiku).",
        ).toBe(false);
      }
    }
  });

  it("flow-verify.md and flow-fix-applier.md retain the mcp__chrome-devtools__* and ToolSearch grants (UI-running agents)", () => {
    for (const file of ["flow-verify.md", "flow-fix-applier.md"]) {
      const content = fs.readFileSync(
        path.resolve(HERE, "..", "agents", "core", file),
        "utf8",
      );
      for (const grant of ["ToolSearch", "mcp__chrome-devtools__*"]) {
        expect(
          content.includes(grant),
          `agents/${file} must keep the '${grant}' grant in its tools: ` +
            "frontmatter — the two sub-agents run the browser UI passes; dropping " +
            "it silently re-breaks the browser gate (mcp-not-available).",
        ).toBe(true);
      }
    }
  });

  it("no agent other than flow-verify.md and flow-fix-applier.md carries the chrome-devtools MCP grant", () => {
    const agentsDir = path.resolve(HERE, "..", "agents", "core");
    const otherAgentFiles = fs
      .readdirSync(agentsDir)
      .filter(
        (file) =>
          file.endsWith(".md") &&
          file !== "flow-verify.md" &&
          file !== "flow-fix-applier.md",
      );
    for (const file of otherAgentFiles) {
      const content = fs.readFileSync(path.resolve(agentsDir, file), "utf8");
      expect(
        content.includes("mcp__chrome-devtools"),
        `agents/${file} must NOT carry the chrome-devtools MCP grant — only ` +
          "flow-verify.md and flow-fix-applier.md run the browser UI passes; " +
          "granting it elsewhere silently widens the browser blast radius.",
      ).toBe(false);
    }
  });

  it("every guarded agent-file probe (`[ -f .../flow-module-<id>/agents/*.md ]`) targets a core-owned agent", () => {
    // Pins the invariant behind the hardcoded `flow-module-core/agents/`
    // guard paths sprinkled across SKILL.md/instructions files (PR #605):
    // `agents:` currently non-empty for exactly module `core` in
    // bin/lib/modules.ts, so every literal Task-tool guard probe in the
    // corpus must resolve into `flow-module-core/agents/`, never another
    // module's plugin root. Guards against a future guard site copy-pasting
    // the wrong module id when a non-core module later grows an agent.
    const guardRegex =
      /\[ -f ~\/\.flow\/claude-home\/\.claude\/skills\/flow-module-([a-z0-9-]+)\/agents\/([a-zA-Z0-9_-]+)\.md \]/g;
    const corpus = [
      ...agentDefinitionFiles,
      ...instructionsAndSpawnPromptFiles,
      SKILL_MD_PATH,
      PR_REVIEW_SKILL_MD_PATH,
      CODER_SKILL_MD_PATH,
    ].filter((p, i, arr) => fs.existsSync(p) && arr.indexOf(p) === i);
    let matchCount = 0;
    for (const file of corpus) {
      const content = fs.readFileSync(file, "utf8");
      for (const match of content.matchAll(guardRegex)) {
        matchCount++;
        const [, moduleId, agentName] = match;
        expect(
          moduleId,
          `${file} guards agent '${agentName}.md' against module ` +
            `'${moduleId}', but only 'core' owns any agents/ rows in ` +
            "bin/lib/modules.ts — every Task-tool agent-file guard must " +
            "target flow-module-core/agents/.",
        ).toBe("core");
      }
    }
    expect(
      matchCount,
      "expected at least one `[ -f .../flow-module-<id>/agents/*.md ]` guard " +
        "in the corpus — a collapsed glob or renamed guard shape would make " +
        "this assertion pass vacuously.",
    ).toBeGreaterThan(0);
  });

  it("the pr-review gatekeeper and consolidator spawn sites resolve their named agents with guarded fallbacks", () => {
    expect(
      prReviewContent.includes(
        "GATEKEEPER_SUBAGENT=flow-module-core:flow-gatekeeper",
      ),
      "pr-review SKILL.md Step 1.5 must resolve GATEKEEPER_SUBAGENT to " +
        "`flow-module-core:flow-gatekeeper`.",
    ).toBe(true);
    expect(
      prReviewContent.includes(
        "[ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-gatekeeper.md ]",
      ),
      "pr-review SKILL.md gatekeeper site must guard on the installed definition file.",
    ).toBe(true);
    expect(
      prReviewContent.includes("subagent_type: $GATEKEEPER_SUBAGENT"),
      "pr-review SKILL.md gatekeeper spawn must pass `subagent_type: $GATEKEEPER_SUBAGENT`.",
    ).toBe(true);
    expect(
      prReviewContent.includes(
        "CONSOLIDATOR_SUBAGENT=flow-module-core:flow-consolidator",
      ),
      "pr-review SKILL.md Step 3.5 must resolve CONSOLIDATOR_SUBAGENT to " +
        "`flow-module-core:flow-consolidator`.",
    ).toBe(true);
    expect(
      prReviewContent.includes(
        "[ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-consolidator.md ]",
      ),
      "pr-review SKILL.md consolidator site must guard on the installed definition file.",
    ).toBe(true);
    expect(
      prReviewContent.includes("subagent_type: $CONSOLIDATOR_SUBAGENT"),
      "pr-review SKILL.md consolidator spawn must pass `subagent_type: $CONSOLIDATOR_SUBAGENT`.",
    ).toBe(true);
  });

  it("the pr-review Step 3 fan-out resolves a named flow-review-<lens> agent per lens", () => {
    expect(
      prReviewContent.includes(
        'LENS_AGENT="flow-module-core:flow-review-$LENS"',
      ),
      "pr-review SKILL.md Step 3 must resolve each lens's subagent type to " +
        "`flow-module-core:flow-review-$LENS` (asserted in full by the " +
        "dedicated qualification test above).",
    ).toBe(true);
    expect(
      prReviewContent.includes("subagent_type: $LENS_AGENT"),
      "pr-review SKILL.md Step 3 spawn must pass `subagent_type: $LENS_AGENT`.",
    ).toBe(true);
    expect(
      prReviewContent.includes(
        "[ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-review-$LENS.md ]",
      ),
      "pr-review SKILL.md Step 3 must guard each lens on the installed definition file.",
    ).toBe(true);
  });

  it("every guarded fallback site emits the named agent-fallback notice", () => {
    for (const name of [
      "flow-gatekeeper",
      "flow-review-$LENS",
      "flow-consolidator",
      "flow-fix-applier",
    ]) {
      expect(
        prReviewContent.includes(`agent-fallback: ${name} → general-purpose`),
        `pr-review SKILL.md must carry the named 'agent-fallback: ${name} → ` +
          "general-purpose' notice — a count-only assertion tolerates deleting " +
          "real guard notices as long as the prose mention survives.",
      ).toBe(true);
    }
    expect(
      content.includes("agent-fallback: flow-verify → general-purpose"),
      "flow-pipeline SKILL.md step-6 verify guard must emit the named agent-fallback " +
        "notice on its general-purpose fallback branch.",
    ).toBe(true);
    expect(
      content.includes("agent-fallback: flow-merge-resolver → general-purpose"),
      "flow-pipeline SKILL.md step-10 merge-resolver guard must emit the named " +
        "agent-fallback notice on its general-purpose fallback branch.",
    ).toBe(true);
    expect(
      newFeatureContent.includes(
        "agent-fallback: flow-scout → general-purpose",
      ),
      "flow-new-feature SKILL.md Step 1b scout guard must emit the named " +
        "agent-fallback notice on its general-purpose fallback branch.",
    ).toBe(true);
    expect(
      productPlanningTopContent.includes(
        "agent-fallback: flow-discovery → general-purpose",
      ),
      "flow-product-planning SKILL.md discovery guard must emit the named " +
        "agent-fallback notice on its general-purpose fallback branch.",
    ).toBe(true);
    expect(
      coderContent.includes(
        "agent-fallback: flow-edit-applier → general-purpose",
      ),
      "flow-coder SKILL.md edit-applier guard must emit the named " +
        "agent-fallback notice on its general-purpose fallback branch.",
    ).toBe(true);
  });

  it("the scout, discovery, merge-resolver, and edit-applier spawn sites resolve their named agents with guarded fallbacks", () => {
    expect(
      newFeatureContent.includes("SCOUT_SUBAGENT=flow-module-core:flow-scout"),
      "flow-new-feature SKILL.md Step 1b must resolve SCOUT_SUBAGENT to " +
        "`flow-module-core:flow-scout`.",
    ).toBe(true);
    expect(
      newFeatureContent.includes(
        "[ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-scout.md ]",
      ),
      "flow-new-feature SKILL.md scout site must guard on the installed definition file.",
    ).toBe(true);
    expect(
      newFeatureContent.includes("subagent_type: $SCOUT_SUBAGENT"),
      "flow-new-feature SKILL.md scout spawn must pass `subagent_type: $SCOUT_SUBAGENT`.",
    ).toBe(true);

    expect(
      productPlanningTopContent.includes(
        "DISCOVERY_SUBAGENT=flow-module-core:flow-discovery",
      ),
      "flow-product-planning SKILL.md must resolve DISCOVERY_SUBAGENT to " +
        "`flow-module-core:flow-discovery`.",
    ).toBe(true);
    expect(
      productPlanningTopContent.includes(
        "[ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-discovery.md ]",
      ),
      "flow-product-planning SKILL.md discovery site must guard on the installed definition file.",
    ).toBe(true);
    expect(
      productPlanningTopContent.includes("subagent_type: $DISCOVERY_SUBAGENT"),
      "flow-product-planning SKILL.md discovery spawn must pass `subagent_type: $DISCOVERY_SUBAGENT`.",
    ).toBe(true);

    expect(
      content.includes(
        "MERGE_RESOLVER_SUBAGENT=flow-module-core:flow-merge-resolver",
      ),
      "flow-pipeline SKILL.md step 10 must resolve MERGE_RESOLVER_SUBAGENT to " +
        "`flow-module-core:flow-merge-resolver`.",
    ).toBe(true);
    expect(
      content.includes(
        "[ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-merge-resolver.md ]",
      ),
      "flow-pipeline SKILL.md merge-resolver site must guard on the installed definition file.",
    ).toBe(true);
    expect(
      content.includes("subagent_type: $MERGE_RESOLVER_SUBAGENT"),
      "flow-pipeline SKILL.md merge-resolver spawn must pass `subagent_type: $MERGE_RESOLVER_SUBAGENT`.",
    ).toBe(true);

    expect(
      coderContent.includes(
        "CODER_SUBAGENT=flow-module-core:flow-edit-applier",
      ),
      "flow-coder SKILL.md must resolve CODER_SUBAGENT to " +
        "`flow-module-core:flow-edit-applier`.",
    ).toBe(true);
    expect(
      coderContent.includes(
        "[ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-edit-applier.md ]",
      ),
      "flow-coder SKILL.md edit-applier site must guard on the installed definition file.",
    ).toBe(true);
    expect(
      coderContent.includes("subagent_type: $CODER_SUBAGENT"),
      "flow-coder SKILL.md edit-applier spawn must pass `subagent_type: $CODER_SUBAGENT`.",
    ).toBe(true);
  });

  it("the merge-resolver contract never mandates a force-push", () => {
    // Broadened to catch every force-push spelling, not just the
    // `push --force` flag-immediately-after-push shape: `git push -f`,
    // a flag placed after the refspec (`git push origin <ref> --force`),
    // the `+HEAD:<branch>` force-refspec syntax, and `--force-if-includes`.
    const forcePushPattern =
      /force-with-lease|force-if-includes|push\b[^\n]*?(?:-f\b|--force\b)|\+[\w./-]+:[\w./-]+/;
    // NEGATION + the clause-splitting helper are hoisted to the enclosing
    // describe body (shared with the base-branch-write lint below); see the
    // comment there for the rationale.
    const mandatesForcePush = (text: string): boolean =>
      mandatesClause(forcePushPattern, text);
    const step10Section = content.slice(
      content.indexOf("## Step 10 — Merge"),
      content.indexOf("## Step 11"),
    );
    expect(
      mandatesForcePush(mergeResolverInstructionsContent),
      "merge-resolver-instructions.md must never mandate a force-push.",
    ).toBe(false);
    expect(
      mandatesForcePush(mergeResolverSpawnPromptContent),
      "merge-resolver-spawn-prompt.md must never mandate a force-push.",
    ).toBe(false);
    expect(
      mandatesForcePush(
        fs.readFileSync(
          path.resolve(HERE, "..", "agents", "core", "flow-merge-resolver.md"),
          "utf8",
        ),
      ),
      "agents/flow-merge-resolver.md must never mandate a force-push.",
    ).toBe(false);
    expect(
      mandatesForcePush(step10Section),
      "flow-pipeline SKILL.md's step-10 section must never mandate a force-push.",
    ).toBe(false);
  });

  // REGRESSION TRIPWIRE for the current phrasing, not a semantic guard:
  // verified rephrasings such as "check out `main` and land the fix there"
  // are NOT flagged by BASE_BRANCH_WRITE_VERB below (it only matches `git
  // (push|commit|switch|checkout)`, `commit (there|on|to)`, and `push
  // (to|the)`) — the prose prohibition in fix-applier-instructions.md is
  // the primary contract; this lint is the backstop that catches a literal
  // regression of the fixed phrasing, not every possible rewording of a
  // base-branch-write mandate.
  const BASE_BRANCH_TOKEN = /\b(main|master|base branch|default branch)\b/i;
  const BASE_BRANCH_WRITE_VERB =
    /\bgit (push|commit|switch|checkout)\b|\bcommit (there|on|to)\b|\bpush (to|the)\b/i;
  const mandatesBaseBranchWrite = (text: string): boolean =>
    mandatesClause(BASE_BRANCH_TOKEN, text, (clause) =>
      BASE_BRANCH_WRITE_VERB.test(clause),
    );

  // Corpus: every agent definition plus every subagent instructions/
  // spawn-prompt file, enumerated by glob rather than a literal path array
  // so a newly-added subagent file is picked up automatically. Filenames,
  // not a fixed list, are the source of truth.
  // Matches `discoverAgents`'s `.endsWith(".md")` filter (bin/lib/sources.ts)
  // rather than a narrower `/^flow-.*\.md$/` — every file `flow install`
  // actually ships as an agent belongs in this corpus, not just the ones
  // that happen to be `flow-`-prefixed today.
  const AGENTS_DIR = path.resolve(HERE, "..", "agents", "core");
  const agentDefinitionFiles = fs
    .readdirSync(AGENTS_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(AGENTS_DIR, name));

  const PIPELINE_SKILLS_DIR = path.resolve(HERE, "..", "skills", "pipeline");
  const instructionsAndSpawnPromptFiles: string[] = [];
  for (const entry of fs.readdirSync(PIPELINE_SKILLS_DIR, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const refsDir = path.join(PIPELINE_SKILLS_DIR, entry.name, "references");
    if (!fs.existsSync(refsDir)) continue;
    for (const fileName of fs.readdirSync(refsDir)) {
      if (
        /instructions\.md$/.test(fileName) ||
        /spawn-prompt\.md$/.test(fileName)
      ) {
        instructionsAndSpawnPromptFiles.push(path.join(refsDir, fileName));
      }
    }
  }

  const baseBranchWriteCorpus = [
    ...agentDefinitionFiles,
    ...instructionsAndSpawnPromptFiles,
    AGENT_PROMPTS_PATH,
  ];

  // Per-bucket floors, not a bare `> 0` and not an exact pin. A bare `> 0`
  // stays green even if one glob collapses and the corpus shrinks from 27
  // files to 1 — the per-file assertions below would then pass vacuously for
  // the 26 files no longer being read. An exact pin would churn on every
  // added agent/instructions file. Floors sit below today's counts (15 agent
  // definitions, 11 instructions/spawn-prompt files) so adding files is free
  // while a collapsing glob goes red.
  it("the base-branch-write corpus buckets each resolve to a plausible file count (not a vacuously-green lint)", () => {
    expect(
      agentDefinitionFiles.length,
      "the agents/flow-*.md bucket resolved to too few files. A collapsed glob " +
        "makes the per-file assertions below pass vacuously for every file it " +
        "stopped reading — check the glob logic before trusting a green run.",
    ).toBeGreaterThanOrEqual(10);
    expect(
      instructionsAndSpawnPromptFiles.length,
      "the skills/pipeline/*/references/*instructions.md|*spawn-prompt.md bucket " +
        "resolved to too few files. See the comment above: a collapsed glob is a " +
        "vacuously-green lint, not a clean corpus.",
    ).toBeGreaterThanOrEqual(8);
    expect(
      fs.existsSync(AGENT_PROMPTS_PATH),
      `${AGENT_PROMPTS_PATH} must exist — it is added to the corpus explicitly ` +
        "because its filename matches neither glob pattern.",
    ).toBe(true);
  });

  it.each(
    baseBranchWriteCorpus.map((p) => [
      path.relative(path.resolve(HERE, ".."), p),
      p,
    ]),
  )("%s never mandates a write to the base branch", (_rel, absPath) => {
    const text = fs.readFileSync(absPath, "utf8");
    expect(
      mandatesBaseBranchWrite(text),
      `${absPath} must never mandate a commit/push/switch/checkout to the base ` +
        "branch (`main`, `master`, or whatever the PR/branch targets). Unaddressed " +
        "work routes through a deferral path instead of writing to the base branch.",
    ).toBe(false);
  });

  it("the base-branch-write detector catches the pre-fix phrasing and spares verified rephrasings", () => {
    expect(
      mandatesBaseBranchWrite(
        "- If the PR is **already merged**: switch to `main`, pull, commit there,",
      ),
      "the pre-fix fix-applier-instructions.md:342 phrasing must be caught by the detector.",
    ).toBe(true);
    expect(
      mandatesBaseBranchWrite(
        "Just `git commit` directly to main and move on.",
      ),
      "the detector must catch the `git commit` verb alternative, not only `switch`/`commit there`.",
    ).toBe(true);
    expect(
      mandatesBaseBranchWrite(
        "Then `git push` straight to master without a PR.",
      ),
      "the detector must catch the `git push` verb alternative.",
    ).toBe(true);

    // Fixtures are anchored to their live source lines (readFileSync, not
    // frozen string copies) so a rewording rots this test loudly instead of
    // leaving it silently green. The merge-resolver push line below is the
    // ONLY fixture that actually reaches the `!NEGATION.test(clause)`
    // branch — it matches both BASE_BRANCH_TOKEN and BASE_BRANCH_WRITE_VERB
    // and is spared only because it is negated. The other three fail the
    // verb/token gate before negation is ever evaluated; they still pin a
    // different (real) guarantee — ordinary prohibition prose about the
    // base branch that never even reaches the write-verb pattern — but
    // none of them alone would catch a regression in the NEGATION check
    // itself.
    const readAnchoredLine = (
      relPath: string,
      lineNo: number,
      expectedSubstring: string,
    ): string => {
      const absPath = path.resolve(HERE, "..", relPath);
      const line = fs.readFileSync(absPath, "utf8").split("\n")[lineNo - 1];
      expect(
        line,
        `${relPath}:${lineNo} drifted — update the anchor line number/fixture ` +
          `(expected to contain ${JSON.stringify(expectedSubstring)}, got ${JSON.stringify(line)}).`,
      ).toContain(expectedSubstring);
      return line;
    };

    const negatedButMatchesTokenAndVerb = readAnchoredLine(
      "skills/pipeline/flow-pipeline/references/merge-resolver-instructions.md",
      452,
      "NEVER push to the base branch",
    );
    expect(
      mandatesBaseBranchWrite(negatedButMatchesTokenAndVerb),
      "a negated clause that DOES match both the token and write-verb gates " +
        `must still be spared by NEGATION: ${JSON.stringify(negatedButMatchesTokenAndVerb)}`,
    ).toBe(false);

    const verifiedNegativeFixtures: Array<[string, number, string]> = [
      [
        "skills/pipeline/flow-pipeline/references/verify-loop-instructions.md",
        387,
        "NEVER touch the base branch",
      ],
      [
        "agents/core/flow-merge-resolver.md",
        11,
        "never `main`, `master`, or the base branch",
      ],
      [
        "skills/pipeline/flow-pipeline/references/merge-resolver-instructions.md",
        454,
        "NEVER use `git push --force`",
      ],
    ];
    for (const [
      relPath,
      lineNo,
      expectedSubstring,
    ] of verifiedNegativeFixtures) {
      const line = readAnchoredLine(relPath, lineNo, expectedSubstring);
      expect(
        mandatesBaseBranchWrite(line),
        `verified in-tree negative fixture must not be flagged: ${JSON.stringify(line)}`,
      ).toBe(false);
    }
  });

  it("the merge-resolver instructions document the merge conflict-marker orientation", () => {
    const sectionStart = mergeResolverInstructionsContent.indexOf(
      "### Conflict-marker orientation",
    );
    const sectionEnd = mergeResolverInstructionsContent.indexOf(
      "\n## ",
      sectionStart,
    );
    expect(sectionStart, "orientation section must exist").toBeGreaterThan(-1);
    const orientationSection = mergeResolverInstructionsContent.slice(
      sectionStart,
      sectionEnd === -1 ? undefined : sectionEnd,
    );

    expect(
      orientationSection.includes("<<<<<<< HEAD"),
      "merge-resolver-instructions.md must name the `<<<<<<< HEAD` marker in its " +
        "orientation section.",
    ).toBe(true);
    // Scoped to the section, not file-wide — `origin/` appears ~20x
    // across the file, so a bare file-wide substring check is vacuous
    // and would pass on inverted prose too.
    expect(
      orientationSection.includes("origin/"),
      "merge-resolver-instructions.md must name the `origin/<base>` side in its " +
        "orientation section.",
    ).toBe(true);
    expect(
      /inverse of a rebase/i.test(orientationSection),
      "merge-resolver-instructions.md must state the rebase-orientation inversion.",
    ).toBe(true);

    // Ordered-pair assertions: bind each marker to the CORRECT side so
    // inverted prose (e.g. "`<<<<<<< HEAD` / `ours` is THE BASE's
    // version") fails instead of silently passing a substring check —
    // exactly the regression that would make the resolver discard the
    // PR's own changes.
    const headIdx = orientationSection.indexOf("<<<<<<< HEAD");
    const headSideIdx = orientationSection.indexOf(
      "THIS PR's version",
      headIdx,
    );
    expect(
      headIdx,
      "`<<<<<<< HEAD` marker must appear in the orientation section.",
    ).toBeGreaterThan(-1);
    expect(
      headSideIdx,
      "`<<<<<<< HEAD` / `ours` must be bound to THIS PR's version, not the base's.",
    ).toBeGreaterThan(headIdx);

    const baseMarkerIdx = orientationSection.indexOf(
      ">>>>>>> origin/<base>",
      headSideIdx,
    );
    expect(
      baseMarkerIdx,
      "`>>>>>>> origin/<base>` marker must follow the HEAD-side binding.",
    ).toBeGreaterThan(headSideIdx);
    const baseSideIdx = orientationSection.indexOf(
      "THE BASE's version",
      baseMarkerIdx,
    );
    expect(
      baseSideIdx,
      "`>>>>>>> origin/<base>` / `theirs` must be bound to THE BASE's version, not the PR's.",
    ).toBeGreaterThan(baseMarkerIdx);
  });

  it("the merge-resolver's post-commit verification reads the committed tree, not the worktree", () => {
    const sec5Start = mergeResolverInstructionsContent.indexOf(
      "## 5. Verify the resolution",
    );
    const sec5End = mergeResolverInstructionsContent.indexOf(
      "## 6. Push",
      sec5Start,
    );
    expect(sec5Start, "Step 5 section must exist").toBeGreaterThan(-1);
    expect(sec5End, "Step 6 section must exist").toBeGreaterThan(sec5Start);
    const step5 = mergeResolverInstructionsContent.slice(sec5Start, sec5End);

    expect(
      step5.includes("$MARKER_CHECK_CMD --committed"),
      "Step 5 must invoke $MARKER_CHECK_CMD --committed.",
    ).toBe(true);
    expect(
      step5.includes("command -v"),
      "Step 5 must not reintroduce a command -v PATH probe — the " +
        "path-name-probe-with-inline-fallback alternative was rejected " +
        "for deadlocking on a legitimate line-start marker.",
    ).toBe(false);
    expect(
      /\bgit grep\b/.test(step5),
      "Step 5 must not hand-roll a bare git grep — the partition must " +
        "stay inside the flow-conflict-marker-check helper.",
    ).toBe(false);
    expect(
      step5.includes("git diff --check"),
      "Step 5 must not reuse git diff --check post-commit — worktree == " +
        "index == HEAD after Step 4's commit, so it is inert there.",
    ).toBe(false);
    expect(
      /inert/i.test(step5),
      "Step 5 must explain why a worktree-vs-index diff is inert post-commit.",
    ).toBe(true);
    expect(step5.includes("worktree"), "Step 5 must mention worktree").toBe(
      true,
    );
    expect(step5.includes("index"), "Step 5 must mention index").toBe(true);
    expect(step5.includes("`0`"), "Step 5 must name exit value 0").toBe(true);
    expect(step5.includes("`1`"), "Step 5 must name exit value 1").toBe(true);
    expect(step5.includes("`2`"), "Step 5 must name exit value 2").toBe(true);
    expect(
      step5.includes("HEAD:"),
      "Step 5 must name the HEAD: rev-prefix the helper strips (structural " +
        "pin — not a match on the explanation's wording).",
    ).toBe(true);
    expect(
      /spawn prompt/i.test(step5),
      "Step 5 must attribute $MARKER_CHECK_CMD's resolution to the spawn prompt.",
    ).toBe(true);

    // Outside Step 5: Step 3's per-file Layer-1 check and the
    // Troubleshooting table both still legitimately use git diff --check
    // (Layer 1 runs BEFORE the Step 4 commit); the Verification section
    // must not, since it was rewired onto the same helper as Step 5.
    const step3Start = mergeResolverInstructionsContent.indexOf(
      "## 3. Resolve each conflicted file",
    );
    const step3End = mergeResolverInstructionsContent.indexOf(
      "## 4. Complete the merge",
      step3Start,
    );
    const step3 = mergeResolverInstructionsContent.slice(step3Start, step3End);
    expect(
      step3.includes("git diff --check"),
      "Step 3 (Layer 1, pre-commit) must still use git diff --check.",
    ).toBe(true);

    const troubleshootingStart =
      mergeResolverInstructionsContent.indexOf("# Troubleshooting");
    const troubleshootingEnd = mergeResolverInstructionsContent.indexOf(
      "# Verification",
      troubleshootingStart,
    );
    const troubleshooting = mergeResolverInstructionsContent.slice(
      troubleshootingStart,
      troubleshootingEnd,
    );
    expect(
      troubleshooting.includes("git diff --check"),
      "Troubleshooting must still reference git diff --check (Step 3's Layer 1).",
    ).toBe(true);

    const verificationStart =
      mergeResolverInstructionsContent.indexOf("# Verification");
    const verificationEnd = mergeResolverInstructionsContent.indexOf(
      "# Constraints",
      verificationStart,
    );
    const verification = mergeResolverInstructionsContent.slice(
      verificationStart,
      verificationEnd,
    );
    expect(
      verification.includes("git diff --check"),
      "# Verification must not reference git diff --check — it was rewired " +
        "onto $MARKER_CHECK_CMD --committed alongside Step 5.",
    ).toBe(false);
  });

  it("the merge-resolver artifact field is push_status everywhere", () => {
    for (const [name, text] of [
      ["merge-resolver-instructions.md", mergeResolverInstructionsContent],
      ["flow-pipeline SKILL.md", content],
      ["references/exemption-contracts.md", exemptionContractsContent],
    ] as const) {
      expect(text.includes("push_status"), `${name} must use push_status`).toBe(
        true,
      );
      expect(
        text.includes("force_push_status"),
        `${name} must not use force_push_status`,
      ).toBe(false);
    }
  });

  it("the gatekeeper haiku pin agrees between frontmatter and the per-spawn param", () => {
    const gatekeeperFrontmatter =
      fs
        .readFileSync(
          path.resolve(HERE, "..", "agents", "core", "flow-gatekeeper.md"),
          "utf8",
        )
        .split("---")[1] ?? "";
    expect(
      /^model:\s*haiku\s*$/m.test(gatekeeperFrontmatter),
      "agents/flow-gatekeeper.md frontmatter must pin `model: haiku` — the declarative " +
        "half of the cost-routing pin.",
    ).toBe(true);
    expect(
      prReviewContent.includes('model: "haiku"'),
      'pr-review SKILL.md Step 1.5 must keep the per-spawn `model: "haiku"` param — it ' +
        "keeps the general-purpose fallback path on haiku; the two pin sources must not drift.",
    ).toBe(true);
  });
});

describe("Compact Instructions + verify-loop-instructions structural anchors", () => {
  // The `## Compact Instructions` compaction-steering section and the new
  // verify-loop-instructions.md spawn-instructions file are load-bearing
  // governance the PR's one-shot Test-Steps greps cover but no durable lint
  // does. These anchors are the durable guard so a later edit deleting the
  // KEEP/DROP list, dropping the heading from either file, or removing the
  // instructions file goes red on `npm run verify` — same regression class
  // the cross-doc `persist-back` and `task-tool-exemption-preamble.md`
  // existence guards above protect against.

  function compactSection(content: string): string {
    const start = content.indexOf("\n## Compact Instructions");
    if (start === -1) return "";
    const rest = content.slice(start + 1);
    const next = rest.search(/\n## /);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it("AGENTS.md documents the Compact Instructions section with KEEP/DROP lists", () => {
    const section = compactSection(agentsContent);
    expect(
      section.length,
      "AGENTS.md must carry a top-level `## Compact Instructions` section " +
        "steering Claude Code compaction.",
    ).toBeGreaterThan(0);
    for (const keep of [
      "phase",
      "PR number",
      "worktree",
      "plan.md",
      "scout.md",
      "NEEDS HUMAN",
    ]) {
      expect(
        section.includes(keep),
        `AGENTS.md ## Compact Instructions KEEP list must name '${keep}'.`,
      ).toBe(true);
    }
    for (const drop of ["failure", "CI poll"]) {
      expect(
        section.includes(drop),
        `AGENTS.md ## Compact Instructions DROP list must name '${drop}'.`,
      ).toBe(true);
    }
  });

  it("templates/AGENTS.md.template carries the Compact Instructions section", () => {
    expect(
      compactSection(agentsTemplateContent).length,
      "templates/AGENTS.md.template must carry a `## Compact Instructions` " +
        "section so consumer repos get the same compaction steering.",
    ).toBeGreaterThan(0);
  });

  it("references/verify-loop-instructions.md exists and carries its contract anchors", () => {
    const verifyLoopPath = path.resolve(
      HERE,
      "..",
      "skills",
      "pipeline",
      "flow-pipeline",
      "references",
      "verify-loop-instructions.md",
    );
    expect(
      fs.existsSync(verifyLoopPath),
      "skills/pipeline/flow-pipeline/references/verify-loop-instructions.md " +
        "must exist — it is the spawn-instructions file the step-6 " +
        "Verify-Retry-Loop subagent reads, referenced by name from SKILL.md, " +
        "AGENTS.md, and exemption-contracts.md.",
    ).toBe(true);
    const content = fs.readFileSync(verifyLoopPath, "utf8");
    expect(
      content.length,
      "verify-loop-instructions.md must be non-empty.",
    ).toBeGreaterThan(0);
    expect(
      content.includes("verify-loop-result.json"),
      "verify-loop-instructions.md must name the `verify-loop-result.json` artifact.",
    ).toBe(true);
    expect(
      content.includes("verify_status"),
      "verify-loop-instructions.md must document the `verify_status` artifact field.",
    ).toBe(true);
    expect(
      content.includes("verify-coder-result.json"),
      "verify-loop-instructions.md must document the load-bearing hybrid " +
        "inline/nested-spawn invariant: narrow fixes apply inline; wider-scope " +
        "fixes spawn one flow-edit-applier subagent writing " +
        "verify-coder-result.json, recording coder_spawn and falling back " +
        "inline on any miss — never hanging or retrying the spawn.",
    ).toBe(true);
    expect(
      content.includes("select:Task") ||
        content.includes("Load the Task tool before spawning"),
      "verify-loop-instructions.md must document the Task-load guard " +
        "('Load the Task tool before spawning' / ToolSearch query=\"select:Task\") " +
        "for its one sanctioned nested spawn.",
    ).toBe(true);
  });

  const CODER_SPAWN_VALUES = [
    "ok",
    "not-attempted",
    "task-tool-unavailable",
    "agent-unavailable",
    "artifact-missing",
    "invalid",
  ] as const;

  it.each(CODER_SPAWN_VALUES)(
    "verify-loop-instructions.md documents the coder_spawn value %s",
    (value) => {
      const verifyLoopPath = path.resolve(
        HERE,
        "..",
        "skills",
        "pipeline",
        "flow-pipeline",
        "references",
        "verify-loop-instructions.md",
      );
      const content = fs.readFileSync(verifyLoopPath, "utf8");
      expect(
        content.includes(`"${value}"`),
        `verify-loop-instructions.md must document the coder_spawn value '"${value}"' — the ` +
          "supervisor's step-6 NOTICE branch keys off exactly this enum; dropping a value " +
          "breaks the record-and-degrade contract without failing any test.",
      ).toBe(true);
    },
  );

  it("flow-pipeline/SKILL.md's step-6 artifact read keeps the CODER_SPAWN NOTICE anchors", () => {
    for (const literal of [
      "CODER_SPAWN=$(jq -r '.coder_spawn // empty' \"$ARTIFACT_PATH\")",
      "NOTICE — verify-loop coder spawn degraded:",
    ]) {
      expect(
        content.includes(literal),
        `flow-pipeline SKILL.md step-6 artifact read must keep '${literal}' — the recorded ` +
          "coder_spawn degradation is never escalated, so this NOTICE is the only signal a " +
          "depth-3 spawn or artifact miss ever reaches a human.",
      ).toBe(true);
    }
  });

  it("flow-pipeline SKILL.md step 6 writes the verifying phase INSIDE the spawn-prep fence", () => {
    const step6 = content.slice(content.indexOf("## Step 6 — Local verify"));
    const fenceStart = step6.indexOf("```bash");
    const fence = step6.slice(fenceStart, step6.indexOf("```", fenceStart + 7));
    expect(
      fence.includes("flow-state-update --phase verifying"),
      "step 6's phase write must live inside the spawn-prep bash fence, not a " +
        "standalone block — measured at 7/10 skipped when it stood alone.",
    ).toBe(true);
    expect(
      /```bash\n#[^`]*?\nflow-state-update --phase verifying/.test(step6),
      "the phase write must be the fence's first command so skipping it means " +
        "skipping the spawn setup.",
    ).toBe(true);
  });
});

describe("/flow-coder caller-list symmetry (AGENTS.md ↔ flow-pipeline/SKILL.md ↔ flow-coder/SKILL.md)", () => {
  /**
   * The /flow-coder skill is invoked by three callers via the wider-scope path of
   * each caller's hybrid threshold: /flow-new-feature step 5, /flow-verify step 3, and
   * /flow-refactoring step 3. The caller list is documented in three places:
   *
   *   - AGENTS.md `## Don'ts` — /flow-coder Task-tool exemption bullet body prose.
   *   - flow-pipeline/SKILL.md "Hard rules" — Task-tool exemption #6 block.
   *   - flow-coder/SKILL.md frontmatter `description:` field.
   *
   * If a future change adds or removes a caller (e.g. a new skill starts
   * invoking /flow-coder, or one of the existing three stops doing so), all three
   * documents must update in lockstep. This lint anchors the three sets so a
   * unilateral edit on any one side fails fast with a message that names the
   * divergent file AND the missing/extra caller.
   *
   * Extraction strategy: within each anchor section, match backticked
   * `/skill-name` tokens that appear immediately before a `step <N>` body-
   * prose marker. The `/flow-pipeline` token is filtered out — it's the
   * supervisor, not a /flow-coder caller (and appears in two of the three sections
   * as "When `/flow-pipeline` step 5 loads ..." framing prose).
   */

  /**
   * Slice the /flow-coder Task-tool exemption bullet from AGENTS.md, bounded by
   * the next `**Task-tool exemption` marker or end-of-string.
   */
  function sliceAgentsCoderSection(): string {
    const startMarker =
      "**Task-tool exemption: `/flow-pipeline` → `/flow-coder` Independent";
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
      "**Task-tool exemption #6: `/flow-coder` Independent Edit-Applier Subagent.**";
    const startIdx = stripped.indexOf(startMarker);
    if (startIdx === -1) return "";
    const rest = stripped.slice(startIdx + startMarker.length);
    const nextMarkerIdx = rest.indexOf("**Task-tool exemption");
    return nextMarkerIdx === -1 ? rest : rest.slice(0, nextMarkerIdx);
  }

  /**
   * Slice the frontmatter `description:` block from flow-coder/SKILL.md, bounded
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
   * lowercase. Filter out `/flow-pipeline` (the supervisor, not a /flow-coder
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

  it("AGENTS.md, flow-pipeline/SKILL.md, and flow-coder/SKILL.md each list exactly 3 /flow-coder callers", () => {
    const agentsCallers = extractAgentsCallers();
    const pipelineCallers = extractPipelineCallers();
    const coderCallers = extractCoderCallers();
    expect(
      agentsCallers.length,
      `AGENTS.md /flow-coder exemption section must list exactly 3 callers ` +
        `(/flow-new-feature, /flow-verify, /flow-refactoring). Found: ${JSON.stringify(agentsCallers)}. ` +
        `If you are intentionally adding a 4th caller, update this assertion in lockstep with the three docs.`,
    ).toBe(3);
    expect(
      pipelineCallers.length,
      `flow-pipeline/SKILL.md Task-tool exemption #6 block must list exactly 3 callers ` +
        `(/flow-new-feature, /flow-verify, /flow-refactoring). Found: ${JSON.stringify(pipelineCallers)}. ` +
        `If you are intentionally adding a 4th caller, update this assertion in lockstep with the three docs.`,
    ).toBe(3);
    expect(
      coderCallers.length,
      `flow-coder/SKILL.md frontmatter description must list exactly 3 callers ` +
        `(/flow-new-feature, /flow-verify, /flow-refactoring). Found: ${JSON.stringify(coderCallers)}. ` +
        `If you are intentionally adding a 4th caller, update this assertion in lockstep with the three docs.`,
    ).toBe(3);
  });

  it("AGENTS.md, flow-pipeline/SKILL.md, and flow-coder/SKILL.md list the same set of /flow-coder callers", () => {
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
      `Callers in AGENTS.md but missing from flow-pipeline/SKILL.md or flow-coder/SKILL.md: ${JSON.stringify(onlyInAgents)}. ` +
        `The three documents enumerate /flow-coder's callers bidirectionally; if you add one to one ` +
        `side, you must add it to the other two.`,
    ).toEqual([]);
    expect(
      onlyInPipeline,
      `Callers in flow-pipeline/SKILL.md but missing from AGENTS.md or flow-coder/SKILL.md: ${JSON.stringify(onlyInPipeline)}. ` +
        `The three documents enumerate /flow-coder's callers bidirectionally; if you add one to one ` +
        `side, you must add it to the other two.`,
    ).toEqual([]);
    expect(
      onlyInCoder,
      `Callers in flow-coder/SKILL.md but missing from AGENTS.md or flow-pipeline/SKILL.md: ${JSON.stringify(onlyInCoder)}. ` +
        `The three documents enumerate /flow-coder's callers bidirectionally; if you add one to one ` +
        `side, you must add it to the other two.`,
    ).toEqual([]);
  });
});

describe("flow-pr-agent-lens routing map ↔ flow-pr-review/SKILL.md agent table", () => {
  /**
   * Parses the bold agent names from the agent table in flow-pr-review/SKILL.md
   * (rows like `| **Bug Detection** | ...`) and kebab-cases them, then asserts
   * set-equality against Object.keys(AGENT_LENS_MAP). Same bidirectional
   * pattern as the "Task-tool exemption symmetry" block above.
   */
  const AGENT_NAME_TO_KEBAB: Record<string, string> = {
    "Bug Detection": "bug-detection",
    Security: "security",
    "Pattern/Consistency": "pattern-consistency",
    Performance: "performance",
    "Supply-Chain": "supply-chain",
    "Test Coverage": "test-coverage",
  };

  function extractSkillAgentKebabs(): string[] {
    const re = /^\|\s*\*\*([^*]+?)\*\*\s*\|/gm;
    return [...prReviewContent.matchAll(re)]
      .map((m) => m[1].trim())
      .filter((name) => name in AGENT_NAME_TO_KEBAB)
      .map((name) => AGENT_NAME_TO_KEBAB[name]);
  }

  it("flow-pr-review/SKILL.md agent table and AGENT_LENS_MAP list the same six agents", () => {
    const skill = new Set(extractSkillAgentKebabs());
    const map = new Set(Object.keys(AGENT_LENS_MAP));
    const onlyInSkill = [...skill].filter((x) => !map.has(x));
    const onlyInMap = [...map].filter((x) => !skill.has(x));
    expect(
      onlyInSkill.length,
      `SKILL.md agent table contains ${JSON.stringify(onlyInSkill)} but bin/flow-pr-agent-lens.ts ` +
        "AGENT_LENS_MAP is missing them. Add the matching entry to the map (or rename the table " +
        "row) so the two stay in sync.",
    ).toBe(0);
    expect(
      onlyInMap.length,
      `bin/flow-pr-agent-lens.ts AGENT_LENS_MAP contains ${JSON.stringify(onlyInMap)} but ` +
        "flow-pr-review/SKILL.md agent table is missing them. Add the matching `| **<Name>** | ... |` " +
        "row to the table (or remove the map entry) so the two stay in sync.",
    ).toBe(0);
  });

  it("flow-pr-review/SKILL.md agent table parses exactly six agent rows", () => {
    expect(
      extractSkillAgentKebabs().length,
      "flow-pr-review/SKILL.md agent table must have exactly six rows with bold agent names. " +
        "If you added or removed an agent, update AGENT_LENS_MAP in bin/flow-pr-agent-lens.ts too.",
    ).toBe(6);
  });
});

describe("cross-model (Gemini) lens doc symmetry", () => {
  /**
   * The Gemini cross-model lens is a flow-delegate Bash fan-out (NOT a Task,
   * NOT a seventh agent-table row — it has no static-analysis lens, so it is
   * deliberately absent from AGENT_LENS_MAP and the six-row table above). It
   * is documented as a separate Step 3 sub-step + Step 3.5 consolidator
   * input. This lint guards against the two halves drifting: the Step 3
   * spawn/note and the Step 3.5 consolidator input list must both name
   * `agent-output-gemini.json`, and the consolidator-instructions §2 input
   * list must too. A separately-anchored guard — it does NOT touch the
   * six-row `.toBe(6)` lint or the nine-exemption-count lints.
   */
  const GEMINI_ARTIFACT = "agent-output-gemini.json";

  const consolidatorInstructionsPath = path.resolve(
    HERE,
    "..",
    "skills",
    "pipeline",
    "flow-pr-review",
    "references",
    "consolidator-instructions.md",
  );
  const consolidatorContent = fs.readFileSync(
    consolidatorInstructionsPath,
    "utf8",
  );

  // Split flow-pr-review/SKILL.md at the Step 3.5 heading so we can assert the
  // artifact appears on BOTH sides (Step 3 sub-step AND Step 3.5 input list).
  const step35Marker = "## 3.5. Independent Consolidator-Validator";
  const step35Idx = prReviewContent.indexOf(step35Marker);

  it("flow-pr-review/SKILL.md Step 3.5 marker is present (split anchor)", () => {
    expect(
      step35Idx,
      "Expected the '## 3.5. Independent Consolidator-Validator' heading in " +
        "flow-pr-review/SKILL.md to split Step 3 from Step 3.5.",
    ).toBeGreaterThan(0);
  });

  it("flow-pr-review/SKILL.md Step 3 (before 3.5) names agent-output-gemini.json", () => {
    const step3 = prReviewContent.slice(0, step35Idx);
    expect(
      step3.includes(GEMINI_ARTIFACT),
      "flow-pr-review/SKILL.md Step 3 must document the cross-model Gemini lens " +
        `naming '${GEMINI_ARTIFACT}'. If you removed the Step 3 sub-step, the lens drifted ` +
        "out of the spawn half of the contract.",
    ).toBe(true);
  });

  it("flow-pr-review/SKILL.md Step 3.5 (consolidator input) names agent-output-gemini.json", () => {
    const step35 = prReviewContent.slice(step35Idx);
    expect(
      step35.includes(GEMINI_ARTIFACT),
      "flow-pr-review/SKILL.md Step 3.5 consolidator input list must name " +
        `'${GEMINI_ARTIFACT}' as the optional seventh (tolerated-absent) input. ` +
        "Drift here means the lens is spawned at Step 3 but never consumed.",
    ).toBe(true);
  });

  it("consolidator-instructions.md §2 input list names agent-output-gemini.json", () => {
    expect(
      consolidatorContent.includes(GEMINI_ARTIFACT),
      "references/consolidator-instructions.md §2 Inputs must name " +
        `'${GEMINI_ARTIFACT}' as the optional seventh input so the consolidator ` +
        "subagent's instructions stay in sync with flow-pr-review/SKILL.md.",
    ).toBe(true);
  });
});

describe("cross-model plan review doc symmetry (AGENTS.md ↔ flow-pipeline/SKILL.md)", () => {
  /**
   * The Layer-2 cross-model plan review is a flow-delegate Bash fan-out (NOT a
   * Task, NOT a tenth exemption). Its "not a tenth exemption" sibling note must
   * appear in BOTH AGENTS.md `## Don'ts` and flow-pipeline/SKILL.md "Hard
   * rules", using the SAME shared phrase as the Gemini-lens note so a rename
   * can't silently drift one doc out of sync. A separately-anchored guard — it
   * does NOT touch the nine-exemption-count `.toBe`/only-nine lints.
   */
  const PLAN_REVIEW_PHRASE = "cross-model plan review";
  const FANOUT_PHRASE = "Bash fan-out, not a tenth exemption";

  it("AGENTS.md names the cross-model plan review Bash-fan-out sibling note", () => {
    expect(
      agentsContent.includes(PLAN_REVIEW_PHRASE),
      `AGENTS.md ## Don'ts must name the '${PLAN_REVIEW_PHRASE}' Layer-2 lens.`,
    ).toBe(true);
    expect(
      agentsContent.includes(FANOUT_PHRASE),
      `AGENTS.md must carry the shared '${FANOUT_PHRASE}' phrase for the plan-review note.`,
    ).toBe(true);
  });

  it("flow-pipeline/SKILL.md names the cross-model plan review Bash-fan-out sibling note", () => {
    expect(
      content.includes(PLAN_REVIEW_PHRASE),
      `flow-pipeline/SKILL.md must name the '${PLAN_REVIEW_PHRASE}' Layer-2 lens.`,
    ).toBe(true);
    expect(
      content.includes(FANOUT_PHRASE),
      `flow-pipeline/SKILL.md Hard rules must carry the shared '${FANOUT_PHRASE}' phrase for the plan-review note.`,
    ).toBe(true);
  });
});

describe("cross-model design review doc symmetry (AGENTS.md ↔ flow-epic-create/SKILL.md)", () => {
  /**
   * The /flow-epic-create Step 4.5 cross-model design review is a flow-plan-review
   * Bash fan-out (NOT a Task, NOT a tenth exemption). Its "not a tenth exemption"
   * sibling note must appear in BOTH AGENTS.md `## Don'ts` and flow-epic-create/SKILL.md,
   * using the SAME shared phrase as the /flow-pipeline plan-review note so a rename
   * can't silently drift one doc out of sync. A DISTINCT design-review phrase (not
   * the feature "cross-model plan review") independently anchors the epic note. A
   * separately-anchored guard — it does NOT touch the two-named-surface count.
   */
  const DESIGN_REVIEW_PHRASE = "cross-model design review";
  const FANOUT_PHRASE = "Bash fan-out, not a tenth exemption";
  const EPIC_CREATE_PATH = path.resolve(
    HERE,
    "..",
    "skills",
    "pipeline",
    "flow-epic-create",
    "SKILL.md",
  );
  const epicCreateSkillContent = fs.readFileSync(EPIC_CREATE_PATH, "utf8");

  it("AGENTS.md names the cross-model design review Bash-fan-out sibling note", () => {
    expect(
      agentsContent.includes(DESIGN_REVIEW_PHRASE),
      `AGENTS.md ## Don'ts must name the '${DESIGN_REVIEW_PHRASE}' /flow-epic-create gate.`,
    ).toBe(true);
    expect(
      agentsContent.includes(FANOUT_PHRASE),
      `AGENTS.md must carry the shared '${FANOUT_PHRASE}' phrase for the /flow-epic-create design-review note.`,
    ).toBe(true);
  });

  it("flow-epic-create/SKILL.md names the cross-model design review Bash-fan-out sibling note", () => {
    expect(
      epicCreateSkillContent.includes(DESIGN_REVIEW_PHRASE),
      `flow-epic-create/SKILL.md must name the '${DESIGN_REVIEW_PHRASE}' Step 4.5 gate.`,
    ).toBe(true);
    expect(
      epicCreateSkillContent.includes(FANOUT_PHRASE),
      `flow-epic-create/SKILL.md must carry the shared '${FANOUT_PHRASE}' phrase for the design-review note.`,
    ).toBe(true);
  });

  // Durable guard for the "epic decompositions always get two reviewers"
  // contract (SKILL.md prose: `auto` cannot reach `deep` on a design.md
  // artifact shape, so this call site must pin `--depth deep` explicitly).
  // Was a one-shot PR-body Test Steps grep; moved here per Durable-test
  // precedence so a future edit dropping the flag fails CI, not just review.
  it("flow-epic-create/SKILL.md invokes flow-plan-review with --depth deep", () => {
    expect(
      /flow-plan-review\b[\s\S]{0,200}?--depth deep/.test(
        epicCreateSkillContent,
      ),
      "flow-epic-create/SKILL.md's cross-model design review call site must pin " +
        "'--depth deep' — `auto` cannot resolve deep on a design.md artifact shape " +
        "(no `### Task N:` headings, no `### D` subsections), so an epic decomposition " +
        "only gets two reviewers if this flag stays explicit.",
    ).toBe(true);
  });
});

describe("cross-model plan review worktree + convergence pins", () => {
  /**
   * Pins two invariants added by the reviewer-engagement PR: every
   * flow-plan-review review-mode invocation across BOTH SKILL.md call
   * sites must thread `--worktree "$WORKTREE"` (a `worktree-not-provided`
   * skip is a wiring bug, not an environment condition), and
   * flow-pipeline/SKILL.md's convergence rule must be stated as
   * conditional on two genuinely `ran:true` reviewers — not merely "both
   * reviewers dispatched" — so a demoted (non-engaging/empty) reviewer
   * can never be silently re-admitted into the convergence count.
   */
  const EPIC_CREATE_SKILL_MD_PATH = path.resolve(
    HERE,
    "..",
    "skills",
    "pipeline",
    "flow-epic-create",
    "SKILL.md",
  );
  const epicCreateContent = fs.readFileSync(EPIC_CREATE_SKILL_MD_PATH, "utf8");

  it.each([
    ["flow-pipeline/SKILL.md", content],
    ["flow-epic-create/SKILL.md", epicCreateContent],
  ])(
    '%s\'s flow-plan-review call site threads --worktree "$WORKTREE"',
    (name, skillContent) => {
      expect(
        /flow-plan-review\b[\s\S]{0,200}?--worktree "\$WORKTREE"/.test(
          skillContent,
        ),
        `${name}'s flow-plan-review call site must pass --worktree "$WORKTREE" ` +
          "— both tiers pass the repository itself as the reviewer's sole " +
          "--add-dir, and an omitted flag is a wiring bug (worktree-not-provided). " +
          "This must be anchored to the flow-plan-review invocation itself, not " +
          "merely present anywhere in the file (e.g. on an unrelated " +
          "flow-state-update call).",
      ).toBe(true);
    },
  );

  it("flow-pipeline/SKILL.md states the convergence rule is conditional on two ran:true reviewers", () => {
    expect(
      content.includes("reviewers[]` holds exactly two `ran:true` entries"),
      "flow-pipeline/SKILL.md's convergence-rule prose must require " +
        "reviewers[] to hold exactly two ran:true entries — a demoted " +
        "(non-engaging/empty) reviewer must not count as a survivor for " +
        "the convergence rule.",
    ).toBe(true);
  });
});

describe("Fix-Applier artifact JSON schema drift (flow-pr-review/SKILL.md ↔ references/fix-applier-instructions.md)", () => {
  const REQUIRED_KEYS = [
    "commits",
    "deferred",
    "rejected_alternatives",
    "anti_patterns_found",
    "summary",
  ];

  it.each(REQUIRED_KEYS)(
    "flow-pr-review/SKILL.md declares the '%s' top-level key for the fix-applier artifact",
    (key) => {
      expect(
        prReviewContent.includes(`\`${key}\``),
        `flow-pr-review/SKILL.md must reference '\`${key}\`' as one of the artifact's typed fields. ` +
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
          `Drift between this file and flow-pr-review/SKILL.md silently breaks the wrapper-subagent contract.`,
      ).toBe(true);
    },
  );

  it("flow-pr-review/SKILL.md has a Fix-Applier Subagent section", () => {
    expect(
      prReviewContent.includes("# Fix-Applier Subagent"),
      "flow-pr-review/SKILL.md must have a top-level '# Fix-Applier Subagent' section that " +
        "documents the spawn procedure and prompt template. The exemption in flow-pipeline/SKILL.md " +
        "Hard rules and AGENTS.md ## Don'ts is anchored on this heading name.",
    ).toBe(true);
  });

  it("flow-pr-review/references/fix-applier-spawn-prompt.md instructs the subagent on negative-findings slots", () => {
    const hasNegativeFindings =
      fixApplierSpawnPromptContent.includes("rejected_alternatives") &&
      fixApplierSpawnPromptContent.includes("anti_patterns_found") &&
      fixApplierSpawnPromptContent.includes("silence is not the default");
    expect(
      hasNegativeFindings,
      "flow-pr-review/references/fix-applier-spawn-prompt.md must affirmatively instruct the subagent to " +
        "populate 'rejected_alternatives' and 'anti_patterns_found' (and warn that 'silence is " +
        "not the default'). Without this, the subagent defaults to leaving the slots empty and " +
        "the user-redirect contract is silently broken.",
    ).toBe(true);
  });

  it("flow-pr-review/references/agent-prompts.md instructs every review lens on the negative-findings slots", () => {
    // Slice to the shared block every lens actually reads (everything before
    // the per-lens sections starting at '## Bug Detection Agent') so this
    // guard can't pass merely because the tokens survive somewhere ELSE in
    // the file (e.g. the Gemini-only section) after the shared block itself
    // is deleted.
    const sharedBlockEnd = agentPromptsContent.indexOf(
      "## Bug Detection Agent",
    );
    expect(sharedBlockEnd).toBeGreaterThan(-1);
    const sharedBlock = agentPromptsContent.slice(0, sharedBlockEnd);
    const hasNegativeFindings =
      sharedBlock.includes("rejected_alternatives") &&
      sharedBlock.includes("anti_patterns_found") &&
      /silence is not the default/i.test(sharedBlock);
    expect(
      hasNegativeFindings,
      "flow-pr-review/references/agent-prompts.md's shared block (everything before " +
        "'## Bug Detection Agent') must affirmatively instruct every review lens to " +
        "populate 'rejected_alternatives' and 'anti_patterns_found' (and warn that 'silence is " +
        "not the default'). Without this, a lens defaults to leaving the slots empty (or omitting " +
        "the keys entirely) and the Consolidator's lens-negatives pass-through channel is silently starved.",
    ).toBe(true);
  });

  it("flow-pipeline/references/merge-resolver-spawn-prompt.md carries all nine spawn-prompt placeholders", () => {
    const placeholders = [
      "{{INSTRUCTIONS_PATH}}",
      "{{PR}}",
      "{{BASE_BRANCH}}",
      "{{MERGE_STDERR}}",
      "{{CONFLICTING_FILES}}",
      "{{WORKTREE}}",
      "{{PR_DESCRIPTION}}",
      "{{ARTIFACT_PATH}}",
      "{{MARKER_CHECK_CMD}}",
    ];
    const missing = placeholders.filter(
      (p) => !mergeResolverSpawnPromptContent.includes(p),
    );
    expect(
      missing,
      "flow-pipeline/references/merge-resolver-spawn-prompt.md must carry every " +
        "spawn-prompt placeholder the flow-pipeline SKILL.md Step 10 composer fills; a " +
        "silently dropped placeholder would spawn the merge-conflict resolver with an " +
        "unfilled template. Missing: " +
        missing.join(", "),
    ).toEqual([]);
  });

  it("references/fix-applier-instructions.md documents the per-entry 'introduced_by_this_pr' field", () => {
    expect(
      fixApplierContent.includes("introduced_by_this_pr"),
      "references/fix-applier-instructions.md must document the per-entry " +
        "'introduced_by_this_pr' boolean on anti_patterns_found entries. Dropping it here " +
        "breaks lockstep with the fix-applier-schema.ts validator that now requires the field.",
    ).toBe(true);
  });

  it("flow-pr-review/SKILL.md documents the per-entry 'introduced_by_this_pr' field", () => {
    expect(
      prReviewContent.includes("introduced_by_this_pr"),
      "flow-pr-review/SKILL.md must document the per-entry 'introduced_by_this_pr' boolean on " +
        "anti_patterns_found entries (Step-12 renderer note). Dropping it here breaks lockstep.",
    ).toBe(true);
  });

  it("flow-pr-review/references/fix-applier-spawn-prompt.md instructs the subagent on 'introduced_by_this_pr'", () => {
    expect(
      fixApplierSpawnPromptContent.includes("introduced_by_this_pr"),
      "flow-pr-review/references/fix-applier-spawn-prompt.md must instruct the subagent to set " +
        "'introduced_by_this_pr' on every anti_patterns_found entry. Dropping it here breaks lockstep.",
    ).toBe(true);
  });

  it("references/fix-applier-instructions.md documents the self-validate-before-exit step (validator invocation + re-emit-once)", () => {
    expect(
      fixApplierContent.includes("flow-fix-applier-schema --validate"),
      "references/fix-applier-instructions.md must invoke 'flow-fix-applier-schema --validate' " +
        "in section 9 so the subagent self-validates its candidate artifact before the mv. " +
        "Dropping it here lets the subagent exit with an off-shape artifact undetected.",
    ).toBe(true);
    const hasReEmitOnce =
      fixApplierContent.includes("re-emit") &&
      (fixApplierContent.includes("EXACTLY ONCE") ||
        fixApplierContent.includes("exactly once") ||
        fixApplierContent.includes("once"));
    expect(
      hasReEmitOnce,
      "references/fix-applier-instructions.md must document the re-emit-once contract " +
        "(re-emit a corrected artifact exactly once on validation failure). Dropping this prose " +
        "breaks the self-validate-before-exit hardening.",
    ).toBe(true);
  });
});

describe("Edit-Applier artifact JSON schema drift (flow-coder/SKILL.md ↔ references/coder-instructions.md)", () => {
  const CODER_REQUIRED_KEYS = [
    "edits",
    "verify_status",
    "rejected_alternatives",
    "anti_patterns_found",
    "summary",
  ];

  it.each(CODER_REQUIRED_KEYS)(
    "flow-coder/SKILL.md declares the '%s' top-level key for the edit-applier artifact",
    (key) => {
      expect(
        coderContent.includes(`\`${key}\``),
        `flow-coder/SKILL.md must reference '\`${key}\`' as one of the artifact's typed fields. ` +
          `Missing the key here means a downstream consumer (/flow-new-feature step 5, /flow-verify step 3, /flow-refactoring step 3) ` +
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
          `Drift between this file and flow-coder/SKILL.md silently breaks the wrapper-subagent contract.`,
      ).toBe(true);
    },
  );

  it("flow-coder/SKILL.md has an Independent Edit-Applier Subagent section", () => {
    expect(
      coderContent.includes("## Independent Edit-Applier Subagent"),
      "flow-coder/SKILL.md must have an '## Independent Edit-Applier Subagent' section that " +
        "documents the spawn procedure and prompt template. The exemption in flow-pipeline/SKILL.md " +
        "Hard rules and AGENTS.md ## Don'ts is anchored on this heading name.",
    ).toBe(true);
  });

  it("flow-coder/SKILL.md spawn-prompt template instructs the subagent on negative-findings slots", () => {
    const hasNegativeFindings =
      coderContent.includes("rejected_alternatives") &&
      coderContent.includes("anti_patterns_found") &&
      coderContent.includes("silence is not the default");
    expect(
      hasNegativeFindings,
      "flow-coder/SKILL.md's spawn prompt template must affirmatively instruct the subagent to " +
        "populate 'rejected_alternatives' and 'anti_patterns_found' (and warn that 'silence is " +
        "not the default'). Without this, the subagent defaults to leaving the slots empty and " +
        "the user-redirect contract is silently broken.",
    ).toBe(true);
  });

  it("references/coder-instructions.md documents the per-entry 'introduced_by_this_pr' field", () => {
    expect(
      coderInstructionsContent.includes("introduced_by_this_pr"),
      "references/coder-instructions.md must document the per-entry 'introduced_by_this_pr' " +
        "boolean on anti_patterns_found entries. Dropping it here breaks lockstep with the " +
        "coder-schema.ts validator that now requires the field.",
    ).toBe(true);
  });

  it("flow-coder/SKILL.md documents the per-entry 'introduced_by_this_pr' field", () => {
    expect(
      coderContent.includes("introduced_by_this_pr"),
      "flow-coder/SKILL.md must document the per-entry 'introduced_by_this_pr' boolean on " +
        "anti_patterns_found entries (spawn-prompt template). Dropping it here breaks lockstep.",
    ).toBe(true);
  });

  it("flow-coder/SKILL.md cross-references AGENTS.md and flow-pipeline/SKILL.md", () => {
    expect(
      coderContent.includes("AGENTS.md"),
      "flow-coder/SKILL.md must reference 'AGENTS.md' so the bidirectional contract is discoverable.",
    ).toBe(true);
    expect(
      coderContent.includes("skills/pipeline/flow-pipeline/SKILL.md"),
      "flow-coder/SKILL.md must reference 'skills/pipeline/flow-pipeline/SKILL.md' so the named " +
        "exemption pointer is discoverable.",
    ).toBe(true);
  });

  it("AGENTS.md cross-references flow-coder/SKILL.md", () => {
    expect(
      agentsContent.includes("skills/pipeline/flow-coder/SKILL.md"),
      "AGENTS.md must reference 'skills/pipeline/flow-coder/SKILL.md' inside the fifth Task-tool " +
        "exemption block so the bidirectional contract holds.",
    ).toBe(true);
  });
});

describe("Gatekeeper artifact JSON schema drift (flow-pr-review/SKILL.md)", () => {
  // skip_kind is intentionally NOT in the required-keys list — it's emitted
  // only on `decision: "skip"` and omitted on `decision: "proceed"`. The
  // sibling Fix-Applier and Edit-Applier schemas list every key as required;
  // the Gatekeeper's optional skip_kind diverges from that pattern by design.
  //
  // prompt_interpretation_tension IS in the required-keys list — it's emitted
  // on every verdict (always-emit boolean, never undefined) so the downstream
  // Pattern & Consistency Agent at Step 2 can read it from the artifact
  // unconditionally. Sibling contract: skills/pipeline/flow-product-planning/
  // references/discovery-instructions.md "Prompt interpretation (conditional)"
  // is the single source of truth for the detection heuristic and the
  // four-value Recommended-path enum.
  const GATEKEEPER_REQUIRED_KEYS = [
    "decision",
    "reason",
    "summary",
    "prompt_interpretation_tension",
  ];

  it.each(GATEKEEPER_REQUIRED_KEYS)(
    "flow-pr-review/references/gatekeeper-spawn-prompt.md declares the '%s' top-level key for the gatekeeper artifact",
    (key) => {
      expect(
        gatekeeperSpawnPromptContent.includes(`\`${key}\``),
        `flow-pr-review/references/gatekeeper-spawn-prompt.md must reference '\`${key}\`' as one of the gatekeeper ` +
          `artifact's typed fields. Drift here means the wrapper's branch-on-.decision ` +
          `logic at Step 1.5 silently falls through if the Haiku subagent renames a ` +
          `field. Mirrors the parallel Fix-Applier and Edit-Applier schema-drift lints ` +
          `above.`,
      ).toBe(true);
    },
  );

  it("flow-pr-review/references/gatekeeper-spawn-prompt.md documents the optional 'skip_kind' field for the gatekeeper artifact", () => {
    expect(
      gatekeeperSpawnPromptContent.includes("`skip_kind`") ||
        gatekeeperSpawnPromptContent.includes('"skip_kind"'),
      "flow-pr-review/references/gatekeeper-spawn-prompt.md must reference 'skip_kind' (as `skip_kind` or \"skip_kind\") " +
        "in the Gatekeeper subagent's documented artifact shape. The field is optional " +
        '(emitted only on decision: "skip") but the prose must still surface it so the ' +
        "wrapper's reader knows to expect it on skip verdicts.",
    ).toBe(true);
  });

  it("flow-pr-review/SKILL.md has an Independent Gatekeeper Subagent section", () => {
    expect(
      prReviewContent.includes("# Independent Gatekeeper Subagent"),
      "flow-pr-review/SKILL.md must have a top-level '# Independent Gatekeeper Subagent' " +
        "section. The exemption in flow-pipeline/SKILL.md Hard rules and AGENTS.md " +
        "## Don'ts is anchored on this heading name.",
    ).toBe(true);
  });

  it("pr-review-last-sha: read-site lives in the Gatekeeper spawn prompt reference AND write-site lives in flow-pr-review/SKILL.md Step 13", () => {
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
      `flow-pr-review/references/gatekeeper-spawn-prompt.md must reference ` +
        `'pr-review-last-sha' as the read-site for the no-new-commits skip rule. ` +
        `A missing read means the skip rule is dead code.`,
    ).toBe(true);
    expect(
      prReviewContent.includes("pr-review-last-sha"),
      `flow-pr-review/SKILL.md must reference 'pr-review-last-sha' as the write-site ` +
        `in Step 13's clean-completion block. A missing write means the marker is ` +
        `never created and the skip rule's metadata check always falls through.`,
    ).toBe(true);
  });
});

describe("Consolidator artifact JSON schema drift (flow-pr-review/SKILL.md)", () => {
  // The Consolidator-Validator subagent's artifact at
  // <worktree>/.flow-tmp/consolidator-result.json has five REQUIRED
  // top-level keys, plus three OPTIONAL per-lens pass-through keys
  // (`lens_rejected_alternatives`, `lens_anti_patterns_found`,
  // `lens_negatives_missing`) — optional on the runtime validator, but
  // still documented prose the Consolidator's instructions must name so a
  // field rename in either direction can't silently drift the prose
  // contract away from bin/lib/agent-finding-schema.ts. This array (kept
  // under its original name for lint continuity) now pins all eight.
  const CONSOLIDATOR_REQUIRED_KEYS = [
    "consolidated_findings",
    "dropped_by_validation",
    "rejected_alternatives",
    "anti_patterns_found",
    "summary",
    "lens_rejected_alternatives",
    "lens_anti_patterns_found",
    "lens_negatives_missing",
  ];

  const CONSOLIDATOR_INSTRUCTIONS_PATH = path.resolve(
    HERE,
    "..",
    "skills",
    "pipeline",
    "flow-pr-review",
    "references",
    "consolidator-instructions.md",
  );
  const consolidatorInstructionsContent = fs.readFileSync(
    CONSOLIDATOR_INSTRUCTIONS_PATH,
    "utf8",
  );

  it.each(CONSOLIDATOR_REQUIRED_KEYS)(
    "flow-pr-review/SKILL.md declares the '%s' top-level key for the consolidator artifact",
    (key) => {
      expect(
        prReviewContent.includes(`\`${key}\``),
        `flow-pr-review/SKILL.md must reference '\`${key}\`' as one of the ` +
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
          `flow-pr-review/SKILL.md silently breaks the wrapper-subagent contract.`,
      ).toBe(true);
    },
  );

  it("flow-pr-review/SKILL.md has an Independent Consolidator-Validator Subagent section", () => {
    expect(
      prReviewContent.includes("# Independent Consolidator-Validator Subagent"),
      "flow-pr-review/SKILL.md must have a top-level '# Independent Consolidator-Validator Subagent' " +
        "section. The exemption in flow-pipeline/SKILL.md Hard rules and AGENTS.md " +
        "## Don'ts is anchored on this heading name.",
    ).toBe(true);
  });

  it("flow-pr-review/SKILL.md declares the Step 3.5 label and the consolidator-result.json path", () => {
    expect(
      prReviewContent.includes("3.5"),
      "flow-pr-review/SKILL.md must reference '3.5' as a canonical step label so " +
        "the result-artifact step enumeration stays in sync with the new step.",
    ).toBe(true);
    expect(
      prReviewContent.includes("consolidator-result.json"),
      "flow-pr-review/SKILL.md must reference 'consolidator-result.json' so the " +
        "artifact path is grep-discoverable. Drift here means the Step 3.5 " +
        "post-spawn existence check could silently fall through.",
    ).toBe(true);
  });
});

describe("AGENTS.md Output style anchors", () => {
  it("AGENTS.md contains the prompt-as-evidence-of-intent rule anchor phrase exactly once", () => {
    // The bolded anchor phrase **Treat user prompts as evidence of intent,
    // not exhaustive specifications.** is the stable lint hook for the rule
    // documented at AGENTS.md `## Output style`. Downstream contracts
    // (skills/pipeline/flow-product-planning/references/discovery-instructions.md's
    // "Prompt interpretation (conditional)" sub-section,
    // skills/pipeline/flow-new-feature/SKILL.md Step 2's tension surfacing,
    // skills/pipeline/flow-pipeline/SKILL.md Step 3's non-feature-intent
    // routing, skills/pipeline/flow-pr-review/SKILL.md Step 1.5's Gatekeeper
    // tension field) all refer to this rule by name. Renaming the rule's
    // anchor phrase requires updating this assertion in the same commit.
    const matches = agentsContent.match(
      /^- \*\*Treat user prompts as evidence of intent, not exhaustive specifications\.\*\*/gm,
    );
    expect(
      matches?.length ?? 0,
      "AGENTS.md must contain the rule anchor phrase " +
        "'- **Treat user prompts as evidence of intent, not exhaustive specifications.**' " +
        "exactly once at the start of a list item in `## Output style`. " +
        "Found " +
        (matches?.length ?? 0) +
        " match(es).",
    ).toBe(1);
  });

  it("AGENTS.md prompt-as-evidence rule names PR #170 as the canonical precedent", () => {
    // The rule body's PR #170 precedent reference is load-bearing: it grounds
    // the abstract "treat prompts as intent" instruction in a concrete failure
    // mode the reader can search for. If the precedent reference is lost in
    // a future rewrite, the rule becomes pure abstraction and the connection
    // to the canonical incident gets harder to recover.
    expect(
      agentsContent.includes("PR #170"),
      "AGENTS.md must reference 'PR #170' inside the prompt-as-evidence-of-intent " +
        "rule body. This is the canonical precedent for the rule (four prescribed " +
        "trims landed at -71 lines vs a <800-line target, with no tension surfaced).",
    ).toBe(true);
  });

  it("AGENTS.md contains the middle-ground rule anchor phrase exactly once", () => {
    // The bolded anchor phrase **Consider the middle ground when a request
    // is framed as a binary choice.** is the stable lint hook for the rule
    // documented at AGENTS.md `## Output style`. Downstream contracts
    // (skills/pipeline/flow-product-planning/references/discovery-instructions.md's
    // step 3 Trade-offs row + step 4 Architecture Checkpoint,
    // skills/pipeline/flow-product-planning/references/discovery-playbook.md's
    // "Fork" technique, skills/pipeline/flow-new-feature/SKILL.md Step 2's
    // "Consider alternatives" bullet) all refer to this rule by name.
    // Renaming the rule's anchor phrase requires updating this assertion
    // in the same commit.
    const matches = agentsContent.match(
      /^- \*\*Consider the middle ground when a request is framed as a binary choice\.\*\*/gm,
    );
    expect(
      matches?.length ?? 0,
      "AGENTS.md must contain the rule anchor phrase " +
        "'- **Consider the middle ground when a request is framed as a binary choice.**' " +
        "exactly once at the start of a list item in `## Output style`. " +
        "Found " +
        (matches?.length ?? 0) +
        " match(es).",
    ).toBe(1);
  });

  it("AGENTS.md contains the fix-now-vs-defer rule anchor phrase exactly once", () => {
    // The bolded anchor phrase **Fix cheap, in-scope robustness issues now
    // rather than deferring them.** is the stable lint hook for the rule
    // documented at AGENTS.md `## Output style`. The full fix-now-vs-defer
    // bar it summarises lives at the two enforcement sites
    // (templates/AGENTS.md.template `## Anti-Overengineering` and
    // skills/pipeline/flow-pr-review/references/fix-applier-instructions.md);
    // this rule is the flow-repo-side decision-discipline pointer. Renaming
    // the rule's anchor phrase requires updating this assertion in the same
    // commit.
    const matches = agentsContent.match(
      /^- \*\*Fix cheap, in-scope robustness issues now rather than deferring them\.\*\*/gm,
    );
    expect(
      matches?.length ?? 0,
      "AGENTS.md must contain the rule anchor phrase " +
        "'- **Fix cheap, in-scope robustness issues now rather than deferring them.**' " +
        "exactly once at the start of a list item in `## Output style`. " +
        "Found " +
        (matches?.length ?? 0) +
        " match(es).",
    ).toBe(1);
  });

  it("AGENTS.md contains the production-bound rule anchor phrase exactly once", () => {
    // The bolded anchor phrase **Treat every request as production-bound, not
    // a hobby project.** is the stable lint hook for the rule documented at
    // AGENTS.md `## Output style`. It governs the include-vs-defer decision
    // (cohesion over size) and the production-quality bar; the full treatment
    // lives at templates/AGENTS.md.template (`## Scope: bundle cohesive work,
    // defer only separate features`), and the skill-side enforcement sites
    // (skills/pipeline/flow-product-planning/references/discovery-instructions.md's
    // "Bar for inclusion" + skills/pipeline/flow-new-feature/SKILL.md Step 2's
    // "Suggest complementary enhancements" bullet) cite this rule by name.
    // Renaming the rule's anchor phrase requires updating this assertion in
    // the same commit.
    const matches = agentsContent.match(
      /^- \*\*Treat every request as production-bound, not a hobby project\.\*\*/gm,
    );
    expect(
      matches?.length ?? 0,
      "AGENTS.md must contain the rule anchor phrase " +
        "'- **Treat every request as production-bound, not a hobby project.**' " +
        "exactly once at the start of a list item in `## Output style`. " +
        "Found " +
        (matches?.length ?? 0) +
        " match(es).",
    ).toBe(1);
  });

  it("AGENTS.md contains the ultimate-goal rule anchor phrase exactly once", () => {
    // The bolded anchor phrase **Understand the ultimate goal behind the
    // request, not just the literal ask.** is the stable lint hook for the rule
    // documented at AGENTS.md `## Output style`. It governs request *altitude*
    // (ladder up from the proposed solution to the goal it serves); the full
    // technique lives at
    // skills/pipeline/flow-product-planning/references/discovery-playbook.md (Ladder
    // Up), and the skill-side entry point — skills/pipeline/flow-pipeline/SKILL.md
    // step 1's goal-framing sub-step + discovery-instructions.md's caller-supplied
    // ultimate-goal prior — reuses it. Renaming the rule's anchor phrase requires
    // updating this assertion in the same commit.
    const matches = agentsContent.match(
      /^- \*\*Understand the ultimate goal behind the request, not just the literal ask\.\*\*/gm,
    );
    expect(
      matches?.length ?? 0,
      "AGENTS.md must contain the rule anchor phrase " +
        "'- **Understand the ultimate goal behind the request, not just the literal ask.**' " +
        "exactly once at the start of a list item in `## Output style`. " +
        "Found " +
        (matches?.length ?? 0) +
        " match(es).",
    ).toBe(1);
  });

  it("AGENTS.md contains the impact-first-language rule anchor phrase exactly once", () => {
    // The bolded anchor phrase **Explain problems impact-first in plain
    // language.** is the stable lint hook for the rule documented at
    // AGENTS.md `## Output style`. Its rationale lives at
    // references/output-style.md `## Explain problems impact-first in
    // plain language`, and its applied contract — the six language
    // rules plus five worked before/after pairs — lives at
    // skills/pipeline/flow-pipeline/references/pause-output-contract.md
    // `## Language contract`. Renaming the rule's anchor phrase requires
    // updating this assertion in the same commit.
    const matches = agentsContent.match(
      /^- \*\*Explain problems impact-first in plain language\.\*\*/gm,
    );
    expect(
      matches?.length ?? 0,
      "AGENTS.md must contain the rule anchor phrase " +
        "'- **Explain problems impact-first in plain language.**' " +
        "exactly once at the start of a list item in `## Output style`. " +
        "Found " +
        (matches?.length ?? 0) +
        " match(es).",
    ).toBe(1);
  });

  it("AGENTS.md contains the scannable-numbered-steps rule anchor phrase exactly once", () => {
    // The bolded anchor phrase **Emit instructions as scannable numbered
    // steps.** is the stable lint hook for the rule documented at
    // AGENTS.md `## Output style`. Its rationale lives at
    // references/output-style.md `## Emit instructions as scannable
    // numbered steps`, and its enforceable shape — the numbered-step
    // rule, the SCOPE reconciliation with the informal pause-block
    // `**Next action:**` slot, the `discrete action` definition, and the
    // three carve-outs — lives at
    // skills/pipeline/flow-pipeline/references/pause-output-contract.md
    // `## Step contract`. Renaming the rule's anchor phrase requires
    // updating this assertion in the same commit.
    const matches = agentsContent.match(
      /^- \*\*Emit instructions as scannable numbered steps\.\*\*/gm,
    );
    expect(
      matches?.length ?? 0,
      "AGENTS.md must contain the rule anchor phrase " +
        "'- **Emit instructions as scannable numbered steps.**' " +
        "exactly once at the start of a list item in `## Output style`. " +
        "Found " +
        (matches?.length ?? 0) +
        " match(es).",
    ).toBe(1);
  });

  it("AGENTS.md contains the product-lens impact-first rule anchor phrase exactly once", () => {
    // The bolded anchor phrase **Frame every explanation impact-first for
    // a product-lens reader.** is the stable lint hook for the rule
    // documented at AGENTS.md `## Output style`. Its rationale (worked
    // examples, exclusion list, per-stage focus table) lives at
    // references/output-style.md `## Frame every explanation
    // impact-first for a product-lens reader`, and the pause-point
    // widening sentence lives at
    // skills/pipeline/flow-pipeline/references/pause-output-contract.md.
    // Renaming the rule's anchor phrase requires updating this assertion
    // in the same commit.
    const matches = agentsContent.match(
      /^- \*\*Frame every explanation impact-first for a product-lens reader\.\*\*/gm,
    );
    expect(
      matches?.length ?? 0,
      "AGENTS.md must contain the rule anchor phrase " +
        "'- **Frame every explanation impact-first for a product-lens " +
        "reader.**' exactly once at the start of a list item in " +
        "`## Output style`. Found " +
        (matches?.length ?? 0) +
        " match(es).",
    ).toBe(1);
  });
});

describe("Prompt-interpretation contract anchors", () => {
  // discovery-instructions.md is the single source of truth for the four-value
  // Recommended-path enum that bin/flow-step3-route.ts exact-matches against.
  // bin/flow-step3-route.test.ts enumerates the four values, but nothing
  // catches a drop / rename in discovery-instructions.md itself — that's the
  // upstream silent-drift footgun this anchor block guards.
  it.each([
    "methods plausibly reach target",
    "extend scope with named additional safe steps",
    "relax target",
    "split into multiple pipelines",
  ])(
    "discovery-instructions.md contains the Recommended-path enum value '%s'",
    (enumValue) => {
      expect(
        discoveryInstructionsContent.includes(enumValue),
        `discovery-instructions.md must contain the verbatim Recommended-path enum ` +
          `value '${enumValue}'. This file is the single source of truth (see the ` +
          `"Single source of truth" paragraph in the same file); bin/flow-step3-route.ts ` +
          `exact-matches against the first string, and drift here silently routes ` +
          `pipeline runs the wrong way. Rename the value in lock-step across this ` +
          `file, bin/flow-step3-route.ts, and bin/flow-step3-route.test.ts.`,
      ).toBe(true);
    },
  );

  it("discovery-instructions.md contains the '### Prompt interpretation (conditional)' heading", () => {
    expect(
      discoveryInstructionsContent.includes(
        "### Prompt interpretation (conditional)",
      ),
      "discovery-instructions.md must contain the heading " +
        "'### Prompt interpretation (conditional)' verbatim. The PRD template " +
        "(skills/pipeline/flow-product-planning/templates/prd-template.md), pr-review's " +
        "Gatekeeper spawn prompt (skills/pipeline/flow-pr-review/references/gatekeeper-spawn-prompt.md), " +
        "and the AGENTS.md Output style rule all cite this heading by name. " +
        "Renaming requires a lock-step update across those four files.",
    ).toBe(true);
  });

  // agent-prompts.md's Pattern & Consistency Agent step 8 anchor is referenced
  // from skills/pipeline/flow-pr-review/SKILL.md step 5 (the {{PROMPT_INTERPRETATION_TENSION}}
  // template-variable substitution site). Dropping the step would leave the
  // template variable un-consumed, and the SKILL.md prose would still claim a
  // step exists that the linter can't find.
  it("agent-prompts.md Pattern & Consistency Process contains the 'Prompt-interpretation tension check' anchor", () => {
    expect(
      agentPromptsContent.includes(
        "Prompt-interpretation tension check (conditional)",
      ),
      "agent-prompts.md must contain the anchor literal " +
        "'Prompt-interpretation tension check (conditional)' inside the Pattern & " +
        "Consistency Agent's Process section (step 8). This is the consumer of " +
        "the {{PROMPT_INTERPRETATION_TENSION}} template variable substituted by " +
        "flow-pr-review/SKILL.md step 5 — dropping the step would leave the variable " +
        "un-consumed and the Gatekeeper-side tension signal silently dead.",
    ).toBe(true);
  });
});

describe("New planning-discipline contract anchors", () => {
  // PR #290 introduced three planning disciplines as verbatim prose, documented
  // bidirectionally across flow-new-feature/SKILL.md Step 2 (the Critical Analysis
  // self-critique closer) and product-planning discovery-instructions.md (the
  // "Draft the PRD" / "Plan risks" sub-sections). The parallel disciplines they
  // were modeled on ("Prompt interpretation" / "Coverage breadth") already have
  // anchor blocks above; without an equivalent here, a future edit could silently
  // drop the `## Plan risks` section, rename a phrase, or sever the cross-link
  // with nothing failing in CI. Issue #291 tracks closing this drift-surface gap.
  // `## Plan risks` is backtick-wrapped to pin the documented content-convention
  // code-span (present verbatim in both files) and not also match the `### Plan
  // risks` h3 instruction heading via bare substring — that would let a future
  // edit drop the prose reference while the lint stayed vacuously green.
  it.each(["externally-failable", "`## Plan risks`", "weakest assumption"])(
    "both planning skills carry the discipline phrase '%s'",
    (phrase) => {
      expect(
        newFeatureContent.includes(phrase),
        `flow-new-feature/SKILL.md Step 2 must contain the verbatim planning-discipline ` +
          `phrase '${phrase}'. PR #290 introduced it as prose cross-linked with ` +
          `product-planning discovery-instructions.md; dropping or renaming it here ` +
          `silently breaks the discipline with nothing failing in CI. Rename it in ` +
          `lock-step across both files and update this lint in the same commit ` +
          `(AGENTS.md anchored-phrase rule).`,
      ).toBe(true);
      expect(
        discoveryInstructionsContent.includes(phrase),
        `product-planning discovery-instructions.md must contain the verbatim ` +
          `planning-discipline phrase '${phrase}'. PR #290 introduced it as prose ` +
          `cross-linked with flow-new-feature/SKILL.md Step 2; dropping or renaming it ` +
          `here silently breaks the discipline with nothing failing in CI. Rename ` +
          `it in lock-step across both files and update this lint in the same ` +
          `commit (AGENTS.md anchored-phrase rule).`,
      ).toBe(true);
    },
  );

  it("both planning skills carry the redundancy anchor phrase", () => {
    // Pins the redundancy obligation added to the Critical Analysis table
    // (flow-new-feature/SKILL.md, a `| Redundancy` row) and to the
    // "Necessity & redundancy" category (discovery-instructions.md). Unlike
    // the symmetric it.each above, these anchors are file-specific: the
    // table-row form only makes sense in flow-new-feature/SKILL.md, and the
    // category-label form only makes sense in discovery-instructions.md.
    expect(
      discoveryInstructionsContent.includes("Necessity & redundancy"),
      "product-planning discovery-instructions.md must contain the verbatim " +
        "category label 'Necessity & redundancy' — the redundancy obligation " +
        "(check duplication against an existing capability, route a found " +
        "duplication into '## Recommendation') is single-sourced here. Dropping " +
        "or renaming it here silently breaks the discipline with nothing " +
        "failing in CI. Rename it in lock-step with the cross-link in " +
        "flow-new-feature/SKILL.md and update this lint in the same commit " +
        "(AGENTS.md anchored-phrase rule).",
    ).toBe(true);
    expect(
      newFeatureContent.includes("| Redundancy"),
      "flow-new-feature/SKILL.md Step 2's Critical Analysis assessment table " +
        "must contain a '| Redundancy' row — the per-feature counterpart to " +
        "discovery-instructions.md's 'Necessity & redundancy' category. " +
        "Dropping this row silently breaks the discipline with nothing " +
        "failing in CI. Restore it or update this lint in the same commit " +
        "(AGENTS.md anchored-phrase rule).",
    ).toBe(true);
  });

  it("flow-new-feature/SKILL.md Step 2 and discovery-instructions.md cross-link bidirectionally", () => {
    expect(
      newFeatureContent.includes(
        "skills/pipeline/flow-product-planning/references/discovery-instructions.md",
      ),
      "flow-new-feature/SKILL.md Step 2 must reference " +
        "skills/pipeline/flow-product-planning/references/discovery-instructions.md — the " +
        "self-critique disciplines (externally-failable / weakest assumption) defer to " +
        "the discovery-side source by path. Severing this direction of the cross-link " +
        "orphans the discipline; restore the reference or update this lint in the same " +
        "commit (AGENTS.md anchored-phrase rule).",
    ).toBe(true);
    expect(
      discoveryInstructionsContent.includes("flow-new-feature/SKILL.md"),
      "product-planning discovery-instructions.md must reference flow-new-feature/SKILL.md — " +
        "the `## Plan risks` discipline names flow-new-feature/SKILL.md Step 2 as the " +
        "counterpart self-critique site. Severing this direction of the cross-link " +
        "orphans the discipline; restore the reference or update this lint in the same " +
        "commit (AGENTS.md anchored-phrase rule).",
    ).toBe(true);
  });

  it("discovery-playbook.md names the framing-lens subsection", () => {
    // The "Framing lenses (bounded internal heuristics)" subsection encodes the
    // six named framing methodologies (Five Whys, JTBD, first-principles,
    // inversion, pre-mortem, second-order effects) as bounded internal heuristics
    // that extend PR #376's Ladder Up. discovery-instructions.md §3/§4, the
    // flow-pipeline step-1 goal-framing sub-step, and the AGENTS.md ultimate-goal
    // rule all point at it; a silent deletion would orphan those references with
    // nothing failing in CI. One content anchor on the subsection heading (not a
    // per-lens regex battery, per the plan's chosen lint granularity); restore the
    // subsection or update this lint in the same commit (AGENTS.md anchored-phrase
    // rule).
    expect(
      discoveryPlaybookContent.includes(
        "## Framing lenses (bounded internal heuristics)",
      ),
      "discovery-playbook.md must contain the '## Framing lenses (bounded internal " +
        "heuristics)' subsection — the home for the six named framing methodologies " +
        "referenced by discovery-instructions.md, flow-pipeline/SKILL.md step 1, and " +
        "the AGENTS.md ultimate-goal rule. Dropping or renaming the heading silently " +
        "orphans those pointers; restore it or update this lint in the same commit.",
    ).toBe(true);
    const framingLensNames = [
      "**Five Whys**",
      "**Jobs-to-be-Done (JTBD)**",
      "**First-principles**",
      "**Inversion**",
      "**Pre-mortem**",
      "**Second-order effects**",
    ];
    expect(
      framingLensNames.every((name) => discoveryPlaybookContent.includes(name)),
      "discovery-playbook.md must name all six bolded framing lenses — the heading " +
        "anchor alone lets a partial within-section deletion (e.g. dropping 3 of 6 " +
        "lens bullets while keeping the heading) pass CI, yet the cross-doc pointers " +
        "in discovery-instructions.md, flow-pipeline/SKILL.md, and the AGENTS.md " +
        "ultimate-goal rule reference individual lenses by name. One combined " +
        "assertion (not a per-lens regex battery, per the plan's chosen single-anchor " +
        "granularity); restore the lens or update this lint in the same commit.",
    ).toBe(true);
  });
});

describe("Surgical task-contract anchors (discovery-instructions.md ↔ prd-template.md ↔ example-prd.md)", () => {
  // The per-task Contract block (Files / Interfaces / Call-site edits +
  // runnable Acceptance criteria) is what lets a cheaper implementer execute
  // to the planner's interface decisions instead of re-deriving them.
  // discovery-instructions.md step 6 is the single source of truth; the
  // prd-template sketch and example-prd.md's worked example both mirror the
  // field names. example-prd.md is the file discovery runs imitate, so a
  // one-sided rename there is arguably a stronger silent-drift risk than in
  // the template. A rename in any one file but not the others silently
  // breaks the downstream consumers (/flow-new-feature Step 2's contract read,
  // /flow-coder's contract pre-check) that grep these labels.
  const CONTRACT_FIELDS = [
    "- **Contract:**",
    "**Files:**",
    "**Interfaces:**",
    "**Call-site edits:**",
    "- **Acceptance criteria:**",
  ];
  const CONTRACT_FIELD_SITES: Array<[string, string]> = [
    ["discovery-instructions.md", discoveryInstructionsContent],
    ["prd-template.md", prdTemplateContent],
    ["example-prd.md", examplePrdContent],
  ];

  it.each(CONTRACT_FIELDS)(
    "discovery-instructions.md, prd-template.md, and example-prd.md all carry the Contract-block field '%s'",
    (field) => {
      for (const [label, docContent] of CONTRACT_FIELD_SITES) {
        expect(
          docContent.includes(field),
          `${label} must carry the Contract-block field '${field}' verbatim — ` +
            `discovery-instructions.md step 6 is the single source of truth for the ` +
            `surgical task format; prd-template.md and example-prd.md mirror it. ` +
            `Rename in lock-step across all three plus this lint in the same commit.`,
        ).toBe(true);
      }
    },
  );

  it("discovery-instructions.md carries the strong-prior guardrail, change-type table, and dependency-table mandate", () => {
    expect(
      /strong prior/i.test(discoveryInstructionsContent),
      "discovery-instructions.md step 6 must state the 'strong prior, not a straitjacket' " +
        "guardrail — the deviation-handling contract the scout and coder both anchor on.",
    ).toBe(true);
    expect(
      discoveryInstructionsContent.includes("| Change type"),
      "discovery-instructions.md step 6 must carry the per-change-type surgical-form " +
        "table header row (`| Change type`) — not just the prose word 'change-type', " +
        "which survives the table itself being deleted — so non-code tasks get an " +
        "equally exact Contract slot.",
    ).toBe(true);
    expect(
      discoveryInstructionsContent.includes("| Task | Depends on |"),
      "discovery-instructions.md step 6 must mandate the `| Task | Depends on |` " +
        "dependency table whenever ≥2 tasks have dependencies.",
    ).toBe(true);
  });

  it("prd-template.md points at discovery-instructions.md for the change-type table instead of inlining it", () => {
    expect(
      prdTemplateContent.includes("references/discovery-instructions.md"),
      "prd-template.md must reference discovery-instructions.md as the single source " +
        "of truth for the change-type surgical-form table — inlining the table in the " +
        "template is the duplication-drift failure mode the thin-sketch discipline exists " +
        "to prevent.",
    ).toBe(true);
  });
});

describe("Plan-artifact section anchors (discovery-instructions.md ↔ prd-template.md ↔ example-prd.md)", () => {
  // The Goal line / Behavioral contrast / Lost affirmation / Alternatives
  // considered contract is the at-a-glance + delta-grounding surface this PR
  // adds to plan.md. discovery-instructions.md is the SSOT; prd-template.md
  // and example-prd.md mirror it. A one-sided drop silently reverts the
  // artifact to its pre-PR shape with nothing failing in CI.
  const MIRRORED_PHRASES = [
    "**Goal:**",
    "## Behavioral contrast",
    "**Lost:**",
    "## Alternatives considered",
    "## Cut list",
  ];
  const MIRROR_SITES: Array<[string, string]> = [
    ["discovery-instructions.md", discoveryInstructionsContent],
    ["prd-template.md", prdTemplateContent],
    ["example-prd.md", examplePrdContent],
  ];

  it.each(MIRRORED_PHRASES)(
    "discovery-instructions.md, prd-template.md, and example-prd.md all carry the plan-artifact anchor '%s'",
    (phrase) => {
      for (const [label, docContent] of MIRROR_SITES) {
        expect(
          docContent.includes(phrase),
          `${label} must carry the plan-artifact anchor '${phrase}' verbatim — ` +
            `discovery-instructions.md is the single source of truth; prd-template.md ` +
            `and example-prd.md mirror it. Rename in lock-step across all three plus ` +
            `this lint in the same commit.`,
        ).toBe(true);
      }
    },
  );

  it("discovery-instructions.md carries the '## Epic context' anchor", () => {
    expect(
      discoveryInstructionsContent.includes("## Epic context"),
      "discovery-instructions.md must carry the '## Epic context' section contract — " +
        "the omit-when-empty section populated by the step 1.7 epic-membership detection.",
    ).toBe(true);
  });

  // Not mirrored into prd-template.md/example-prd.md (it's an authoring
  // instruction for the reviewer battery, not a plan-artifact section
  // anchor), so it belongs here rather than in MIRRORED_PHRASES above. Was a
  // one-shot PR-body Test Steps grep; moved here per Durable-test precedence.
  it("discovery-instructions.md's cross-model review contract requires interruptions-per-run", () => {
    expect(
      discoveryInstructionsContent.includes("interruptions-per-run"),
      "discovery-instructions.md must require every user-flow walkthrough to state " +
        "interruptions-per-run as a number — the adversarial battery's lens 3 contract " +
        "in bin/lib/plan-review-prompt.ts.",
    ).toBe(true);
  });

  it("epic-discovery-instructions.md carries the pointer-sentence authoring rule", () => {
    expect(
      epicDiscoveryInstructionsContent.includes("Part of epic"),
      "epic-discovery-instructions.md must carry the 'Part of epic' pointer-sentence " +
        "authoring rule — every feature description must end with a pointer to its " +
        "epic's design.md so discovery can detect membership without the EPIC: marker.",
    ).toBe(true);
  });

  it("prd-template.md no longer carries the superseded '## User-Facing Changes' heading", () => {
    expect(
      /^## User-Facing Changes/m.test(prdTemplateContent),
      "prd-template.md must NOT carry '## User-Facing Changes' — it is subsumed by " +
        "'### User flow' under the new '## Behavioral contrast' section. A reappearance " +
        "here is template/instructions drift reverting to the pre-PR shape.",
    ).toBe(false);
  });

  it.each(["Premise check", "source-traceable", "structured markdown"])(
    "discovery-instructions.md carries the revision-2 audit anchor '%s'",
    (phrase) => {
      expect(
        discoveryInstructionsContent
          .toLowerCase()
          .includes(phrase.toLowerCase()),
        `discovery-instructions.md must carry the audit anchor '${phrase}' — the ` +
          `premise-check discipline, the re-contracted Technical Constraints, and the ` +
          `structured-markdown authoring-style paragraph are all load-bearing contract ` +
          `additions; a drop here silently reverts the audit with nothing failing in CI.`,
      ).toBe(true);
    },
  );
});

describe("Machine-readable closed-path anchors (excluded-paths.json injection)", () => {
  it("discovery-instructions.md documents the excluded-paths.json sibling mirror", () => {
    expect(
      discoveryInstructionsContent.includes("excluded-paths.json"),
      "discovery-instructions.md must document the sibling .flow-tmp/excluded-paths.json " +
        "mirror of '## Alternatives considered' — the machine-readable transport the " +
        "scout/coder spawn templates inject programmatically.",
    ).toBe(true);
  });

  it.each([
    ["flow-new-feature/SKILL.md", () => newFeatureContent],
    ["flow-coder/SKILL.md", () => coderContent],
  ] as const)(
    "%s carries the EXCLUDED_PATHS spawn-template anchor",
    (label, getContent) => {
      expect(
        getContent().includes("EXCLUDED_PATHS"),
        `${label} must carry the EXCLUDED_PATHS placeholder — the omit-when-absent ` +
          `spawn-template block that injects closed paths into the scout/coder prompts.`,
      ).toBe(true);
    },
  );
});

describe("Optional edit-set field symmetry (flow-coder/SKILL.md ↔ coder-instructions.md ↔ flow-new-feature/SKILL.md)", () => {
  // The optional `contract` / `acceptance` edit-set fields extend the required
  // {file, intent, expected_outcome} triple. Three docs carry the field names:
  // flow-coder/SKILL.md (the wrapper contract), coder-instructions.md (the subagent
  // procedure), and flow-new-feature/SKILL.md Step 5 (the composing caller). A
  // one-sided rename silently severs the plan-contract channel — the caller
  // composes a field the subagent no longer honors, or vice versa. Mirrors the
  // five-key artifact symmetry lint above.
  const OPTIONAL_FIELDS = ["`contract`", "`acceptance`"];
  const SITES: Array<[string, string]> = [
    ["flow-coder/SKILL.md", coderContent],
    ["flow-coder/references/coder-instructions.md", coderInstructionsContent],
    ["flow-new-feature/SKILL.md", newFeatureContent],
  ];

  it.each(OPTIONAL_FIELDS)(
    "all three edit-set docs name the optional edit-set field %s",
    (field) => {
      for (const [label, docContent] of SITES) {
        expect(
          docContent.includes(field),
          `${label} must name the optional edit-set field ${field}. The field is ` +
            `documented in lock-step across flow-coder/SKILL.md, coder-instructions.md, and ` +
            `flow-new-feature/SKILL.md Step 5; a one-sided drop silently severs the ` +
            `plan-contract channel between the composing caller and the edit-applier.`,
        ).toBe(true);
      }
    },
  );

  it("coder-instructions.md states the strong-prior mechanical pre-check", () => {
    expect(
      /strong prior/i.test(coderInstructionsContent),
      "coder-instructions.md must state that the `contract` field is a strong prior, " +
        "not a straitjacket — the deviation-handling half of the contract channel.",
    ).toBe(true);
    expect(
      coderInstructionsContent.includes("MECHANICAL PRE-CHECK"),
      "coder-instructions.md must state the contract check as a MECHANICAL PRE-CHECK " +
        "(files/symbols/signatures vs actual code), not a judgment call — the wording " +
        "that keeps cheaper coder models from fixating on stale literal signatures.",
    ).toBe(true);
  });
});

describe("Scout plan-verification anchors (PLAN wiring + PLAN-DEVIATION channel)", () => {
  // The plan reaches the implementer through three prose hops: /flow-pipeline
  // Step 5 appends the PLAN: line, /flow-new-feature Step 1b forwards it into the
  // scout spawn as {{PLAN_PATH}}, and scout-instructions.md's
  // verify-not-rederive mode reports contradictions as PLAN-DEVIATION: bullets
  // inside the UNCHANGED six-section artifact. Any hop silently dropped means
  // plans are authored surgically but never consumed.
  it("scout-instructions.md carries the PLAN-DEVIATION: prefix", () => {
    expect(
      scoutInstructionsContent.includes("PLAN-DEVIATION:"),
      "scout-instructions.md must instruct the scout to record contract " +
        "contradictions as 'PLAN-DEVIATION:'-prefixed bullets in ## open_questions — " +
        "the drift-visibility channel /flow-new-feature Step 2 reconciles.",
    ).toBe(true);
  });

  it("flow-new-feature/SKILL.md and scout-instructions.md agree on the `absent` PLAN_PATH sentinel", () => {
    for (const [label, docContent] of [
      ["flow-new-feature/SKILL.md", newFeatureContent],
      ["scout-instructions.md", scoutInstructionsContent],
    ] as Array<[string, string]>) {
      expect(
        /the literal string\s+`absent`/.test(docContent),
        `${label} must define the PLAN_PATH no-plan sentinel as 'the literal string ` +
          "`absent`' verbatim — a one-sided rename (e.g. to `none`) leaves the scout " +
          "treating the new literal as a real path, silently breaking or misfiring " +
          "verify-not-rederive mode. Rename in lock-step across both docs and this lint.",
      ).toBe(true);
    }
  });

  it("discovery-instructions.md's plan.md persist format pins the `# Task breakdown` heading byte-exactly", () => {
    expect(
      discoveryInstructionsContent.includes("# Task breakdown"),
      "discovery-instructions.md step 8's plan.md persist skeleton must emit the " +
        "literal heading `# Task breakdown` — this is the PRODUCER side every " +
        "downstream consumer (/flow-new-feature Step 1b, scout-instructions.md, " +
        "flow-pipeline/SKILL.md, flow-coder/SKILL.md) gates on. Consumers match this " +
        "heading tolerantly (any level, case-insensitive), but the producer must " +
        "still emit this exact string so the tolerant match has something to find.",
    ).toBe(true);
    for (const [label, docContent] of [
      ["flow-new-feature/SKILL.md", newFeatureContent],
      ["scout-instructions.md", scoutInstructionsContent],
      ["flow-pipeline/SKILL.md", content],
      ["flow-coder/SKILL.md", coderContent],
    ] as Array<[string, string]>) {
      expect(
        /task\s+breakdown/i.test(docContent),
        `${label} must reference the plan's Task breakdown section — the tolerant ` +
          "(case-insensitive, any heading level) match consistent with the gating " +
          "wording in flow-new-feature/SKILL.md Step 1b and scout-instructions.md.",
      ).toBe(true);
    }
  });

  it("scout-instructions.md six-section artifact list is unchanged (no seventh section)", () => {
    const SECTIONS = [
      "## affected_modules",
      "## relevant_tests",
      "## public_api_surface",
      "## open_questions",
      "## recommended_strategy",
      "## anti_patterns",
    ];
    for (const section of SECTIONS) {
      expect(
        scoutInstructionsContent.includes(section),
        `scout-instructions.md must keep the artifact section '${section}' — the ` +
          `consumer reads the six sections positionally, and the plan-verification ` +
          `mode explicitly reuses ## open_questions rather than adding a section.`,
      ).toBe(true);
    }
    expect(
      scoutInstructionsContent.includes("## plan_deviations"),
      "scout-instructions.md must NOT add a seventh '## plan_deviations' section — " +
        "PLAN-DEVIATION: bullets live inside the existing ## open_questions so the " +
        "positionally-read six-section contract stays intact.",
    ).toBe(false);
  });

  it("flow-new-feature/SKILL.md passes {{PLAN_PATH}} into the scout spawn and reconciles PLAN-DEVIATION findings", () => {
    expect(
      newFeatureContent.includes("{{PLAN_PATH}}"),
      "flow-new-feature/SKILL.md's scout spawn template must carry the {{PLAN_PATH}} " +
        "placeholder — without it the plan path never reaches the scout and " +
        "verify-not-rederive mode is dead prose.",
    ).toBe(true);
    expect(
      newFeatureContent.includes("PLAN-DEVIATION"),
      "flow-new-feature/SKILL.md Step 2 must reconcile the scout's PLAN-DEVIATION: " +
        "findings as contract adjustments — dropping the reconciliation leaves " +
        "deviations unread and stale contracts flowing into the Step 5 edit-set.",
    ).toBe(true);
  });

  it("flow-pipeline/SKILL.md Step 5 carries the PLAN: line on the first-entry invocation", () => {
    expect(
      content.includes("PLAN: $WORKTREE/.flow-tmp/plan.md"),
      "flow-pipeline/SKILL.md Step 5 must append 'PLAN: $WORKTREE/.flow-tmp/plan.md' " +
        "to the first-entry /flow-new-feature invocation — the wiring hop that hands the " +
        "approved plan's task contracts to the implementer.",
    ).toBe(true);
  });
});

describe("Epic planning-discipline parity anchors (epic-discovery-instructions.md ↔ feature discovery)", () => {
  // This PR ports the feature-grain critique/framing layer one altitude up into
  // the epic-grain discovery contract: an always-present `## Recommendation`
  // verdict + `## Plan risks` decomposition pre-mortem, an omit-when-empty
  // `## Decision analysis`, the `Reject — do nothing` first-class verdict, the
  // discovery-playbook.md framing-lens load, and a cross-link back to the
  // feature `discovery-instructions.md`. Without an anchor here a future edit
  // could silently drop any of them — reverting to the pre-port "six-section"
  // shape — with nothing failing in CI. Rename any pinned phrase in lock-step
  // with this lint in the same commit (AGENTS.md anchored-phrase rule).
  it.each([
    "## Recommendation",
    "## Plan risks",
    "## Decision analysis",
    "Reject — do nothing",
    "discovery-playbook.md",
    "**Goal:**",
    "before → after behavioral contrast",
    "**Lost:**",
    "Necessity & redundancy",
  ])(
    "epic-discovery-instructions.md carries the ported critique/framing anchor '%s'",
    (phrase) => {
      expect(
        epicDiscoveryInstructionsContent.includes(phrase),
        `skills/pipeline/flow-product-planning/references/epic-discovery-instructions.md ` +
          `must contain the verbatim critique/framing anchor '${phrase}'. This PR ports ` +
          `the feature-grain critique layer to epic grain; dropping or renaming it here ` +
          `silently breaks the epic↔feature planning-discipline parity with nothing ` +
          `failing in CI. Restore it or update this anchor in the same commit ` +
          `(AGENTS.md anchored-phrase rule).`,
      ).toBe(true);
    },
  );

  it("epic-discovery-instructions.md cross-links the feature discovery-instructions.md", () => {
    expect(
      /(?<!epic-)discovery-instructions\.md/.test(
        epicDiscoveryInstructionsContent,
      ),
      "epic-discovery-instructions.md must reference discovery-instructions.md — the " +
        "epic `## Plan risks` / `## Recommendation` critique sections byte-mirror the " +
        "feature file's counterparts and cross-link to it as the port source. Severing " +
        "the cross-link orphans the ported discipline; restore the reference or update " +
        "this lint in the same commit (AGENTS.md anchored-phrase rule).",
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
  ])(
    "pr-review SKILL.md documents the result-artifact literal '%s'",
    (literal) => {
      expect(
        prReviewContent.includes(literal),
        `pr-review SKILL.md must include the literal '${literal}' so the ` +
          `result-artifact contract is grep-discoverable. The /flow-pipeline ` +
          `step 8 reader branches on these exact strings; drift here means ` +
          `the supervisor's parser falls through to the escalation path.`,
      ).toBe(true);
    },
  );

  it.each(['"clean"', '"partial"', '"escalated"', "--resume-from"])(
    "flow-pipeline SKILL.md Step 8 documents the result-artifact literal '%s'",
    (literal) => {
      expect(
        content.includes(literal),
        `flow-pipeline SKILL.md Step 8 must include the literal '${literal}' ` +
          `so the supervisor's branch-on-status logic stays anchored on the ` +
          `same string the /flow-pr-review wrapper writes. A drift means the ` +
          `partial-retry path silently falls through to the escalation arm.`,
      ).toBe(true);
    },
  );

  const PR_REVIEW_REQUIRED_KEYS = [
    "status",
    "completed_steps",
    "missed_steps",
    "escalation_tag",
    "summary",
  ];

  it.each(PR_REVIEW_REQUIRED_KEYS)(
    "flow-pr-review/SKILL.md declares the '%s' top-level key for the result artifact",
    (key) => {
      expect(
        prReviewContent.includes(`\`${key}\``),
        `flow-pr-review/SKILL.md must reference '\`${key}\`' as one of the ` +
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

describe("Task-tool ToolSearch-load preamble at all nine top-level spawn sites plus the nested verify-loop site", () => {
  const SITES: ReadonlyArray<{ file: string; exemption_name: string }> = [
    {
      file: "skills/pipeline/flow-pr-review/SKILL.md",
      exemption_name: "pr-review-multi-agent-review",
    },
    {
      file: "skills/pipeline/flow-pr-review/SKILL.md",
      exemption_name: "pr-review-fix-applier",
    },
    {
      file: "skills/pipeline/flow-pr-review/SKILL.md",
      exemption_name: "pr-review-gatekeeper",
    },
    {
      file: "skills/pipeline/flow-pr-review/SKILL.md",
      exemption_name: "pr-review-consolidator-validator",
    },
    {
      file: "skills/pipeline/flow-product-planning/SKILL.md",
      exemption_name: "product-planning-discovery",
    },
    {
      file: "skills/pipeline/flow-new-feature/SKILL.md",
      exemption_name: "new-feature-scout",
    },
    {
      file: "skills/pipeline/flow-coder/SKILL.md",
      exemption_name: "coder-edit-applier",
    },
    {
      file: "skills/pipeline/flow-pipeline/SKILL.md",
      exemption_name: "flow-pipeline-merge-resolver",
    },
    {
      file: "skills/pipeline/flow-pipeline/SKILL.md",
      exemption_name: "flow-pipeline-verify-loop",
    },
  ];

  const NESTED_SITE_NAME = "verify-loop-edit-applier";
  const NESTED_SITE_FILE =
    "skills/pipeline/flow-pipeline/references/verify-loop-instructions.md";
  const TOP_LEVEL_SITES = SITES.filter(
    (s) => s.exemption_name !== NESTED_SITE_NAME,
  );

  it.each(TOP_LEVEL_SITES)(
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

  it("the nested verify-loop → edit-applier site loads Task then records-and-degrades instead of escalating", () => {
    const absPath = path.resolve(HERE, "..", ...NESTED_SITE_FILE.split("/"));
    const fileContent = fs.readFileSync(absPath, "utf8");
    expect(
      fileContent.includes("Load the Task tool before spawning"),
      `${NESTED_SITE_FILE} must include the literal 'Load the Task tool before spawning' ` +
        `anchor for '${NESTED_SITE_NAME}', same as the nine top-level sites.`,
    ).toBe(true);
    expect(
      fileContent.includes('coder_spawn: "task-tool-unavailable"'),
      `${NESTED_SITE_FILE} must record coder_spawn: "task-tool-unavailable" on a missing ` +
        `Task schema at the '${NESTED_SITE_NAME}' site.`,
    ).toBe(true);
    expect(
      /do not escalate/i.test(fileContent),
      `${NESTED_SITE_FILE} must state its failure action is inverted from the nine ` +
        `top-level sites: do not escalate on a missing Task schema.`,
    ).toBe(true);
    expect(
      fileContent.includes(
        `NEEDS HUMAN: task-tool-unavailable: ${NESTED_SITE_NAME}`,
      ),
      `${NESTED_SITE_FILE} must NOT escalate 'NEEDS HUMAN: task-tool-unavailable: ` +
        `${NESTED_SITE_NAME}' — inline application is this site's known-good fallback, ` +
        `unlike the nine top-level exemptions that have none.`,
    ).toBe(false);
  });

  // Sites refactored to include-by-reference: the alias-tolerance literals
  // live in skills/pipeline/flow-pr-review/references/task-tool-exemption-preamble.md
  // rather than at the spawn site. For these sites, fall back to the reference
  // file when the literals are not present in SKILL.md directly. The other
  // three sites continue to carry the literals at the spawn site as before.
  const REFACTORED_SITES = new Set([
    "pr-review-multi-agent-review",
    "pr-review-fix-applier",
    "pr-review-consolidator-validator",
    "flow-pipeline-merge-resolver",
    "flow-pipeline-verify-loop",
  ]);
  const PREAMBLE_REF_PATH = path.resolve(
    HERE,
    "..",
    "skills",
    "pipeline",
    "flow-pr-review",
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
        hasTaskInSkill ||
        (isRefactored && refContent.includes('"name": "Task"'));
      const hasAgent =
        hasAgentInSkill ||
        (isRefactored && refContent.includes('"name": "Agent"'));

      expect(
        hasTask,
        `${file} (or its include-by-reference preamble at ` +
          `skills/pipeline/flow-pr-review/references/task-tool-exemption-preamble.md ` +
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
          `skills/pipeline/flow-pr-review/references/task-tool-exemption-preamble.md ` +
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

describe("Agent spawn sites resolve plugin-qualified subagent_type on the plugin-root branch", () => {
  // Measured ground truth (live Claude Code session, `--plugin-dir
  // ~/.flow/claude-home/.claude/skills/flow-module-core`): passing the
  // BARE string "flow-scout" as Task-tool subagent_type FAILS with
  // `Agent type 'flow-scout' not found. Available agents: ...,
  // flow-module-core:flow-scout, ...`. Plugin-hosted agents are therefore
  // addressable ONLY by the plugin-qualified `<pluginRootName>:<agent>`
  // name. Every agent-resolution block that guards on the plugin-root
  // definition path (`~/.flow/claude-home/.claude/skills/flow-module-core/agents/<agent>.md`)
  // must resolve the subagent type it assigns on that branch to a
  // `flow-module-core:`-qualified value — never the bare agent name. This
  // test pins that invariant so a future refactor cannot silently revert
  // it back to the pre-fix, hard-spawn-failure shape.
  const SITES: ReadonlyArray<{ file: string; agent: string }> = [
    { file: "skills/pipeline/flow-pipeline/SKILL.md", agent: "flow-verify" },
    {
      file: "skills/pipeline/flow-pipeline/SKILL.md",
      agent: "flow-merge-resolver",
    },
    {
      file: "skills/pipeline/flow-pipeline/references/verify-loop-instructions.md",
      agent: "flow-edit-applier",
    },
    { file: "skills/pipeline/flow-new-feature/SKILL.md", agent: "flow-scout" },
    {
      file: "skills/pipeline/flow-product-planning/SKILL.md",
      agent: "flow-discovery",
    },
    {
      file: "skills/pipeline/flow-pr-review/SKILL.md",
      agent: "flow-gatekeeper",
    },
    {
      file: "skills/pipeline/flow-pr-review/SKILL.md",
      agent: "flow-fix-applier",
    },
    {
      file: "skills/pipeline/flow-pr-review/SKILL.md",
      agent: "flow-consolidator",
    },
    { file: "skills/pipeline/flow-coder/SKILL.md", agent: "flow-edit-applier" },
    {
      file: "skills/universal/flow-backlog-triage/references/verification-fanout.md",
      agent: "flow-backlog-verifier",
    },
    {
      file: "skills/pipeline/flow-pr-review/references/intent-mismatch-resolution.md",
      agent: "flow-review-intent-guess",
    },
  ];

  it.each(SITES)(
    "$file resolves $agent to flow-module-core:$agent on the plugin-root branch, never the bare name",
    ({ file, agent }) => {
      const absPath = path.resolve(HERE, "..", ...file.split("/"));
      const fileContent = fs.readFileSync(absPath, "utf8");
      const qualified = `flow-module-core:${agent}`;
      expect(
        fileContent.includes(qualified),
        `${file} must resolve ${agent}'s subagent_type to the plugin-qualified ` +
          `'${qualified}' when ~/.flow/claude-home/.claude/skills/flow-module-core/agents/${agent}.md ` +
          `exists — a bare '${agent}' subagent_type fails Task-tool resolution outright ` +
          `(measured: "Agent type 'flow-scout' not found. Available agents: ...").`,
      ).toBe(true);
    },
  );

  it("the per-lens review agent resolution qualifies the computed $LENS_AGENT with flow-module-core:", () => {
    const absPath = path.resolve(
      HERE,
      "..",
      "skills",
      "pipeline",
      "flow-pr-review",
      "SKILL.md",
    );
    const fileContent = fs.readFileSync(absPath, "utf8");
    expect(
      fileContent.includes('LENS_AGENT="flow-module-core:flow-review-$LENS"'),
      "flow-pr-review/SKILL.md's per-lens resolution loop must qualify the computed " +
        "LENS_AGENT with flow-module-core: on the plugin-root branch, not just a " +
        "hardcoded literal per lens — a bare 'flow-review-<lens>' subagent_type fails " +
        "Task-tool resolution outright.",
    ).toBe(true);
  });
});

describe("pr-review include-by-reference structure", () => {
  const PR_REVIEW_REFS_DIR = path.resolve(
    HERE,
    "..",
    "skills",
    "pipeline",
    "flow-pr-review",
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
      `skills/pipeline/flow-pr-review/references/task-tool-exemption-preamble.md ` +
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
      `skills/pipeline/flow-pr-review/references/escalation-recipes.md must exist.`,
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

  it("skills/pipeline/flow-pr-review/SKILL.md links to both reference files", () => {
    const prReviewSkillPath = path.resolve(
      HERE,
      "..",
      "skills",
      "pipeline",
      "flow-pr-review",
      "SKILL.md",
    );
    const content = fs.readFileSync(prReviewSkillPath, "utf8");
    const preambleLinks = (
      content.match(/references\/task-tool-exemption-preamble\.md/g) ?? []
    ).length;
    expect(
      preambleLinks,
      `flow-pr-review/SKILL.md must link to references/task-tool-exemption-preamble.md ` +
        `at least three times (once per spawn site: Fix-Applier, Multi-Agent ` +
        `Review, and Consolidator-Validator).`,
    ).toBeGreaterThanOrEqual(3);
    const recipesLinks = (
      content.match(/references\/escalation-recipes\.md/g) ?? []
    ).length;
    expect(
      recipesLinks,
      `flow-pr-review/SKILL.md must link to references/escalation-recipes.md at least ` +
        `five times (once per escalation path: multi-agent-review, fix-applier, ` +
        `missing-artifact, consolidator-schema-failure, consolidator-missing-artifact). ` +
        `consolidator-validator's spawn-preamble references the recipe via the ` +
        `task-tool-exemption-preamble link, so its link count is not counted here.`,
    ).toBeGreaterThanOrEqual(5);
  });

  it("skills/pipeline/flow-pr-review/SKILL.md line count stays under the post-refactor budget", () => {
    const prReviewSkillPath = path.resolve(
      HERE,
      "..",
      "skills",
      "pipeline",
      "flow-pr-review",
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
    // a regrowth of previously-trimmed prose. The intent-annotation PR
    // adds ~10 lines for the {{EXISTING_INTENT_COMMENTS}} substitution
    // block, well under this ceiling.
    //
    // Bumped 1875 → 1880 to absorb the SUBJECTIVE-marker contract on top
    // of #327's three-tier-pyramid bump (1850 → 1875, absorbing 018bedc's
    // growth to 1862): Step 8c's Not-runnable bullet gains the
    // `SUBJECTIVE: `-prefix never-runnable signal, 8c.ii / 8c.iii each
    // gain a one-clause exclusion, and Step 11b's Testability prose folds
    // in the missing-SUBJECTIVE-step finding. The new ceiling reflects the
    // new contract's scope, not a regrowth of previously-trimmed prose.
    //
    // Bumped 1880 → 1945 to absorb two independent additions that landed
    // concurrently: (a) the F5 cross-model (Gemini) lens (issue #339) — Step 3
    // gains a "Cross-model (Gemini) lens" sub-step (the gate recipe, the
    // `flow-gemini-lens` call, and the `{ran}` branch) and Step 3.5's
    // consolidator input list gains the optional seventh tolerated-absent
    // `agent-output-gemini.json` path (the lens is a Bash fan-out, not a Task,
    // so it adds no exemption block); and (b) the Step 11b Testability nudge
    // flagging import-presence-grep-only Test Steps on wiring changes as
    // Testability: Fail (shallow). Both are new-contract prose, not regrowth.
    //
    // Bumped 1945 → 1965 to absorb the per-phase model-routing wiring
    // (feature: per-phase Claude model selection): three spawn sites gain a
    // one-paragraph `model:` resolution note (Multi-Agent Review → review,
    // Fix-Applier → fixApplier, Consolidator-Validator → consolidator) and the
    // Gatekeeper gains a "pinned to haiku, no flag, config.models.gatekeeper
    // discouraged" note. Each is a `model:` override on an EXISTING named
    // fan-out — no new exemption, no new spawn site. New-contract prose, not
    // regrowth of previously-trimmed prose.
    //
    // Bumped 1965 → 1985 to absorb the design-fidelity per-assertion walk
    // pointer (feature: design-artifact fidelity): 8c.iii gains one terse
    // paragraph naming the walk and deferring the full body to
    // references/ui-validation-evidence.md ("Design-fidelity per-assertion
    // walk"), restating it runs inside the already-exempt Fix-Applier surface
    // (no new Task-tool exemption, no new spawn site). New-contract prose,
    // not regrowth of previously-trimmed prose.
    //
    // Bumped 1985 → 2025 to absorb the p4-review-agents named-definition
    // promotion: the Gatekeeper (Step 1.5 x2), per-lens (Step 3), and
    // Consolidator (Step 3.5) spawn sites each gain a file-exists guard
    // resolving their agents/*.md definition with the loud agent-fallback
    // notice, the six-agent table gains a Definition column, and Step 12
    // gains the fired-notice echo paragraph. Every existing spawn keeps its
    // per-spawn model: param and artifact path — new-contract prose, not
    // regrowth of previously-trimmed prose.
    //
    // Lowered 2025 → 1750 (p5-context-diet): the lean-body + lazy-reference
    // pass trimmed the file 2,016 → 1,698 lines by moving procedural detail
    // (escalation recipes, the deployment follow-up checklist, UI-validation
    // execution detail) into topic-owning reference files and collapsing
    // duplicated spawn-procedure prose. The lowered ceiling locks in this
    // win with modest headroom rather than leaving the old, now-stale 2025
    // budget as ~327 lines of silent regrowth room — the exact failure mode
    // this diet fights.
    //
    // Bumped 1750 → 1755 (fix-shaped causal-explanation contract): Step 11
    // gains one new bold-prefixed paragraph naming Step 11's fix-shaped
    // completeness criteria — a fix-shaped PR missing `**Failing:**` /
    // `**Root cause:**` / `**Fix mechanism:**`, or a cross-component PR
    // missing `## System flow changes` — and 11a's Structure Check gains a
    // conditional-section mention appended to its existing User-facing-changes
    // bullet. Both were written as long single lines (matching the file's
    // existing `**Proactive verification.**`-style long-line convention) to
    // cost only 2 net lines total; 1755 leaves 4 lines of genuine headroom
    // above the resulting 1751-line file (per this test's own split-length
    // metric), not round-number headroom for future growth.
    //
    // Bumped 1755 → 1790 (plugin-qualified agent-resolution fix): a bare
    // `flow-<agent>` subagent_type fails Task-tool resolution outright on a
    // plugin-root install (measured: "Agent type 'flow-scout' not found").
    // The gatekeeper, fix-applier, consolidator, and per-lens agent
    // resolvers each grew from a one-line `X=flow-x; [ -f ... ] || fallback`
    // guard to an explicit three-tier if/elif/else block (plugin-qualified
    // → legacy bare → general-purpose) — genuine load-bearing correctness
    // content, not incidental bloat. File lands at 1781 lines — 1790 leaves
    // 9 lines of genuine headroom, not round-number headroom for future
    // growth.
    // Note: a later PR collapsed these three-tier guards to two tiers
    // (plugin-qualified → general-purpose, dropping the legacy-bare
    // elif branch), shrinking the file below this ceiling — the number
    // above is left as historical record, not re-tightened.
    //
    // Bumped 1790 → 1820 (monolith checklist → per-lens checklists split):
    // Step 3's reference-files bullet, the Step 8 spawn-procedure sibling-path
    // note, the per-agent checklist-path bullet, the 6-lens table's Checklist
    // file column, and Step 5.4's "Capture the gap" two-destination rewrite
    // (repo-specific `.flow/review-checklist.md` append vs. flow-repo
    // `flow-create-issue` filing, plus the never-edit-SKILL_DIR rule and the
    // Step 12 report/backlog-triage nudge) are genuine load-bearing content —
    // the monolith they replace moved to `references/checklists/*.md`, not
    // this file. File lands at 1804 lines — 1820 leaves 16 lines of genuine
    // headroom, not round-number headroom for future growth.
    //
    // Bumped 1820 → 1860 (PM-lens supervisor wiring, Task 10): 11a's
    // Structure Check gains a `Deviations from plan` bullet, 11d gains the
    // Q5-class-deviation routing paragraph, and Step 13 gains the two
    // mechanical `flow-untracked add` seed blocks (fix-applier `deferred[]`
    // with no `tracker_entry_url`, and `anti_patterns_found[]` with
    // `introduced_by_this_pr: false`) — genuine load-bearing content for
    // this PR's own contract, not regrowth. File lands at 1851 lines — 1860
    // leaves 9 lines of genuine headroom, not round-number headroom for
    // future growth.
    expect(
      lineCount,
      `flow-pr-review/SKILL.md line count must stay under the post-diet ` +
        `budget of 1860 lines. Material regrowth past this ceiling would ` +
        `indicate unrelated bloat creeping back in.`,
    ).toBeLessThan(1860);
  });

  it("skills/pipeline/flow-pipeline/SKILL.md line count stays under the post-diet budget", () => {
    const pipelineSkillPath = path.resolve(
      HERE,
      "..",
      "skills",
      "pipeline",
      "flow-pipeline",
      "SKILL.md",
    );
    const content = fs.readFileSync(pipelineSkillPath, "utf8");
    const lineCount = content.split("\n").length;
    // New lint (p5-context-diet): the supervisor body had regrown 236 lines
    // since its #411 split before this diet trimmed it 2,986 → 2,700 lines
    // by moving the Step 3 threading/backstop contracts to
    // references/step3-threading.md. 2750 leaves modest headroom above the
    // 2,700-line post-diet floor without reopening the zero-headroom gate
    // tension this same PR's Test Steps hit at exactly 2,700 — regrowth
    // past 2750 should be treated as bloat creeping back in, the failure
    // mode this diet exists to prevent. Raised from 2750 to 2760 to fund the
    // rebase-to-merge conversion's `merge-resolver-spawn-denied` escalation
    // branch in the Independent Merge-Conflict Resolver Subagent section — a
    // few lines naming the new NEEDS HUMAN reason and its no-re-spawn /
    // no-inline-resolution invariants. Kept deliberately tight rather than
    // offloaded, since the branch is a handful of lines, not a new section.
    // Tightened the spawn-denied branch (pr-review #485): removed a
    // restated no-re-spawn clause (already stated three lines below) and
    // moved the trailing context-isolation rationale to
    // references/exemption-contracts.md. File now lands at 2758 lines —
    // raised the ceiling to 2765 (7 lines of genuine headroom) rather than
    // pinning it back at zero headroom, which is the exact tension this
    // ceiling exists to prevent.
    // Resolver-contract-hygiene PR: extracted the three no-retry escalation
    // variants (branch-mismatch, terminal-regression, task-tool-unavailable)
    // out of the `# Failure paths` block into references/failure-recovery.md
    // § (c), replacing them with a compact trigger table, then appended a
    // short "standard `# Failure paths` chain" pointer clause to each of the
    // five terse step-10 escalation sites (the fifth,
    // merge-resolver-missing-artifact, was initially missed in this PR and
    // added in a pr-review #506 follow-up fix commit). File lands at 2660
    // lines — RATCHETED the ceiling DOWN to 2685 (measured + ~25, rounded to
    // the nearest 5), not raised, so the headroom this extraction freed is
    // not silently refilled by unrelated regrowth.
    // Terminal-state reap wiring PR: rewrote "# Resource cleanup" as the
    // three-layer contract (point-of-use / registry-first backstop /
    // orphan-sweep crash net) and wired `flow-browser-teardown --reap
    // --record` + `flow-gate-summary --cleanup` into every terminal-state
    // runbook block. This is genuine load-bearing safety content (the
    // standalone-call / non-`&&`-chained warning this feature exists to
    // enforce), already tightened repeatedly rather than offloaded — no
    // references/ file is a natural home for a supervisor-wide invariant
    // spanning every terminal exit. File lands at 2696 lines — raised the
    // ceiling to 2700 (4 lines of genuine headroom), same discipline as the
    // 2765 precedent above: not pinned back at zero headroom.
    // Plugin-qualified agent-resolution fix: a bare `flow-<agent>`
    // subagent_type fails Task-tool resolution outright on a plugin-root
    // install (measured: "Agent type 'flow-scout' not found"). The
    // flow-verify and flow-merge-resolver resolvers each grew from a
    // one-line guard to an explicit three-tier if/elif/else block
    // (plugin-qualified → legacy bare → general-purpose), plus corrected
    // prose at each site — genuine load-bearing correctness content. File
    // lands at 2725 lines — raised the ceiling to 2735 (10 lines of genuine
    // headroom), same discipline as the precedents above.
    // Note: a later PR collapsed these three-tier guards to two tiers
    // (plugin-qualified → general-purpose, dropping the legacy-bare
    // elif branch), shrinking the file below this ceiling — the number
    // above is left as historical record, not re-tightened.
    // Intent interview (adaptive): step 1's Intent interview sub-step,
    // step 3's Question-gate branch, the sixth invocation-threading
    // marker, the answer-sheet End-condition addition, and the two new
    // pending-phase enumerations are genuine load-bearing feature
    // content, not incidental bloat. File lands at 2815 lines — raised
    // the ceiling to 2830 (15 lines of genuine headroom), same
    // discipline as the precedents above.
    // pr-review fix pass (PR #637): the step-1 per-round persistence fix,
    // the step-3 question-gate post-answer persistence fix, and the
    // reconciled step-3 resume-row wording are genuine correctness content
    // fixing a mid-interview data-loss bug, not incidental bloat. File
    // lands at 2845 lines — raised the ceiling to 2860 (15 lines of
    // genuine headroom), same discipline as the precedents above.
    // PM-lens supervisor wiring (Task 9): every terminal-state
    // `flow-gate-summary` / `flow-pipeline-summary` / `flow-notify` call
    // site across steps 3, 7, 9, 10, 11, and the resume/cancel paths
    // gained `--tldr`/`--lens`/`--untracked-file`/`--counts-line`
    // wiring, plus the six-slot pause-block templates and the `file #N`
    // / `drop #N` reply-verb documentation at three sites — this is the
    // feature's own mechanical breadth, not incidental bloat, and there
    // is no references/ file that would not just relocate the same
    // per-site wiring away from the site it documents. File lands at
    // 2904 lines — raised the ceiling to 2920 (16 lines of genuine
    // headroom), same discipline as the precedents above.
    // Merging that PM-lens work with the flow-ci-check/flow-ci-wait
    // step-7 split (PR #666) lands the combined file at 2923 lines —
    // both sides' growth is feature-mechanical, so the ceiling moves to
    // 2940 (17 lines of headroom), same discipline as above.
    expect(
      lineCount,
      `flow-pipeline/SKILL.md line count must stay under the post-diet ` +
        `budget of 2940 lines. Material regrowth past this ceiling would ` +
        `indicate unrelated bloat creeping back in.`,
    ).toBeLessThan(2940);
  });

  it("skills/pipeline/flow-new-feature/SKILL.md line count stays under the post-diet budget", () => {
    const newFeatureSkillPath = path.resolve(
      HERE,
      "..",
      "skills",
      "pipeline",
      "flow-new-feature",
      "SKILL.md",
    );
    const content = fs.readFileSync(newFeatureSkillPath, "utf8");
    const lineCount = content.split("\n").length;
    // New lint (p5-context-diet): the Step 4b PR-description authoring
    // rubric moved verbatim to references/pr-description-authoring.md,
    // trimming the file 916 → 750 lines. 780 leaves modest headroom above
    // the post-diet floor; regrowth past it should be treated as bloat
    // creeping back in.
    //
    // Bumped 780 → 795 (plugin-qualified agent-resolution fix): a bare
    // `flow-scout` subagent_type fails Task-tool resolution outright on a
    // plugin-root install (measured: "Agent type 'flow-scout' not found").
    // The scout resolver grew from a one-line guard to an explicit
    // three-tier if/elif/else block (plugin-qualified → legacy bare →
    // general-purpose), plus corrected prose at two other sites — genuine
    // load-bearing correctness content. File lands at 785 lines — 795
    // leaves 10 lines of genuine headroom, not round-number headroom for
    // future growth.
    // Note: a later PR collapsed this three-tier guard to two tiers
    // (plugin-qualified → general-purpose, dropping the legacy-bare
    // elif branch), shrinking the file below this ceiling — the number
    // above is left as historical record, not re-tightened.
    expect(
      lineCount,
      `flow-new-feature/SKILL.md line count must stay under the post-diet ` +
        `budget of 795 lines. Material regrowth past this ceiling would ` +
        `indicate unrelated bloat creeping back in.`,
    ).toBeLessThan(795);
  });

  it("skills/pipeline/flow-pr-review/SKILL.md Result artifact section carries the exit-path table header", () => {
    const prReviewSkillPath = path.resolve(
      HERE,
      "..",
      "skills",
      "pipeline",
      "flow-pr-review",
      "SKILL.md",
    );
    const content = fs.readFileSync(prReviewSkillPath, "utf8");
    expect(
      content.includes("| Status | Escalation tag |"),
      `flow-pr-review/SKILL.md must contain the result-artifact markdown table ` +
        `header '| Status | Escalation tag |'. The table consolidates the ` +
        `five exit-path prose bullets the refactor replaced.`,
    ).toBe(true);
  });
});

describe("flow-pipeline SKILL.md ↔ flow-stop-guard NEXT_STEP_BY_PHASE cross-doc lint", () => {
  // The `epic-*` step phases (epic-designing / epic-validating / epic-pr-open)
  // are `/flow-epic-create` steps, NOT /flow-pipeline steps, so they have no
  // `## Step N` heading in flow-pipeline/SKILL.md to map to. Scope this
  // cross-doc lint to the /flow-pipeline step phases only; the epic phases are
  // exercised by the standalone `/flow-epic-create` supervisor literal lint below.
  it.each(
    STEP_PHASES.filter((phase) => !phase.startsWith("epic-")).map((phase) => [
      phase,
    ]),
  )(
    "every `step N(.M)?` reference in NEXT_STEP_BY_PHASE['%s'] maps to a `## Step N — ` heading in SKILL.md",
    (phase) => {
      const label = NEXT_STEP_BY_PHASE[phase];
      expect(
        label,
        `flow-stop-guard NEXT_STEP_BY_PHASE is missing an entry for ` +
          `STEP_PHASES value '${phase}'. Every step phase needs a "next step" ` +
          `reminder so the Stop hook can tell the supervisor where to go next.`,
      ).toBeDefined();

      const refs = [...label!.matchAll(/step (\d+(?:\.\d+)?)/gi)].map(
        (m) => m[1],
      );
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

describe("flow-pipeline SKILL.md ↔ TERMINAL_EXIT_TRANSITIONS cross-doc lint", () => {
  // Guards against the allowlist (bin/lib/state.ts) and the SKILL.md prose
  // silently drifting apart again: a phase dropped from
  // TERMINAL_EXIT_TRANSITIONS.gated (or the symbol itself going unmentioned)
  // should fail loudly here rather than leaving the doc describing exits the
  // guard no longer permits, or vice versa.
  //
  // The per-phase check below is scoped to an ISOLATED PROSE SLICE, not
  // whole-file `content` — 21 of 26 PIPELINE_PHASES are already backticked
  // somewhere in SKILL.md as ordinary step headers, so a whole-file
  // `content.includes` check passes vacuously for almost any allowlist
  // widening.
  //
  // The slice deliberately EXCLUDES the "Gated is an explicit carve-out"
  // paragraph, even though it also discusses the mechanic: that paragraph
  // enumerates the in-flight phases (`implementing`, `ci-wait`,
  // `reviewing`, `plan-pending-review`), which are precisely the most
  // likely allowlist-widening targets — including it would re-open the
  // vacuity hole for exactly the drift this lint exists to catch. Only the
  // two regions that name actual EXITS are in scope: the `gated-feedback`
  // Resume-mode row (step 6 / step 9 writes) and the "Gate override
  // (post-verdict, opt-in)" section (the step 10 write). The carve-out
  // paragraph is still anchor-checked below, just not phase-matched.
  const gatedFeedbackRow = content
    .split("\n")
    .find((line) => line.includes("| `gated-feedback` |"));
  const gateOverrideSection = (() => {
    const start = content.indexOf("### Gate override (post-verdict, opt-in)");
    const end = content.indexOf("\n### ", start + 1);
    return content.slice(start, end === -1 ? undefined : end);
  })();
  const carveOutParagraph = (() => {
    const marker =
      "**Gated is an explicit carve-out, not a sixth in-flight phase.**";
    const start = content.indexOf(marker);
    const end = content.indexOf("\n\n", start + 1);
    return content.slice(start, end === -1 ? undefined : end);
  })();
  const gatedExitProse = [gatedFeedbackRow ?? "", gateOverrideSection].join(
    "\n\n",
  );

  it("the gated-exit prose slice was found (sanity check for the anchors above)", () => {
    expect(
      gatedFeedbackRow,
      "gated-feedback Resume-mode row not found",
    ).not.toBe(undefined);
    expect(
      gateOverrideSection.length,
      "Gate override (post-verdict, opt-in) section not found",
    ).toBeGreaterThan(0);
    expect(
      carveOutParagraph.length,
      "Gated is an explicit carve-out paragraph not found",
    ).toBeGreaterThan(0);
  });

  it.each(TERMINAL_EXIT_TRANSITIONS.gated.map((phase) => [phase]))(
    "TERMINAL_EXIT_TRANSITIONS.gated phase '%s' is named (backticked) in SKILL.md's gated-exit prose",
    (phase) => {
      expect(
        gatedExitProse.includes(`\`${phase}\``),
        `TERMINAL_EXIT_TRANSITIONS.gated includes '${phase}' ` +
          `(bin/lib/state.ts), but flow-pipeline/SKILL.md's gated-exit ` +
          "prose (gated-feedback row / Gate override section) never " +
          "mentions `" +
          phase +
          "` — fix SKILL.md's gated-exit prose to name every allowlisted " +
          "target.",
      ).toBe(true);
    },
  );

  it("SKILL.md mentions the literal symbol TERMINAL_EXIT_TRANSITIONS", () => {
    // Load-bearing check: verifying/gating/merging each also appear
    // elsewhere in SKILL.md as ordinary phase names, so the it.each above
    // alone can't catch the allowlist going unmentioned entirely — only the
    // literal symbol name proves SKILL.md's prose is actually describing
    // this guard, not just naming the phases in another context.
    expect(
      content.includes("TERMINAL_EXIT_TRANSITIONS"),
      "flow-pipeline/SKILL.md no longer mentions the literal symbol " +
        "TERMINAL_EXIT_TRANSITIONS — fix SKILL.md to name it explicitly so " +
        "the gated-exit prose stays traceable to bin/lib/state.ts.",
    ).toBe(true);
  });
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
    const stepSlice =
      prReviewContent.split("### 11e. Resolution")[1]?.split(/^## /m)[0] ?? "";
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
    const markers = [
      "default-on",
      "Auto-push exemption",
      "redirects via reply",
    ];
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
      prReviewContent.includes(
        "Manual items auto-converted (N items, redirect by replying)",
      ),
      "SKILL.md Step 12 must contain the verbatim cross-reference " +
        "'Manual items auto-converted (N items, redirect by replying)' so the " +
        "Step 12 prose and the report-template.md Status enum stay in lock-step. " +
        "Drift here means SKILL.md and report-template.md describe different " +
        "Status enum values for the same auto-conversion disposition.",
    ).toBe(true);
  });
});

describe("pipeline skills invoke PATH binaries, not cwd-relative bun bin/ paths", () => {
  // Pipeline skills run from a per-pipeline worktree whose cwd is unknown at
  // authoring time. An executable invocation written as `bun bin/lib/<x>.ts`
  // or `bun bin/flow-<x>.ts` only resolves when cwd is the flow repo root —
  // it breaks in every consumer worktree. `flow install` symlinks the helpers
  // (and, via discoverValidators, the schema validators) onto PATH, so the
  // skills must invoke them by bare name. This lint walks every SKILL.md and
  // references/*.md under skills/pipeline/ and fails on any `bun bin/lib/` or
  // `bun bin/flow-` executable-invocation token. The regex anchors on those
  // two prefixes so it does NOT false-positive on bare `bin/lib/...` prose
  // path mentions, the `bun bin/<helper>.test.ts` placeholder snippet,
  // `bun bin/foo --help`, or `bun bin/flow install`.
  const PIPELINE_DIR = path.resolve(HERE, "..", "skills", "pipeline");
  const EXEC_INVOCATION_RE = /bun bin\/(lib\/|flow-)/;

  function walkMarkdown(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...walkMarkdown(full));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
    return out;
  }

  const mdFiles = walkMarkdown(PIPELINE_DIR);

  it.each(mdFiles.map((f) => [path.relative(PIPELINE_DIR, f), f]))(
    "skills/pipeline/%s carries no `bun bin/lib/` or `bun bin/flow-` executable invocation",
    (_rel, absPath) => {
      const lines = fs.readFileSync(absPath, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        expect(
          EXEC_INVOCATION_RE.test(line),
          `${absPath}:${i + 1} invokes a cwd-relative path: ${JSON.stringify(line)}. ` +
            `Pipeline skills run from an unknown worktree cwd — invoke the bare ` +
            `PATH-binary name instead (e.g. 'flow-pr-review-result-schema', ` +
            `'flow-agent-finding-schema', 'flow-fetch-intent-comments'), which ` +
            `'flow install' symlinks onto PATH.`,
        ).toBe(false);
      }
    },
  );
});

describe("gate-hardening structural anchors (gated verdict is terminal)", () => {
  // These anchors guard the process-hardening change that made a `gated`
  // auto-merge verdict terminal — the supervisor may no longer override it on
  // its own judgment. Each assertion pins a phrase the hardening depends on;
  // a rename that drops a phrase must update this lint in the same commit
  // (the AGENTS.md ## Output style structural-lint rule). The incident: a
  // supervisor reclassified unchecked functional Test Steps as "subjective
  // UX", cited a stale "merge" instruction, and shipped a broken feature.

  // AGENTS.md bullets are wrapped prose — collapse whitespace so a phrase
  // that spans a line break still matches.
  const agentsNorm = agentsContent.replace(/\s+/g, " ");

  it("flow-pipeline SKILL.md step 9 states a gated verdict is terminal, not advisory", () => {
    expect(
      content.includes("terminal, not advisory"),
      "flow-pipeline SKILL.md step 9 must contain the phrase 'terminal, not " +
        "advisory' — the anchor for the rule that the supervisor must not " +
        "merge a gated PR on its own judgment.",
    ).toBe(true);
  });

  it("flow-pipeline SKILL.md documents the post-verdict gate-override sub-step", () => {
    expect(
      content.includes("Gate override (post-verdict"),
      "flow-pipeline SKILL.md step 9 must contain a 'Gate override " +
        "(post-verdict, opt-in)' sub-step — the named AskUserQuestion site " +
        "where a fresh override confirmation is obtained.",
    ).toBe(true);
  });

  it("flow-pipeline SKILL.md step 9 documents a live re-query before the override decision", () => {
    expect(
      content.includes("Re-query the live gate"),
      "flow-pipeline SKILL.md step 9 must contain the phrase 'Re-query the " +
        "live gate' — the anchor for the live-gate-decide re-query that runs " +
        "before the AskUserQuestion override form fires (closes the " +
        "stale-verdict footgun).",
    ).toBe(true);
  });

  it("flow-pipeline SKILL.md step 10 wires in the flow-merge-guard backstop", () => {
    expect(
      content.includes("flow-merge-guard"),
      "flow-pipeline SKILL.md step 10 must invoke 'flow-merge-guard' — the " +
        "mechanical backstop that blocks a merge on a gated verdict without a " +
        "fresh-confirmation token.",
    ).toBe(true);
    expect(
      content.includes("gate-override-without-confirmation"),
      "flow-pipeline SKILL.md step 10 must escalate " +
        "'gate-override-without-confirmation' when flow-merge-guard blocks.",
    ).toBe(true);
  });

  it("auto-merge-rubric.md states a gated verdict is terminal, not advisory", () => {
    expect(
      autoMergeRubricContent.includes("terminal, not advisory"),
      "auto-merge-rubric.md must contain a 'terminal, not advisory' section " +
        "so the rubric and SKILL.md step 9 stay in lock-step on the gate's " +
        "non-advisory status.",
    ).toBe(true);
  });

  it("flow-pipeline SKILL.md Resume mode has a gated-feedback row stating the never-merge / flow-merge-guard guarantee", () => {
    expect(
      content.includes("| `gated-feedback` |"),
      "flow-pipeline SKILL.md Resume-mode branch table must have a " +
        "`gated-feedback` row — the resume routing for a gated PR carrying a " +
        "checkpoint marker (flow-resume-decide's new ResumeAt value).",
    ).toBe(true);
    expect(
      content.includes(
        "This loop introduces no new merge path and never merges on its own authority:",
      ),
      "the gated-feedback Resume-mode row must state the never-merge / " +
        "no-new-merge-path guarantee verbatim — the structural guard for the " +
        "gated-is-terminal invariant (PRD Plan risks).",
    ).toBe(true);
    expect(
      content.includes(
        "its re-gate re-enters the normal step 9 gate, which routes every merge through the existing `flow-merge-guard` backstop",
      ),
      "the gated-feedback Resume-mode row must state that the re-gate routes " +
        "every merge through flow-merge-guard — so a future edit adding a " +
        "bypass path breaks the lint, not production.",
    ).toBe(true);
  });

  it("flow-pipeline SKILL.md step 9 has a Gate auto-checkpoint sub-step arming flow-checkpoint non-clobberingly", () => {
    expect(
      content.includes("### Gate auto-checkpoint sub-step"),
      "flow-pipeline SKILL.md step 9 must contain a 'Gate auto-checkpoint " +
        "sub-step' heading — the near-zero-residue checkpoint arm at the GATED " +
        "render that lets the user /clear during validation.",
    ).toBe(true);
    expect(
      content.includes(
        "safe to `/clear` during validation — the\npipeline auto-resumes",
      ) ||
        content.includes(
          "safe to `/clear` during validation — the pipeline auto-resumes",
        ) ||
        content.includes(
          "safe to `/clear` during\nvalidation — the pipeline auto-resumes",
        ),
      "the step 9 gate auto-checkpoint sub-step must carry the 'safe to " +
        "/clear during validation — the pipeline auto-resumes' nudge.",
    ).toBe(true);
    expect(
      /### Gate auto-checkpoint sub-step[\s\S]*?\*\*Non-clobbering:\*\*[\s\S]*?flow-checkpoint/.test(
        content,
      ),
      "the step 9 gate auto-checkpoint sub-step must state the non-clobber " +
        "rule AND arm the marker with a `flow-checkpoint` call.",
    ).toBe(true);
  });

  it("flow-pipeline SKILL.md documents gated as an explicit /flow-coder redirect carve-out (not a sixth in-flight phase)", () => {
    expect(
      content.includes(
        "**Gated is an explicit carve-out, not a sixth in-flight phase.**",
      ),
      "flow-pipeline SKILL.md 'Mid-flight code-change redirects' must carry " +
        "gated as an EXPLICIT carve-out (bug callout → /flow-coder → step 6 → " +
        "step 9), NOT a blind append to the five in-flight phases.",
    ).toBe(true);
    expect(
      redirectHandlingContent.includes(
        "**Bug callout at `gated` (terminal) — explicit carve-out.**",
      ),
      "redirect-handling.md must document the gated /flow-coder carve-out " +
        "distinctly from the in-flight phases and from the gate-override " +
        "merge path.",
    ).toBe(true);
  });

  it("flow-pipeline SKILL.md step 4 has the auto-checkpoint sub-step body arming flow-checkpoint at checkpoint-pending-clear", () => {
    expect(
      content.includes("### Auto-checkpoint sub-step"),
      "flow-pipeline SKILL.md step 4 must contain the 'Auto-checkpoint " +
        "sub-step' body PR #407 referenced but never authored — the three " +
        "forward-references resolve to this heading.",
    ).toBe(true);
    expect(
      content.includes(
        "Flush approval state to `checkpoint.md` (non-clobbering).",
      ),
      "the step 4 auto-checkpoint sub-step must flush approval state to " +
        "checkpoint.md non-clobberingly (the fuller /checkpoint-style flush).",
    ).toBe(true);
    expect(
      // Matches the ARM specifically (`flow-checkpoint --site plan-approval`),
      // not a bare `flow-checkpoint` substring — a `--probe` call inserted
      // before the arm would otherwise satisfy a looser regex and silently
      // stop proving the arm-before-phase-write ordering this test exists
      // for.
      /### Auto-checkpoint sub-step[\s\S]*?flow-checkpoint --site plan-approval[\s\S]*?flow-state-update --phase checkpoint-pending-clear/.test(
        content,
      ),
      "the step 4 auto-checkpoint sub-step must arm `flow-checkpoint --site " +
        "plan-approval` BEFORE writing `flow-state-update --phase " +
        "checkpoint-pending-clear`.",
    ).toBe(true);
  });

  it("flow-pipeline SKILL.md step 3 arms the plan-review clear point (auto-checkpoint at plan-pending-review)", () => {
    expect(
      content.includes("**Plan-review clear point (auto-checkpoint arm).**"),
      "flow-pipeline SKILL.md step 3's feature-intent End condition must arm " +
        "a plan-review clear point (non-clobbering checkpoint.md pointer + " +
        "flow-checkpoint) so /clear at plan-pending-review auto-resumes.",
    ).toBe(true);
    expect(
      content.includes(
        "safe to `/clear` —\n  approve on a fresh session; the plan re-renders on resume.",
      ) ||
        content.includes(
          "safe to `/clear` — approve on a fresh session; the plan re-renders on resume.",
        ),
      "the step 3 plan-review clear point must carry the 'safe to /clear — " +
        "approve on a fresh session; the plan re-renders on resume' nudge.",
    ).toBe(true);
  });

  it.each(CHECKPOINT_SITES.filter((site) => site !== "manual"))(
    "flow-pipeline SKILL.md probes and arms --site %s at its auto-checkpoint sub-step",
    (site) => {
      expect(
        content.includes(`--probe --site ${site}`),
        `flow-pipeline SKILL.md must probe freshness with ` +
          `\`--probe --site ${site}\` before its ${site} auto-checkpoint arm.`,
      ).toBe(true);
      expect(
        content.includes(`flow-checkpoint --site ${site}`),
        `flow-pipeline SKILL.md must arm the ${site} auto-checkpoint site ` +
          `with an explicit \`flow-checkpoint --site ${site}\` call.`,
      ).toBe(true);
    },
  );

  it("the /flow-checkpoint skill documents the checkpoint.consumed.md archive", () => {
    expect(
      checkpointSkillContent.includes("checkpoint.consumed.md"),
      "skills/universal/flow-checkpoint/SKILL.md must document that " +
        "--consume now archives the body to checkpoint.consumed.md, not " +
        "just deletes the one-shot marker.",
    ).toBe(true);
  });

  it("manual-test-rubric.md distinguishes functional from subjective manual checks", () => {
    expect(
      manualTestRubricContent.includes("Functional checks"),
      "manual-test-rubric.md must contain a 'Functional checks' sub-heading " +
        "splitting the 'Genuinely manual' category.",
    ).toBe(true);
    expect(
      manualTestRubricContent.includes("Subjective checks"),
      "manual-test-rubric.md must contain a 'Subjective checks' sub-heading " +
        "splitting the 'Genuinely manual' category.",
    ).toBe(true);
  });

  it("manual-test-rubric.md states an unverified functional step blocks merge", () => {
    expect(
      manualTestRubricContent.includes(
        "unverified functional step blocks merge",
      ),
      "manual-test-rubric.md must contain the phrase 'unverified functional " +
        "step blocks merge' — the rule that a functional manual check may not " +
        "be reclassified as subjective to wave it through.",
    ).toBe(true);
  });

  it("manual-test-rubric.md requires one functional check per distinct user-facing change", () => {
    expect(
      manualTestRubricContent.includes(
        "one functional check per distinct user-facing change",
      ),
      "manual-test-rubric.md must contain the phrase 'one functional check " +
        "per distinct user-facing change' — the coverage-breadth rule that a " +
        "multi-facet feature needs one check per facet, not a single conflated " +
        "step. The two authoring sites (flow-new-feature/SKILL.md Step 4b, " +
        "product-planning discovery-instructions.md Step 7) defer to this " +
        "phrase by reference; renaming it must update this lint in the same " +
        "commit (AGENTS.md anchored-phrase rule).",
    ).toBe(true);
  });

  it("both authoring sites defer to the rubric's 'Coverage breadth' section", () => {
    expect(
      newFeatureContent.includes("Coverage breadth"),
      "flow-new-feature/SKILL.md Step 4b must reference the rubric's 'Coverage " +
        "breadth' section — the cross-file-deference contract: the breadth " +
        "requirement is anchored once in manual-test-rubric.md (the single " +
        "source of truth), and each authoring site defers to it by name. " +
        "Dropping the reference here silently orphans the requirement. " +
        "Renaming the section name must update both sites and this lint in the " +
        "same commit (AGENTS.md anchored-phrase rule).",
    ).toBe(true);
    expect(
      discoveryInstructionsContent.includes("Coverage breadth"),
      "product-planning discovery-instructions.md Step 7 must reference the " +
        "rubric's 'Coverage breadth' section — same cross-file-deference " +
        "contract as flow-new-feature/SKILL.md: the breadth requirement is anchored " +
        "once in manual-test-rubric.md and deferred to by name here. Dropping " +
        "the reference silently orphans the requirement. Renaming the section " +
        "name must update both sites and this lint in the same commit " +
        "(AGENTS.md anchored-phrase rule).",
    ).toBe(true);
  });

  it("manual-test-rubric.md requires the concrete how for every manual precondition", () => {
    expect(
      manualTestRubricContent.includes("Spell out the concrete how"),
      "manual-test-rubric.md must contain the phrase 'Spell out the concrete " +
        "how' — the precondition-concreteness rule that every manual / " +
        "human-verification step must name the exact command, click path, or " +
        "setting behind each precondition and never use a bare 'turn X on' / " +
        "'with X enabled' phrasing without the concrete how. The three " +
        "authoring sites (flow-new-feature/SKILL.md Step 4b, flow-pr-review/SKILL.md " +
        "Step 11e, product-planning discovery-instructions.md Step 7) defer to " +
        "this phrase by reference; renaming it must update this lint in the " +
        "same commit (AGENTS.md anchored-phrase rule).",
    ).toBe(true);
  });

  it("all three authoring sites defer to the rubric's 'Precondition concreteness' section", () => {
    expect(
      newFeatureContent.includes("Precondition concreteness"),
      "flow-new-feature/SKILL.md Step 4b must reference the rubric's 'Precondition " +
        "concreteness' section — the cross-file-deference contract: the " +
        "spell-out-the-how requirement is anchored once in manual-test-rubric.md " +
        "(the single source of truth), and each authoring site defers to it by " +
        "name. Dropping the reference here silently orphans the requirement. " +
        "Renaming the section name must update all three sites and this lint in " +
        "the same commit (AGENTS.md anchored-phrase rule).",
    ).toBe(true);
    expect(
      prReviewContent.includes("Precondition concreteness"),
      "flow-pr-review/SKILL.md Step 11e must reference the rubric's 'Precondition " +
        "concreteness' section — same cross-file-deference contract: the " +
        "spell-out-the-how requirement is anchored once in manual-test-rubric.md " +
        "and deferred to by name here, governing every manual item Step 11e " +
        "drafts or extends. Dropping the reference silently orphans the " +
        "requirement. Renaming the section name must update all three sites and " +
        "this lint in the same commit (AGENTS.md anchored-phrase rule).",
    ).toBe(true);
    expect(
      discoveryInstructionsContent.includes("Precondition concreteness"),
      "product-planning discovery-instructions.md Step 7 must reference the " +
        "rubric's 'Precondition concreteness' section — same cross-file-deference " +
        "contract: the spell-out-the-how requirement is anchored once in " +
        "manual-test-rubric.md and deferred to by name here. Dropping the " +
        "reference silently orphans the requirement. Renaming the section name " +
        "must update all three sites and this lint in the same commit (AGENTS.md " +
        "anchored-phrase rule).",
    ).toBe(true);
  });

  it("both authoring sites carry the fix-shaped Failing/Root-cause pair", () => {
    expect(
      prDescriptionAuthoringContent.includes("**Failing:**") &&
        prDescriptionAuthoringContent.includes("**Root cause:**"),
      "flow-new-feature/references/pr-description-authoring.md's `## Why` " +
        "guidance must carry both `**Failing:**` and `**Root cause:**` — the " +
        "fix-shaped causal-explanation contract. Dropping either token silently " +
        "regresses fix PRs back to intent-only `## Why` prose. Renaming the " +
        "tokens must update both authoring sites, flow-pr-review/SKILL.md Step " +
        "11, and this lint in the same commit.",
    ).toBe(true);
    expect(
      discoveryInstructionsContent.includes("**Failing:**") &&
        discoveryInstructionsContent.includes("**Root cause:**"),
      "product-planning discovery-instructions.md Step 7's `## Why` guidance " +
        "must carry both `**Failing:**` and `**Root cause:**` — the same " +
        "fix-shaped causal-explanation contract mirrored from " +
        "pr-description-authoring.md. Dropping either token silently regresses " +
        "fix PRs seeded from a PRD back to intent-only `## Why` prose. Renaming " +
        "the tokens must update both authoring sites, flow-pr-review/SKILL.md " +
        "Step 11, and this lint in the same commit.",
    ).toBe(true);
    expect(
      pullRequestTemplateContent.includes("**Failing:**") &&
        pullRequestTemplateContent.includes("**Root cause:**"),
      ".github/PULL_REQUEST_TEMPLATE.md must carry both `**Failing:**` and " +
        "`**Root cause:**` guidance — so a human authoring a fix PR by hand " +
        "sees the same causal contract as the two skill-authored paths. " +
        "Dropping either token silently drops the contract from hand-authored " +
        "fix PRs.",
    ).toBe(true);
    expect(
      agentsContent.includes("**Failing:**") &&
        agentsContent.includes("**Root cause:**"),
      "AGENTS.md's `- **PRs:**` bullet must name both `**Failing:**` and " +
        "`**Root cause:**` — the repo-wide pointer to the causal-explanation " +
        "contract. Dropping either token silently orphans the pointer from " +
        "the canonical agent guide.",
    ).toBe(true);
  });

  it("both authoring sites carry the fix-shaped Fix-mechanism lead bullet", () => {
    expect(
      prDescriptionAuthoringContent.includes("**Fix mechanism:**"),
      "flow-new-feature/references/pr-description-authoring.md's `## Key " +
        "decisions` guidance must carry `**Fix mechanism:**` — the rule that a " +
        "fix-shaped PR's first Key-decisions bullet names why the change " +
        "eliminates the root cause. Dropping it silently regresses fix PRs back " +
        "to undifferentiated decision bullets. Renaming the token must update " +
        "both authoring sites, flow-pr-review/SKILL.md Step 11, and this lint " +
        "in the same commit.",
    ).toBe(true);
    expect(
      discoveryInstructionsContent.includes("**Fix mechanism:**"),
      "product-planning discovery-instructions.md Step 7's `## Key decisions` " +
        "guidance must carry `**Fix mechanism:**` — the same fix-shaped lead- " +
        "bullet rule mirrored from pr-description-authoring.md. Dropping it " +
        "silently regresses fix PRs seeded from a PRD back to undifferentiated " +
        "decision bullets. Renaming the token must update both authoring " +
        "sites, flow-pr-review/SKILL.md Step 11, and this lint in the same " +
        "commit.",
    ).toBe(true);
    expect(
      pullRequestTemplateContent.includes("**Fix mechanism:**"),
      ".github/PULL_REQUEST_TEMPLATE.md must carry `**Fix mechanism:**` " +
        "guidance — so a human authoring a fix PR by hand sees the same " +
        "lead-bullet rule as the two skill-authored paths. Dropping it " +
        "silently drops the rule from hand-authored fix PRs.",
    ).toBe(true);
    expect(
      agentsContent.includes("**Fix mechanism:**"),
      "AGENTS.md's `- **PRs:**` bullet must name `**Fix mechanism:**` — the " +
        "repo-wide pointer to the causal-explanation contract. Dropping it " +
        "silently orphans the pointer from the canonical agent guide.",
    ).toBe(true);
  });

  it("all four prose sites name the conditional 'System flow changes' section", () => {
    expect(
      prDescriptionAuthoringContent.includes("## System flow changes"),
      "flow-new-feature/references/pr-description-authoring.md must carry a " +
        "`## System flow changes` guidance block between `## User-facing " +
        "changes` and `## Test Steps` — the conditional, omit-when-empty " +
        "section for cross-component PRs. Dropping it silently drops the " +
        "section from every new-feature-authored PR description.",
    ).toBe(true);
    expect(
      discoveryInstructionsContent.includes("## System flow changes"),
      "product-planning discovery-instructions.md Step 7 must carry the same " +
        "`## System flow changes` guidance block, mirrored from " +
        "pr-description-authoring.md. Dropping it silently drops the section " +
        "from every discovery-seeded PR description.",
    ).toBe(true);
    expect(
      pullRequestTemplateContent.includes("## System flow changes"),
      ".github/PULL_REQUEST_TEMPLATE.md must carry a commented-out `## System " +
        "flow changes` block after the `## User-facing changes` comment — so a " +
        "human authoring a PR by hand (no seeding skill involved) sees the same " +
        "conditional section as the two skill-authored paths. Dropping it " +
        "silently drops the section from hand-authored PRs.",
    ).toBe(true);
    expect(
      agentsContent.includes("`## System flow changes`"),
      "AGENTS.md's `- **PRs:**` bullet must name `## System flow changes` as " +
        "conditional — the repo-wide pointer to the four-prose-site contract. " +
        "Dropping it silently orphans the pointer from the canonical agent " +
        "guide. Renaming the section name must update all four sites and this " +
        "lint in the same commit.",
    ).toBe(true);
  });

  it("both authoring sites carry the System-flow-changes omit-when-empty rule", () => {
    expect(
      prDescriptionAuthoringContent.includes("OMIT THIS HEADING ENTIRELY"),
      "flow-new-feature/references/pr-description-authoring.md must instruct " +
        "OMIT THIS HEADING ENTIRELY for `## System flow changes` — the property " +
        "that distinguishes it from `## User-facing changes`, which affirms " +
        "`none` instead of omitting. Dropping this rule risks a vacuous `none` " +
        "under a heading meant to be absent when nothing moved.",
    ).toBe(true);
    expect(
      discoveryInstructionsContent.includes("OMIT THIS HEADING ENTIRELY"),
      "product-planning discovery-instructions.md Step 7 must carry the same " +
        "OMIT THIS HEADING ENTIRELY rule, mirrored from " +
        "pr-description-authoring.md. Dropping it risks a vacuous `none` under " +
        "a heading meant to be absent when nothing moved.",
    ).toBe(true);
  });

  it("flow-pr-review/SKILL.md Step 11 carries the 'Fix mechanism' review-time safety net", () => {
    expect(
      prReviewContent.includes("Fix mechanism"),
      "flow-pr-review/SKILL.md Step 11 must reference 'Fix mechanism' — the " +
        "review-time safety net that flags a fix-shaped PR missing the " +
        "`**Failing:**` / `**Root cause:**` / `**Fix mechanism:**` causal " +
        "contract, or a cross-component PR missing `## System flow changes`, " +
        "as a `suggestion`-severity description finding. Dropping this " +
        "paragraph silently removes the review-time backstop and lets a " +
        "non-compliant fix PR through unflagged.",
    ).toBe(true);
  });

  it("manual-test-rubric.md names the three-tier pyramid's 'lowest faithful layer' principle", () => {
    expect(
      manualTestRubricContent.includes("lowest faithful layer"),
      "manual-test-rubric.md must contain the phrase 'lowest faithful layer' — " +
        "the load-bearing principle of the unit -> HTTP/integration -> browser " +
        "test pyramid: push every assertion to the cheapest tier that can still " +
        "fail honestly. It anchors the 'Automate first' pyramid framing and the " +
        "'Decompose a manual step by layer' section. Renaming the phrase must " +
        "update this lint in the same commit (AGENTS.md anchored-phrase rule).",
    ).toBe(true);
  });

  it("manual-test-rubric.md contains the 'Decompose a manual step by layer' section", () => {
    expect(
      manualTestRubricContent.includes("Decompose a manual step by layer"),
      "manual-test-rubric.md must contain the section heading 'Decompose a " +
        "manual step by layer' — the single source of truth for the layered " +
        "decomposition rule (route a backend/API contract to an integration " +
        "test, reserve the browser tier for assertions only a browser can make, " +
        "split a step that bundles the two). Four sites defer to this phrase by " +
        "reference (flow-new-feature/SKILL.md Step 4b, product-planning " +
        "discovery-instructions.md Step 7, flow-pr-review/SKILL.md Step 8c, " +
        "pr-review references/agent-prompts.md); renaming it must update all " +
        "four sites and this lint in the same commit (AGENTS.md " +
        "anchored-phrase rule).",
    ).toBe(true);
  });

  it("all four consumer sites defer to the rubric's 'Decompose a manual step by layer' section", () => {
    expect(
      newFeatureContent.includes("Decompose a manual step by layer"),
      "flow-new-feature/SKILL.md Step 4b must reference the rubric's 'Decompose a " +
        "manual step by layer' section — the cross-file-deference contract: the " +
        "layered-decomposition rule is anchored once in manual-test-rubric.md " +
        "(the single source of truth), and each authoring site defers to it by " +
        "name rather than inlining the rule body. Dropping the reference here " +
        "silently orphans the requirement. Renaming the section name must update " +
        "all four consumer sites and this lint in the same commit (AGENTS.md " +
        "anchored-phrase rule).",
    ).toBe(true);
    expect(
      discoveryInstructionsContent.includes("Decompose a manual step by layer"),
      "product-planning discovery-instructions.md Step 7 must reference the " +
        "rubric's 'Decompose a manual step by layer' section — same " +
        "cross-file-deference contract as flow-new-feature/SKILL.md: the rule is " +
        "anchored once in manual-test-rubric.md and deferred to by name here. " +
        "Dropping the reference silently orphans the requirement. Renaming the " +
        "section name must update all four consumer sites and this lint in the " +
        "same commit (AGENTS.md anchored-phrase rule).",
    ).toBe(true);
    expect(
      prReviewContent.includes("Decompose a manual step by layer"),
      "flow-pr-review/SKILL.md Step 8c must reference the rubric's 'Decompose a " +
        "manual step by layer' section — the layered-decomposition " +
        "classification cue routes a backend-contract assertion embedded in a " +
        "browser-flavored step to a Step 11e `Fail (automatable)` conversion " +
        "(integration tier) rather than auto-classifying it browser-only. " +
        "Dropping the reference silently reverts Step 8c to the conflated " +
        "behavior. Renaming the section name must update all four consumer sites " +
        "and this lint in the same commit (AGENTS.md anchored-phrase rule).",
    ).toBe(true);
    expect(
      agentPromptsContent.includes("Decompose a manual step by layer"),
      "pr-review references/agent-prompts.md must reference the rubric's " +
        "'Decompose a manual step by layer' section — the multi-agent test lens " +
        "applies layered decomposition so a conflated backend-contract-plus-" +
        "visual manual step is flagged for an integration test. Dropping the " +
        "reference silently orphans the cue. Renaming the section name must " +
        "update all four consumer sites and this lint in the same commit " +
        "(AGENTS.md anchored-phrase rule).",
    ).toBe(true);
  });

  it("manual-test-rubric.md contains the Guard-strength check section and its load-bearing axis-d question", () => {
    expect(
      manualTestRubricContent.includes("Guard-strength check"),
      "manual-test-rubric.md must contain the 'Guard-strength check' section — " +
        "the (d) axis that complements the (a)–(c) automatability test: a check " +
        "that only fails by reverting the exact diff is a change-detector, not a " +
        "guard. Renaming or removing the section must update this lint in the same " +
        "commit (AGENTS.md anchored-phrase rule).",
    ).toBe(true);
    expect(
      manualTestRubricContent.includes(
        "could this check fail under a plausible regression",
      ),
      "manual-test-rubric.md must contain the phrase 'could this check fail " +
        "under a plausible regression' — the load-bearing question of the (d) " +
        "guard-strength axis that distinguishes a real guard from a change-detector. " +
        "A rename here breaks the conceptual link between the Guard-strength check " +
        "section and the Shallow smells change-detector bullet.",
    ).toBe(true);
  });

  it("manual-test-rubric.md contains the UI wiring behavioral assertion section and change-detector term", () => {
    expect(
      manualTestRubricContent.includes("UI wiring behavioral assertion"),
      "manual-test-rubric.md must contain the 'UI wiring behavioral assertion' " +
        "section heading — the cross-reference target from flow-pr-review/SKILL.md " +
        "Step 11b. Renaming it must update the Step 11b nudge paragraph and this " +
        "lint in the same commit (AGENTS.md anchored-phrase rule).",
    ).toBe(true);
    expect(
      manualTestRubricContent.includes("change-detector"),
      "manual-test-rubric.md must contain the term 'change-detector' — the " +
        "load-bearing concept name for a check that can only fail by reverting the " +
        "exact diff rather than catching a real regression. It appears in both the " +
        "Guard-strength check section and the Shallow smells list.",
    ).toBe(true);
  });

  it("flow-pr-review/SKILL.md Step 11b references the rubric's 'UI wiring behavioral assertion' section", () => {
    expect(
      prReviewContent.includes("UI wiring behavioral assertion"),
      "flow-pr-review/SKILL.md Step 11b must reference the rubric's 'UI wiring " +
        "behavioral assertion' section — the cross-file-deference contract: the " +
        "rule that import-presence-grep-only Test Steps on wiring changes are " +
        "under-tested is anchored once in manual-test-rubric.md and deferred to " +
        "by name in Step 11b. Dropping the reference silently orphans the nudge. " +
        "Renaming the section name must update this lint in the same commit " +
        "(AGENTS.md anchored-phrase rule).",
    ).toBe(true);
  });

  it("manual-test-rubric.md contains the SUBJECTIVE marker contract", () => {
    expect(
      manualTestRubricContent.includes("SUBJECTIVE: "),
      "manual-test-rubric.md must contain the literal `SUBJECTIVE: ` marker " +
        "string (uppercase, colon, single space) — the single source of truth " +
        "for the subjective-approval contract: a non-trivial artifact-less UI " +
        "appearance change must author one `SUBJECTIVE: `-prefixed Test Step per " +
        "facet (an artifact-referencing PR with a `## Visual Spec` authors " +
        "exactly one overall sign-off instead) that the agent can never tick. " +
        "Six sites defer to this marker " +
        "(flow-new-feature/SKILL.md Step 4b, product-planning discovery-instructions.md " +
        "Step 7, flow-pr-review/SKILL.md Step 8c + Step 11, pr-review " +
        "references/agent-prompts.md, AGENTS.md, templates/AGENTS.md.template); " +
        "the byte-exact `SUBJECTIVE: ` string is the cross-file contract — " +
        "renaming it must update all sites and this lint in the same commit " +
        "(AGENTS.md anchored-phrase rule).",
    ).toBe(true);
  });

  it("all consumer sites carry the SUBJECTIVE marker contract", () => {
    expect(
      discoveryInstructionsContent.includes("SUBJECTIVE: "),
      "product-planning discovery-instructions.md Step 7 must reference the " +
        "literal `SUBJECTIVE: ` marker — the authoring site emits one " +
        "`SUBJECTIVE: `-prefixed step per UI facet for artifact-less changes " +
        "(exactly one overall sign-off for artifact-referencing PRs whose plan " +
        "carries `## Visual Spec`), deferring to " +
        "manual-test-rubric.md ('Subjective checks') by name. Dropping it " +
        "silently orphans the requirement.",
    ).toBe(true);
    expect(
      newFeatureContent.includes("SUBJECTIVE: "),
      "flow-new-feature/SKILL.md Step 4b must reference the literal `SUBJECTIVE: ` " +
        "marker — same cross-file-deference contract as discovery-instructions.md.",
    ).toBe(true);
    expect(
      prReviewContent.includes("SUBJECTIVE: "),
      "flow-pr-review/SKILL.md must reference the literal `SUBJECTIVE: ` marker — " +
        "Step 8c classifies a `SUBJECTIVE: ` item as never-runnable (never " +
        "ticked, prose-promoted, or browser-validated) and Step 11 flags a " +
        "non-trivial UI PR with none. Dropping it reverts both behaviors.",
    ).toBe(true);
    expect(
      agentPromptsContent.includes("SUBJECTIVE: "),
      "pr-review references/agent-prompts.md must reference the literal " +
        "`SUBJECTIVE: ` marker — the test lens must not flag a never-automatable " +
        "`SUBJECTIVE: ` item for conversion to an automated check.",
    ).toBe(true);
    expect(
      agentsContent.includes("SUBJECTIVE: "),
      "AGENTS.md `## Output style` must reference the literal `SUBJECTIVE: ` " +
        "marker — the lean bullet names the rule and defers to the rubric.",
    ).toBe(true);
    expect(
      agentsTemplateContent.includes("SUBJECTIVE: "),
      "templates/AGENTS.md.template must reference the literal `SUBJECTIVE: ` " +
        "marker — the full bar carries the per-facet rule, the marker contract, " +
        "and the never-tick / flag-if-absent consequence, deferring to the " +
        "rubric by name.",
    ).toBe(true);
  });

  it("redirect-handling.md requires a gate override to be fresh, unambiguous, and in-context", () => {
    expect(
      redirectHandlingContent.includes("## Gate override"),
      "redirect-handling.md must contain a '## Gate override' section.",
    ).toBe(true);
    expect(
      // Collapse whitespace — the phrase can wrap across a line break.
      redirectHandlingContent
        .replace(/\s+/g, " ")
        .includes("fresh, unambiguous, and in-context"),
      "redirect-handling.md must contain the phrase 'fresh, unambiguous, and " +
        "in-context' — the three-part bar a gate override must clear.",
    ).toBe(true);
  });

  it("redirect-handling.md documents a live re-query before the override decision", () => {
    expect(
      redirectHandlingContent.includes("Re-query the live gate"),
      "redirect-handling.md must contain the phrase 'Re-query the live " +
        "gate' in its Gate override section — the anchor for the live-" +
        "gate-decide re-query step 0 that runs before the override decision.",
    ).toBe(true);
  });

  it("flow-pipeline SKILL.md + redirect-handling.md pin the genuinely-ambiguous list ('cool', 'thanks', 'next')", () => {
    // The softened "unambiguous" test refuses ONLY inputs that aren't about
    // merging at all — anchored on the three-word list "cool", "thanks",
    // "next". Without this lint a future edit could silently drop the list
    // from either file (re-tightening the carve-out into a refuse-bare-
    // "merge" stance, or losing the carve-out's failure case), drifting the
    // two surfaces out of lock-step. PR #221.
    expect(
      content.includes('"cool", "thanks", "next"'),
      "flow-pipeline SKILL.md step 9 must contain the genuinely-ambiguous " +
        'list \'"cool", "thanks", "next"\' verbatim — the anchor for the ' +
        "softened 'unambiguous' test's failure case (inputs that aren't " +
        "about merging at all).",
    ).toBe(true);
    expect(
      redirectHandlingContent.includes('"cool", "thanks", "next"'),
      "redirect-handling.md 'Gate override' section must contain the " +
        'genuinely-ambiguous list \'"cool", "thanks", "next"\' verbatim — ' +
        "the sibling anchor on the references-doc side; both files must " +
        "carry the list or they drift out of lock-step.",
    ).toBe(true);
  });

  it("flow-pipeline SKILL.md + redirect-handling.md pin the merge-vocabulary qualifiers ('ship it', 'lgtm')", () => {
    // The softened "unambiguous" test ACCEPTS bare merge-vocabulary — "merge",
    // "ship it", "lgtm" — as sufficient to fire the AskUserQuestion form.
    // Anchoring on "ship it" + "lgtm" (both present verbatim in both files)
    // pins the carve-out's accepted-inputs side. A future edit that drops
    // these qualifiers from either file would silently re-tighten the test
    // back to a refuse-bare-"merge" stance. PR #221.
    expect(
      content.includes('"ship it"') && content.includes('"lgtm"'),
      "flow-pipeline SKILL.md step 9 must contain the merge-vocabulary " +
        "qualifiers '\"ship it\"' and '\"lgtm\"' verbatim — the anchors for " +
        "the softened 'unambiguous' test's accepted-inputs side.",
    ).toBe(true);
    expect(
      redirectHandlingContent.includes('"ship it"') &&
        redirectHandlingContent.includes('"lgtm"'),
      "redirect-handling.md 'Gate override' section must contain the " +
        "merge-vocabulary qualifiers '\"ship it\"' and '\"lgtm\"' verbatim — " +
        "the sibling anchors on the references-doc side; both files must " +
        "carry the qualifiers or they drift out of lock-step.",
    ).toBe(true);
  });

  it("AGENTS.md auto-merge exemption excludes a gated verdict", () => {
    expect(
      agentsNorm.includes("does **not** extend to a `gated` verdict"),
      "AGENTS.md's auto-merge exemption bullet must state the exemption " +
        "'does **not** extend to a `gated` verdict' so the squash-merge " +
        "authority is scoped to the auto-merge verdict only.",
    ).toBe(true);
  });

  it("AGENTS.md names the step 9 gate-override AskUserQuestion exemption", () => {
    expect(
      agentsNorm.includes(
        "AskUserQuestion exemption: `/flow-pipeline` step 9 gate-override",
      ),
      "AGENTS.md ## Don'ts must carry a named 'AskUserQuestion exemption: " +
        "`/flow-pipeline` step 9 gate-override' bullet — the second authorised " +
        "AskUserQuestion site, documented bidirectionally with SKILL.md.",
    ).toBe(true);
  });
});

describe("/flow-coder interactive-redirect caller anchor", () => {
  // The supervisor routing a user's free-form code-change redirect through
  // /flow-coder is the fourth /flow-coder caller, distinct from the three step-N
  // callers the extractCallers symmetry lint counts. That caller has no
  // `<skill> step N` token (the routing happens in the /flow-pipeline
  // supervisor, filtered by extractCallers), so the lockstep count lint
  // can't see it. This block anchors on the shared literal phrase
  // 'interactive code-change redirect' so a one-sided edit — adding the
  // routing to one doc but not the rest — fails fast naming the divergent
  // file. The five docs that must all carry the phrase (co-located with a
  // /flow-coder mention) are: flow-pipeline/SKILL.md (Mid-flight section +
  // exemption #6), its redirect-handling.md reference, AGENTS.md's /flow-coder
  // exemption bullet, flow-coder/SKILL.md, and the repo-root
  // references/exemption-contracts.md /flow-coder section.
  const ANCHOR = "interactive code-change redirect";

  it.each([
    ["flow-pipeline/SKILL.md", content],
    ["flow-pipeline/references/redirect-handling.md", redirectHandlingContent],
    ["AGENTS.md", agentsContent],
    ["flow-coder/SKILL.md", coderContent],
    ["references/exemption-contracts.md", exemptionContractsContent],
  ])(
    "%s carries the 'interactive code-change redirect' anchor phrase",
    (label, docContent) => {
      const anchorIdx = docContent.indexOf(ANCHOR);
      // Co-location check: a /flow-coder mention must appear within a bounded
      // window around the anchor, so the "next to a /flow-coder mention"
      // invariant the failure message promises is actually enforced — a
      // relocated phrase severed from its /flow-coder context fails here.
      const WINDOW = 400;
      const near =
        anchorIdx !== -1 &&
        docContent
          .slice(
            Math.max(0, anchorIdx - WINDOW),
            anchorIdx + ANCHOR.length + WINDOW,
          )
          .includes("/flow-coder");
      expect(
        near,
        `${label} must contain the literal '${ANCHOR}' phrase next to a /flow-coder ` +
          `mention (within ${WINDOW} chars). This is the fourth /flow-coder caller ` +
          `(the /flow-pipeline supervisor routing a user's free-form ` +
          `code-change redirect through /flow-coder) and is documented across all ` +
          `five docs in lockstep — a missing or relocated phrase here means a ` +
          `one-sided edit drifted ${label} out of sync with the others.`,
      ).toBe(true);
    },
  );
});

describe("browser-driven UI-validation structural anchors", () => {
  // Anchors the UI-validation feature's prose wiring so a doc rename can't
  // silently drift away from what the helper (bin/flow-ui-validate.ts) and
  // the skill prose contract on. Each phrase below is the EXACT string the
  // corresponding doc carries; renaming the phrase requires updating this
  // assertion in the same commit.

  it("flow-pipeline SKILL.md Step 6 documents the Automated UI-smoke pass", () => {
    // Step 6 (verifying) wires the LLM-free flow-ui-validate helper + the
    // MCP probe → --mcp-absent fallback → loud-skip relay → ok:false fix-loop
    // routing. Consumed by /flow-verify's own SKILL.md (which mirrors it) and the
    // supervisor that drives Step 6. NOT a new ## Step heading (the 12-step
    // count is asserted above).
    expect(
      content.includes("Automated UI-smoke pass (before/alongside"),
      "flow-pipeline SKILL.md Step 6 must document the 'Automated UI-smoke " +
        "pass'. It is the supervisor-side contract for the browser-validation " +
        "capability; /flow-verify SKILL.md and the rubric reference it.",
    ).toBe(true);
  });

  it("flow-pipeline SKILL.md Step 6 documents the adaptive noise filter", () => {
    // The other half of the noise filter: when an ok:false flags benign noise
    // unrelated to the diff, the agent adds the substring to the manifest's
    // ignore*Patterns and COMMITS that change (lands in the PR diff) instead of
    // burning a fix-loop attempt. verify SKILL.md mirrors this guidance.
    expect(
      content.includes("Adaptive noise filter:") &&
        content.includes(
          "add the offending substring to the manifest's `ignoreRequestPatterns`",
        ),
      "flow-pipeline SKILL.md Step 6 must document the 'Adaptive noise " +
        "filter' (add benign-noise substring to ignoreRequestPatterns + " +
        "commit the manifest change, don't fix-loop on it).",
    ).toBe(true);
  });

  it("flow-pipeline SKILL.md Step 8 points to /flow-pr-review Step 8c visual pass", () => {
    expect(
      content.includes(
        "subjective visual-appearance pass against the browser-validation capability",
      ),
      "flow-pipeline SKILL.md Step 8 must point to the Step 8c visual " +
        "pass so the reviewing-phase wiring is discoverable.",
    ).toBe(true);
  });

  it("verify SKILL.md documents the Optional UI-smoke pass", () => {
    // /flow-verify runs flow-ui-validate alongside flow-pre-commit; the MCP probe,
    // --mcp-absent fallback, loud-nudge relay, and ok:false fix-loop routing
    // live here. Mirrors flow-pipeline Step 6.
    expect(
      verifyContent.includes("Optional UI-smoke pass"),
      "verify SKILL.md must document the 'Optional UI-smoke pass'.",
    ).toBe(true);
    expect(
      verifyContent.includes("flow-ui-validate"),
      "verify SKILL.md must name the 'flow-ui-validate' helper.",
    ).toBe(true);
  });

  it("manual-test-rubric.md adds the enumerated visual-appearance category", () => {
    // The new visual-appearance category + the automatable reclassification
    // are what flip browser-observable checks from genuinely-manual to
    // runnable; /flow-pr-review SKILL.md Step 8c and report-template.md reference
    // the 'visual-appearance' rubric category by name.
    expect(
      manualTestRubricContent.includes(
        "Enumerated visual-appearance assertions",
      ),
      "manual-test-rubric.md must contain the 'Enumerated visual-appearance " +
        "assertions' category heading.",
    ).toBe(true);
    expect(
      manualTestRubricContent.includes(
        "Automatable via the browser-validation capability",
      ),
      "manual-test-rubric.md must reclassify browser-observable checks as " +
        "'Automatable via the browser-validation capability'.",
    ).toBe(true);
  });

  it("manual-test-rubric.md adds the browser-flakiness caveat", () => {
    expect(
      manualTestRubricContent.includes("Caveat: browser-validation flakiness"),
      "manual-test-rubric.md must contain the 'Caveat: browser-validation " +
        "flakiness' caveat (gate on a11y snapshot + wait_for; screenshots " +
        "are evidence-not-gate).",
    ).toBe(true);
  });

  it("manual-test-rubric.md adds the durable-test-precedence note", () => {
    expect(
      manualTestRubricContent.includes("Durable-test precedence"),
      "manual-test-rubric.md must contain the 'Durable-test precedence' note " +
        "(prefer Playwright/vitest for permanent guards; MCP for live + visual).",
    ).toBe(true);
  });

  it("manual-test-rubric.md pins the local-and-reversible boundary phrase", () => {
    expect(
      manualTestRubricContent.includes("local and reversible"),
      "manual-test-rubric.md must contain the canonical boundary phrase 'local " +
        "and reversible' — a Test Step whose only unmet preconditions are local " +
        "and reversible is RUNNABLE, not manual. This is the single source of " +
        "truth the SKILL surfaces; dropping the phrase unmoors the whole " +
        "self-satisfy-preconditions contract from its anchor.",
    ).toBe(true);
  });

  it("manual-test-rubric.md pins the probe-then-attempt fallback language", () => {
    expect(
      manualTestRubricContent.includes("Probe-then-attempt"),
      "manual-test-rubric.md must contain 'Probe-then-attempt' — when unsure a " +
        "local dependency is running, probe, attempt to start it, and only fall " +
        "back to manual after a genuine attempt fails. Dropping it lets agents " +
        "pre-label local-stack steps manual without trying.",
    ).toBe(true);
    expect(
      manualTestRubricContent.includes("outside the agent's control"),
      "manual-test-rubric.md must state the fallback trigger as a failure 'outside " +
        "the agent's control' — the bar for leaving an item manual after a genuine " +
        "start attempt. Without this phrase the fallback has no anchored trigger.",
    ).toBe(true);
  });

  it("manual-test-rubric.md pins the guardrail-preservation clause", () => {
    expect(
      manualTestRubricContent.includes(
        "This boundary does NOT loosen any guardrail",
      ),
      "manual-test-rubric.md must keep the guardrail-preservation clause " +
        "('This boundary does NOT loosen any guardrail on external, destructive, " +
        "or irreversible actions') so the local-and-reversible boundary can never " +
        "be read as license over prod writes, destructive ops, the " +
        ".github/workflows/* approval gate, or real secrets.",
    ).toBe(true);
  });

  it("references/ui-validation-evidence.md documents the browser-item runnable bucket", () => {
    // Step 8c's full runnable-bucket procedure moved out of flow-pr-review/SKILL.md
    // (line-budget extraction) into references/ui-validation-evidence.md; the
    // canonical 'Browser-item runnable bucket' detail now lives there, and
    // Step 8c carries only a concise pointer to it.
    expect(
      uiValidationEvidenceContent.includes("Browser-item runnable bucket"),
      "references/ui-validation-evidence.md must document the 'Browser-item " +
        "runnable bucket' path for visual-appearance items.",
    ).toBe(true);
    expect(
      prReviewContent.includes("references/ui-validation-evidence.md"),
      "pr-review SKILL.md Step 8c must point to " +
        "references/ui-validation-evidence.md for the extracted detail.",
    ).toBe(true);
  });

  it("report-template.md documents the visual-appearance evidence rows", () => {
    expect(
      reportTemplateContent.includes("For a ticked **visual-appearance** item"),
      "report-template.md must document the visual-appearance evidence rows " +
        "(a11y-snapshot primary, screenshot referenced by path).",
    ).toBe(true);
  });

  it("ui-ux SKILL.md adds the snapshot/screenshot evaluation entry point", () => {
    expect(
      uiUxContent.includes("Evaluate from a captured snapshot/screenshot"),
      "ui-ux SKILL.md must contain the 'Evaluate from a captured " +
        "snapshot/screenshot' step — the entry point /flow-pr-review Step 8c invokes.",
    ).toBe(true);
  });

  it("AGENTS.md.template documents the ui-validation.json onboarding", () => {
    expect(
      agentsTemplateContent.includes("three-ingredient new-repo onboarding"),
      "templates/AGENTS.md.template must document the 'three-ingredient " +
        "new-repo onboarding' for UI validation.",
    ).toBe(true);
    expect(
      agentsTemplateContent.includes("ui-validation.json"),
      "templates/AGENTS.md.template must reference 'ui-validation.json'.",
    ).toBe(true);
  });

  it("AGENTS.md.template documents the ignoreRequestPatterns noise field", () => {
    // The optional ignore*Patterns substring lists suppress benign browser
    // noise (canonically the favicon 404) before a route's ok is computed;
    // the manifest field reference must name them.
    expect(
      agentsTemplateContent.includes("ignoreRequestPatterns"),
      "templates/AGENTS.md.template must reference 'ignoreRequestPatterns' in " +
        "the ui-validation manifest field reference.",
    ).toBe(true);
  });

  it("guards the secret-value guardrail phrase across the bootstrap doc sites", () => {
    // The bootstrap can auto-write a manifest, so the "names/config only,
    // never a secret VALUE" boundary must be stated at every site that
    // documents the manifest's provenance. Anchor on a stable single-line
    // substring present in the helper doc comment, the schema doc comment,
    // and the onboarding template.
    const guardrailAnchor = "never a secret value";
    expect(
      flowUiValidateContent.includes(guardrailAnchor),
      "bin/flow-ui-validate.ts doc comment must state the secret-value " +
        "guardrail (anchor: '" +
        guardrailAnchor +
        "').",
    ).toBe(true);
    expect(
      uiValidationSchemaContent.includes(guardrailAnchor),
      "bin/lib/ui-validation-schema.ts doc comment must state the " +
        "secret-value guardrail (anchor: '" +
        guardrailAnchor +
        "').",
    ).toBe(true);
    expect(
      agentsTemplateContent.includes(guardrailAnchor),
      "templates/AGENTS.md.template must state the secret-value guardrail " +
        "(anchor: '" +
        guardrailAnchor +
        "').",
    ).toBe(true);
  });

  it("guards the self-improving-manifest persist-back instruction across doc sites", () => {
    // The CRITICAL persist-back instruction (the agent commits on-the-fly
    // launch adaptations back into .flow/ui-validation.json) must survive at
    // all four prose sites that document it so it can't be silently dropped
    // from any one of them. Anchor on a stable single-line substring written
    // into every site.
    const anchor = "persists the launch adaptation back into";
    expect(
      agentsTemplateContent.includes(anchor),
      "templates/AGENTS.md.template must document the self-improving-manifest " +
        "persist-back instruction (anchor: '" +
        anchor +
        "').",
    ).toBe(true);
    expect(
      content.includes(anchor),
      "flow-pipeline SKILL.md Step 6 must document the self-improving-manifest " +
        "persist-back instruction (anchor: '" +
        anchor +
        "').",
    ).toBe(true);
    expect(
      verifyContent.includes(anchor),
      "flow-verify/SKILL.md must document the self-improving-manifest " +
        "persist-back instruction (anchor: '" +
        anchor +
        "').",
    ).toBe(true);
    expect(
      uiValidationEvidenceContent.includes(anchor),
      "references/ui-validation-evidence.md must document the " +
        "self-improving-manifest persist-back instruction (anchor: '" +
        anchor +
        "').",
    ).toBe(true);
    expect(
      uiSmokePassContent.includes(anchor),
      "flow-pipeline/references/ui-smoke-pass.md must document the " +
        "self-improving-manifest persist-back instruction (anchor: '" +
        anchor +
        "').",
    ).toBe(true);
  });

  it("flow-pipeline/references/ui-smoke-pass.md holds the shared gate-time procedure", () => {
    // The gate-time UI-smoke procedure was de-duplicated out of
    // flow-pipeline SKILL.md Step 6 AND flow-verify/SKILL.md into one shared
    // references/ file both consumers cite (issue #318). The canonical
    // long-form drive-MCP sentence now lives ONLY here; both SKILLs keep a
    // concise pointer. Guard the body's presence in the shared file and the
    // pointer link from each consumer.
    const driveMcpSentence =
      "`navigate_page` → `wait_for` → `take_snapshot` → " +
      "`list_console_messages`";
    expect(
      uiSmokePassContent.includes(driveMcpSentence),
      "ui-smoke-pass.md must carry the canonical drive-MCP-per-route " +
        "sentence (the de-duplicated procedure body).",
    ).toBe(true);
    expect(
      content.includes("references/ui-smoke-pass.md"),
      "flow-pipeline SKILL.md Step 6 must point to " +
        "references/ui-smoke-pass.md for the shared procedure.",
    ).toBe(true);
    expect(
      verifyContent.includes("flow-pipeline/references/ui-smoke-pass.md"),
      "verify SKILL.md must point to the shared " +
        "flow-pipeline/references/ui-smoke-pass.md procedure.",
    ).toBe(true);
    // Anti-drift: the long-form drive-MCP sentence must survive in exactly
    // one file under skills/ — the shared reference, not a re-introduced
    // copy in either citing SKILL.
    const copiesUnderSkills = [
      content,
      verifyContent,
      uiValidationEvidenceContent,
    ].filter((c) => c.includes(driveMcpSentence)).length;
    expect(
      copiesUnderSkills,
      "the long-form drive-MCP sentence must not be duplicated back into a " +
        "citing SKILL (it lives only in ui-smoke-pass.md).",
    ).toBe(0);
  });

  it("references/ui-validation-evidence.md documents the screenshot save-path cascade", () => {
    // The worktree may not be an MCP workspace root, so take_screenshot into
    // it can be sandbox-denied; the worktree -> session-cwd -> skip cascade
    // (a11y snapshot is the gate, screenshots evidence) moved with the rest of
    // the Step 8c detail into references/ui-validation-evidence.md.
    expect(
      uiValidationEvidenceContent.includes("Screenshot save-path cascade"),
      "references/ui-validation-evidence.md must document the 'Screenshot " +
        "save-path cascade' for screenshot evidence.",
    ).toBe(true);
  });

  it("browser-teardown contract is anchored across both teardown sections and the supervisor cleanup checkpoint", () => {
    // The browser-teardown contract (close the per-pipeline isolated MCP
    // page, symmetric with the existing dev-server teardown) lives in a
    // "## Teardown (servers and browser, symmetric)" section in BOTH
    // browser-pass reference files, and the flow-pipeline supervisor's
    // "# Resource cleanup" checkpoint plus the pr-review Step 8c.iii pointer
    // cite that teardown by the bare literal "Teardown". flow-md-validate
    // can't catch a prose heading rename, so pin the heading text + the
    // citing checkpoint here so the cross-reference can't rot silently.
    const teardownHeading = "## Teardown (servers and browser, symmetric)";
    expect(
      uiSmokePassContent.includes(teardownHeading),
      "ui-smoke-pass.md must carry the '" +
        teardownHeading +
        "' section (browser teardown symmetric with the server teardown).",
    ).toBe(true);
    expect(
      uiValidationEvidenceContent.includes(teardownHeading),
      "ui-validation-evidence.md must carry the '" +
        teardownHeading +
        "' section so the supervisor cleanup checkpoint's prose cite resolves.",
    ).toBe(true);
    expect(
      content.includes("# Resource cleanup (before any terminal state)"),
      "flow-pipeline SKILL.md must carry the '# Resource cleanup (before any " +
        "terminal state)' checkpoint tying the per-pass teardown sections to " +
        "the terminal-state contract.",
    ).toBe(true);

    // The process-level teardown (SIGTERMing the session's own
    // chrome-devtools-mcp server so its shutdown() reaps the Chrome
    // subprocess) is a distinct mechanism from the page/context cleanup
    // above — pin the literal helper name at all three wired prose
    // surfaces so a future prose edit can't silently drop it.
    expect(
      content.includes("flow-browser-teardown"),
      "flow-pipeline SKILL.md must name 'flow-browser-teardown' in the " +
        "supervisor cleanup checkpoint.",
    ).toBe(true);

    // Section-scoped: a bare mention in the "# Resource cleanup" prose is
    // not sufficient — the helper must actually be WIRED into each
    // terminal-state runbook block, not just described. Slice from the
    // heading to the next top-level heading and require the literal call
    // to appear at least once per named terminal-state site (MERGED,
    // gated, both merged-externally renders, and the canonical NEEDS
    // HUMAN Failure-paths block) so a future prose-only edit can't
    // silently regress back to narrative-only.
    const resourceCleanupStart = content.indexOf(
      "# Resource cleanup (before any terminal state)",
    );
    const nextHeadingIdx = content.indexOf("\n# ", resourceCleanupStart + 1);
    const resourceCleanupSection = content.slice(
      resourceCleanupStart,
      nextHeadingIdx === -1 ? undefined : nextHeadingIdx,
    );
    expect(
      resourceCleanupSection.includes("flow-browser-teardown --reap --record"),
      "the '# Resource cleanup' section must name the exact wired call " +
        "'flow-browser-teardown --reap --record', not just the bare helper name.",
    ).toBe(true);

    const wiredCallCount = (
      content.match(/flow-browser-teardown --reap --record/g) ?? []
    ).length;
    expect(
      wiredCallCount,
      "flow-browser-teardown --reap --record must be wired into every " +
        "named terminal-state runbook block (MERGED, gated, both " +
        "merged-externally renders, closed-no-merge, the canonical " +
        "NEEDS HUMAN Failure-paths block, and both cancelled renders — " +
        "step 4's approval-handling Cancel branch and the mid-flight-redirect " +
        "Cancel branch) — a count below 8 means a site silently lost its call.",
    ).toBeGreaterThanOrEqual(8);
    expect(
      uiSmokePassContent.includes("flow-browser-teardown"),
      "ui-smoke-pass.md must name 'flow-browser-teardown' in its Teardown section.",
    ).toBe(true);
    expect(
      uiValidationEvidenceContent.includes("flow-browser-teardown"),
      "ui-validation-evidence.md must name 'flow-browser-teardown' in its Teardown section.",
    ).toBe(true);
  });

  it("flow-spawn adoption: step-7 CI-poller launch and ui-smoke dev-server launch both go through the wrapper", () => {
    // Semantic-token anchors (tolerant of whitespace/reformatting), not a
    // fixed byte sequence — a later line-wrap or quote-style change must not
    // red this suite for a non-functional edit, while a genuinely-dropped
    // wrapper must still fail.
    expect(
      /flow-spawn\s+--class\s+default\s+--\s+flow-ci-wait/.test(content),
      "flow-pipeline SKILL.md step 7 must launch flow-ci-wait through " +
        "`flow-spawn --class default --`.",
    ).toBe(true);
    expect(
      /^flow-ci-wait "\$PR"/m.test(content),
      "flow-pipeline SKILL.md must not carry a bare (unwrapped) " +
        '`flow-ci-wait "$PR"` launch line.',
    ).toBe(false);
    expect(
      /^flow-ci-check "\$PR"/m.test(content),
      "flow-pipeline SKILL.md step 7 must run the foreground " +
        '`flow-ci-check "$PR"` decider call.',
    ).toBe(true);

    const uiSmokeLaunchLine = uiSmokePassContent
      .split("\n")
      .find(
        (line) =>
          line.includes("flow-spawn") &&
          /--class\s+default/.test(line) &&
          line.includes("sh -c"),
      );
    expect(
      uiSmokeLaunchLine,
      "ui-smoke-pass.md's launch line must carry `flow-spawn`, " +
        "`--class default`, and `sh -c` together on one line.",
    ).toBeDefined();

    expect(
      /never written to/i.test(uiSmokePassContent),
      "ui-smoke-pass.md must still carry the never-write-a-config-file " +
        "sentence.",
    ).toBe(true);

    expect(
      /dedicated ports\s+through\s+`flow-spawn`/.test(verifyContent),
      "flow-verify SKILL.md's UI-smoke launch pointer must name `flow-spawn`.",
    ).toBe(true);
  });

  it("svelte + tailwind-shadcn SKILLs direct authoring enumerated visual assertions", () => {
    const phrase =
      "UI-change Test Steps: author enumerated visual-appearance assertions";
    expect(
      svelteContent.includes(phrase),
      "svelte SKILL.md must direct authoring enumerated visual-appearance " +
        "assertions as Test Steps (cross-linking the rubric category).",
    ).toBe(true);
    expect(
      tailwindShadcnContent.includes(phrase),
      "tailwind-shadcn SKILL.md must direct authoring enumerated " +
        "visual-appearance assertions as Test Steps.",
    ).toBe(true);
  });

  it("the multi-viewport 'UI traits to verify' rubric stays wired and not skippable", () => {
    // The per-viewport responsive rubric is the single source of truth both
    // browser passes apply per captured viewport; this anchor fails if the
    // rubric is dropped, un-wired from one pass, or the 1.4.10 Reflow citation
    // is removed from the ui-ux judgment dimension.
    const rubricHeading = "## UI traits to verify";
    expect(
      uiValidationEvidenceContent.includes(rubricHeading),
      "references/ui-validation-evidence.md must author the canonical " +
        "'## UI traits to verify' rubric block (the single source of truth " +
        "both browser passes apply per captured viewport).",
    ).toBe(true);
    expect(
      uiSmokePassContent.includes("UI traits to verify"),
      "flow-pipeline/references/ui-smoke-pass.md must reference the " +
        "'UI traits to verify' rubric so both passes point at the same block.",
    ).toBe(true);
    expect(
      uiUxContent.includes("1.4.10"),
      "ui-ux SKILL.md must cite WCAG 1.4.10 Reflow in the responsive-layout " +
        "judgment dimension (the no-horizontal-scroll-at-320px floor).",
    ).toBe(true);
  });
});

describe("terminal-state reap wiring lint", () => {
  const REAP_RECORD = "flow-browser-teardown --reap --record";
  const TERMINAL_STATUS_RE =
    /flow-gate-summary --status (merged|gated|needs-human|cancelled)/g;

  it("D4: no flow-browser-teardown invocation is || true-swallowed", () => {
    const matches =
      content.match(/flow-browser-teardown[^\n]*\|\|\s*true/g) ?? [];
    expect(
      matches,
      "flow-browser-teardown must never be `|| true`-swallowed (D4) — a " +
        "non-zero exit on the failure path must surface, never be " +
        `silently absorbed. Found: ${JSON.stringify(matches)}`,
    ).toHaveLength(0);
  });

  /**
   * STRUCTURAL, not a bare count: every WIRED terminal `flow-gate-summary`
   * occurrence (identified by carrying `--cleanup` before the NEXT terminal
   * occurrence) must have its own preceding `flow-browser-teardown --reap
   * --record` call, newer than the reap call the previous wired site used.
   * A bare >=8 count would pass unchanged if a 9th terminal site were added
   * with `--cleanup` but no preceding reap, or if two sites shared one
   * reap call — exactly the weakness a count can't catch.
   *
   * A handful of PRE-EXISTING terminal `flow-gate-summary` occurrences
   * are genuinely out of scope for this feature: the deep interior NEEDS
   * HUMAN escalation branches inside the step-10 merge-conflict-resolution
   * flow that explicitly delegate to "the standard `# Failure paths`
   * chain" (merge-resolver-spawn-denied, merge-failed x3) — that chain is
   * itself wired, so wiring them separately would double-render — and the
   * elliptical step-9/step-10 resume-path back-references that cite the
   * SAME render used elsewhere via `...` rather than a full argument list.
   *
   * Those are PINNED BY COUNT, never skipped silently. An earlier draft of
   * this check did a bare `if (!isWired) continue`, which was
   * self-defeating: the one regression it most needed to catch — a NEW
   * terminal site added with neither a reap nor `--cleanup` — is exactly
   * the shape that skip waved through. Pinning the count makes any new
   * unwired site trip this spec and forces a deliberate choice: wire it,
   * or bump the expectation with a written justification.
   */
  function checkTerminalSitesWired(
    text: string,
    label: string,
    expectedUnwired: number,
  ): void {
    const matches = [...text.matchAll(TERMINAL_STATUS_RE)];
    const unwiredLines: number[] = [];
    let prevReapIdx = -1;
    for (let i = 0; i < matches.length; i++) {
      const idx = matches[i].index ?? 0;
      const nextIdx = matches[i + 1]?.index ?? text.length;
      // Bounded lookahead: a wired call's --cleanup flag always sits within
      // a few hundred chars of its own --status flag. Capping the window
      // (rather than scanning all the way to the next terminal occurrence,
      // which can be thousands of chars away or even EOF) stops an
      // unrelated LATER --cleanup mention from falsely marking an
      // elliptical resume-path back-reference as wired.
      const segment = text.slice(idx, Math.min(nextIdx, idx + 400));
      const isWired = /--cleanup\b/.test(segment);
      if (!isWired) {
        unwiredLines.push(text.slice(0, idx).split("\n").length);
        continue;
      }
      const reapIdx = text.lastIndexOf(REAP_RECORD, idx);
      expect(
        reapIdx,
        `${label}: the wired terminal call '${matches[i][0]}' at offset ` +
          `${idx} must have a preceding '${REAP_RECORD}' call.`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        reapIdx,
        `${label}: the reap call preceding '${matches[i][0]}' at offset ` +
          `${idx} must be its OWN reap call, not one already claimed by ` +
          `an earlier wired terminal site.`,
      ).toBeGreaterThan(prevReapIdx);
      prevReapIdx = reapIdx;
    }
    expect(
      unwiredLines.length,
      `${label}: expected exactly ${expectedUnwired} terminal ` +
        `flow-gate-summary occurrence(s) to be deliberately unwired (see ` +
        `the comment above this helper), but found ${unwiredLines.length} ` +
        `at line(s) ${unwiredLines.join(", ") || "(none)"}. A NEW unwired ` +
        `terminal site is the exact regression this spec exists to catch: ` +
        `either give it its own preceding '${REAP_RECORD}' call plus ` +
        `--cleanup, or raise this expectation deliberately and say why.`,
    ).toBe(expectedUnwired);
  }

  it("every wired terminal flow-gate-summary occurrence in SKILL.md has its own preceding reap call", () => {
    // 8 deliberately unwired: 5 step-10 merge-resolution escalations that
    // delegate to the (already-wired) `# Failure paths` chain, and 3
    // elliptical resume-path back-references. Was pinned at 7 before the
    // PM-lens TLDR/--lens sweep (Task 9): the step-10 conflict-class
    // "On retry failure" escalation's `flow-gate-summary --status
    // needs-human` text originally wrapped `--status` and `needs-human`
    // onto separate lines, which made TERMINAL_STATUS_RE silently miss it
    // — a pre-existing formatting fluke, not a deliberate gap. Adding the
    // `--tldr`/`--lens` flags there reflowed the paragraph so the two
    // words landed on one line, making the site newly visible to this
    // lint (still correctly unwired — it delegates to the same `#
    // Failure paths` chain as its siblings). Bumped 7 → 8 to reflect the
    // true count, not to loosen the check.
    checkTerminalSitesWired(content, "flow-pipeline/SKILL.md", 8);
  });

  it("every wired terminal flow-gate-summary occurrence in the reference docs has its own preceding reap call", () => {
    // All three reference docs are fully wired — no deliberate gap.
    checkTerminalSitesWired(
      redirectHandlingContent,
      "references/redirect-handling.md",
      0,
    );
    checkTerminalSitesWired(
      failureRecoveryContent,
      "references/failure-recovery.md",
      0,
    );
    checkTerminalSitesWired(
      pollingProtocolContent,
      "references/polling-protocol.md",
      0,
    );
    // Two deliberately unwired: the auto-merge and already-merged rows'
    // elliptical `flow-gate-summary --status merged ...` back-references —
    // same shape as SKILL.md's elliptical resume-path back-references.
    checkTerminalSitesWired(
      autoMergeRubricContent,
      "references/auto-merge-rubric.md",
      2,
    );
  });

  it("the step-11 MERGED block and the Failure-paths NEEDS HUMAN block run the reap as a standalone, unchained, separate-line step before the render", () => {
    const namedBlocks: Array<{ label: string; startAnchor: string }> = [
      {
        label: "step-11 MERGED block",
        startAnchor:
          'flow-followups run > "$WORKTREE/.flow-tmp/followups-block.txt"  # executes auto-allowlisted entries',
      },
      {
        label: "Failure-paths NEEDS HUMAN block",
        startAnchor:
          'flow-followups run --note-only > "$WORKTREE/.flow-tmp/followups-block.txt"  # captures the deferred LOCAL FOLLOW-UPS block',
      },
    ];
    for (const { label, startAnchor } of namedBlocks) {
      const startIdx = content.indexOf(startAnchor);
      expect(
        startIdx,
        `${label}: anchor text not found in SKILL.md.`,
      ).toBeGreaterThanOrEqual(0);
      const fenceEnd = content.indexOf("\n```", startIdx);
      expect(fenceEnd, `${label}: closing fence not found.`).toBeGreaterThan(
        startIdx,
      );
      const block = content.slice(startIdx, fenceEnd);

      const reapIdx = block.indexOf(REAP_RECORD);
      const gateSummaryIdx = block.indexOf("flow-gate-summary --status");
      expect(
        reapIdx,
        `${label}: must contain '${REAP_RECORD}'.`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        gateSummaryIdx,
        `${label}: must contain a flow-gate-summary call.`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        reapIdx,
        `${label}: the reap call must precede the flow-gate-summary render.`,
      ).toBeLessThan(gateSummaryIdx);

      const reapLine =
        block.slice(0, block.indexOf("\n", reapIdx)).split("\n").pop() ?? "";
      // Strip the trailing shell comment before checking for chaining —
      // the explanatory comment legitimately uses ';' as prose punctuation
      // (e.g. "records the outcome in state.json; always exits 0"), which
      // must not be mistaken for an actual command separator.
      const reapCode = reapLine.split(/\s#/)[0] ?? reapLine;
      expect(
        reapCode.includes("&&") || reapCode.includes(";"),
        `${label}: the reap call must be on its OWN line, never ` +
          `&&-chained or ;-joined to the render that follows: '${reapLine}'`,
      ).toBe(false);
      expect(
        reapLine.includes("flow-gate-summary"),
        `${label}: the reap call and the flow-gate-summary render must be ` +
          `on separate lines, found both on: '${reapLine}'`,
      ).toBe(false);
    }
  });

  it("AGENTS.md and SKILL.md's Resource cleanup section both name all three layers (point-of-use, backstop, crash-path)", () => {
    for (const kw of ["point-of-use", "backstop", "crash-path"]) {
      expect(
        agentsContent.includes(kw),
        `AGENTS.md's spawned-resources Don'ts bullet must name '${kw}'.`,
      ).toBe(true);
    }
    const resourceCleanupStart = content.indexOf(
      "# Resource cleanup (before any terminal state)",
    );
    const nextHeadingIdx = content.indexOf("\n# ", resourceCleanupStart + 1);
    const resourceCleanupSection = content.slice(
      resourceCleanupStart,
      nextHeadingIdx === -1 ? undefined : nextHeadingIdx,
    );
    for (const kw of ["point-of-use", "backstop", "crash-path"]) {
      expect(
        resourceCleanupSection.includes(kw),
        `SKILL.md's '# Resource cleanup' section must name '${kw}'.`,
      ).toBe(true);
    }
  });
});

describe("product-planning MODE: epic routing anchor", () => {
  // The `MODE: epic` → epic-discovery-instructions.md branch in
  // flow-product-planning/SKILL.md is the one piece of executable wiring the
  // epic-designer F4 PR added, otherwise covered only by one-shot PR-body
  // greps that never run again. This durable anchor goes red on `npm run
  // verify` if the mode branch or its sibling file reference is dropped from
  // the spawn template — the same regression class the discovery-instructions
  // anchors above guard. Standalone block so it doesn't disturb the
  // "exactly 9 Task-tool exemptions" assertion.
  const PRODUCT_PLANNING_SKILL_MD_PATH = path.resolve(
    HERE,
    "..",
    "skills",
    "pipeline",
    "flow-product-planning",
    "SKILL.md",
  );
  const productPlanningContent = fs.readFileSync(
    PRODUCT_PLANNING_SKILL_MD_PATH,
    "utf8",
  );

  it("SKILL.md carries the MODE: epic branch and names epic-discovery-instructions.md", () => {
    expect(
      productPlanningContent.includes("MODE: epic"),
      "flow-product-planning/SKILL.md must reference 'MODE: epic' — the spawn " +
        "template's epic-grain routing branch. Dropping it un-wires the " +
        "epic designer from /flow-product-planning's single discovery spawn site.",
    ).toBe(true);
    expect(
      productPlanningContent.includes("epic-discovery-instructions.md"),
      "flow-product-planning/SKILL.md must reference 'epic-discovery-instructions.md' " +
        "— the epic-grain sibling INSTRUCTIONS_PATH the MODE: epic branch resolves to.",
    ).toBe(true);
  });

  // PR #353 follow-up (i): keep the epic-mode artifact names coherent across
  // the spawn template's epic {{OUTPUT_PATHS}} Write-block AND the post-spawn
  // epic existence-check, so a future edit can't fix one branch and miss the
  // other. `design.md` and `manifest.json` must each appear in BOTH regions.
  it("design.md and manifest.json each appear in BOTH the epic Write-block AND the epic existence-check", () => {
    const writeBlock =
      productPlanningContent
        .split("### `{{OUTPUT_PATHS}}` — epic mode")[1]
        ?.split(/^# /m)[0] ?? "";
    expect(
      writeBlock.length,
      "flow-product-planning/SKILL.md must contain the `### {{OUTPUT_PATHS}} — epic " +
        "mode` Write-block section.",
    ).toBeGreaterThan(0);

    const existenceCheck =
      productPlanningContent
        .split("**Epic mode (`MODE: epic`):**")[1]
        ?.split(/\n- /)[0] ?? "";
    expect(
      existenceCheck.length,
      "flow-product-planning/SKILL.md must contain the `**Epic mode (MODE: epic):**` " +
        "Verification existence-check bullet.",
    ).toBeGreaterThan(0);

    for (const [region, label] of [
      [writeBlock, "epic {{OUTPUT_PATHS}} Write-block"],
      [existenceCheck, "epic existence-check"],
    ] as const) {
      for (const artifact of ["design.md", "manifest.json"]) {
        expect(
          region.includes(artifact),
          `The ${label} in flow-product-planning/SKILL.md must name '${artifact}'. ` +
            `Both epic artifacts must appear in BOTH the Write-block and the ` +
            `existence-check (PR #353 follow-up i) so the two stay coherent.`,
        ).toBe(true);
      }
    }
  });
});

describe("/flow-epic-create supervisor SKILL.md literal anchors", () => {
  // Durable structural guards for the /flow-epic-create supervisor (Task 3). These
  // go red on `npm run verify` if any load-bearing literal — the checkpoint
  // phase, both bare-name validators, the MODE: epic Task spawn, the named
  // AskUserQuestion form, the ToolSearch select:Task escalate-on-miss
  // paragraph, flow-open-pr, approve/redirect/cancel, the no-merge HALT, the R1
  // no-bin/lib constraint, OR the resume-mode literals — is dropped from the
  // skill. STANDALONE block so it does NOT disturb the "exactly 9 Task-tool
  // exemptions" / one-AskUserQuestion-form assertions (which are
  // /flow-pipeline-anchored and must stay green).
  const EPIC_CREATE_SKILL_MD_PATH = path.resolve(
    HERE,
    "..",
    "skills",
    "pipeline",
    "flow-epic-create",
    "SKILL.md",
  );
  const epicCreateContent = fs.readFileSync(EPIC_CREATE_SKILL_MD_PATH, "utf8");

  const REQUIRED_LITERALS: Array<[string, string]> = [
    ["epic-design-pending-review", "the review checkpoint phase"],
    ["flow-epic-manifest-schema --validate", "the bare-name schema validator"],
    ["flow-epic-dag --validate", "the bare-name DAG validator"],
    ["MODE: epic", "the designer fan-out mode flag"],
    ["AskUserQuestion", "the materiality-gated clarification form"],
    ['ToolSearch query="select:Task"', "the Task-schema load preamble"],
    [
      "task-tool-unavailable: epic-create-designer",
      "the escalate-on-Task-miss NEEDS HUMAN tag",
    ],
    ["flow-open-pr", "the idempotent design-PR open"],
    ["flow-new-worktree", "the per-pipeline worktree creation"],
    ["flow-remove-worktree", "the cancel-path worktree cleanup"],
    ["never import", "the R1 no-bin/lib-import constraint"],
    // Step 4.5 cross-model design-review gate literals
    ["flow-plan-review", "the cross-model design-review Bash fan-out"],
    ["review.gemini", "the shared cross-model opt-in key"],
    ["Bash fan-out, not a tenth exemption", "the not-a-Task sibling note"],
    ["^## Decision analysis", "the consumer-side Decision-analysis gate grep"],
    // Resume-mode literals
    [
      "Use the /flow-epic-create skill in --resume mode for:",
      "the resume seed-prompt prefix",
    ],
    ["flow-epic-resume-decide", "the bare-name epic resume decider"],
    ["RESUMING AT", "the resume re-entry print"],
  ];

  it.each(REQUIRED_LITERALS)(
    "flow-epic-create/SKILL.md contains the load-bearing literal %j (%s)",
    (literal) => {
      expect(
        epicCreateContent.includes(literal),
        `skills/pipeline/flow-epic-create/SKILL.md must contain '${literal}'. ` +
          `Dropping it breaks the /flow-epic-create supervisor's contract (the F5 ` +
          `acceptance lints this literal); restore it or update this anchor in ` +
          `lockstep.`,
      ).toBe(true);
    },
  );

  it("names the approve / redirect / cancel checkpoint classifications", () => {
    for (const verb of ["approve", "redirect", "cancel"]) {
      expect(
        epicCreateContent.toLowerCase().includes(verb),
        `flow-epic-create/SKILL.md must classify '${verb}' at the ` +
          `epic-design-pending-review checkpoint.`,
      ).toBe(true);
    }
  });

  it("carries the no-merge / no-launch HALT contract (F5 opens but never merges)", () => {
    // F5 opens the design PR but never merges it; the supervisor must never
    // compute a frontier, flow-new a feature, or gh pr merge. Anchor on the
    // HALT-section heading plus the never-merge prohibition so removing the
    // guard fails the lint.
    expect(
      /never\s+merge/i.test(epicCreateContent),
      "flow-epic-create/SKILL.md must state the supervisor NEVER merges the design " +
        "PR (F5 opens but never merges; approve leaves the PR open).",
    ).toBe(true);
    expect(
      epicCreateContent.includes("HALT"),
      "flow-epic-create/SKILL.md must carry the HALT contract section.",
    ).toBe(true);
  });

  it("carries the don't-replay-approval and don't-re-open-PR resume safeguards", () => {
    expect(
      /replay an approval/i.test(epicCreateContent),
      "flow-epic-create/SKILL.md resume mode must state it does NOT replay an " +
        "approval given to a now-dead session.",
    ).toBe(true);
    expect(
      /re-open/i.test(epicCreateContent),
      "flow-epic-create/SKILL.md resume mode must state it does NOT re-open an " +
        "already-open design PR (lean on flow-open-pr's up-front probe).",
    ).toBe(true);
  });
});

describe("/flow-epic-run playbook SKILL.md literal anchors", () => {
  // Durable structural guards for the /flow-epic-run PLAYBOOK (the rebuild). These go
  // red on `npm run verify` if any load-bearing literal — the four recipe
  // headings, the hard invariants, the seed-prefix, the EPIC_DIR/R1 no-bin/lib
  // constraint, the hypothesis framing, the safe-write actuators, or the
  // duplicate-check commands — is dropped; and if any loop-era literal (the tick
  // primitive, AUTO_REDIRECT, --relaunch-slug, the judgment Task opener)
  // reappears. STANDALONE block so it does NOT disturb the "exactly 9 Task-tool
  // exemptions" / one-AskUserQuestion-form assertions: /flow-epic-run is a SEPARATE
  // sanctioned session that spawns NO Task fan-out and fires NO AskUserQuestion.
  const EPIC_RUN_SKILL_MD_PATH = path.resolve(
    HERE,
    "..",
    "skills",
    "pipeline",
    "flow-epic-run",
    "SKILL.md",
  );
  const epicRunContent = fs.readFileSync(EPIC_RUN_SKILL_MD_PATH, "utf8");

  const REQUIRED_LITERALS: Array<[string, string]> = [
    // The four recipe headings the playbook teaches.
    ["reconcile-drift", "the reconcile-cache-against-truth recipe heading"],
    [
      "launch-next",
      "the frontier-then-duplicate-check-then-launch recipe heading",
    ],
    ["amend-manifest", "the edit-and-validate-the-manifest recipe heading"],
    ["delete-when-done", "the flow-epic-done cleanup recipe heading"],
    // The byte-exact hard invariants.
    [
      "gated ⇒ escalate-only, never override",
      "the gated-escalate-only hard invariant (a gated verdict is terminal)",
    ],
    ["escalate-on-exhaustion", "the human-in-the-loop bounded-retry contract"],
    // The hypothesis framing + the deterministic hands.
    ["flow epic status <slug> --json", "the machine-readable hypothesis board"],
    ["hypothesis", "the framing that the board is a hypothesis to verify"],
    ["flow-epic-dag --frontier", "the exact ready-frontier math hand"],
    ["flow-epic-judge-context", "the bare-name feature-evidence helper"],
    ["flow epic bind", "the #1 drift-repair safe-write primitive"],
    ["flow epic launch", "the atomic create+bind primitive"],
    [
      "flow feature resume <feature-slug> --force",
      "the sanctioned clean-respawn retry actuator (never send-keys)",
    ],
    // The duplicate-check recipe commands.
    ["gh pr list", "a duplicate-check truth probe"],
    ["git worktree list", "a duplicate-check truth probe"],
    // The seed-prefix it parses + the R1 no-bin/lib constraint.
    ["Use the /flow-epic-run skill for:", "the seed-prompt prefix it parses"],
    ["EPIC_DIR", "the literal epic path embedded by the CLI (R1)"],
    ["never import", "the R1 no-bin/lib-import constraint"],
    ["never hand-edit run.json", "the safe-write-only invariant"],
  ];

  it.each(REQUIRED_LITERALS)(
    "flow-epic-run/SKILL.md contains the load-bearing literal %j (%s)",
    (literal) => {
      expect(
        epicRunContent.includes(literal),
        `skills/pipeline/flow-epic-run/SKILL.md must contain '${literal}'. ` +
          `Dropping it breaks the /flow-epic-run playbook's contract; restore it or ` +
          `update this anchor in lockstep.`,
      ).toBe(true);
    },
  );

  const ABSENT_LITERALS: Array<[string, string]> = [
    ["--once --json", "the removed deterministic tick primitive"],
    ["AUTO_REDIRECT", "the removed autonomous-redirect seed line"],
    ["--relaunch-slug", "the removed redirect-actuator flag"],
    [
      "Task-tool fan-out: /flow-epic-run → judgment sub-agent",
      "the removed judgment sub-agent Task surface opener",
    ],
  ];

  it.each(ABSENT_LITERALS)(
    "flow-epic-run/SKILL.md no longer contains the loop-era literal %j (%s)",
    (literal) => {
      expect(
        epicRunContent.includes(literal),
        `skills/pipeline/flow-epic-run/SKILL.md must NOT contain '${literal}' — the ` +
          `tick loop + judgment machinery were removed in the playbook rebuild.`,
      ).toBe(false);
    },
  );

  it("names the four hard invariants (no merge / no gated override / no send-keys / no hand-edit)", () => {
    expect(
      /never\s+merge\s+a\s+feature\s+PR/i.test(epicRunContent),
      "flow-epic-run/SKILL.md must state the playbook NEVER merges a feature PR.",
    ).toBe(true);
    expect(
      /never\s+override\s+a\s+gated\s+verdict/i.test(epicRunContent),
      "flow-epic-run/SKILL.md must state the playbook NEVER overrides a gated verdict.",
    ).toBe(true);
    expect(
      /send-keys/i.test(epicRunContent),
      "flow-epic-run/SKILL.md must forbid send-keys into a feature window (retry is a " +
        "clean respawn).",
    ).toBe(true);
    expect(
      /never\s+hand-edit\s+run\.json/i.test(epicRunContent),
      "flow-epic-run/SKILL.md must forbid hand-editing run.json (use flow epic bind).",
    ).toBe(true);
  });

  it("agrees bidirectionally with AGENTS.md that the session spawns NO Task fan-out and fires NO AskUserQuestion", () => {
    // The rebuilt /flow-epic-run session has ZERO named fan-out surfaces. Both docs
    // must state it spawns no Task/Agent and fires no AskUserQuestion form, so
    // neither can drift into re-introducing one.
    expect(
      /spawns?\s+(NO|no)\s+Task/i.test(epicRunContent) ||
        /NO\s+Task\/Agent/i.test(epicRunContent),
      "flow-epic-run/SKILL.md must state it spawns NO Task/Agent sub-agent.",
    ).toBe(true);
    expect(
      /AskUserQuestion/i.test(epicRunContent),
      "flow-epic-run/SKILL.md must state it fires NO AskUserQuestion form.",
    ).toBe(true);
    expect(
      agentsContent.includes("/flow-epic-run") &&
        /flow-epic-run[\s\S]{0,600}?(no|zero)[\s\S]{0,80}?Task/i.test(
          agentsContent,
        ),
      "AGENTS.md's /flow-epic-run bullet must state the playbook session spawns no " +
        "Task fan-out (bidirectional with flow-epic-run/SKILL.md).",
    ).toBe(true);
    expect(
      /flow-epic-run[\s\S]{0,600}?AskUserQuestion/i.test(agentsContent),
      "AGENTS.md's /flow-epic-run bullet must state it fires no AskUserQuestion form.",
    ).toBe(true);
  });
});

describe("epic-metadata auto-commit/auto-push exemption doc wiring (Task 6)", () => {
  // The base-branch guard's v4 status-board allowlist gets a documented
  // --commit --push route in the epic-run playbook, and a lean pointer in
  // AGENTS.md's ## Don'ts — both must land, and the old
  // bare-invocation-plus-hand-commit instruction must be gone so the
  // playbook can't drift back into instructing an action the guard refuses.
  const EPIC_RUN_SKILL_MD_PATH = path.resolve(
    HERE,
    "..",
    "skills",
    "pipeline",
    "flow-epic-run",
    "SKILL.md",
  );
  const epicRunSyncContent = fs.readFileSync(EPIC_RUN_SKILL_MD_PATH, "utf8");

  it("flow-epic-run/SKILL.md's reconcile recipe uses the --commit --push route", () => {
    expect(
      epicRunSyncContent.includes(
        "flow-epic-sync --epic-slug <slug> --commit --push",
      ),
      "flow-epic-run/SKILL.md's reconcile-drift recipe must invoke " +
        "`flow-epic-sync --epic-slug <slug> --commit --push` — the base-branch " +
        "guard's v4 status-board allowlist makes this legal on the base branch.",
    ).toBe(true);
  });

  it("flow-epic-run/SKILL.md no longer instructs a bare-invocation-plus-hand-commit for the board", () => {
    expect(
      /flow-epic-sync --epic-slug <slug>`\s*\n\s*\(writes/.test(
        epicRunSyncContent,
      ),
      "flow-epic-run/SKILL.md must not still carry the pre-Task-6 " +
        "bare-invocation-then-hand-commit sentence for the status board — the " +
        "guard refuses that shape on the base branch; use --commit --push instead.",
    ).toBe(false);
  });

  it("flow-epic-run/SKILL.md's amend-manifest step names the switch-branch route, not a base-branch commit", () => {
    expect(
      epicRunSyncContent.includes("git switch -c flow-epic-amend/"),
      "flow-epic-run/SKILL.md's amend-manifest step must name the " +
        "`git switch -c flow-epic-amend/<epic>` route — the base-branch guard " +
        "refuses a manifest.json commit on the base branch directly.",
    ).toBe(true);
  });

  it("AGENTS.md names both the auto-commit and auto-push epic-sync exemptions", () => {
    expect(
      agentsContent.includes("Auto-commit exemption"),
      "AGENTS.md ## Don'ts must name the 'Auto-commit exemption' for flow-epic-sync --commit.",
    ).toBe(true);
    expect(
      agentsContent.includes("flow-epic-sync --push"),
      "AGENTS.md ## Don'ts must name 'flow-epic-sync --push' as the auto-push exemption.",
    ).toBe(true);
  });
});

describe("per-phase model-routing wiring lint (feature: per-phase model selection)", () => {
  // Each named Task-spawn site that gained a `model:` override must name its
  // resolution field + precedence + reference the central model-routing doc, so
  // a future edit can't silently drop the per-phase wiring. Adding a `model:`
  // override to an EXISTING fan-out is NOT a new exemption — these anchors guard
  // the wiring, not a new spawn count.
  const skillsDir = path.resolve(HERE, "..", "skills", "pipeline");
  const read = (rel: string) =>
    fs.readFileSync(path.resolve(skillsDir, rel), "utf8");

  it("the central model-routing reference exists with its precedence table", () => {
    const routing = read("flow-pipeline/references/model-routing.md");
    expect(routing).toContain("Per-phase model routing");
    // Every phase state field is named in the precedence table.
    for (const field of [
      "modelPlanning",
      "modelImplement",
      "modelVerify",
      "modelReview",
      "modelFixApplier",
      "modelConsolidator",
      "modelMergeResolver",
    ]) {
      expect(
        routing.includes(field),
        `model-routing.md must name the '${field}' resolution field.`,
      ).toBe(true);
    }
    // The verify-sonnet asymmetry and the gatekeeper pin are documented there.
    expect(routing).toMatch(/verify.*sonnet/i);
    expect(routing).toContain('model: "haiku"');
  });

  it.each([
    ["flow-pipeline/SKILL.md", "modelVerify", "config.models.verify"],
    [
      "flow-pipeline/SKILL.md",
      "modelMergeResolver",
      "config.models.mergeResolver",
    ],
    ["flow-pipeline/SKILL.md", "modelPlanning", "config.models.planning"],
    ["flow-new-feature/SKILL.md", "modelImplement", "config.models.scout"],
    ["flow-coder/SKILL.md", "modelImplement", "config.models.coder"],
    ["flow-pr-review/SKILL.md", "modelReview", "config.models.review"],
    ["flow-pr-review/SKILL.md", "modelFixApplier", "config.models.fixApplier"],
    [
      "flow-pr-review/SKILL.md",
      "modelConsolidator",
      "config.models.consolidator",
    ],
    ["flow-epic-create/SKILL.md", "modelPlanning", "config.models.planning"],
  ])(
    "%s names the %s resolution field + %s precedence key at its spawn site",
    (skill, field, cfgKey) => {
      const content = read(skill);
      expect(
        content.includes(field),
        `${skill} must name the '${field}' resolution field at its per-phase model spawn site.`,
      ).toBe(true);
      expect(
        content.includes(cfgKey),
        `${skill} must name the '${cfgKey}' config precedence key at its per-phase model spawn site.`,
      ).toBe(true);
      expect(
        content.includes("model-routing.md"),
        `${skill} must reference the central model-routing.md at its per-phase model spawn site.`,
      ).toBe(true);
    },
  );

  it('the /flow-pr-review gatekeeper stays pinned to model: "haiku" with no flag and a discouraged config key', () => {
    const prReview = read("flow-pr-review/SKILL.md");
    expect(prReview).toContain('model: "haiku"');
    // The discouraged-config-override note is present and forecloses a flag.
    expect(prReview).toContain("config.models.gatekeeper");
    expect(prReview.toLowerCase()).toContain("no");
    expect(prReview).toContain("--model-gatekeeper");
  });

  it("product-planning forwards the MODEL_PLANNING marker to its discovery spawn", () => {
    const pp = read("flow-product-planning/SKILL.md");
    expect(pp).toContain("MODEL_PLANNING");
    expect(pp).toContain("model-routing.md");
  });
});

describe("discovery-process improvements anchors (candidate ranking table, REVISION marker, --lint, plan-review re-fire)", () => {
  // Structural anchors for the four consumer-run lessons baked into
  // /flow-product-planning: the mandatory value-vs-complexity ranking table, the
  // first-class REVISION marker + its {{REVISION_OVERRIDE}} spawn block, the
  // flow-candidate-issues --lint consistency backstop, and the
  // decision-analysis-materially-changed re-fire rule for flow-plan-review.
  // These close the CLAUDE.md "renames must update the lint in the same commit"
  // loop: the exact contract strings live in the docs, so an edit that drops or
  // renames one goes red here on `npm run verify`.
  const skillsDir = path.resolve(HERE, "..", "skills", "pipeline");
  const read = (rel: string) =>
    fs.readFileSync(path.resolve(skillsDir, rel), "utf8");

  const RANKING_TABLE_HEADER =
    "Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline?";

  it("discovery-instructions.md mandates the ranking-table columns and the plain-Yes/No pull rule", () => {
    const di = read(
      "flow-product-planning/references/discovery-instructions.md",
    );
    expect(
      di.includes(RANKING_TABLE_HEADER),
      "discovery-instructions.md must name the exact candidate ranking-table " +
        "columns — the prd-template sketch anchors on the same header.",
    ).toBe(true);
    expect(di).toContain("plain `Yes` / `No`");
  });

  it("discovery-instructions.md carries the Revision pass mode section and the --lint consistency rubric", () => {
    const di = read(
      "flow-product-planning/references/discovery-instructions.md",
    );
    expect(
      di.includes("## Revision pass mode"),
      "discovery-instructions.md must carry the top-level 'Revision pass mode' " +
        "section — the single source of truth the REVISION marker forwards to.",
    ).toBe(true);
    expect(di).toContain("flow-candidate-issues --lint");
    // The revision contract names the MUST-NOT-regenerate embedded marker.
    expect(di).toContain("flow-plan-review-hash");
  });

  it("prd-template.md carries the ranking-table sketch header", () => {
    const tpl = read("flow-product-planning/templates/prd-template.md");
    expect(
      tpl.includes(RANKING_TABLE_HEADER),
      "prd-template.md must carry the candidate ranking-table sketch with the " +
        "exact column header — kept in lockstep with discovery-instructions.md.",
    ).toBe(true);
  });

  it("discovery-instructions.md mandates objective-item triage bundling", () => {
    const di = read(
      "flow-product-planning/references/discovery-instructions.md",
    );
    expect(
      di.includes("Objective-item triage"),
      "discovery-instructions.md must carry the 'Objective-item triage' rule " +
        "folding objective bug fixes / hardening into the task breakdown.",
    ).toBe(true);
  });

  it("flow-pipeline/SKILL.md carries the pull-#N offer plus the --details echo instruction", () => {
    const fp = read("flow-pipeline/SKILL.md");
    const pullMatches = fp.match(/pull #N into the plan/g) ?? [];
    expect(
      pullMatches.length,
      "flow-pipeline/SKILL.md must name the 'pull #N into the plan' reply " +
        "verb (>=2 occurrences) — the mechanical curation surface that " +
        "replaced the retired candidate-issues form.",
    ).toBeGreaterThanOrEqual(2);
    expect(
      fp.includes("--details") && /echo its output\s+VERBATIM/.test(fp),
      "flow-pipeline/SKILL.md must instruct running `--details` and echoing " +
        "its output verbatim as part of the plan-review checkpoint disclosure " +
        "(there is no candidate-issues form to fire — the disclosure precedes " +
        "the AWAITING APPROVAL block instead).",
    ).toBe(true);
  });

  it("flow-pipeline/SKILL.md names --untick, defer task #N, and drop candidate #N", () => {
    const fp = read("flow-pipeline/SKILL.md");
    for (const marker of ["--untick", "defer task #N", "drop candidate #N"]) {
      expect(
        fp.includes(marker),
        `flow-pipeline/SKILL.md must name '${marker}' — one of the ` +
          "mechanical reply verbs the plan-review checkpoint documents in " +
          "place of the retired candidate-issues AskUserQuestion form.",
      ).toBe(true);
    }
  });

  it("flow-pipeline/SKILL.md's Hard rules blockquote names gate-override as the only authorised AskUserQuestion form", () => {
    const fp = read("flow-pipeline/SKILL.md");
    expect(
      fp.includes("You only call `AskUserQuestion` from the one named form"),
      "flow-pipeline/SKILL.md's Hard rules blockquote must state the " +
        "one-named-form contract verbatim — the candidate-issues form is " +
        "retired, so gate-override is the supervisor's sole AskUserQuestion site.",
    ).toBe(true);
    expect(
      fp.includes("### Gate override (post-verdict, opt-in)"),
      "flow-pipeline/SKILL.md must carry the '### Gate override " +
        "(post-verdict, opt-in)' step-9 heading the Hard rules blockquote " +
        "names as the sole authorised AskUserQuestion form.",
    ).toBe(true);
    expect(
      fp.includes("no candidate-issues form"),
      "flow-pipeline/SKILL.md's Hard rules blockquote must state " +
        "'no candidate-issues form' so a reintroduction attempt trips this lint.",
    ).toBe(true);
  });

  it("flow-pipeline/SKILL.md drops the retired skip-already-ticked and candidate-issues-overflow markers", () => {
    const fp = read("flow-pipeline/SKILL.md");
    expect(
      fp.includes("skip-already-ticked"),
      "flow-pipeline/SKILL.md must NOT reference 'skip-already-ticked' — " +
        "that reply-classification marker belonged to the retired " +
        "candidate-issues AskUserQuestion form.",
    ).toBe(false);
    expect(
      fp.includes("candidate-issues-overflow"),
      "flow-pipeline/SKILL.md must NOT reference 'candidate-issues-overflow' " +
        "— the overflow-marker mechanic belonged to the retired " +
        "candidate-issues AskUserQuestion form.",
    ).toBe(false);
  });

  it("discovery-instructions.md names the three bundle exclusions and the cumulative size rule", () => {
    const di = read(
      "flow-product-planning/references/discovery-instructions.md",
    );
    expect(
      di.includes("genuinely novel non-trivial feature"),
      "discovery-instructions.md must name the verbatim exclusion phrase " +
        "'genuinely novel non-trivial feature' — one of the three named " +
        "exclusions from bundle-by-default triage.",
    ).toBe(true);
    expect(
      di.includes("cumulatively"),
      "discovery-instructions.md must state the bundle-size test " +
        "cumulatively (several individually-fine bundles can together " +
        "clear the exclusion bar) — a per-candidate-only reading would " +
        "under-exclude.",
    ).toBe(true);
    expect(
      di.includes("- **Bundled:**"),
      "discovery-instructions.md must require the `- **Bundled:**` marker " +
        "bullet on every task that originated as a folded-in candidate.",
    ).toBe(true);
  });

  it("prd-template.md carries the pre-ticked candidate sketch", () => {
    const tpl = read("flow-product-planning/templates/prd-template.md");
    expect(
      tpl.includes("- [x]"),
      "prd-template.md must sketch a pre-ticked `- [x]` candidate line — " +
        "bundle-by-default triage means candidates ship ticked, not opt-in.",
    ).toBe(true);
  });

  it("flow-new-feature/SKILL.md and flow-pr-review/references/checklists/pattern-consistency.md both name the 'Bundled during implementation:' marker", () => {
    const nf = read("flow-new-feature/SKILL.md");
    const rc = read(
      "flow-pr-review/references/checklists/pattern-consistency.md",
    );
    expect(
      nf.includes("Bundled during implementation:"),
      "flow-new-feature/SKILL.md must name the verbatim " +
        "'Bundled during implementation:' PR-body marker for late-discovery bundling.",
    ).toBe(true);
    expect(
      rc.includes("Bundled during implementation:"),
      "flow-pr-review/references/checklists/pattern-consistency.md must name the same " +
        "verbatim marker so the review-side check stays anchored to the " +
        "implementation-side contract.",
    ).toBe(true);
  });

  it("the candidate-issues AskUserQuestion exemption is gone from AGENTS.md", () => {
    // Proven non-vacuous: this phrase matched exactly once in AGENTS.md at
    // the commit immediately before the candidate-issues form's retirement
    // (`git show HEAD~2:AGENTS.md` from the commit that retired it) and
    // matches zero times post-retirement. A phrase that already matched
    // zero pre-change (e.g. a line-wrapped substring) would be a vacuous
    // anchor — this one is not.
    expect(
      agentsContent.includes(
        "AskUserQuestion exemption: `/flow-pipeline` candidate-issues",
      ),
      "AGENTS.md must NOT reference the retired 'AskUserQuestion exemption: " +
        "`/flow-pipeline` candidate-issues' bullet — full retirement (option " +
        "(e)) means only the gate-override form remains authorised.",
    ).toBe(false);
  });

  it("the candidate-issues form's 'picks which orthogonal candidates' description is gone from references/git-workflow.md", () => {
    // Proven non-vacuous the same way as the AGENTS.md check above: this
    // exact phrase (on one line, unlike its line-wrapped AGENTS.md
    // counterpart) matched once pre-retirement and zero times now.
    const gw = fs.readFileSync(
      path.resolve(HERE, "..", "references", "git-workflow.md"),
      "utf8",
    );
    expect(
      gw.includes("picks which orthogonal candidates"),
      "references/git-workflow.md must NOT describe a form that " +
        "'picks which orthogonal candidates' — the candidate-issues " +
        "AskUserQuestion form is fully retired.",
    ).toBe(false);
  });

  it("flow-product-planning/SKILL.md defines the {{REVISION_OVERRIDE}} spawn block", () => {
    const pp = read("flow-product-planning/SKILL.md");
    expect(
      pp.includes("{{REVISION_OVERRIDE}}"),
      "flow-product-planning/SKILL.md must define the {{REVISION_OVERRIDE}} " +
        "omit-when-absent spawn block that forwards the REVISION marker.",
    ).toBe(true);
    expect(pp).toContain("Revision pass mode");
  });

  it("flow-pipeline/SKILL.md step 3 threads the REVISION marker, the --lint backstop, and the re-fire rule", () => {
    const fp = read("flow-pipeline/SKILL.md");
    expect(
      fp.includes("Revision-pass threading"),
      "flow-pipeline/SKILL.md must thread the REVISION marker on step-3 re-entry.",
    ).toBe(true);
    expect(fp).toContain("REVISION: <n>");
    expect(
      fp.includes("flow-candidate-issues --lint --plan-md-file"),
      "flow-pipeline/SKILL.md step 3 must run the --lint consistency backstop.",
    ).toBe(true);
    expect(
      fp.includes("decision-analysis-unchanged"),
      "flow-pipeline/SKILL.md must state the flow-plan-review re-fire rule keyed " +
        "on the decision-analysis-unchanged skip.",
    ).toBe(true);
    // The marker hash MUST be sourced from `--print-hash` on the final revised
    // plan, not the `ran:true` envelope's pre-revision hash (else the embedded
    // marker is stale and falsely re-fires the next pass). Lock in the fix.
    expect(
      fp.includes("flow-plan-review --print-hash"),
      "flow-pipeline/SKILL.md step 3 must embed the marker from " +
        "`flow-plan-review --print-hash` run on the final revised plan.",
    ).toBe(true);
  });
});

describe("design-artifact fidelity structural anchors", () => {
  // Freezes the cross-file design-fidelity contract: the per-site gate
  // phrases, the {{DESIGN_CONTEXT}} producer/consumer symmetry, and the
  // spec-shape symmetry between the schema module and the documented shape.
  // The two run-time consumer sites gate on the EPHEMERAL spec file's
  // existence; discovery is a PRODUCER — its gate is the
  // request-references-an-artifact judgment (spec.json does not exist at plan
  // time), so the three sites deliberately do NOT share one literal string.
  const designSpecSchemaContent = fs.readFileSync(
    path.resolve(HERE, "lib", "design-spec-schema.ts"),
    "utf8",
  );
  const prdTemplateContent = fs.readFileSync(
    path.resolve(
      HERE,
      "..",
      "skills",
      "pipeline",
      "flow-product-planning",
      "templates",
      "prd-template.md",
    ),
    "utf8",
  );

  const SPEC_GATE_PHRASE = "worktree-local `.flow-tmp/design/spec.json` exists";

  it("ui-smoke-pass.md opens the design-fidelity sub-pass with the spec-existence gate", () => {
    expect(
      uiSmokePassContent.includes(SPEC_GATE_PHRASE),
      "flow-pipeline references/ui-smoke-pass.md must gate its design-fidelity " +
        `sub-pass on the phrase '${SPEC_GATE_PHRASE}' — the zero-cost contract: ` +
        "no spec.json → the sub-pass does not exist. Renaming the phrase must " +
        "update this lint in the same commit (AGENTS.md anchored-phrase rule).",
    ).toBe(true);
    expect(
      uiSmokePassContent.includes("flow-design-spec"),
      "ui-smoke-pass.md must name the flow-design-spec helper.",
    ).toBe(true);
  });

  it("ui-validation-evidence.md opens the per-assertion walk with the spec-existence gate", () => {
    expect(
      uiValidationEvidenceContent.includes(SPEC_GATE_PHRASE),
      "pr-review references/ui-validation-evidence.md must gate its " +
        `design-fidelity per-assertion walk on the phrase '${SPEC_GATE_PHRASE}'.`,
    ).toBe(true);
    expect(
      uiValidationEvidenceContent.includes("flow-design-spec"),
      "ui-validation-evidence.md must name the flow-design-spec helper.",
    ).toBe(true);
    expect(
      uiValidationEvidenceContent.includes(".flow/design/foundation.md"),
      "ui-validation-evidence.md must document the model-C degradation to " +
        "foundation-conformance against the committed .flow/design/foundation.md.",
    ).toBe(true);
  });

  it("discovery-instructions.md carries the producer gate + the zero-cost-when-absent contract", () => {
    expect(
      discoveryInstructionsContent.includes(
        "the request references a design artifact",
      ),
      "product-planning discovery-instructions.md must gate the design-artifact " +
        "fidelity pre-pass on 'the request references a design artifact' — the " +
        "producer-side judgment gate (spec.json does not exist at plan time).",
    ).toBe(true);
    expect(
      discoveryInstructionsContent.includes("Zero-cost-when-absent"),
      "discovery-instructions.md must name the 'Zero-cost-when-absent' contract " +
        "— no artifact reference → no section, no files, no browser pass.",
    ).toBe(true);
    expect(
      discoveryInstructionsContent.includes("Re-freeze is explicit-only"),
      "discovery-instructions.md must state the explicit-only re-freeze policy " +
        "(a user redirect is the only trigger).",
    ).toBe(true);
  });

  it("{{DESIGN_CONTEXT}} is wired symmetrically across producer and consumers", () => {
    expect(
      coderContent.includes("{{DESIGN_CONTEXT}}"),
      "flow-coder/SKILL.md's spawn prompt template must carry the {{DESIGN_CONTEXT}} " +
        "placeholder (optional; the whole block omitted when the caller passed " +
        "none, so non-UI spawn prompts stay byte-identical).",
    ).toBe(true);
    expect(
      coderInstructionsContent.includes("DESIGN_CONTEXT"),
      "coder references/coder-instructions.md must consume DESIGN_CONTEXT as " +
        "REQUIRED context (read foundation.md/spec.json BEFORE the first UI " +
        "edit; conform every edit).",
    ).toBe(true);
    expect(
      newFeatureContent.includes("DESIGN_CONTEXT"),
      "flow-new-feature/SKILL.md Step 5 must produce the DESIGN_CONTEXT argument " +
        "(two-tier: foundation+spec / foundation-only; omit-when-absent).",
    ).toBe(true);
  });

  it("design-spec-schema.ts and the documented spec shape agree on field names and tiers", () => {
    for (const key of [
      "surfaces",
      "assertions",
      "selector",
      "tier",
      "properties",
      "tolerancePx",
    ]) {
      expect(
        designSpecSchemaContent.includes(key),
        `bin/lib/design-spec-schema.ts must declare the '${key}' field.`,
      ).toBe(true);
      expect(
        discoveryInstructionsContent.includes(key),
        `discovery-instructions.md's documented spec shape must carry '${key}' ` +
          "— drift between the schema module and the documented shape silently " +
          "breaks the producer/consumer contract.",
      ).toBe(true);
    }
    for (const tier of ['"mechanical"', '"judged"']) {
      expect(
        designSpecSchemaContent.includes(tier),
        `design-spec-schema.ts must declare the ${tier} tier literal.`,
      ).toBe(true);
      expect(
        discoveryInstructionsContent.includes(tier),
        `discovery-instructions.md's spec shape must carry the ${tier} tier.`,
      ).toBe(true);
    }
  });

  it("prd-template.md carries the omit-when-empty ## Visual Spec sketch", () => {
    expect(
      /^## Visual Spec$/m.test(prdTemplateContent),
      "prd-template.md must carry the '## Visual Spec' section (omit-when-empty " +
        "sketch, placed after User Stories / Acceptance Criteria).",
    ).toBe(true);
  });

  it("manual-test-rubric.md forbids SUBJECTIVE-relabelling a Visual Spec assertion", () => {
    expect(
      manualTestRubricContent.includes("never `SUBJECTIVE: `-relabelled"),
      "manual-test-rubric.md must extend the prohibited-move guard: a Visual " +
        "Spec assertion is never `SUBJECTIVE: `-relabelled — its verdict belongs " +
        "to the flow-design-spec diff envelope or the side-by-side comparison.",
    ).toBe(true);
    expect(
      manualTestRubricContent.includes("author **exactly one** overall"),
      "manual-test-rubric.md must scope the SUBJECTIVE contract: exactly one " +
        "overall sign-off for artifact-referencing PRs; per-facet stays for " +
        "artifact-less non-trivial UI changes.",
    ).toBe(true);
  });

  it("flow-pr-review/SKILL.md 8c.iii points at the per-assertion walk", () => {
    expect(
      prReviewContent.includes("design-fidelity per-assertion walk"),
      "flow-pr-review/SKILL.md 8c.iii must point at the design-fidelity " +
        "per-assertion walk in references/ui-validation-evidence.md (terse " +
        "pointer; the walk body lives in the reference).",
    ).toBe(true);
  });

  it("Layout Intent is wired symmetrically across producer and consumers", () => {
    expect(
      discoveryInstructionsContent.includes("### Layout Intent"),
      "discovery-instructions.md must carry the '### Layout Intent' " +
        "authoring sub-section.",
    ).toBe(true);
    expect(
      discoveryInstructionsContent.includes(
        "viewport-fill vs intrinsic vs scroll container",
      ),
      "discovery-instructions.md's Layout Intent sub-section must require " +
        "the sizing-policy facet to name viewport-fill vs intrinsic vs " +
        "scroll container.",
    ).toBe(true);
    expect(
      discoveryInstructionsContent.includes("the prose is normative"),
      "discovery-instructions.md's Layout Intent sub-section must resolve " +
        "any topology-diagram/prose conflict to the prose.",
    ).toBe(true);
    expect(
      prdTemplateContent.includes("## Layout Intent"),
      "prd-template.md must carry the omit-when-empty '## Layout Intent' " +
        "thin-sketch section.",
    ).toBe(true);
    expect(
      newFeatureContent.includes("layout-only mode"),
      "flow-new-feature/SKILL.md Step 5 must add the third 'layout-only mode' " +
        "DESIGN_CONTEXT tier, additive alongside foundation+spec / " +
        "foundation-only.",
    ).toBe(true);
    expect(
      coderInstructionsContent.includes("Layout Intent"),
      "coder references/coder-instructions.md must consume a ratified " +
        "Layout Intent as a structural constraint the edit-applier may " +
        "never silently drop.",
    ).toBe(true);
    expect(
      newFeatureContent.includes("Layout append"),
      "flow-new-feature/SKILL.md must keep the 'Layout append' paragraph that " +
        "threads the Layout Intent body into DESIGN_CONTEXT across every " +
        "mode — deleting it while keeping the 'layout-only mode' bullet " +
        "would silently drop the load-bearing threading this test exists " +
        "to freeze.",
    ).toBe(true);
    expect(
      newFeatureContent.includes(
        "only the normative prose reaches the implementer",
      ),
      "flow-new-feature/SKILL.md's Layout append paragraph must keep stripping " +
        "fenced ASCII topology diagrams so only normative prose reaches " +
        "/flow-coder.",
    ).toBe(true);
  });

  it("discovery-instructions.md carries the spec.json properties-map worked example and self-validate step", () => {
    expect(
      discoveryInstructionsContent.includes(
        '"grid-template-columns": "repeat(auto-fill, minmax(240px, 1fr))"',
      ),
      "discovery-instructions.md 1.6(c) must carry a worked example whose " +
        "'properties' is a {prop: extracted-value} map, not a bare array of " +
        "property names.",
    ).toBe(true);
    expect(
      discoveryInstructionsContent.includes(
        "flow-design-spec validate .flow-tmp/design/spec.json",
      ),
      "discovery-instructions.md 1.6(c) must instruct the discovery " +
        "subagent to self-validate the frozen spec.json before proceeding.",
    ).toBe(true);
  });

  it("flow-pipeline/SKILL.md step 3 carries the design-spec validation backstop", () => {
    expect(
      content.includes("flow-design-spec validate"),
      "flow-pipeline/SKILL.md step 3 must run 'flow-design-spec validate' " +
        "as a deterministic, advisory backstop before plan-pending-review.",
    ).toBe(true);
    expect(
      content.includes(".flow-tmp/design/spec.json"),
      "flow-pipeline/SKILL.md's design-spec validation backstop must " +
        "existence-gate on .flow-tmp/design/spec.json.",
    ).toBe(true);
    expect(
      content.includes("DESIGN_SPEC_REASON"),
      "flow-pipeline/SKILL.md's design-spec backstop must thread " +
        "DESIGN_SPEC_REASON into the awaiting-approval gate render's " +
        "--why string — the banner-blindness mitigation this backstop " +
        "exists to provide.",
    ).toBe(true);
    expect(
      content.includes("design spec INVALID: $DESIGN_SPEC_REASON"),
      "flow-pipeline/SKILL.md must keep the '--why \"...; design spec " +
        "INVALID: $DESIGN_SPEC_REASON\"' threading in both the feature " +
        "and tension-flag awaiting-approval gate renders.",
    ).toBe(true);
  });
});

describe("module-status conditional-degradation guards (flow-pipeline/SKILL.md, discovery-instructions.md, AGENTS.md)", () => {
  // Pins the `flow-module-status` runtime-gate call sites so a future edit
  // can't silently drop the precheck: Step 7's Copilot request/wait guard,
  // Step 3's forced-research + cross-model plan-review guards, and the
  // AGENTS.md `## Don'ts` convention naming `--check-skill` for optional-
  // module skill deferrals. These are structural anchors, not behavior
  // tests — the runtime contract itself is unit-tested at
  // bin/flow-module-status.test.ts and bin/lib/module-status.test.ts.
  it("flow-pipeline/SKILL.md Step 7 gates the Copilot request path on the copilot module", () => {
    expect(content).toContain("flow-module-status --check copilot");
  });

  it("flow-pipeline/SKILL.md Step 3 gates both the forced-research fan-out and the cross-model plan review on the research module", () => {
    const matches = content.match(/flow-module-status --check research/g) ?? [];
    expect(
      matches.length,
      "flow-pipeline/SKILL.md must carry 'flow-module-status --check research' " +
        "at least twice — once before the forced-research flow-research-run " +
        "block, once before the cross-model flow-plan-review block.",
    ).toBeGreaterThanOrEqual(2);
  });

  it("discovery-instructions.md Step 1.5 gates the flow-delegate-fanout research fan-out on the research module", () => {
    expect(discoveryInstructionsContent).toContain(
      "flow-module-status --check research",
    );
  });

  it("AGENTS.md ## Don'ts names the check-skill convention for optional-module skill deferrals", () => {
    expect(agentsContent).toContain("check-skill");
  });
});

describe("prompt-intent-sanity-check structural anchors", () => {
  it("flow-pipeline/SKILL.md Step 1 carries the Prompt sanity gate sub-step", () => {
    expect(content).toContain("Prompt sanity gate");
  });

  it("flow-pipeline/SKILL.md Prompt sanity gate names all three verdicts and the escalation tag", () => {
    expect(content).toContain("prompt-contradiction");
    for (const verdict of ["sound", "suspect", "contradicted"]) {
      expect(content).toContain(verdict);
    }
  });

  it("references/prompt-sanity.md exists and carries the three-verdict enum", () => {
    const promptSanityPath = path.resolve(
      HERE,
      "..",
      "skills",
      "pipeline",
      "flow-pipeline",
      "references",
      "prompt-sanity.md",
    );
    expect(fs.existsSync(promptSanityPath)).toBe(true);
    const promptSanityContent = fs.readFileSync(promptSanityPath, "utf8");
    expect(promptSanityContent).toContain("prompt-contradiction");
    for (const verdict of ["sound", "suspect", "contradicted"]) {
      expect(promptSanityContent).toContain(verdict);
    }
  });

  it("flow-pr-review/SKILL.md Step 3 carries the diff-only intent-guess sub-step and blindness prose", () => {
    expect(prReviewContent).toContain("intent-guess");
    expect(prReviewContent).toContain("flow-review-intent-guess");
    expect(prReviewContent).toContain("Diff-only context");
  });

  it("agents/flow-review-intent-guess.md carries the blindness contract and never names Bash", () => {
    const intentGuessAgentPath = path.resolve(
      HERE,
      "..",
      "agents",
      "core",
      "flow-review-intent-guess.md",
    );
    expect(fs.existsSync(intentGuessAgentPath)).toBe(true);
    const intentGuessAgentContent = fs.readFileSync(
      intentGuessAgentPath,
      "utf8",
    );
    expect(intentGuessAgentContent).toContain("Blindness contract");
    expect(intentGuessAgentContent).not.toContain("Bash");
  });

  it("flow-pr-review/SKILL.md carries the ## 3.6 Intent-mismatch resolution heading", () => {
    expect(prReviewContent).toContain("## 3.6");
    expect(prReviewContent).toContain("Intent-mismatch resolution");
  });

  it("references/escalation-recipes.md registers the intent-drift recipe", () => {
    const escalationRecipesPath = path.resolve(
      HERE,
      "..",
      "skills",
      "pipeline",
      "flow-pr-review",
      "references",
      "escalation-recipes.md",
    );
    const escalationRecipesContent = fs.readFileSync(
      escalationRecipesPath,
      "utf8",
    );
    expect(escalationRecipesContent).toContain("## `intent-drift`");
  });

  it("references/intent-mismatch-resolution.md carries the ladder's verdict enum and the gate item", () => {
    const p = path.resolve(
      HERE,
      "..",
      "skills",
      "pipeline",
      "flow-pr-review",
      "references",
      "intent-mismatch-resolution.md",
    );
    expect(fs.existsSync(p)).toBe(true);
    const c = fs.readFileSync(p, "utf8");
    for (const v of [
      "match",
      "benign-divergence",
      "scope-drift",
      "fundamental",
    ]) {
      expect(c).toContain(v);
    }
    expect(c).toContain("- [ ] SUBJECTIVE: confirm scope drift is intentional");
    expect(c).toContain("NEEDS HUMAN: intent-drift");
  });

  it("references/intent-mismatch-resolution.md invokes the flow-intent-resolution-schema validator", () => {
    const p = path.resolve(
      HERE,
      "..",
      "skills",
      "pipeline",
      "flow-pr-review",
      "references",
      "intent-mismatch-resolution.md",
    );
    const c = fs.readFileSync(p, "utf8");
    expect(
      c.includes("flow-intent-resolution-schema --validate"),
      "references/intent-mismatch-resolution.md must invoke " +
        "'flow-intent-resolution-schema --validate' so Step 3.6 self-validates " +
        "its artifact before proceeding.",
    ).toBe(true);
  });

  it("wires --intent-resolution at the post-review terminal snapshot sites", () => {
    const matches =
      content.match(/flow-pipeline-summary[^\n]*--intent-resolution/g) ?? [];
    expect(
      matches.length,
      "flow-pipeline SKILL.md must pass '--intent-resolution' at every terminal flow-pipeline-summary site so the INTENT section is sourced.",
    ).toBeGreaterThanOrEqual(5);
  });

  it("flow-pipeline/SKILL.md agent table Multi-Agent Review exemption still counts nine total", () => {
    const matches = content.match(/Task-tool exemption #\d+:/g) ?? [];
    expect(matches.length).toBe(9);
  });
});

describe("N-port sentinel doc wiring (AGENTS.md ↔ UI references ↔ SKILL.md resource cleanup)", () => {
  const REPO_ROOT = path.resolve(HERE, "..");
  const AGENTS_MD_PATH = path.join(REPO_ROOT, "AGENTS.md");
  const UI_SMOKE_PASS_PATH = path.join(
    REPO_ROOT,
    "skills",
    "pipeline",
    "flow-pipeline",
    "references",
    "ui-smoke-pass.md",
  );
  const UI_VALIDATION_EVIDENCE_PATH = path.join(
    REPO_ROOT,
    "skills",
    "pipeline",
    "flow-pr-review",
    "references",
    "ui-validation-evidence.md",
  );
  const INLINE_ONLY_RULE =
    "**Port and URL overrides are passed INLINE to the launch subprocess (env vars / CLI flags) and are NEVER written to `.env.local`, `.env`, or any other file.**";

  it("AGENTS.md carries the 'Don't write test-time port or URL overrides to a file.' bullet", () => {
    const content = fs.readFileSync(AGENTS_MD_PATH, "utf8");
    expect(content).toContain(
      "Don't write test-time port or URL overrides to a file.",
    );
  });

  it("both UI references carry the verbatim inline-only rule naming .env.local", () => {
    for (const p of [UI_SMOKE_PASS_PATH, UI_VALIDATION_EVIDENCE_PATH]) {
      const content = fs.readFileSync(p, "utf8");
      expect(
        content,
        `${p} must carry the verbatim inline-only rule`,
      ).toContain(INLINE_ONLY_RULE);
      expect(content).toContain(".env.local");
    }
  });

  it("flow-pipeline/SKILL.md resource-cleanup list carries the agent-written-file class", () => {
    const skillMdPath = path.join(
      REPO_ROOT,
      "skills",
      "pipeline",
      "flow-pipeline",
      "SKILL.md",
    );
    const content = fs.readFileSync(skillMdPath, "utf8");
    expect(content).toContain("**Agent-written env/config files**");
  });
});

describe("pause-output contract wiring lint", () => {
  // Mirrors the `pipeline-snapshot wiring lint` idiom: pins the
  // pause-output contract file, its slot vocabulary, and every wired
  // pause site so a future edit cannot silently drop the structure.
  // Extend-on-add rule: any NEW pause site (a turn-ending user-facing
  // reply or report in any SKILL.md) must reference
  // pause-output-contract.md AND be added to WIRED_SKILLS below.
  const REPO_ROOT = path.resolve(HERE, "..");
  const CONTRACT_PATH = path.join(
    REPO_ROOT,
    "skills",
    "pipeline",
    "flow-pipeline",
    "references",
    "pause-output-contract.md",
  );
  const SLOT_LABELS = [
    "**TLDR:**",
    "**Unsolved:**",
    "**Needs attention:**",
    "**Manual action:**",
    "**Untracked:**",
    "**Next action:**",
  ];
  // Enumerated by NAME, not a directory glob (scout PLAN-DEVIATION:
  // flow-new-feature / flow-verify live under skills/pipeline/, not
  // skills/universal/).
  const WIRED_SKILLS = [
    "skills/pipeline/flow-epic-create/SKILL.md",
    "skills/pipeline/flow-epic-run/SKILL.md",
    "skills/pipeline/flow-pr-review/SKILL.md",
    "skills/pipeline/flow-product-planning/SKILL.md",
    "skills/pipeline/flow-new-feature/SKILL.md",
    "skills/pipeline/flow-verify/SKILL.md",
    "skills/universal/flow-refactoring/SKILL.md",
    "skills/universal/flow-testing/SKILL.md",
    "skills/universal/flow-research/SKILL.md",
    "skills/universal/flow-ui-ux/SKILL.md",
  ];

  it("the contract file exists and carries the six literal slot labels", () => {
    const c = fs.readFileSync(CONTRACT_PATH, "utf8");
    for (const label of SLOT_LABELS) {
      expect(
        c.includes(label),
        `pause-output-contract.md must define the literal slot label ${label}`,
      ).toBe(true);
    }
  });

  it("pause-output-contract.md carries the Ceiling section", () => {
    const c = fs.readFileSync(CONTRACT_PATH, "utf8");
    expect(c).toMatch(/^## Ceiling$/m);
    expect(c).toMatch(/~12\s*lines?/);
    expect(c).toContain("≤2 bullets per slot");
  });

  it("pause-output-contract.md carries the four Definitions", () => {
    const c = fs.readFileSync(CONTRACT_PATH, "utf8");
    expect(c).toMatch(/^## Definitions$/m);
    expect(c).toContain("**Meaningful deviation**");
    expect(c).toContain("**High-stakes decision**");
    expect(c).toContain("**Untracked**");
    expect(c).toContain("**Count line**");
    expect(c).toContain("**Manual action split**");
    expect(c).toContain('**"Give me the technical version"**');
    expect(c).toContain("**Q&A answers live above the block**");
  });

  it("no legacy pause slot label survives under skills/ or references/", () => {
    // Extend-on-add rule: this is the mechanical form of Task 2's
    // acceptance grep (`! grep -rnE '**(Went wrong|Remaining|Needs your
    // review|Notes):**' skills references`) — an fs walk over every
    // `.md` under skills/**/*.md and references/*.md, so CI catches a
    // reintroduced legacy label without needing the shell one-liner.
    const LEGACY_LABELS = [
      "**Went wrong:**",
      "**Remaining:**",
      "**Needs your review:**",
      "**Notes:**",
    ];
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith(".md")) out.push(full);
      }
      return out;
    }
    const roots = [
      path.join(REPO_ROOT, "skills"),
      path.join(REPO_ROOT, "references"),
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        const c = fs.readFileSync(file, "utf8");
        for (const label of LEGACY_LABELS) {
          if (c.includes(label)) {
            offenders.push(`${path.relative(REPO_ROOT, file)}: ${label}`);
          }
        }
      }
    }
    expect(
      offenders,
      `Legacy pause slot labels survive: ${JSON.stringify(offenders)}. ` +
        "Replace with the six-slot vocabulary (TLDR/Unsolved/Needs " +
        "attention/Manual action/Untracked/Next action).",
    ).toEqual([]);
  });

  it("flow-pipeline/SKILL.md references pause-output-contract.md at ≥9 pause sites", () => {
    const c = fs.readFileSync(
      path.join(REPO_ROOT, "skills", "pipeline", "flow-pipeline", "SKILL.md"),
      "utf8",
    );
    // Strip HTML comments first so the extend-on-add sentinel comments
    // (`<!-- any new pause site below must reference
    // pause-output-contract.md -->`) don't inflate the count — only the
    // backticked in-prose reference form counts as a real wired site.
    const stripped = c.replace(/<!--[\s\S]*?-->/g, "");
    const matches =
      stripped.match(/`references\/pause-output-contract\.md`/g) ?? [];
    expect(
      matches.length,
      "flow-pipeline SKILL.md must reference `references/pause-output-contract.md` " +
        "at each of its nine informal pause sites (triage clarification, plan " +
        "summary, checkpoint nudge, approval clarification, gated feedback, " +
        "post-render QA, resume-mode terminal QA, step-1 intent interview, " +
        "step-3 question-gate interview).",
    ).toBeGreaterThanOrEqual(9);
  });

  it("each wired sibling SKILL.md references the contract via a resolvable cross-skill path", () => {
    expect(
      fs.existsSync(CONTRACT_PATH),
      "the cross-skill path flow-pipeline/references/pause-output-contract.md " +
        "must resolve to an existing file from the repo tree",
    ).toBe(true);
    for (const rel of WIRED_SKILLS) {
      const c = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(
        c.includes("flow-pipeline/references/pause-output-contract.md"),
        `${rel} must reference the cross-skill path ` +
          "flow-pipeline/references/pause-output-contract.md at its " +
          "turn-ending pause site",
      ).toBe(true);
    }
  });

  it("AGENTS.md carries the binding pause-point bullet", () => {
    const c = fs.readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
    expect(c).toContain("**Structure every pause-point message.**");
  });

  it("interview-playbook.md ships no AskUserQuestion site and no numeric question/round cap", () => {
    // Converts the PR's two one-shot Test Steps checklist greps into a
    // durable regression: the intent interview (adaptive) is a one-form-rule
    // exemption (no new AskUserQuestion form) with an explicit no-numeric-cap
    // user clarification, and a future edit to interview-playbook.md could
    // silently reintroduce either without any signal short of this lint.
    const c = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "skills",
        "pipeline",
        "flow-pipeline",
        "references",
        "interview-playbook.md",
      ),
      "utf8",
    );
    expect(c).not.toMatch(/AskUserQuestion/);
    expect(c).not.toMatch(
      /at most \d+ questions|≤ ?\d+ questions|maximum of \d+ (questions|rounds)/i,
    );
  });

  it("step 1's intent interview persists the digest at ask time, not only after the answer", () => {
    // Live-pipeline regression (PR #637): driving a real `flow feature
    // create` battery showed step 1 writing `--phase
    // triage-pending-interview` with NO `--interview-stdin`, because the
    // only persistence instruction sat after answer-parsing. The pause
    // between asking and answering is exactly the /clear-and-crash
    // window, so `state.interview` was absent at the one phase a resume
    // can land on mid-interview — leaving flow-resume-decide's step-1 row
    // with an empty `.context.interview` and forcing it to re-derive a
    // renumbered frontier, breaking the stable-Q<n> contract the compact
    // `3a` answer form depends on. Step 3's question gate does not share
    // the bug (its battery survives on disk at
    // .flow-tmp/interview-questions.md), which is why this pins step 1
    // specifically.
    const c = fs.readFileSync(SKILL_MD_PATH, "utf8").replace(/\s+/g, " ");
    const askTimeWrite =
      /flow-state-update --phase triage-pending-interview --interview-stdin/;
    expect(
      askTimeWrite.test(c),
      "step 1 must write the phase together with --interview-stdin so the " +
        "battery survives the pause it ends the turn on",
    ).toBe(true);
    expect(
      c.includes("still-open"),
      "the ask-time digest must carry this round's questions at still-open",
    ).toBe(true);
  });

  it("references/output-style.md carries the section and both carve-outs", () => {
    // Normalize hard-wrapped prose so the carve-out phrases match
    // regardless of where the 72-col wrap falls.
    const c = fs
      .readFileSync(
        path.join(REPO_ROOT, "references", "output-style.md"),
        "utf8",
      )
      .replace(/\s+/g, " ");
    expect(c).toContain("## Structure every pause-point message");
    expect(
      c.includes(
        "except pause-point messages, which always use the labeled pause-block slots",
      ),
      "the 'Calibrate length to task.' bullet must carry the pause-point carve-out",
    ).toBe(true);
    expect(
      c.includes("that turn MUST end in a pause block"),
      "the 'No end-of-turn summary unless asked.' bullet must carry the " +
        "pause-point carve-out",
    ).toBe(true);
  });

  it("the three discovery-return sites agree on the same label vocabulary (lockstep-drift guard)", () => {
    // Match the backticked/bolded rendered form, not a bare substring —
    // a bare "Research:" match is also satisfied by unrelated tokens like
    // `forceResearch: true`, which would let a drifted label pass.
    const DISCOVERY_LABELS = [
      "`Problem:`",
      "`Tasks:`",
      "`Candidates:`",
      "`Top assumptions:`",
      "`Research:`",
    ];
    const sites = [
      "skills/pipeline/flow-product-planning/SKILL.md",
      "skills/pipeline/flow-product-planning/references/discovery-instructions.md",
      "agents/core/flow-discovery.md",
    ];
    for (const rel of sites) {
      const c = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      for (const label of DISCOVERY_LABELS) {
        expect(
          c.includes(label),
          `${rel} must carry the discovery-return label ${label} — the ` +
            "three return-contract sites must agree verbatim on the bullet set",
        ).toBe(true);
      }
      expect(
        /one short paragraph \(3|one-paragraph summary \(3–5 sentences\) — the problem statement/.test(
          c,
        ),
        `${rel} must not retain the old paragraph-grained discovery return contract`,
      ).toBe(false);
    }
  });

  it("pause-output-contract.md carries the Language contract section", () => {
    const c = fs.readFileSync(CONTRACT_PATH, "utf8");
    expect(c).toContain("## Language contract");
  });

  it("references/output-style.md carries the impact-first-language section", () => {
    const c = fs.readFileSync(
      path.join(REPO_ROOT, "references", "output-style.md"),
      "utf8",
    );
    expect(c).toContain("## Explain problems impact-first in plain language");
  });

  it("templates/AGENTS.md.template carries the impact-first-language bullet", () => {
    const c = fs.readFileSync(
      path.join(REPO_ROOT, "templates", "AGENTS.md.template"),
      "utf8",
    );
    expect(c).toContain("**Explain problems impact-first in plain language.**");
  });

  it("pause-output-contract.md carries the Step contract section", () => {
    const c = fs.readFileSync(CONTRACT_PATH, "utf8");
    expect(c).toContain("## Step contract");
  });

  it("pause-output-contract.md's Step contract carries its three carve-outs", () => {
    // Mirrors the stricter idiom two precedents up in this same file (the
    // output-style.md carve-out pin at :6837 and the Precondition-
    // concreteness anchored-phrase pin at :4766-4796): pinning only the
    // heading lets a future edit delete carve-out 2 (Test Steps are never
    // renumbered — the one whose loss silently flips every gated PR to
    // auto-merge) while every other test stays green.
    const c = fs.readFileSync(CONTRACT_PATH, "utf8").replace(/\s+/g, " ");
    expect(c).toContain("## Step contract");
    expect(c).toContain("never padded into a one-item numbered list");
    expect(c).toContain("never** renumbered to ordinals");
    expect(c).toContain("numbering a recap of what already happened");
  });

  it("the two new authoring sites defer to the Step contract by name and carry the never-renumber carve-out", () => {
    const discovery = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "skills",
        "pipeline",
        "flow-product-planning",
        "references",
        "discovery-instructions.md",
      ),
      "utf8",
    );
    const rubric = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "skills",
        "pipeline",
        "flow-pr-review",
        "references",
        "manual-test-rubric.md",
      ),
      "utf8",
    );
    for (const [name, c] of [
      ["discovery-instructions.md", discovery],
      ["manual-test-rubric.md", rubric],
    ] as const) {
      expect(
        c.includes("Step contract"),
        `${name} must defer to the Step contract by name — dropping the ` +
          "reference silently orphans the requirement",
      ).toBe(true);
      expect(
        c.includes("NEVER renumbered") || c.includes("never renumbered"),
        `${name} must carry the never-renumber carve-out`,
      ).toBe(true);
    }
  });

  it("references/output-style.md carries the scannable-numbered-steps section", () => {
    const c = fs.readFileSync(
      path.join(REPO_ROOT, "references", "output-style.md"),
      "utf8",
    );
    expect(c).toContain("## Emit instructions as scannable numbered steps");
  });

  it("AGENTS.md and templates/AGENTS.md.template carry the numbered-steps bullet", () => {
    const agentsC = fs.readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
    const templateC = fs.readFileSync(
      path.join(REPO_ROOT, "templates", "AGENTS.md.template"),
      "utf8",
    );
    expect(agentsC).toContain(
      "**Emit instructions as scannable numbered steps.**",
    );
    expect(templateC).toContain(
      "**Emit instructions as scannable numbered steps.**",
    );
  });

  it("references/output-style.md carries the product-lens impact-first section", () => {
    // Deliberately NOT mirrored into templates/AGENTS.md.template — this
    // rule's cross-repo delivery lives in the user's own global
    // ~/.claude/CLAUDE.md (managed outside this repo — flow ships nothing
    // it doesn't manage), and a repo's own AGENTS.md rules win by
    // precedence, so a template mirror would duplicate delivery paths
    // rather than add coverage.
    const c = fs.readFileSync(
      path.join(REPO_ROOT, "references", "output-style.md"),
      "utf8",
    );
    expect(c).toContain(
      "## Frame every explanation impact-first for a product-lens reader",
    );
    expect(c).toContain("### Where impact-first does NOT apply");
    expect(c).toContain("### Per-stage focus");
  });

  it("pause-output-contract.md carries the explanatory-content widening sentence", () => {
    const c = fs.readFileSync(CONTRACT_PATH, "utf8").replace(/\s+/g, " ");
    expect(c).toContain(
      "Explanatory content in any slot follows rules 1–2 as well",
    );
  });

  it("no .md file under skills/ probes the legacy ~/.claude/agents/ location", () => {
    // The three-tier legacy-bare-name resolution tier was collapsed to two
    // tiers (plugin-qualified → general-purpose) across every spawn-site
    // guard. This is a negative repo-wide guard against reintroducing the
    // `~/.claude/agents/` probe anywhere under skills/ — scoped to skills/
    // ONLY, never bin/ (bin/lib/setup.ts legitimately still references it
    // for the sweep-migration path).
    const skillsRoot = path.join(REPO_ROOT, "skills");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          const c = fs.readFileSync(full, "utf8");
          if (c.includes(".claude/agents")) {
            offenders.push(path.relative(REPO_ROOT, full));
          }
        }
      }
    };
    walk(skillsRoot);
    expect(
      offenders,
      `The following skills/ .md files reference the legacy '.claude/agents' ` +
        `location, which no live spawn-site guard resolves against anymore: ` +
        `${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("no inline code span is split across a hard line-wrap in review checklist files", () => {
    // Scoped deliberately to the six per-lens checklist files, NOT a repo-wide
    // scan — a repo-wide scan flags ~177 pre-existing spans elsewhere; the
    // wider sweep is a filed follow-up, not this guard's job. CommonMark/GFM
    // inline code spans cannot contain an unescaped line break: a span whose
    // opening backtick lands on one line and closing backtick on the next
    // breaks exact-string grep anchors that cite the span later, even though
    // rendering is (mostly) unaffected — some renderers merge the tokens
    // instead, but the anchor breakage is the reason this guard exists.
    const findBrokenInlineSpans = (content: string): { line: number }[] => {
      const lines = content.split("\n");
      const offenders: { line: number }[] = [];
      let inFence = false;
      let pendingOpenLine: number | null = null;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*```/.test(line)) {
          inFence = !inFence;
          pendingOpenLine = null;
          continue;
        }
        if (inFence) continue;
        if (line.trim() === "") {
          // Paragraph boundary — an unclosed span here isn't "split across a
          // hard line-wrap within a paragraph"; drop any pending state.
          pendingOpenLine = null;
          continue;
        }
        // Strip complete double-backtick spans (CommonMark's escape for
        // embedding a literal backtick, e.g. `` `$` ``) before counting —
        // otherwise their odd per-span backtick total corrupts the parity
        // check on an otherwise-fully-closed line.
        const stripped = line.replace(/``[^`]*``/g, "");
        const backtickCount = (stripped.match(/`/g) || []).length;
        if (pendingOpenLine !== null) {
          if (backtickCount > 0) {
            offenders.push({ line: pendingOpenLine });
          }
          pendingOpenLine = null;
        }
        if (backtickCount % 2 === 1) {
          pendingOpenLine = i + 1;
        }
      }
      return offenders;
    };

    const checklistsDir = path.join(
      REPO_ROOT,
      "skills",
      "pipeline",
      "flow-pr-review",
      "references",
      "checklists",
    );
    const offenders: string[] = [];
    for (const name of fs.readdirSync(checklistsDir)) {
      if (!name.endsWith(".md")) continue;
      const full = path.join(checklistsDir, name);
      const content = fs.readFileSync(full, "utf8");
      for (const { line } of findBrokenInlineSpans(content)) {
        offenders.push(`${path.relative(REPO_ROOT, full)}:${line}`);
      }
    }
    expect(
      offenders,
      `The following review checklist files split an inline code span across ` +
        `a hard line-wrap (opening backtick on one line, closing on the next): ` +
        `${offenders.join(", ")}. Wrapped spans break exact-string grep anchors ` +
        `even though rendering is unaffected — keep the span on one line or ` +
        `split it into two adjacent spans.`,
    ).toEqual([]);
  });

  it("findBrokenInlineSpans fixture coverage (split spans, double-backtick spans, fences)", () => {
    const findBrokenInlineSpans = (content: string): { line: number }[] => {
      const lines = content.split("\n");
      const offenders: { line: number }[] = [];
      let inFence = false;
      let pendingOpenLine: number | null = null;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*```/.test(line)) {
          inFence = !inFence;
          pendingOpenLine = null;
          continue;
        }
        if (inFence) continue;
        if (line.trim() === "") {
          pendingOpenLine = null;
          continue;
        }
        const stripped = line.replace(/``[^`]*``/g, "");
        const backtickCount = (stripped.match(/`/g) || []).length;
        if (pendingOpenLine !== null) {
          if (backtickCount > 0) {
            offenders.push({ line: pendingOpenLine });
          }
          pendingOpenLine = null;
        }
        if (backtickCount % 2 === 1) {
          pendingOpenLine = i + 1;
        }
      }
      return offenders;
    };

    // A genuinely split span is flagged at the opening line.
    expect(findBrokenInlineSpans("see `foo\nbar` next")).toEqual([{ line: 1 }]);

    // A fenced code block's odd backtick counts are ignored.
    expect(findBrokenInlineSpans("```\nlone ` backtick\n```")).toEqual([]);

    // A blank-line paragraph boundary clears pending state — no false flag.
    expect(findBrokenInlineSpans("odd ` count\n\nmore text")).toEqual([]);

    // A double-backtick span containing a literal backtick, fully closed on
    // one line, must not be flagged even though it carries an odd raw count.
    expect(
      findBrokenInlineSpans("interprets `` $` `` as substitution"),
    ).toEqual([]);

    // An odd-count line followed by a zero-backtick line clears pending
    // state without flagging — the intentional continuation-must-carry-a-
    // backtick rule.
    expect(findBrokenInlineSpans("odd ` count\nno backticks here")).toEqual([]);
  });

  it("the six lens checklist files exist and the monolith stays deleted", () => {
    const checklistsDir = path.join(
      REPO_ROOT,
      "skills",
      "pipeline",
      "flow-pr-review",
      "references",
      "checklists",
    );
    const expected = [
      "bug-detection.md",
      "security.md",
      "pattern-consistency.md",
      "performance.md",
      "supply-chain.md",
      "test-coverage.md",
    ];
    const present = fs
      .readdirSync(checklistsDir)
      .filter((n) => n.endsWith(".md"))
      .sort();
    expect(present).toEqual([...expected].sort());
    expect(
      fs.existsSync(
        path.join(
          REPO_ROOT,
          "skills",
          "pipeline",
          "flow-pr-review",
          "references",
          "review-checklist.md",
        ),
      ),
    ).toBe(false);
  });

  it("no skills/ markdown file references the deleted review-checklist.md monolith path", () => {
    const skillsDir = path.join(REPO_ROOT, "skills");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          const content = fs.readFileSync(full, "utf8");
          if (content.includes("references/review-checklist.md")) {
            offenders.push(path.relative(REPO_ROOT, full));
          }
        }
      }
    };
    walk(skillsDir);
    expect(
      offenders,
      `The following files still reference the deleted monolith path ` +
        `references/review-checklist.md: ${offenders.join(", ")}. Repoint ` +
        `to references/checklists/<lens>.md.`,
    ).toEqual([]);
  });

  it("no pattern heading is duplicated across lens checklist files", () => {
    const checklistsDir = path.join(
      REPO_ROOT,
      "skills",
      "pipeline",
      "flow-pr-review",
      "references",
      "checklists",
    );
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const name of fs.readdirSync(checklistsDir)) {
      if (!name.endsWith(".md")) continue;
      const content = fs.readFileSync(path.join(checklistsDir, name), "utf8");
      for (const m of content.matchAll(/^## (.+)$/gm)) {
        const heading = m[1].trim();
        if (seen.has(heading)) {
          dupes.push(`"${heading}" in ${seen.get(heading)} and ${name}`);
        } else {
          seen.set(heading, name);
        }
      }
    }
    expect(
      dupes,
      `The following pattern headings appear in more than one lens ` +
        `checklist file: ${dupes.join(", ")}. Each pattern should live in ` +
        `exactly one lens file — condense into one entry.`,
    ).toEqual([]);
  });

  it("no lens checklist exceeds the 250-line accretion tripwire", () => {
    const checklistsDir = path.join(
      REPO_ROOT,
      "skills",
      "pipeline",
      "flow-pr-review",
      "references",
      "checklists",
    );
    const LINE_LIMIT = 250;
    const offenders: string[] = [];
    for (const name of fs.readdirSync(checklistsDir)) {
      if (!name.endsWith(".md")) continue;
      const full = path.join(checklistsDir, name);
      const lineCount = fs.readFileSync(full, "utf8").split("\n").length;
      if (lineCount > LINE_LIMIT) {
        offenders.push(`${name} (${lineCount} lines)`);
      }
    }
    expect(
      offenders,
      `The following lens checklist files exceed the ${LINE_LIMIT}-line ` +
        `accretion tripwire: ${offenders.join(", ")}. Remediate in this order: ` +
        `condense → merge duplicates → automate deterministic entries into ` +
        `lint → move consumer-specific entries to the portable doc ` +
        `(docs/consumer-review-patterns.md). Never split a lens file into ` +
        `sub-files, and never delete a load-bearing pattern just for length.`,
    ).toEqual([]);
  });
});

describe("PM-lens supervisor wiring lint (Tasks 9/10)", () => {
  const REPO_ROOT = path.resolve(HERE, "..");

  it("every flow-gate-summary --status (merged|gated|needs-human|cancelled) invocation in flow-pipeline SKILL.md carries --tldr", () => {
    const c = fs.readFileSync(SKILL_MD_PATH, "utf8");
    const stripped = c.replace(/<!--[\s\S]*?-->/g, "");
    const lines = stripped.split("\n");
    const offenders: string[] = [];
    const STATUS_RE =
      /flow-gate-summary --status (merged|gated|needs-human|cancelled)/;
    for (let i = 0; i < lines.length; i++) {
      if (!STATUS_RE.test(lines[i])) continue;
      // A fenced-bash invocation continues via a trailing backslash; a
      // hard-wrapped prose invocation continues as long as the paragraph
      // does (non-blank lines, not starting a new `|`-table row or list
      // item) — scan forward under either continuation rule until neither
      // applies.
      let j = i;
      let block = lines[j];
      for (;;) {
        const backslashContinuation = /\\\s*$/.test(lines[j]);
        const nextExists = j < lines.length - 1;
        const nextIsParagraphContinuation =
          nextExists &&
          lines[j + 1].trim() !== "" &&
          !/^\s*\|/.test(lines[j + 1]) &&
          !/^```/.test(lines[j + 1]);
        if (
          !nextExists ||
          (!backslashContinuation && !nextIsParagraphContinuation)
        ) {
          break;
        }
        j++;
        block += "\n" + lines[j];
      }
      if (!block.includes("--tldr")) {
        offenders.push(`line ${i + 1}: ${lines[i].trim()}`);
      }
    }
    expect(
      offenders,
      `Every flow-gate-summary --status merged|gated|needs-human|cancelled ` +
        `invocation must pass --tldr. Offenders: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("step-3 plan-summary template states task titles and file lists are not echoed", () => {
    const c = fs.readFileSync(SKILL_MD_PATH, "utf8");
    expect(c).toContain("task titles and file lists are not echoed");
  });

  it("`file #N` / `drop #N` reply verbs appear at the three named sites", () => {
    const skillC = fs.readFileSync(SKILL_MD_PATH, "utf8");
    const matches = skillC.match(/file #N/g) ?? [];
    expect(
      matches.length,
      "flow-pipeline/SKILL.md must offer the `file #N` reply verb at " +
        "plan-pending-review, gated feedback mode, and the resume terminal " +
        `row (≥3 sites). Found ${matches.length}.`,
    ).toBeGreaterThanOrEqual(3);
    expect(skillC).toContain("drop #N");
    const redirectC = fs.readFileSync(REDIRECT_HANDLING_PATH, "utf8");
    expect(redirectC).toContain("file #N");
  });

  it("`## Deviations from plan` docs-sync anchor appears at the four sites", () => {
    const sites: Array<[string, string]> = [
      ["pr-description-authoring.md", PR_DESCRIPTION_AUTHORING_PATH],
      ["discovery-instructions.md", DISCOVERY_INSTRUCTIONS_PATH],
      ["flow-pr-review/SKILL.md", PR_REVIEW_SKILL_MD_PATH],
      ["AGENTS.md", AGENTS_MD_PATH],
    ];
    for (const [label, p] of sites) {
      const c = fs.readFileSync(p, "utf8");
      expect(
        c.includes("Deviations from plan"),
        `${label} must reference 'Deviations from plan'`,
      ).toBe(true);
    }
    // The authoring template and discovery draft mirror carry the real
    // `## ` heading (source of truth); pr-review 11a and AGENTS.md name
    // it in prose/bullet form, not as a standalone heading.
    expect(fs.readFileSync(PR_DESCRIPTION_AUTHORING_PATH, "utf8")).toContain(
      "## Deviations from plan",
    );
    expect(fs.readFileSync(DISCOVERY_INSTRUCTIONS_PATH, "utf8")).toContain(
      "## Deviations from plan",
    );
  });

  it("flow-pr-review/SKILL.md Step 13 carries the two mechanical flow-untracked add seeds", () => {
    const c = fs.readFileSync(PR_REVIEW_SKILL_MD_PATH, "utf8");
    const idx = c.indexOf("## 13. Register Local Follow-ups");
    expect(idx, "Step 13 heading must exist").toBeGreaterThan(-1);
    const section = c.slice(idx, idx + 4000);
    expect(section).toContain("flow-untracked add");
    expect(section).toContain("tracker_entry_url");
    expect(section).toContain("introduced_by_this_pr");
  });

  it("failure-recovery.md's flow-gate-summary blocks and needs-human flow-notify calls carry --tldr/--reason", () => {
    const c = fs.readFileSync(FAILURE_RECOVERY_PATH, "utf8");
    const gateBlocks = c.match(/flow-gate-summary --status[^\n]*/g) ?? [];
    for (const block of gateBlocks) {
      // A multi-line invocation is validated at the containing paragraph
      // level below; the single-line form must self-carry --tldr.
      if (!/\\\s*$/.test(block)) {
        expect(
          block.includes("--tldr") || c.includes("--tldr"),
          `failure-recovery.md flow-gate-summary line must be near a --tldr flag: ${block}`,
        ).toBe(true);
      }
    }
    expect(c).toContain("--tldr");
    const notifyBlocks =
      c.match(/flow-notify --status needs-human[^\n]*/g) ?? [];
    expect(
      notifyBlocks.length,
      "failure-recovery.md must carry 3 flow-notify --status needs-human calls",
    ).toBeGreaterThanOrEqual(3);
    expect(c).toContain("--reason");
  });

  it("redirect-handling.md's Phase × input action matrix carries a file #N / drop #N row", () => {
    const c = fs.readFileSync(REDIRECT_HANDLING_PATH, "utf8");
    const idx = c.indexOf("## Phase × input action matrix");
    expect(idx).toBeGreaterThan(-1);
    const nextHeadingIdx = c.indexOf("\n## ", idx + 1);
    const section = c.slice(
      idx,
      nextHeadingIdx === -1 ? undefined : nextHeadingIdx,
    );
    expect(section).toContain("file #N");
  });
});

describe("flow-checkpoint SKILL.md frontmatter policy", () => {
  const frontmatter = checkpointSkillContent.split("---")[1] ?? "";

  it("pins effort: medium", () => {
    expect(
      /^effort: medium$/m.test(frontmatter),
      "skills/universal/flow-checkpoint/SKILL.md frontmatter must declare " +
        "'effort: medium' — the skill's judgment calls (what conversational " +
        "state is load-bearing, and whether an addendum is an implementation " +
        "nuance or a scope change) fail silently and unrecoverably once the " +
        "transcript is cleared, so 'effort: low' is not safe.",
    ).toBe(true);
  });

  it("does NOT pin a model", () => {
    expect(
      /^model:/m.test(frontmatter),
      "skills/universal/flow-checkpoint/SKILL.md frontmatter must NOT pin a " +
        "'model:' — prompt caches are model-scoped, so a model switch on this " +
        "turn would discard the supervisor's warm cache and re-read the whole " +
        "transcript at full input rate, the opposite of the intended saving.",
    ).toBe(false);
  });

  it("does NOT fork context or pin an agent", () => {
    expect(
      /^context:/m.test(frontmatter),
      "skills/universal/flow-checkpoint/SKILL.md frontmatter must NOT set " +
        "'context:' (e.g. fork) — a forked context cannot see the " +
        "conversation, which is this skill's only input.",
    ).toBe(false);
    expect(
      /^agent:/m.test(frontmatter),
      "skills/universal/flow-checkpoint/SKILL.md frontmatter must NOT set " +
        "'agent:' — a forked context cannot see the conversation, which is " +
        "this skill's only input.",
    ).toBe(false);
  });

  it("does NOT disable model invocation", () => {
    expect(
      /^disable-model-invocation:/m.test(frontmatter),
      "skills/universal/flow-checkpoint/SKILL.md frontmatter must NOT set " +
        "'disable-model-invocation:' — it would block the Skill-tool load " +
        "path skills/pipeline/flow-pipeline/references/redirect-handling.md " +
        "documents for the supervisor's natural-language checkpoint redirect.",
    ).toBe(false);
  });

  // Repo-wide freeze on the two claims above: AGENTS.md states flow-checkpoint
  // is the ONLY skill pinning `effort:` and that NO skill pins `model:`
  // (see AGENTS.md's per-spawn model:-still-wins passage and
  // skills/pipeline/flow-pipeline/references/model-routing.md). The two
  // `it`s above only check flow-checkpoint's own file; without this scan
  // both claims go stale silently the moment a second SKILL.md pins effort
  // or any SKILL.md pins model.
  it("is the ONLY SKILL.md pinning effort:, and no SKILL.md pins model:", () => {
    const repoRoot = path.resolve(HERE, "..");
    const skillsRoot = path.join(repoRoot, "skills");
    const effortPinned: string[] = [];
    const modelPinned: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name === "SKILL.md") {
          const fm = fs.readFileSync(full, "utf8").split("---")[1] ?? "";
          if (/^effort:/m.test(fm))
            effortPinned.push(path.relative(repoRoot, full));
          if (/^model:/m.test(fm))
            modelPinned.push(path.relative(repoRoot, full));
        }
      }
    };
    walk(skillsRoot);
    expect(
      effortPinned,
      "AGENTS.md claims skills/universal/flow-checkpoint/SKILL.md is the ONLY " +
        "skill pinning 'effort:' — the following SKILL.md files also pin it, " +
        "which makes that claim stale: " +
        effortPinned.join(", "),
    ).toEqual(["skills/universal/flow-checkpoint/SKILL.md"]);
    expect(
      modelPinned,
      "AGENTS.md states skills never pin 'model:' (see also " +
        "skills/pipeline/flow-pipeline/references/model-routing.md) — the " +
        "following SKILL.md files pin one, which makes that claim stale: " +
        modelPinned.join(", "),
    ).toEqual([]);
  });
});

describe("gh pr edit --body-file recipes repair <details> blank-line gaps first", () => {
  // Enumerated by NAME, not a directory glob (house style pinned above at
  // the "pause-output contract wiring lint" describe block). Every
  // hand-written `gh pr edit ... --body-file` recipe across the skill
  // library must run `flow-md-validate --fix-pr-body` on the same file
  // immediately before writing it, so a malformed <details> block a prior
  // step produced never reaches GitHub unrepaired. Model this on the
  // "Load the Task tool before spawning" precedent above.
  type BodyEditSite = {
    file: string;
    siteName: string;
    kind: "adjacent-lines" | "same-paragraph";
    anchor: string;
  };

  const BODY_EDIT_SITES: BodyEditSite[] = [
    {
      file: "skills/pipeline/flow-pipeline/SKILL.md",
      siteName: "pipeline-ui-smoke-note",
      kind: "adjacent-lines",
      anchor: 'upsert the sibling line "> [!NOTE] UI changed',
    },
    {
      file: "skills/pipeline/flow-pipeline/SKILL.md",
      siteName: "pipeline-verify-exhausted-caution",
      kind: "adjacent-lines",
      anchor: "verify-caution.txt",
    },
    {
      file: "skills/pipeline/flow-pr-review/SKILL.md",
      siteName: "pr-review-evidence-injection",
      kind: "adjacent-lines",
      anchor: "After every runnable item has been processed",
    },
    {
      file: "skills/pipeline/flow-pr-review/SKILL.md",
      siteName: "pr-review-redraft-description",
      kind: "adjacent-lines",
      anchor: "<updated description>",
    },
    {
      file: "skills/pipeline/flow-pr-review/SKILL.md",
      siteName: "pr-review-testability-extend",
      kind: "adjacent-lines",
      anchor: "<original description with test section extended or added>",
    },
    {
      file: "skills/pipeline/flow-pr-review/SKILL.md",
      siteName: "pr-review-automatable-prune",
      kind: "same-paragraph",
      anchor: "prune the converted bullet",
    },
    {
      file: "skills/pipeline/flow-new-feature/SKILL.md",
      siteName: "new-feature-overflow-note",
      kind: "same-paragraph",
      anchor: "append it as a self-contained callout at the END of the PR body",
    },
  ];

  function findAdjacentRepairPair(content: string, anchor: string): boolean {
    const anchorIdx = content.indexOf(anchor);
    if (anchorIdx < 0) return false;
    // Search a bounded window after the anchor for a
    // `flow-md-validate --fix-pr-body` line immediately followed (next
    // non-blank line) by a `gh pr edit ... --body-file` line — or, when
    // the two are chained on one `&&` line, the same line.
    const window = content.slice(anchorIdx, anchorIdx + 2000);
    const lines = window.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("flow-md-validate --fix-pr-body")) continue;
      if (/gh pr edit .*--body-file/.test(lines[i])) return true;
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && /gh pr edit .*--body-file/.test(lines[j])) {
        return true;
      }
    }
    return false;
  }

  function findSameParagraphRepairPair(
    content: string,
    anchor: string,
  ): boolean {
    const anchorIdx = content.indexOf(anchor);
    if (anchorIdx < 0) return false;
    const before = content.lastIndexOf("\n\n", anchorIdx);
    const after = content.indexOf("\n\n", anchorIdx);
    const paragraph = content.slice(
      before < 0 ? 0 : before,
      after < 0 ? content.length : after,
    );
    return (
      paragraph.includes("flow-md-validate --fix-pr-body") &&
      /gh pr edit .*--body-file/.test(paragraph)
    );
  }

  it.each(BODY_EDIT_SITES)(
    "$file names the '$siteName' site running flow-md-validate --fix-pr-body before its gh pr edit --body-file call",
    ({ file, siteName, kind, anchor }) => {
      const absPath = path.resolve(HERE, "..", ...file.split("/"));
      const content = fs.readFileSync(absPath, "utf8");
      const found =
        kind === "adjacent-lines"
          ? findAdjacentRepairPair(content, anchor)
          : findSameParagraphRepairPair(content, anchor);
      expect(
        found,
        `${file}'s '${siteName}' recipe (anchored on ${JSON.stringify(anchor)}) ` +
          `must run 'flow-md-validate --fix-pr-body' on the same body file ` +
          `immediately before its 'gh pr edit ... --body-file' call, so a ` +
          `malformed <details> block never reaches GitHub unrepaired.`,
      ).toBe(true);
    },
  );

  it("covers exactly the seven known gh pr edit --body-file recipe sites, by name", () => {
    expect(BODY_EDIT_SITES.map((s) => s.siteName)).toEqual([
      "pipeline-ui-smoke-note",
      "pipeline-verify-exhausted-caution",
      "pr-review-evidence-injection",
      "pr-review-redraft-description",
      "pr-review-testability-extend",
      "pr-review-automatable-prune",
      "new-feature-overflow-note",
    ]);
  });

  it("BODY_EDIT_SITES' per-file count matches the actual 'gh pr edit ... --body-file' occurrence count in each covered file (independent of the enumerated list itself)", () => {
    // The test above only asserts BODY_EDIT_SITES against a literal copy
    // of its own siteName list, so an eighth recipe added to a covered
    // file (or a ninth in a new file) would silently slip through
    // unrepaired without failing anything. Cross-check against the raw
    // occurrence count in each file this describe block actually reads,
    // so drift between the enumerated sites and the real markdown is
    // caught mechanically.
    const filesCovered = [...new Set(BODY_EDIT_SITES.map((s) => s.file))];
    for (const file of filesCovered) {
      const absPath = path.resolve(HERE, "..", ...file.split("/"));
      const content = fs.readFileSync(absPath, "utf8");
      const actualCount = (content.match(/gh pr edit .*--body-file/g) ?? [])
        .length;
      const enumeratedCount = BODY_EDIT_SITES.filter(
        (s) => s.file === file,
      ).length;
      expect(
        actualCount,
        `${file}: found ${actualCount} 'gh pr edit ... --body-file' occurrence(s) ` +
          `but BODY_EDIT_SITES enumerates ${enumeratedCount} site(s) for this file — ` +
          `a recipe was added or removed without updating BODY_EDIT_SITES.`,
      ).toBe(enumeratedCount);
    }
  });
});
