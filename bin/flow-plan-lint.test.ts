import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

- [ ] none

## Recommendation

**Proceed** — clear value.

**Redundancy:** none found

## Plan risks

The export format might not match user expectations.

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
  it("parses --plan-md-file", () => {
    const parsed = parseArgs(["--plan-md-file", "/tmp/plan.md"]);
    expect(parsed).toEqual({ planMdFile: "/tmp/plan.md" });
  });

  it("errors when --plan-md-file is missing", () => {
    const parsed = parseArgs([]);
    expect("error" in parsed).toBe(true);
  });

  it("errors on an unknown flag", () => {
    const parsed = parseArgs(["--bogus"]);
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
});
