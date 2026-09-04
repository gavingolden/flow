import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Drift + prose lint for the flow-value-rubric feature: the canonical
 * value-prop block at
 * `skills/universal/flow-backlog-triage/references/value-rubric.md` is
 * embedded verbatim (marker-delimited) in four consumer files —
 * `methodology.md`, `flow-product-planning/references/discovery-instructions.md`,
 * `flow-fix-applier-instructions/SKILL.md`, and
 * `flow-file-issue/SKILL.md`. There is no
 * runtime read of the canonical file (sub-agents run in consumer worktrees
 * and can't reliably fetch a sibling skill file), so drift between the five
 * copies is a silent authoring bug this lint exists to catch — same
 * cross-file byte-identity idiom as
 * `bin/skill-md-lint.test.ts`'s "Fix-Applier artifact JSON schema drift"
 * describe block, and the same sliced whitespace-normalized `includes()`
 * idiom as `bin/flow-backlog-triage-skill-lint.test.ts`.
 *
 * Also pins the prose-level consumer edits: the tick-only-when-
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

/** Returns the marker-delimited block, or null when the marker is absent. Never asserts — callers assert inside their own `it` so a missing marker surfaces as a named test failure, not a suite-collection error. */
function extractRubricBlock(content: string): string | null {
  const m = content.match(RUBRIC_BLOCK_RE);
  return m ? m[1] : null;
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
    path: "skills/pipeline/flow-fix-applier-instructions/SKILL.md",
    label: "flow-fix-applier-instructions/SKILL.md",
  },
  {
    path: "skills/universal/flow-file-issue/SKILL.md",
    label: "flow-file-issue/SKILL.md",
  },
];

let canonicalBlock = "";

describe("flow-value-rubric: canonical block drift", () => {
  it("value-rubric.md carries the marker-delimited block", () => {
    const block = extractRubricBlock(read(canonicalPath));
    expect(
      block,
      "value-rubric.md must carry a <!-- flow-value-rubric:begin --> … " +
        "<!-- flow-value-rubric:end --> marker-delimited block.",
    ).not.toBeNull();
    canonicalBlock = block ?? "";
  });

  it.each(CONSUMERS)(
    "$label embeds the value-prop block byte-identical to value-rubric.md",
    ({ path: relPath, label }) => {
      const block = extractRubricBlock(read(relPath));
      expect(
        block,
        `${label} must carry a <!-- flow-value-rubric:begin --> … ` +
          "<!-- flow-value-rubric:end --> marker-delimited block.",
      ).not.toBeNull();
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
    "- **Value rank:**",
    "- **Complexity:**",
    "- **Risk:**",
    "- **If never done:**",
    "- **Verdict:**",
    "clears bar",
    "below bar",
    "[anchor:",
    "worse than `none`",
    "Short form",
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

describe("flow-value-rubric: discovery tick-only-when-clears-bar rule", () => {
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

describe("flow-value-rubric: step-10 sweep carries .details", () => {
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

describe("flow-value-rubric: below-bar deferrals stay unfiled (fix-applier / pr-review)", () => {
  const fixApplierContent = read(
    "skills/pipeline/flow-fix-applier-instructions/SKILL.md",
  );

  it("flow-fix-applier-instructions/SKILL.md states the below-bar-deferrals-not-filed rule", () => {
    expect(
      fixApplierContent.includes("Below-bar deferrals are not filed"),
    ).toBe(true);
  });

  it("flow-fix-applier-instructions/SKILL.md's below-bar reason begins 'below bar — '", () => {
    expect(fixApplierContent.includes("below bar — ")).toBe(true);
  });

  it("flow-fix-applier-instructions/SKILL.md's deferred-body.md heredoc carries all eight value-prop labels", () => {
    const start = fixApplierContent.indexOf(
      'cat > "$WORKTREE/.flow-tmp/deferred-body.md"',
    );
    expect(
      start,
      "flow-fix-applier-instructions/SKILL.md must carry the deferred-body.md heredoc.",
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
      "- **Value rank:**",
      "- **Complexity:**",
      "- **Risk:**",
      "- **If never done:**",
      "- **Verdict:**",
    ]) {
      expect(
        heredoc.includes(label),
        `flow-fix-applier-instructions/SKILL.md's deferred-body.md heredoc must ` +
          `include the value-prop label '${label}'.`,
      ).toBe(true);
    }
  });

  it("flow-pr-review/SKILL.md renders below-bar deferrals under their own sub-list", () => {
    const prReview = read("skills/pipeline/flow-pr-review/SKILL.md");
    expect(prReview.includes("Below bar (not filed)")).toBe(true);
  });
});

describe("flow-value-rubric: no file-by-default / pre-ticked wording survives", () => {
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

  // Durable tree-wide sweep, mirroring Test Step 7's shell-only
  // `grep -rqn 'file-by-default' skills references AGENTS.md templates
  // bin/flow-candidate-issues.ts` so a reintroduction in a file NOT on the
  // NO_FILE_BY_DEFAULT allowlist above (e.g. a references/*.md under a
  // different skill) is caught by `npm run test`, not only by someone
  // re-running the shell line by hand.
  function mdFilesUnder(rel: string): string[] {
    const dirPath = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(dirPath)) return [];
    return fs
      .readdirSync(dirPath, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && /\.(md|template)$/.test(d.name))
      .map((d) =>
        path.relative(REPO_ROOT, path.join(d.parentPath ?? d.path, d.name)),
      );
  }

  const SWEEP = [
    ...mdFilesUnder("skills"),
    ...mdFilesUnder("references"),
    ...mdFilesUnder("templates"),
    "AGENTS.md",
    "bin/flow-candidate-issues.ts",
  ];

  it.each(SWEEP)("%s no longer contains 'file-by-default'", (rel) => {
    expect(read(rel).includes("file-by-default")).toBe(false);
  });
});

describe("flow-value-rubric: no stale Cost label survives", () => {
  // The label-only `grep -rq '- **Cost:**'` acceptance check is blind to
  // prose forms of the same idea (e.g. "the Cost line is …", "rendered as
  // six nested sub-bullets (… / Cost / …)"). This sweep catches both the
  // label and the word "Cost line" tree-wide in a single pass over each
  // file, mirroring the `mdFilesUnder`/`SWEEP` idiom above.
  function mdFilesUnder(rel: string): string[] {
    const dirPath = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(dirPath)) return [];
    return fs
      .readdirSync(dirPath, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && /\.(md|template)$/.test(d.name))
      .map((d) =>
        path.relative(REPO_ROOT, path.join(d.parentPath ?? d.path, d.name)),
      );
  }

  const SWEEP = [
    ...mdFilesUnder("skills"),
    ...mdFilesUnder("references"),
    ...mdFilesUnder("templates"),
  ];

  it.each(SWEEP)("%s no longer contains a stale Cost reference", (rel) => {
    const contents = read(rel);
    expect(contents.includes("- **Cost:**")).toBe(false);
    expect(contents.includes("Cost line")).toBe(false);
  });
});
