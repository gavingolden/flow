import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { lintPlan, parseArgs, run } from "./flow-plan-lint";

const CONFORMING_PLAN = `# PRD

# Widget Exporter

**Goal:** Let users export a widget to CSV in one click.

## Problem Statement

Users cannot export widgets today.

## Scope Boundary

**In scope:** CSV export.

## Behavioral contrast

### User flow (before -> after)

| Before | After |
| --- | --- |
| No export | CSV export button |

### System flow (before -> after)

- **Before:** nothing.
- **After:** a new export endpoint.

**Lost:** none

## User Stories / Acceptance Criteria

### Story 1

- [ ] Given a widget, when exported, then a CSV downloads.

## Architecture Decisions

- **Layers touched:** UI, domain.

## Technical Constraints

- none beyond repo-wide conventions

## Open Questions

- [ ] [Is CSV the only export format needed? — a second format adds a task]
  - **Stakes:** system — a second format adds a task and a schema change if missed
  - **Recommended:** CSV only — the request names CSV and no other consumer exists. [confidence: high] [anchor: user: "just CSV for now"]

## Recommendation

**Proceed** — clear value. [confidence: medium] [anchor: weighing: risk — self-contained, low-blast-radius scope]

**Redundancy:** none found

## Plan risks

The export format might not match user expectations.

## Cut list

nothing — plan is minimal.

# Task breakdown

### Task 1: Add export button

- **Skill:** \`svelte\`
- **Description:** Add the button.
- **Inputs:** none
- **Outputs:** a button
- **Contract:**
  - **Files:** create src/ExportButton.svelte
  - **Interfaces:** none
  - **Call-site edits:** none
- **Acceptance criteria:** \`npm run test -- ExportButton\`

# PR description draft

## Why

Users want CSV export.
`;

function withoutSection(plan: string, heading: string): string {
  const re = new RegExp(
    `^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?(?=^#{1,2} |$)`,
    "m",
  );
  return plan.replace(re, "");
}

describe("lintPlan — always-present sections", () => {
  it("returns zero misses for a conforming plan", () => {
    const { misses } = lintPlan(CONFORMING_PLAN);
    expect(misses).toEqual([]);
  });

  it("names a miss when the '# PRD' heading itself is absent", () => {
    const plan = CONFORMING_PLAN.replace("# PRD\n\n", "");
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("missing '# PRD' heading"))).toBe(
      true,
    );
  });

  it("names a miss when '**Goal:**' is absent from the '# PRD' section", () => {
    const plan = CONFORMING_PLAN.replace(
      "**Goal:** Let users export a widget to CSV in one click.\n\n",
      "",
    );
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("Goal"))).toBe(true);
  });

  it("names a miss when '## Problem Statement' is absent", () => {
    const plan = withoutSection(CONFORMING_PLAN, "## Problem Statement");
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("Problem Statement"))).toBe(true);
  });

  it("names a miss when '## Behavioral contrast' is absent", () => {
    const plan = withoutSection(CONFORMING_PLAN, "## Behavioral contrast");
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("Behavioral contrast"))).toBe(true);
  });

  it("names a miss when the closing '**Lost:**' line is absent from Behavioral contrast", () => {
    const plan = CONFORMING_PLAN.replace("\n**Lost:** none\n", "\n");
    const { misses } = lintPlan(plan);
    expect(
      misses.some(
        (m) => m.includes("Behavioral contrast") && m.includes("Lost"),
      ),
    ).toBe(true);
  });

  it("names a miss when '## Recommendation' is absent", () => {
    const plan = withoutSection(CONFORMING_PLAN, "## Recommendation");
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("Recommendation"))).toBe(true);
  });

  it("names a miss when the '**Redundancy:**' affirmation line is absent from Recommendation", () => {
    const plan = CONFORMING_PLAN.replace(
      "\n**Redundancy:** none found\n",
      "\n",
    );
    const { misses } = lintPlan(plan);
    expect(
      misses.some(
        (m) => m.includes("Recommendation") && m.includes("Redundancy"),
      ),
    ).toBe(true);
  });

  it("names a miss when '## Plan risks' is absent", () => {
    const plan = withoutSection(CONFORMING_PLAN, "## Plan risks");
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("Plan risks"))).toBe(true);
  });

  it("names a miss when '## Cut list' is absent", () => {
    const plan = withoutSection(CONFORMING_PLAN, "## Cut list");
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("Cut list"))).toBe(true);
  });

  it("names a miss when '## Cut list' asserts a bare 'nothing' with no justification", () => {
    const plan = CONFORMING_PLAN.replace(
      "nothing — plan is minimal.",
      "nothing",
    );
    const { misses } = lintPlan(plan);
    expect(
      misses.some((m) => m.includes("Cut list") && m.includes("nothing")),
    ).toBe(true);
  });

  it("does not miss a justified 'nothing' Cut list", () => {
    const { misses } = lintPlan(CONFORMING_PLAN);
    expect(misses.some((m) => m.includes("no justification"))).toBe(false);
  });

  it("names a miss when '# Task breakdown' is absent", () => {
    const plan = CONFORMING_PLAN.replace("# Task breakdown\n\n", "");
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("Task breakdown"))).toBe(true);
  });

  it("names a miss when a task lacks a '- **Contract:**' block", () => {
    const plan = CONFORMING_PLAN.replace(
      /- \*\*Contract:\*\*[\s\S]*?(?=- \*\*Acceptance criteria:\*\*)/,
      "",
    );
    const { misses } = lintPlan(plan);
    expect(
      misses.some((m) => m.includes("Task 1") && m.includes("Contract")),
    ).toBe(true);
  });

  it("never throws on malformed markdown", () => {
    expect(() => lintPlan("not markdown at all {{{")).not.toThrow();
    expect(() => lintPlan("")).not.toThrow();
  });
});

