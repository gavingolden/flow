import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural-anchor lint for `skills/universal/flow-backlog-triage/`.
 *
 * The product of this skill IS its opinionated constraint set — a "balanced"
 * edit that softens mandatory verification, permits an empty kill list, or lets
 * DO-LATER stand without a promotion trigger reproduces the two failed triage
 * runs the skill exists to prevent. Prose has no test, so this file pins the
 * load-bearing, easily-softened rules as literal anchors.
 *
 * It is also the ONLY lint covering this skill: in bin/skill-md-lint.test.ts,
 * the bare-PATH lint (describe block "pipeline skills invoke PATH binaries,
 * not cwd-relative bun bin/ paths") and the ToolSearch-preamble lint
 * (describe block "Task-tool ToolSearch-load preamble at all nine top-level
 * spawn sites plus the nested verify-loop site") both hardcode
 * `skills/pipeline/` and give a universal skill zero coverage. Cited by
 * describe-block title, not line number, so this citation cannot rot as
 * skill-md-lint.test.ts grows.
 *
 * STANDALONE: this file owns its own describe blocks and does not touch the
 * exactly-9 Task-tool-exemption assertions in bin/skill-md-lint.test.ts —
 * `/flow-backlog-triage` is a separate sanctioned standalone session (see
 * AGENTS.md `## Don'ts`), not a tenth /flow-pipeline exemption, so its one
 * named Task-tool fan-out site (Phase-1 verification via
 * flow-backlog-verifier) is anchored here, not folded into that count.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(
  HERE,
  "..",
  "skills",
  "universal",
  "flow-backlog-triage",
);
const REFERENCES_DIR = path.join(SKILL_DIR, "references");

const skillMdPath = path.join(SKILL_DIR, "SKILL.md");
const methodologyPath = path.join(REFERENCES_DIR, "methodology.md");
const outputTemplatePath = path.join(REFERENCES_DIR, "output-template.md");
const fanoutPath = path.join(REFERENCES_DIR, "verification-fanout.md");
const workedExamplePath = path.join(REFERENCES_DIR, "worked-example.md");
const verifierAgentPath = path.resolve(
  HERE,
  "..",
  "agents",
  "core",
  "flow-backlog-verifier.md",
);

const skillContent = fs.readFileSync(skillMdPath, "utf8");
const methodologyContent = fs.readFileSync(methodologyPath, "utf8");
const outputTemplateContent = fs.readFileSync(outputTemplatePath, "utf8");
const fanoutContent = fs.readFileSync(fanoutPath, "utf8");
const workedExampleContent = fs.readFileSync(workedExamplePath, "utf8");
const verifierAgentContent = fs.readFileSync(verifierAgentPath, "utf8");

describe("flow-backlog-triage opinionated-constraint anchors", () => {
  // Verification is mandatory (spec failure mode 1)
  it("names the hedged-completion phrase class as banned when the methodology states its verification rule", () => {
    const paragraphs = methodologyContent.split(/\n\s*\n/);
    const banParagraph = paragraphs.find((p) => /banned verdict/i.test(p));
    expect(
      banParagraph,
      "methodology.md must contain a paragraph naming 'banned verdict'.",
    ).toBeDefined();
    for (const hedge of ["likely", "probably", "presumably", "appears to be"]) {
      expect(
        banParagraph!.toLowerCase().includes(hedge),
        `methodology.md's banned-verdict paragraph must name the hedge '${hedge}' ` +
          "as part of the banned phrase class — softening the ban to just " +
          "'likely fixed' would leave 'probably fixed' / 'presumably resolved' / " +
          "'appears to be done' as unbanned loopholes for the same guess.",
      ).toBe(true);
    }
  });

  const FIVE_VERDICTS = [
    "CONFIRMED",
    "ALREADY DONE",
    "STALE-PARTIAL",
    "NOT REPRODUCIBLE IN CODE",
    "UNVERIFIABLE",
  ];

  it.each(FIVE_VERDICTS)(
    "methodology.md Phase 1 lists the verdict %j",
    (verdict) => {
      expect(
        methodologyContent.includes(verdict),
        `methodology.md must list the Phase 1 verdict '${verdict}'. Dropping ` +
          "one of the five verdicts narrows the taxonomy the skill's whole " +
          "verification discipline depends on.",
      ).toBe(true);
    },
  );

  it("requires file:line, PR, or run-id evidence when the methodology defines a verdict", () => {
    expect(methodologyContent.includes("file:line")).toBe(true);
    expect(
      methodologyContent.includes("cite the PR or commit") ||
        methodologyContent.includes("the PR or commit"),
    ).toBe(true);
    expect(methodologyContent.includes("run ID")).toBe(true);
  });

  // The kill list is required and non-empty (spec failure mode 3)
  it("describes the kill list as required and non-empty when the output template defines its outputs", () => {
    expect(
      outputTemplateContent.includes("required and non-empty"),
      "output-template.md must describe the kill list section as required " +
        "and non-empty — a backlog that survives triage untouched is a " +
        "triage failure, not a clean backlog (spec failure mode 3).",
    ).toBe(true);
  });

  it("routes STALE-PARTIAL to survivors and never to the kill list when the methodology defines verdict routing", () => {
    expect(
      methodologyContent.includes("NEVER in the kill list"),
      "methodology.md must state STALE-PARTIAL routes to survivors and " +
        "NEVER to the kill list — it is unfinished work, not a rejection.",
    ).toBe(true);
  });

  // The four value verdicts (spec Phase 2)
  const PHASE_2_VERDICTS = ["DO:", "DO-LATER:", "NEEDS-DECISION:", "REJECT:"];

  it.each(PHASE_2_VERDICTS)(
    "methodology.md Phase 2 canonical block contains the verdict %j",
    (verdict) => {
      expect(
        methodologyContent.includes(verdict),
        `methodology.md's Phase 2 canonical block must contain '${verdict}'.`,
      ).toBe(true);
    },
  );

  it("requires a concrete promotion trigger for DO-LATER when the methodology defines that verdict", () => {
    expect(methodologyContent.includes("concrete promotion trigger")).toBe(
      true,
    );
  });

  it("states that a DO-LATER without a trigger is a REJECT when the methodology defines that verdict", () => {
    expect(
      methodologyContent.includes("A DO-LATER without a trigger is a REJECT"),
    ).toBe(true);
  });

  // Both canonical prompt blocks reproduced (spec "Canonical prompt blocks")
  it("reproduces the Phase 2 canonical block when the methodology defines value adjudication", () => {
    expect(
      methodologyContent.includes(
        "as a single decision point with a recommendation",
      ),
      "methodology.md must reproduce the Phase 2 canonical block's conflict " +
        "clause verbatim in substance.",
    ).toBe(true);
  });

  it("reproduces the Phase 4 canonical block when the methodology defines the act phase", () => {
    expect(
      methodologyContent.includes("closing on opinion is not"),
      "methodology.md must reproduce the Phase 4 canonical block's " +
        "automate-vs-stage distinction verbatim in substance.",
    ).toBe(true);
  });

  it("reproduces the grooming-mode block when the methodology defines mode selection", () => {
    expect(
      methodologyContent.includes(
        "Grooming success is measured by how much the backlog SHRINKS",
      ),
    ).toBe(true);
  });

  // Losslessness (spec failure mode 4)
  it("describes the disposition table as lossless with a residue section when the methodology defines Phase 0", () => {
    expect(methodologyContent.includes("residue section")).toBe(true);
    expect(
      methodologyContent.includes("exactly once in the final disposition"),
    ).toBe(true);
  });

  it("requires the literal inventory count assertion when the methodology defines Phase 0", () => {
    expect(
      methodologyContent.includes("Inventory: <N> issues, <M> notes"),
    ).toBe(true);
  });

  it("states that the disposition table has exactly N+M rows when the methodology defines Phase 0", () => {
    expect(
      methodologyContent.includes("the disposition table has EXACTLY N+M rows"),
    ).toBe(true);
  });

  // Conflicts surface, never resolved silently (spec failure mode 5)
  it("requires conflicts to surface as a single decision point with a recommendation when the methodology defines Phase 2", () => {
    expect(
      methodologyContent.includes(
        "as a single decision point with a recommendation",
      ),
    ).toBe(true);
  });

  // Bundling (spec failure mode 2)
  it("requires the one-reviewable-PR test and forbids bundling by theme when the methodology defines Phase 3", () => {
    expect(
      methodologyContent.includes(
        "one coherent PR a reviewer holds in their head",
      ),
    ).toBe(true);
    expect(methodologyContent.includes("NEVER by theme")).toBe(true);
  });

  it("forbids mixing verdict tiers within one bundle when the methodology defines Phase 3", () => {
    expect(methodologyContent.includes("Never mix verdict tiers")).toBe(true);
  });

  // Evidence-automated vs judgment-staged closure split (spec Phase 4)
  it("splits automated evidence-based closures from staged judgment-based closures when the methodology defines Phase 4", () => {
    expect(
      methodologyContent.includes("evidence-based closures are automated"),
    ).toBe(true);
    expect(
      methodologyContent.includes("judgment-based closures are staged"),
    ).toBe(true);
  });

  it("names the parent session as the actor for automated closures when the methodology defines Phase 4", () => {
    expect(
      methodologyContent.includes("PARENT SESSION executes the evidence-based"),
    ).toBe(true);
  });

  // Dry-run refinements (revision 1, spec-level authority)
  it("bans hybrid verdicts and requires one primary verdict per item when the methodology defines its taxonomy", () => {
    expect(methodologyContent.includes("Hybrid verdicts")).toBe(true);
    expect(methodologyContent.includes("disallowed")).toBe(true);
    expect(methodologyContent.includes("one primary verdict")).toBe(true);
  });

  it("names supersede-closes as evidence-based when the methodology defines closure eligibility", () => {
    expect(
      methodologyContent.includes("Supersede-closes") &&
        methodologyContent.includes("evidence-based closures eligible"),
    ).toBe(true);
  });

  it("forbids a bundle deferring a product call from silently becoming DO when the methodology defines Phase 3", () => {
    expect(methodologyContent.includes("Decision-parameter rule")).toBe(true);
    expect(methodologyContent.includes("cannot silently become DO")).toBe(true);
  });

  it("requires inferred milestones to be surfaced as the first escalation when the methodology defines grooming mode", () => {
    expect(
      methodologyContent.includes(
        'confirm or strike the inferred milestone" the FIRST numbered question',
      ),
    ).toBe(true);
  });

  // Queue-seed contract (revision 1)
  it("carries --tmux in every emitted launch command across the methodology and the output template", () => {
    expect(methodologyContent.includes("--tmux")).toBe(true);
    expect(outputTemplateContent.includes("--tmux")).toBe(true);
  });

  it("carries --slug in every emitted launch command across the methodology and the output template", () => {
    expect(methodologyContent.includes("--slug")).toBe(true);
    expect(outputTemplateContent.includes("--slug")).toBe(true);
  });

  it("states the no-backticks rule when the output template defines the queue section", () => {
    expect(outputTemplateContent.includes("ZERO backticks")).toBe(true);
  });

  it("requires a cross-bundle sequencing warning list when the output template defines the queue section", () => {
    expect(outputTemplateContent.includes("cross-bundle sequencing")).toBe(
      true,
    );
    expect(outputTemplateContent.includes("warning list")).toBe(true);
  });

  it("renders a fire-time decision parameter as a value-required placeholder when the output template defines the queue section", () => {
    expect(outputTemplateContent.includes("<value required>")).toBe(true);
  });

  // Runtime-visible half of enforcement
  it("contains a Self-check block when the output template defines its final section", () => {
    expect(outputTemplateContent.includes("## Self-check")).toBe(true);
  });

  // Phase-1 fan-out contract
  it("loads the Task schema via ToolSearch when the fan-out reference defines the spawn site", () => {
    expect(fanoutContent.includes('ToolSearch query="select:Task"')).toBe(true);
  });

  it("names inline sequential verification as the degrade path when the fan-out reference defines its degrade path", () => {
    // Positive anchor on the required behavior, not just an absence — an
    // absence-only assertion (e.g. asserting "general-purpose" is missing)
    // makes deleting the whole degrade-path section pass HARDER.
    expect(
      fanoutContent.includes("inline sequential"),
      "references/verification-fanout.md must name inline sequential " +
        "verification as the degrade path when the read-only verifier " +
        "agent is unavailable — deleting the section must fail this check.",
    ).toBe(true);
  });

  it("never uses general-purpose as the subagent_type value when the fan-out reference defines its degrade path", () => {
    // Narrower than a file-wide includes()-is-false: this specifically
    // pins that the write-capable catch-all is never handed to
    // `subagent_type:`, without forcing the prose to euphemize the name
    // entirely (SKILL.md names it outright for a reader's benefit).
    expect(/subagent_type:\s*general-purpose/.test(fanoutContent)).toBe(false);
  });

  it("names flow-backlog-verifier as the subagent type when the fan-out reference defines the spawn call", () => {
    // The literal is $BACKLOG_VERIFIER_SUBAGENT (resolved to the
    // plugin-qualified flow-module-core:flow-backlog-verifier on a
    // plugin-root install, else the bare name on a legacy global install —
    // a bare "flow-backlog-verifier" subagent_type fails Task-tool
    // resolution outright on a plugin-root install, measured: "Agent type
    // 'flow-scout' not found"), not a hardcoded bare-name literal.
    expect(
      fanoutContent.includes("subagent_type: $BACKLOG_VERIFIER_SUBAGENT"),
    ).toBe(true);
    expect(
      fanoutContent.includes(
        "BACKLOG_VERIFIER_SUBAGENT=flow-module-core:flow-backlog-verifier",
      ),
    ).toBe(true);
  });

  it("requires batched work with a wave-bounded spawn cap when the fan-out reference defines the spawn shape", () => {
    expect(fanoutContent.includes("Batch")).toBe(true);
    expect(fanoutContent.includes("waves of at most 6")).toBe(true);
    expect(fanoutContent.includes("ceil(total_items / 6)")).toBe(true);
  });

  it("forbids (not merely names) mutating commands when the verifier agent defines its read-only contract", () => {
    // Anchor on the PROHIBITION shape ("no `<cmd>`"), not bare presence — a
    // polarity-flipping edit (e.g. rewording to permit these commands while
    // still naming them) would keep a bare includes() green.
    // Normalize whitespace (including markdown line-wraps) so a phrase
    // spanning a wrapped line still matches.
    const normalizedVerifierAgentContent = verifierAgentContent.replace(
      /\s+/g,
      " ",
    );
    for (const mutatingCommand of [
      "gh issue close",
      "gh issue comment",
      "gh issue edit",
      "git commit",
      "git push",
    ]) {
      expect(
        normalizedVerifierAgentContent.includes(`no \`${mutatingCommand}\``),
        `agents/flow-backlog-verifier.md must forbid '${mutatingCommand}' ` +
          "(the literal 'no `<cmd>`' phrasing) as a mutating command — the " +
          "read-only contract is prose-enforced (Bash can mutate), so the " +
          "file must say so explicitly and prohibit it, not merely name it.",
      ).toBe(true);
    }
  });

  it("forbids gh api as the generic mutation escape hatch when the verifier agent defines its read-only contract", () => {
    // Same prohibition-shape anchoring as the loop above, not bare presence:
    // `gh api` is the escape hatch that bypasses every named `gh issue ...`
    // check, so the anchor pins BOTH the prohibition ("no `gh api`") and the
    // non-GET qualifier that scopes it — a reword permitting non-GET calls
    // while still mentioning `gh api` would keep a bare includes() green.
    const normalized = verifierAgentContent.replace(/\s+/g, " ");
    expect(
      normalized.includes("no `gh api` with a non-GET method"),
      "agents/flow-backlog-verifier.md must forbid '`gh api` with a " +
        "non-GET method' (that literal phrasing) — it is the generic " +
        "escape hatch around the named `gh issue ...` prohibitions, and " +
        "the read-only contract is prose-enforced (Bash can mutate).",
    ).toBe(true);
  });

  // Portability: this skill runs in arbitrary consumer repos
  const ALL_SKILL_FILES: ReadonlyArray<{ label: string; content: string }> = [
    { label: "SKILL.md", content: skillContent },
    { label: "references/methodology.md", content: methodologyContent },
    {
      label: "references/output-template.md",
      content: outputTemplateContent,
    },
    { label: "references/verification-fanout.md", content: fanoutContent },
    { label: "references/worked-example.md", content: workedExampleContent },
    { label: "agents/flow-backlog-verifier.md", content: verifierAgentContent },
  ];

  it.each(ALL_SKILL_FILES.map((f) => [f.label, f.content] as const))(
    "%s invokes helpers by bare PATH name, never a repo-relative bun bin/ path",
    (label, content) => {
      expect(
        /bun bin\/(lib\/|flow-)/.test(content),
        `${label} must not invoke a helper via 'bun bin/lib/...' or 'bun ` +
          "bin/flow-...' — this skill runs in arbitrary consumer repos whose " +
          "cwd is never the flow checkout; invoke helpers by their bare PATH " +
          "name instead.",
      ).toBe(false);
    },
  );

  // Structural conventions
  const REQUIRED_HEADERS = [
    "# Goal",
    "# When to Use",
    "# When NOT to Use",
    "# Context",
    "# Instructions",
    "# Verification",
    "# Constraints",
  ];

  it.each(REQUIRED_HEADERS)(
    "SKILL.md contains the required project-convention header %j",
    (header) => {
      expect(
        new RegExp(`^${header}$`, "m").test(skillContent),
        `skills/universal/flow-backlog-triage/SKILL.md must contain the ` +
          `required header '${header}' (see flow-skill-creator/references/` +
          "project-conventions.md's standard-header checklist).",
      ).toBe(true);
    },
  );

  it("SKILL.md's self-reference to this lint file's path is correct", () => {
    // SKILL.md claims its Constraints section is "anchored by a structural
    // lint at bin/flow-backlog-triage-skill-lint.test.ts" — pin that claim
    // so a rename of this file can't silently orphan the reference.
    expect(
      skillContent.includes("bin/flow-backlog-triage-skill-lint.test.ts"),
      "skills/universal/flow-backlog-triage/SKILL.md must reference this " +
        "lint file by its exact path in the Constraints section.",
    ).toBe(true);
  });

  it("resolves every references/*.md link when the SKILL.md links to its references", () => {
    const linkRe = /\]\(references\/([^)]+)\)/g;
    const linked = [...skillContent.matchAll(linkRe)].map((m) => m[1]);
    expect(
      linked.length,
      "SKILL.md must link at least one references/*.md file.",
    ).toBeGreaterThan(0);
    for (const rel of linked) {
      const full = path.join(REFERENCES_DIR, rel);
      expect(
        fs.existsSync(full),
        `SKILL.md links to 'references/${rel}', which must exist on disk ` +
          `at ${full}.`,
      ).toBe(true);
    }
  });

  it("SKILL.md body stays under the 500-line hard cap", () => {
    expect(skillContent.split("\n").length).toBeLessThan(500);
  });
});
