import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Drift + prose lint for the flow-value-rubric feature: the canonical
 * value-prop block at
 * `skills/universal/flow-backlog-triage/references/value-rubric.md` is
 * embedded verbatim (marker-delimited) in three consumer files —
 * `methodology.md`, `flow-product-planning/references/discovery-instructions.md`,
 * and `flow-pr-review/references/fix-applier-instructions.md`. There is no
 * runtime read of the canonical file (sub-agents run in consumer worktrees
 * and can't reliably fetch a sibling skill file), so drift between the four
 * copies is a silent authoring bug this lint exists to catch — same
 * cross-file byte-identity idiom as
 * `bin/skill-md-lint.test.ts`'s "Fix-Applier artifact JSON schema drift"
 * describe block, and the same sliced whitespace-normalized `includes()`
 * idiom as `bin/flow-backlog-triage-skill-lint.test.ts`.
 *
 * Also pins the prose-level consumer edits (Tasks 2–6 of the
 * flow-aggressively-files-candidate-follow plan): the tick-only-when-
 * clears-bar rule replacing the old pre-ticked/file-by-default default,
 * the below-bar-deferral fix-applier path, the step-10 sweep's `.details`
 * call-site, and the repo-wide `file candidate #N` / no-more-`file-by-
 * default` doc sweep.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

const RUBRIC_BLOCK_RE =
  /<!-- flow-value-rubric:begin -->\n([\s\S]*?)<!-- flow-value-rubric:end -->/;

function extractRubricBlock(content: string, label: string): string {
  const m = content.match(RUBRIC_BLOCK_RE);
  expect(
    m,
    `${label} must carry a <!-- flow-value-rubric:begin --> … ` +
      "<!-- flow-value-rubric:end --> marker-delimited block.",
  ).not.toBeNull();
  return m ? m[1] : "";
}

const canonicalPath =
  "skills/universal/flow-backlog-triage/references/value-rubric.md";
const CONSUMERS: { path: string; label: string }[] = [
  {
    path: "skills/universal/flow-backlog-triage/references/methodology.md",
    label: "methodology.md",
  },
  {
    path: "skills/pipeline/flow-product-planning/references/discovery-instructions.md",
    label: "discovery-instructions.md",
  },
  {
    path: "skills/pipeline/flow-pr-review/references/fix-applier-instructions.md",
    label: "fix-applier-instructions.md",
  },
];

const canonicalBlock = extractRubricBlock(
  read(canonicalPath),
  "value-rubric.md",
);

describe("flow-value-rubric: canonical block drift", () => {
  it.each(CONSUMERS)(
    "$label embeds the value-prop block byte-identical to value-rubric.md",
    ({ path: relPath, label }) => {
      const block = extractRubricBlock(read(relPath), label);
      expect(
        block,
        `${label}'s <!-- flow-value-rubric --> block must be byte-identical ` +
          "to skills/universal/flow-backlog-triage/references/value-rubric.md's " +
          "canonical block — drift here means the rubric's rules disagree " +
          "depending on which skill a reader is in.",
      ).toBe(canonicalBlock);
    },
  );

  const REQUIRED_SUBSTRINGS = [
    "- **UX:**",
    "- **Problem:**",
    "- **Stability/efficiency:**",
    "- **Cost:**",
    "- **If never done:**",
    "- **Verdict:**",
    "clears bar",
    "below bar",
    "[anchor:",
    "worse than `none`",
  ];

  it.each(REQUIRED_SUBSTRINGS)(
    "the canonical block contains %j",
    (substring) => {
      expect(
        canonicalBlock.includes(substring),
        `value-rubric.md's canonical block must contain '${substring}' — ` +
          "dropping it silently weakens the rubric every consumer inherits.",
      ).toBe(true);
    },
  );
});

describe("flow-value-rubric: Task 2 — discovery-instructions.md / prd-template.md / flow-new-feature/SKILL.md", () => {
  const discoveryContent = read(
    "skills/pipeline/flow-product-planning/references/discovery-instructions.md",
  );

  it("discovery-instructions.md no longer author-every-candidate-pre-ticked", () => {
    expect(
      discoveryContent.includes("Author every remaining candidate pre-ticked"),
      "discovery-instructions.md must not carry the old file-by-default " +
        "authoring instruction — a candidate ticks only when its value-prop " +
        "block clears the bar.",
    ).toBe(false);
  });

  it("discovery-instructions.md states the tick-only-when-clears-bar rule", () => {
    expect(discoveryContent.includes("Tick (`- [x]`) only")).toBe(true);
  });

  it("discovery-instructions.md documents the file candidate #N reply verb", () => {
    expect(discoveryContent.includes("file candidate #N")).toBe(true);
  });

  it("prd-template.md's Candidate follow-up issues slice sketches an unticked candidate with a Verdict line", () => {
    const tpl = read(
      "skills/pipeline/flow-product-planning/templates/prd-template.md",
    );
    const start = tpl.indexOf("## Candidate follow-up issues");
    expect(
      start,
      "prd-template.md must carry a '## Candidate follow-up issues' heading.",
    ).toBeGreaterThanOrEqual(0);
    const slice = tpl.slice(start);
    expect(
      slice.includes("- [ ]"),
      "prd-template.md's Candidate follow-up issues slice must sketch an " +
        "unticked (`- [ ]`) candidate — ticking is no longer the default.",
    ).toBe(true);
    expect(
      slice.includes("**Verdict:**"),
      "prd-template.md's Candidate follow-up issues slice must sketch the " +
        "value-prop block's Verdict line.",
    ).toBe(true);
  });

  it("flow-new-feature/SKILL.md no longer names a pre-ticked candidate", () => {
    const nf = read("skills/pipeline/flow-new-feature/SKILL.md");
    expect(nf.includes("pre-ticked candidate")).toBe(false);
  });
});

describe("flow-value-rubric: Task 3 — step-10 sweep call-site", () => {
  it("flow-pipeline/SKILL.md's Post-merge follow-up sweep folds .details into the filed issue body", () => {
    const skill = read("skills/pipeline/flow-pipeline/SKILL.md");
    const start = skill.indexOf("### Post-merge follow-up sweep");
    expect(
      start,
      "flow-pipeline/SKILL.md must carry a '### Post-merge follow-up sweep' heading.",
    ).toBeGreaterThanOrEqual(0);
    const nextHeading = skill.indexOf("\n## ", start + 1);
    const slice = skill.slice(
      start,
      nextHeading === -1 ? undefined : nextHeading,
    );
    expect(
      slice.includes(".details"),
      "the Post-merge follow-up sweep's jq must read the ticked item's " +
        "'.details' field into the filed issue body — dropping it silently " +
        "loses the value-prop block on every filed follow-up issue.",
    ).toBe(true);
  });
});

describe("flow-value-rubric: Task 4 — below-bar deferrals (fix-applier / pr-review)", () => {
  const fixApplierContent = read(
    "skills/pipeline/flow-pr-review/references/fix-applier-instructions.md",
  );

  it("fix-applier-instructions.md states the below-bar-deferrals-not-filed rule", () => {
    expect(
      fixApplierContent.includes("Below-bar deferrals are not filed"),
    ).toBe(true);
  });

  it("fix-applier-instructions.md's below-bar reason begins 'below bar — '", () => {
    expect(fixApplierContent.includes("below bar — ")).toBe(true);
  });

  it("fix-applier-instructions.md's deferred-body.md heredoc carries all six value-prop labels", () => {
    const start = fixApplierContent.indexOf(
      'cat > "$WORKTREE/.flow-tmp/deferred-body.md"',
    );
    expect(
      start,
      "fix-applier-instructions.md must carry the deferred-body.md heredoc.",
    ).toBeGreaterThanOrEqual(0);
    // The opening line itself contains the `<<'EOF'` heredoc marker, so the
    // CLOSING `EOF` (a standalone line) must be searched for starting AFTER
    // that opening line, not from `start` itself.
    const end = fixApplierContent.indexOf("\nEOF", start);
    const heredoc = fixApplierContent.slice(
      start,
      end === -1 ? undefined : end,
    );
    for (const label of [
      "- **UX:**",
      "- **Problem:**",
      "- **Stability/efficiency:**",
      "- **Cost:**",
      "- **If never done:**",
      "- **Verdict:**",
    ]) {
      expect(
        heredoc.includes(label),
        `fix-applier-instructions.md's deferred-body.md heredoc must ` +
          `include the value-prop label '${label}'.`,
      ).toBe(true);
    }
  });

  it("flow-pr-review/SKILL.md renders below-bar deferrals under their own sub-list", () => {
    const prReview = read("skills/pipeline/flow-pr-review/SKILL.md");
    expect(prReview.includes("Below bar (not filed)")).toBe(true);
  });
});

describe("flow-value-rubric: Task 6 — repo-wide file-by-default / pre-ticked sweep", () => {
  it("flow-pipeline/SKILL.md documents 'file candidate #N' at least twice and names --tick", () => {
    const skill = read("skills/pipeline/flow-pipeline/SKILL.md");
    const matches = skill.match(/file candidate #N/g) ?? [];
    expect(
      matches.length,
      "flow-pipeline/SKILL.md must document 'file candidate #N' at least " +
        "twice (step 3's disclosure verb list and step 4's reply handling).",
    ).toBeGreaterThanOrEqual(2);
    expect(skill.includes("--tick")).toBe(true);
  });

  it("redirect-handling.md documents 'file candidate #N'", () => {
    const redirect = read(
      "skills/pipeline/flow-pipeline/references/redirect-handling.md",
    );
    expect(redirect.includes("file candidate #N")).toBe(true);
  });

  const NO_FILE_BY_DEFAULT: { path: string; label: string }[] = [
    {
      path: "skills/pipeline/flow-pipeline/SKILL.md",
      label: "flow-pipeline/SKILL.md",
    },
    {
      path: "skills/pipeline/flow-pipeline/references/redirect-handling.md",
      label: "redirect-handling.md",
    },
    { path: "references/git-workflow.md", label: "references/git-workflow.md" },
    { path: "AGENTS.md", label: "AGENTS.md" },
    {
      path: "bin/flow-candidate-issues.ts",
      label: "bin/flow-candidate-issues.ts",
    },
  ];

  it.each(NO_FILE_BY_DEFAULT)(
    "$label no longer contains the phrase 'file-by-default'",
    ({ path: relPath, label }) => {
      expect(
        read(relPath).includes("file-by-default"),
        `${label} must not contain the stale phrase 'file-by-default' — ` +
          "candidates now tick only when their value-prop block clears the bar.",
      ).toBe(false);
    },
  );
});