describe("lintPlan — Contract sub-structure advisory", () => {
  it("names both sub-structure misses for a hollow Contract block", () => {
    const plan = CONFORMING_PLAN.replace(
      "- **Contract:**\n  - **Files:** create src/ExportButton.svelte\n  - **Interfaces:** none\n  - **Call-site edits:** none\n",
      "- **Contract:** see description\n",
    );
    const { misses } = lintPlan(plan);
    expect(
      misses.some((m) => m.includes("Task 1") && m.includes("'- **Files:**'")),
    ).toBe(true);
    expect(
      misses.some(
        (m) => m.includes("Task 1") && m.includes("no surgical sub-bullet"),
      ),
    ).toBe(true);
  });

  it("names only the second-sub-bullet miss for a Files-only Contract block", () => {
    const plan = CONFORMING_PLAN.replace(
      "- **Contract:**\n  - **Files:** create src/ExportButton.svelte\n  - **Interfaces:** none\n  - **Call-site edits:** none\n",
      "- **Contract:**\n  - **Files:** create src/ExportButton.svelte\n",
    );
    const { misses } = lintPlan(plan);
    expect(
      misses.some((m) => m.includes("Task 1") && m.includes("'- **Files:**'")),
    ).toBe(false);
    expect(
      misses.some(
        (m) => m.includes("Task 1") && m.includes("no surgical sub-bullet"),
      ),
    ).toBe(true);
  });

  it("names no contract misses for a conforming Files+Interfaces+Call-site block", () => {
    const { misses } = lintPlan(CONFORMING_PLAN);
    expect(misses.some((m) => m.includes("Contract block"))).toBe(false);
  });

  it("names no contract misses for a conforming config-form block with a non-Interfaces label", () => {
    const plan = CONFORMING_PLAN.replace(
      "- **Contract:**\n  - **Files:** create src/ExportButton.svelte\n  - **Interfaces:** none\n  - **Call-site edits:** none\n",
      "- **Contract:**\n  - **Files:** update config.yaml\n  - **Keys:** add `export.enabled`\n",
    );
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("Contract block"))).toBe(false);
  });

  it("warns (advisory) when acceptance criteria has no backtick-quoted command", () => {
    const plan = CONFORMING_PLAN.replace(
      "- **Acceptance criteria:** `npm run test -- ExportButton`",
      "- **Acceptance criteria:** looks right",
    );
    const { misses } = lintPlan(plan);
    expect(
      misses.some(
        (m) => m.startsWith("warn:") && m.includes("acceptance criteria"),
      ),
    ).toBe(true);
  });

  it("does not warn when acceptance criteria has a backtick-quoted command", () => {
    const { misses } = lintPlan(CONFORMING_PLAN);
    expect(
      misses.some((m) => m.includes("acceptance criteria has no backtick")),
    ).toBe(false);
  });

  it("does not warn when the acceptance command is on a continuation line", () => {
    const plan = CONFORMING_PLAN.replace(
      "- **Acceptance criteria:** `npm run test -- ExportButton`",
      "- **Acceptance criteria:**\n  - `npm run test -- ExportButton` passes",
    );
    const { misses } = lintPlan(plan);
    expect(
      misses.some((m) => m.includes("acceptance criteria has no backtick")),
    ).toBe(false);
  });

  it("does not fire a Contract-sub-bullet miss when the Contract block runs to end-of-body", () => {
    const plan = CONFORMING_PLAN.replace(
      "- **Acceptance criteria:** `npm run test -- ExportButton`\n",
      "",
    );
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("Contract block"))).toBe(false);
  });

  it("does not warn on missing acceptance criteria when the bullet is absent entirely", () => {
    const plan = CONFORMING_PLAN.replace(
      "- **Acceptance criteria:** `npm run test -- ExportButton`\n",
      "",
    );
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("acceptance criteria"))).toBe(false);
  });

  it("attributes Contract sub-structure misses to the right task in a multi-task plan", () => {
    const plan = CONFORMING_PLAN.replace(
      "# PR description draft",
      `### Task 2: Wire up the export endpoint

- **Skill:** \`node\`
- **Description:** Add the endpoint.
- **Inputs:** none
- **Outputs:** an endpoint
- **Contract:** see description
- **Acceptance criteria:** looks right

# PR description draft`,
    );
    const { misses } = lintPlan(plan);
    expect(
      misses.some((m) => m.includes("Task 2") && m.includes("'- **Files:**'")),
    ).toBe(true);
    expect(
      misses.some((m) => m.includes("Task 1") && m.includes("Contract block")),
    ).toBe(false);
  });
});

describe("lintPlan — Candidate follow-up issues ranking table", () => {
  it("never fires when the section is absent", () => {
    const { misses } = lintPlan(CONFORMING_PLAN);
    expect(misses.some((m) => m.includes("candidate ranking table"))).toBe(
      false,
    );
  });

  it("misses 'missing candidate ranking table' when items exist with no table", () => {
    const plan =
      CONFORMING_PLAN +
      "\n# Candidate follow-up issues\n\n- [ ] Some idea — one-line body\n";
    const { misses } = lintPlan(plan);
    expect(
      misses.some((m) => m.includes("missing candidate ranking table")),
    ).toBe(true);
  });

  it("misses missing-Relation-column when the table lacks that column", () => {
    const plan =
      CONFORMING_PLAN +
      "\n# Candidate follow-up issues\n\n" +
      "| Candidate | Value | Complexity | Rationale | Pull into this pipeline? |\n" +
      "| --- | --- | --- | --- | --- |\n" +
      "| Some idea | High | Trivial | worth it | No |\n\n" +
      "- [ ] Some idea — one-line body\n";
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("Relation to current request"))).toBe(
      true,
    );
  });

  it("no misses when a six-column table is present with the section", () => {
    const plan =
      CONFORMING_PLAN +
      "\n# Candidate follow-up issues\n\n" +
      "| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n" +
      "| --- | --- | --- | --- | --- | --- |\n" +
      "| Some idea | High | Trivial | worth it | close | No |\n\n" +
      "- [ ] Some idea — one-line body\n";
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("candidate ranking table"))).toBe(
      false,
    );
  });

  it("never fires when the section is present but empty (no checkbox items)", () => {
    const plan =
      CONFORMING_PLAN + "\n# Candidate follow-up issues\n\nprose only.\n";
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("candidate ranking table"))).toBe(
      false,
    );
  });
});

describe("lintPlan — Prompt interpretation / Recommended path", () => {
  it("does not check Recommended path when '## Prompt interpretation' is absent", () => {
    const { misses } = lintPlan(CONFORMING_PLAN);
    expect(misses.some((m) => m.includes("Prompt interpretation"))).toBe(false);
  });

  it("names a miss when '## Prompt interpretation' is present but has no parseable Recommended path", () => {
    const plan =
      CONFORMING_PLAN +
      "\n## Prompt interpretation\n\n- **Reading of prescribed methods:** exhaustive\n";
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("Prompt interpretation"))).toBe(true);
  });

  it("passes when '## Prompt interpretation' carries a valid one-line Recommended path", () => {
    const plan =
      CONFORMING_PLAN +
      "\n## Prompt interpretation\n\n- **Recommended path:** methods plausibly reach target\n";
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("Prompt interpretation"))).toBe(false);
  });
});

describe("lintPlan — Method selection", () => {
  it("does not check Method selection when the heading is absent", () => {
    const { misses } = lintPlan(CONFORMING_PLAN);
    expect(misses.some((m) => m.includes("Method selection"))).toBe(false);
  });

  it("passes on a well-formed section (verdict + chosen method + quoted judge lines)", () => {
    const plan =
      CONFORMING_PLAN +
      "\n## Method selection\n\n" +
      "- **User's method:** a Task-tool judge sub-agent\n" +
      '- **Judge A (Gemini 3.1 Pro (High)):** "Add a supervisor-side blind survey before discovery drafts a plan." — a fan-out over two pinned judges\n' +
      '- **Judge B (Claude Opus 4.6 (Thinking)):** "Run two model-pinned judges over a goal-only brief." — converges with judge A\n' +
      "- **Survey verdict:** converge-against\n" +
      "- **Chosen method:** blind survey — both judges independently converged away from the user's proposed method\n";
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("Method selection"))).toBe(false);
  });

  it("names a miss when the verdict line is missing", () => {
    const plan =
      CONFORMING_PLAN +
      "\n## Method selection\n\n" +
      '- **Judge A (Gemini 3.1 Pro (High)):** "Add a blind survey." — recommendation\n' +
      "- **Chosen method:** blind survey — rationale\n";
    const { misses } = lintPlan(plan);
    expect(
      misses.some(
        (m) => m.includes("Method selection") && m.includes("Survey verdict"),
      ),
    ).toBe(true);
  });

  it("names a miss when the verdict is misspelled", () => {
    const plan =
      CONFORMING_PLAN +
      "\n## Method selection\n\n" +
      "- **Survey verdict:** converge-againstt\n" +
      "- **Chosen method:** blind survey — rationale\n";
    const { misses } = lintPlan(plan);
    expect(
      misses.some(
        (m) => m.includes("Method selection") && m.includes("Survey verdict"),
      ),
    ).toBe(true);
  });

  it("names a miss naming the judge when a non-skipped judge line has no quoted excerpt", () => {
    const plan =
      CONFORMING_PLAN +
      "\n## Method selection\n\n" +
      "- **Survey verdict:** split\n" +
      "- **Judge A (Gemini 3.1 Pro (High)):** a blind survey with no quoted excerpt\n" +
      "- **Chosen method:** blind survey — rationale\n";
    const { misses } = lintPlan(plan);
    const miss = misses.find(
      (m) => m.includes("Method selection") && m.includes("Judge A"),
    );
    expect(miss).toBeDefined();
  });

  it("does not require a quoted excerpt on a skipped judge line", () => {
    const plan =
      CONFORMING_PLAN +
      "\n## Method selection\n\n" +
      "- **Survey verdict:** split\n" +
      "- **Judge A (Gemini 3.1 Pro (High)):** skipped: agy-timeout\n" +
      '- **Judge B (Claude Opus 4.6 (Thinking)):** "Run two model-pinned judges." — recommendation\n' +
      "- **Chosen method:** blind survey — rationale\n";
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("Judge A"))).toBe(false);
  });

  it("names a miss when '- **Chosen method:**' is missing", () => {
    const plan =
      CONFORMING_PLAN +
      "\n## Method selection\n\n" +
      "- **Survey verdict:** converge-with\n" +
      '- **Judge A (Gemini 3.1 Pro (High)):** "Add a blind survey." — recommendation\n';
    const { misses } = lintPlan(plan);
    expect(
      misses.some(
        (m) => m.includes("Method selection") && m.includes("Chosen method"),
      ),
    ).toBe(true);
  });

  it("names a miss when the section has a verdict + chosen method but zero Judge A/Judge B lines (the audit trail is the whole point of the section)", () => {
    const plan =
      CONFORMING_PLAN +
      "\n## Method selection\n\n" +
      "- **Survey verdict:** converge-against\n" +
      "- **Chosen method:** blind survey — rationale\n";
    const { misses } = lintPlan(plan);
    expect(
      misses.some(
        (m) => m.includes("Method selection") && m.includes("Judge A"),
      ),
    ).toBe(true);
    expect(
      misses.some(
        (m) => m.includes("Method selection") && m.includes("Judge B"),
      ),
    ).toBe(true);
  });

  it("an absent heading without opts.surveyRan is still silent (unchanged default)", () => {
    const { misses } = lintPlan(CONFORMING_PLAN, { surveyRan: false });
    expect(misses.some((m) => m.includes("Method selection"))).toBe(false);
  });

  it("an absent heading WITH surveyRan:true is a named miss", () => {
    const { misses } = lintPlan(CONFORMING_PLAN, { surveyRan: true });
    expect(
      misses.some(
        (m) => m.includes("survey ran") && m.includes("Method selection"),
      ),
    ).toBe(true);
  });

  it("a present, well-formed section with surveyRan:true still names no miss", () => {
    const plan =
      CONFORMING_PLAN +
      "\n## Method selection\n\n" +
      '- **Judge A (Gemini 3.1 Pro (High)):** "Add a supervisor-side blind survey before discovery drafts a plan." — a fan-out over two pinned judges\n' +
      '- **Judge B (Claude Opus 4.6 (Thinking)):** "Run two model-pinned judges over a goal-only brief." — converges with judge A\n' +
      "- **Survey verdict:** converge-against\n" +
      "- **Chosen method:** blind survey — both judges independently converged away from the user's proposed method\n";
    const { misses } = lintPlan(plan, { surveyRan: true });
    expect(misses.some((m) => m.includes("Method selection"))).toBe(false);
  });
});

describe("lintPlan — Goal-line length advisory", () => {
  it("warns (advisory) when the Goal line exceeds 30 words", () => {
    const longGoal = Array.from({ length: 35 }, (_, i) => `word${i}`).join(" ");
    const plan = CONFORMING_PLAN.replace(
      "**Goal:** Let users export a widget to CSV in one click.",
      `**Goal:** ${longGoal}`,
    );
    const { misses } = lintPlan(plan);
    expect(
      misses.some((m) => m.startsWith("warn:") && m.includes("Goal")),
    ).toBe(true);
  });

  it("does not warn when the Goal line is <=30 words", () => {
    const { misses } = lintPlan(CONFORMING_PLAN);
    expect(misses.some((m) => m.includes("advisory bound"))).toBe(false);
  });
});

describe("lintPlan — Open Questions resolution", () => {
  it("passes when an unchecked entry carries a Recommended marker on a nested sub-bullet", () => {
    const { misses } = lintPlan(CONFORMING_PLAN);
    expect(misses.some((m) => m.includes("resolution-first"))).toBe(false);
  });

  it("names a miss when an unchecked entry lacks both markers", () => {
    const plan = CONFORMING_PLAN.replace(
      '- [ ] [Is CSV the only export format needed? — a second format adds a task]\n  - **Stakes:** system — a second format adds a task and a schema change if missed\n  - **Recommended:** CSV only — the request names CSV and no other consumer exists. [confidence: high] [anchor: user: "just CSV for now"]',
      "- [ ] Should exports be paginated?",
    );
    const { misses } = lintPlan(plan);
    expect(
      misses.some(
        (m) =>
          m.includes("resolution-first") &&
          m.includes("Should exports be paginated?"),
      ),
    ).toBe(true);
  });

  it("exits 1 via the CLI when an entry lacks both markers", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "flow-plan-lint-oq-"));
    try {
      const planPath = path.join(dir, "plan.md");
      writeFileSync(
        planPath,
        CONFORMING_PLAN.replace(
          '  - **Recommended:** CSV only — the request names CSV and no other consumer exists. [confidence: high] [anchor: user: "just CSV for now"]\n',
          "",
        ),
      );
      expect(run(["--plan-md-file", planPath])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exempts checked '- [x]' entries", () => {
    const plan = CONFORMING_PLAN.replace(
      "## Open Questions\n",
      "## Open Questions\n\n- [x] Resolved: format is CSV (decision note).\n",
    );
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("resolution-first"))).toBe(false);
  });

  it("exempts uppercase checked '- [X]' entries", () => {
    const plan = CONFORMING_PLAN.replace(
      "## Open Questions\n",
      "## Open Questions\n\n- [X] Resolved: format is CSV (decision note).\n",
    );
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("resolution-first"))).toBe(false);
  });

  it("flags an unchecked entry followed by a resolved top-level entry (block-boundary slicing)", () => {
    const plan = CONFORMING_PLAN.replace(
      '- [ ] [Is CSV the only export format needed? — a second format adds a task]\n  - **Stakes:** system — a second format adds a task and a schema change if missed\n  - **Recommended:** CSV only — the request names CSV and no other consumer exists. [confidence: high] [anchor: user: "just CSV for now"]',
      "- [ ] Should exports be paginated?\n" +
        "- [ ] [Is CSV the only export format needed? — a second format adds a task]\n" +
        "  - **Stakes:** system — a second format adds a task and a schema change if missed\n" +
        '  - **Recommended:** CSV only — the request names CSV and no other consumer exists. [confidence: high] [anchor: user: "just CSV for now"]',
    );
    const { misses } = lintPlan(plan);
    expect(
      misses.some(
        (m) =>
          m.includes("resolution-first") &&
          m.includes("Should exports be paginated?"),
      ),
    ).toBe(true);
    expect(
      misses.some(
        (m) =>
          m.includes("resolution-first") &&
          m.includes("Is CSV the only export format needed?"),
      ),
    ).toBe(false);
  });

  it("does not fire when the '## Open Questions' heading is absent", () => {
    const plan = withoutSection(CONFORMING_PLAN, "## Open Questions");
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("resolution-first"))).toBe(false);
  });

  it("passes when the '**Recommended:**' marker sits on the entry's own line", () => {
    const plan = CONFORMING_PLAN.replace(
      '- [ ] [Is CSV the only export format needed? — a second format adds a task]\n  - **Stakes:** system — a second format adds a task and a schema change if missed\n  - **Recommended:** CSV only — the request names CSV and no other consumer exists. [confidence: high] [anchor: user: "just CSV for now"]',
      "- [ ] Should exports be paginated? **Recommended:** no — out of scope.",
    );
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("resolution-first"))).toBe(false);
  });

  it("truncates a long entry line to 60 characters in the miss message", () => {
    const longLine =
      "Should this extremely long open question line get truncated in the miss message for readability purposes?";
    const plan = CONFORMING_PLAN.replace(
      '- [ ] [Is CSV the only export format needed? — a second format adds a task]\n  - **Stakes:** system — a second format adds a task and a schema change if missed\n  - **Recommended:** CSV only — the request names CSV and no other consumer exists. [confidence: high] [anchor: user: "just CSV for now"]',
      `- [ ] ${longLine}`,
    );
    const { misses } = lintPlan(plan);
    const miss = misses.find((m) => m.includes("resolution-first"));
    expect(miss).toBeDefined();
    expect(miss).toContain(`'${`- [ ] ${longLine}`.slice(0, 60)}'`);
    expect(miss).not.toContain(longLine.slice(60));
  });

  it("accepts a '**Needs user input:**' escape in place of a recommendation", () => {
    const plan = CONFORMING_PLAN.replace(
      '  - **Recommended:** CSV only — the request names CSV and no other consumer exists. [confidence: high] [anchor: user: "just CSV for now"]',
      "  - **Needs user input:** user-held preference on export format.",
    );
    const { misses } = lintPlan(plan);
    expect(misses.some((m) => m.includes("resolution-first"))).toBe(false);
  });
});

describe("lintPlan — confidence + stakes markers", () => {
  function oqPlan(entry: string): string {
    return `## Open Questions\n\n${entry}\n`;
  }

  function daPlan(verdictLine: string): string {
    return `## Decision analysis\n\n${verdictLine}\n\n## Recommendation\n\n**Proceed** — fine. [confidence: high] [anchor: user: "ok"]\n`;
  }

  it("names a miss when the Recommended line has no confidence tag", () => {
    const { misses } = lintPlan(
      oqPlan(
        '- [ ] Q?\n  - **Stakes:** system — degrades reliability\n  - **Recommended:** yes — because. [anchor: user: "quote"]',
      ),
    );
    expect(misses.some((m) => m.startsWith("confidence-missing"))).toBe(true);
  });

  it("names a miss when the Recommended line has a confidence tag but no anchor tag", () => {
    const { misses } = lintPlan(
      oqPlan(
        "- [ ] Q?\n  - **Stakes:** system — degrades reliability\n  - **Recommended:** yes — because. [confidence: high]",
      ),
    );
    expect(misses.some((m) => m.startsWith("anchor-missing-tag"))).toBe(true);
  });

  it("names anchor-missing for a 'high' entry whose file path does not exist", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "flow-plan-lint-anchor-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: dir });
      const planPath = path.join(dir, "plan.md");
      const plan = oqPlan(
        "- [ ] Q?\n  - **Stakes:** system — degrades reliability\n  - **Recommended:** yes — because. [confidence: high] [anchor: does/not/exist.ts:1]",
      );
      writeFileSync(planPath, plan);
      const { misses } = lintPlan(plan, { planMdFile: planPath });
      expect(misses.some((m) => m.startsWith("anchor-missing:"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has no miss for a 'high' entry whose file path exists", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "flow-plan-lint-anchor-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(path.join(dir, "real.ts"), "export {};\n");
      const planPath = path.join(dir, "plan.md");
      const plan = oqPlan(
        "- [ ] Q?\n  - **Stakes:** system — degrades reliability\n  - **Recommended:** yes — because. [confidence: high] [anchor: real.ts:1]",
      );
      writeFileSync(planPath, plan);
      const { misses } = lintPlan(plan, { planMdFile: planPath });
      expect(
        misses.some(
          (m) =>
            m.startsWith("anchor-missing") || m.startsWith("high-anchor-form"),
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has no miss for a 'high' entry with a user-quote anchor", () => {
    const { misses } = lintPlan(
      oqPlan(
        '- [ ] Q?\n  - **Stakes:** system — degrades reliability\n  - **Recommended:** yes — because. [confidence: high] [anchor: user: "just do it"]',
      ),
    );
    expect(
      misses.some(
        (m) =>
          m.startsWith("anchor-missing") || m.startsWith("high-anchor-form"),
      ),
    ).toBe(false);
  });

  it("names medium-anchor-form for a 'medium' entry with a bare path", () => {
    const { misses } = lintPlan(
      oqPlan(
        "- [ ] Q?\n  - **Stakes:** system — degrades reliability\n  - **Recommended:** yes — because. [confidence: medium] [anchor: bin/flow-plan-lint.ts:1]",
      ),
    );
    expect(misses.some((m) => m.startsWith("medium-anchor-form"))).toBe(true);
  });

  it("has no miss for a 'medium' entry with an existing 'adjacent:' path", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "flow-plan-lint-anchor-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(path.join(dir, "real.ts"), "export {};\n");
      const planPath = path.join(dir, "plan.md");
      const plan = oqPlan(
        "- [ ] Q?\n  - **Stakes:** system — degrades reliability\n  - **Recommended:** yes — because. [confidence: medium] [anchor: adjacent: real.ts:1]",
      );
      writeFileSync(planPath, plan);
      const { misses } = lintPlan(plan, { planMdFile: planPath });
      expect(
        misses.some(
          (m) =>
            m.startsWith("anchor-missing") ||
            m.startsWith("medium-anchor-form"),
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names anchor-missing for a 'medium' entry with a nonexistent 'adjacent:' path", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "flow-plan-lint-anchor-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: dir });
      const planPath = path.join(dir, "plan.md");
      const plan = oqPlan(
        "- [ ] Q?\n  - **Stakes:** system — degrades reliability\n  - **Recommended:** yes — because. [confidence: medium] [anchor: adjacent: does/not/exist.ts:1]",
      );
      writeFileSync(planPath, plan);
      const { misses } = lintPlan(plan, { planMdFile: planPath });
      expect(misses.some((m) => m.startsWith("anchor-missing:"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has no miss for a 'medium' entry with a closed-list 'weighing:' factor", () => {
    const { misses } = lintPlan(
      oqPlan(
        "- [ ] Q?\n  - **Stakes:** system — degrades reliability\n  - **Recommended:** yes — because. [confidence: medium] [anchor: weighing: footprint — smaller blast radius]",
      ),
    );
    expect(misses.some((m) => m.startsWith("medium-anchor-form"))).toBe(false);
  });

  it("names medium-anchor-form for a 'medium' entry with an unlisted 'weighing:' factor", () => {
    const { misses } = lintPlan(
      oqPlan(
        "- [ ] Q?\n  - **Stakes:** system — degrades reliability\n  - **Recommended:** yes — because. [confidence: medium] [anchor: weighing: vibes — feels right]",
      ),
    );
    expect(misses.some((m) => m.startsWith("medium-anchor-form"))).toBe(true);
  });

  it("has no miss for a 'low' entry with an 'inference' anchor", () => {
    const { misses } = lintPlan(
      oqPlan(
        "- [ ] Q?\n  - **Stakes:** system — degrades reliability\n  - **Recommended:** yes — because. [confidence: low] [anchor: inference — rises to medium if a precedent surfaces]",
      ),
    );
    expect(misses.some((m) => m.startsWith("low-anchor-form"))).toBe(false);
  });

  it("names low-anchor-form for a 'low' entry with a path anchor", () => {
    const { misses } = lintPlan(
      oqPlan(
        "- [ ] Q?\n  - **Stakes:** system — degrades reliability\n  - **Recommended:** yes — because. [confidence: low] [anchor: bin/flow-plan-lint.ts:1]",
      ),
    );
    expect(misses.some((m) => m.startsWith("low-anchor-form"))).toBe(true);
  });

  it("names stakes-missing when an unchecked entry has no Stakes line", () => {
    const { misses } = lintPlan(
      oqPlan(
        '- [ ] Q?\n  - **Recommended:** yes — because. [confidence: high] [anchor: user: "quote"]',
      ),
    );
    expect(misses.some((m) => m.startsWith("stakes-missing"))).toBe(true);
  });

  it("names stakes-missing when an unchecked entry declares 'Stakes: none'", () => {
    const { misses } = lintPlan(
      oqPlan(
        '- [ ] Q?\n  - **Stakes:** none — resolved without asking\n  - **Recommended:** yes — because. [confidence: high] [anchor: user: "quote"]',
      ),
    );
    expect(misses.some((m) => m.startsWith("stakes-missing"))).toBe(true);
  });

  it("has no miss for a checked '- [x]' entry with 'Stakes: none'", () => {
    const { misses } = lintPlan(
      oqPlan(
        "- [x] Q? — resolved without asking\n  - **Stakes:** none — resolved without asking",
      ),
    );
    expect(misses.some((m) => m.startsWith("stakes-missing"))).toBe(false);
  });

  it("names verdict-confidence-missing for a Decision analysis Verdict line with no tag", () => {
    const { misses } = lintPlan(
      daPlan("**Decision A — fork?** Verdict: **branch 1** — rationale."),
    );
    expect(misses.some((m) => m.startsWith("verdict-confidence-missing"))).toBe(
      true,
    );
  });

  it("names verdict-confidence-missing for a Recommendation verdict line with no tag", () => {
    const { misses } = lintPlan(
      "## Recommendation\n\n**Proceed** — clear value, no tag.\n",
    );
    expect(misses.some((m) => m.startsWith("verdict-confidence-missing"))).toBe(
      true,
    );
  });

  it("does not fire any of the new checks when the relevant headings are absent", () => {
    const { misses } = lintPlan(
      "# Widget Exporter\n\nJust prose, no headings.\n",
    );
    expect(
      misses.some((m) =>
        [
          "confidence-missing",
          "anchor-missing",
          "medium-anchor-form",
          "low-anchor-form",
          "stakes-missing",
          "verdict-confidence-missing",
        ].some((prefix) => m.startsWith(prefix)),
      ),
    ).toBe(false);
  });
});

describe("lintPlan — excluded-paths.json cross-check", () => {
  const PLAN_WITH_ALTERNATIVES =
    CONFORMING_PLAN +
    "\n## Alternatives considered\n\n" +
    "- **Server-side rendering** — rejected: adds a build step for no gain.\n" +
    "- **Client-only PDF export** — rejected: browser support is inconsistent.\n";

  it("is clean when both the section and the file are absent", () => {
    const { misses } = lintPlan(CONFORMING_PLAN, {
      excludedPathsJson: undefined,
    });
    expect(misses).toEqual([]);
  });

  it("names a miss when the section is non-empty but the file is absent", () => {
    const { misses } = lintPlan(PLAN_WITH_ALTERNATIVES, {
      excludedPathsJson: undefined,
    });
    expect(
      misses.some(
        (m) => m.includes("excluded-paths.json") && m.includes("missing"),
      ),
    ).toBe(true);
  });

  it("names a miss when excludedPathsJson is malformed JSON", () => {
    const { misses } = lintPlan(PLAN_WITH_ALTERNATIVES, {
      excludedPathsJson: "{not valid json",
    });
    expect(misses.some((m) => m.includes("not valid JSON"))).toBe(true);
  });

  it("is clean when the mirror matches the prose exactly", () => {
    const json = JSON.stringify({
      version: 1,
      excluded: [
        {
          id: "server-side-rendering",
          path: "Server-side rendering",
          reason: "adds a build step for no gain.",
        },
        {
          id: "client-only-pdf-export",
          path: "Client-only PDF export",
          reason: "browser support is inconsistent.",
        },
      ],
    });
    const { misses } = lintPlan(PLAN_WITH_ALTERNATIVES, {
      excludedPathsJson: json,
    });
    expect(misses).toEqual([]);
  });

  it("names a drift miss for a prose bullet missing from the JSON mirror", () => {
    const json = JSON.stringify({
      version: 1,
      excluded: [
        {
          id: "server-side-rendering",
          path: "Server-side rendering",
          reason: "adds a build step for no gain.",
        },
      ],
    });
    const { misses } = lintPlan(PLAN_WITH_ALTERNATIVES, {
      excludedPathsJson: json,
    });
    expect(misses.some((m) => m.includes("Client-only PDF export"))).toBe(true);
  });

  it("names a drift miss for a JSON entry with no matching prose bullet", () => {
    const json = JSON.stringify({
      version: 1,
      excluded: [
        {
          id: "server-side-rendering",
          path: "Server-side rendering",
          reason: "adds a build step for no gain.",
        },
        {
          id: "client-only-pdf-export",
          path: "Client-only PDF export",
          reason: "browser support is inconsistent.",
        },
        { id: "ghost", path: "A ghost entry", reason: "nowhere in prose." },
      ],
    });
    const { misses } = lintPlan(PLAN_WITH_ALTERNATIVES, {
      excludedPathsJson: json,
    });
    expect(misses.some((m) => m.includes("A ghost entry"))).toBe(true);
  });

  it("names a miss when the file has entries but the prose section is empty/absent", () => {
    const json = JSON.stringify({
      version: 1,
      excluded: [{ id: "x", path: "X", reason: "y" }],
    });
    const { misses } = lintPlan(CONFORMING_PLAN, { excludedPathsJson: json });
    expect(
      misses.some(
        (m) => m.includes("excluded-paths.json") && m.includes("empty"),
      ),
    ).toBe(true);
  });
});

describe("parseArgs", () => {
  it("parses --plan-md-file, defaulting surveyRan to false", () => {
    const parsed = parseArgs(["--plan-md-file", "/tmp/plan.md"]);
    expect(parsed).toEqual({ planMdFile: "/tmp/plan.md", surveyRan: false });
  });

  it("parses --survey-ran as a valueless flag alongside --plan-md-file", () => {
    const parsed = parseArgs([
      "--plan-md-file",
      "/tmp/plan.md",
      "--survey-ran",
    ]);
    expect(parsed).toEqual({ planMdFile: "/tmp/plan.md", surveyRan: true });
  });

  it("errors when --plan-md-file is missing", () => {
    const parsed = parseArgs([]);
    expect("error" in parsed).toBe(true);
  });

  it("errors on an unknown flag", () => {
    const parsed = parseArgs(["--bogus"]);
    expect("error" in parsed).toBe(true);
  });

  it("errors on an unknown flag even alongside --survey-ran", () => {
    const parsed = parseArgs([
      "--plan-md-file",
      "/tmp/plan.md",
      "--survey-ran",
      "--config",
      "/c.json",
    ]);
    expect("error" in parsed).toBe(true);
  });

  it("errors when --plan-md-file has no value", () => {
    const parsed = parseArgs(["--plan-md-file"]);
    expect("error" in parsed).toBe(true);
  });
});

describe("run — CLI exit codes", () => {
  function tmpDir(): string {
    return mkdtempSync(path.join(os.tmpdir(), "flow-plan-lint-test-"));
  }

  it("exits 2 on bad args", () => {
    expect(run([])).toBe(2);
  });

  it("exits 2 when the plan file cannot be read", () => {
    expect(run(["--plan-md-file", "/nonexistent/plan.md"])).toBe(2);
  });

  it("exits 0 on a conforming plan with no excluded-paths.json sibling", () => {
    const dir = tmpDir();
    const planPath = path.join(dir, "plan.md");
    writeFileSync(planPath, CONFORMING_PLAN);
    expect(run(["--plan-md-file", planPath])).toBe(0);
  });

  it("exits 1 and prints misses when the plan is non-conforming", () => {
    const dir = tmpDir();
    const planPath = path.join(dir, "plan.md");
    writeFileSync(planPath, "# PRD\n\nnothing here\n");
    expect(run(["--plan-md-file", planPath])).toBe(1);
  });

  it("reads the sibling excluded-paths.json when present", () => {
    const dir = tmpDir();
    const planPath = path.join(dir, "plan.md");
    const plan =
      CONFORMING_PLAN +
      "\n## Alternatives considered\n\n- **X** — rejected: y.\n";
    writeFileSync(planPath, plan);
    writeFileSync(
      path.join(dir, "excluded-paths.json"),
      JSON.stringify({
        version: 1,
        excluded: [{ id: "x", path: "X", reason: "y" }],
      }),
    );
    expect(run(["--plan-md-file", planPath])).toBe(0);
  });

  it("--survey-ran turns an absent '## Method selection' into exit 1 with the named miss", () => {
    const dir = tmpDir();
    const planPath = path.join(dir, "plan.md");
    writeFileSync(planPath, CONFORMING_PLAN);
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(run(["--plan-md-file", planPath])).toBe(0);
      expect(run(["--plan-md-file", planPath, "--survey-ran"])).toBe(1);
      expect(out.join("")).toContain(
        "survey ran but plan.md has no '## Method selection' section",
      );
    } finally {
      process.stdout.write = orig;
    }
  });
});
