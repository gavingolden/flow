import { describe, expect, it } from "vitest";
import {
  extractTaskBreakdown,
  gradeTasks,
} from "../evals/system-design-defaults/grade-tasks";

const PLAN = [
  "# PRD",
  "",
  "## Architecture Decisions",
  "",
  "### Runtime design",
  "Cloud Tasks queue with idempotency key.",
  "",
  "# Task breakdown",
  "",
  "### Task 1: handler",
  "- Enqueue one Cloud Tasks task per report; timeout 5 min.",
  "- The scheduler stays inline — no queue needed here.",
  "",
  "# PR description draft",
  "",
  "Mentions a spend ledger only here.",
].join("\n");

describe("extractTaskBreakdown", () => {
  it("bounds the section at the next H1", () => {
    const section = extractTaskBreakdown(PLAN);
    expect(section).toContain("Task 1: handler");
    expect(section).not.toContain("spend ledger");
  });

  it("returns null when there is no Task breakdown heading", () => {
    expect(extractTaskBreakdown("# PRD\n\n## Architecture Decisions\n")).toBe(
      null,
    );
  });

  it("ignores PRD template headers above the section", () => {
    expect(extractTaskBreakdown(PLAN)).not.toContain("Runtime design");
  });
});

describe("gradeTasks", () => {
  it("matches case-insensitively", () => {
    expect(gradeTasks(PLAN, "cloud tasks", false)).toBe(true);
    expect(gradeTasks(PLAN, "CLOUD TASKS", false)).toBe(true);
  });

  it("fails a pattern absent from the section, even if present elsewhere", () => {
    expect(gradeTasks(PLAN, "spend ledger", false)).toBe(false);
  });

  it("--absent passes when nothing matches and fails when something does", () => {
    expect(gradeTasks(PLAN, "pub/?sub", true)).toBe(true);
    expect(gradeTasks(PLAN, "enqueue", true)).toBe(false);
  });

  it("--absent skips negated lines", () => {
    const plan = "# Task breakdown\n\nStays inline — no queue worker here.\n";
    expect(gradeTasks(plan, "queue worker", true)).toBe(true);
    expect(gradeTasks(plan, "queue worker", false)).toBe(true);
  });

  it("compiles a (?i)-free pattern and throws without a section", () => {
    expect(() => gradeTasks(PLAN, "idempoten|timeout", false)).not.toThrow();
    expect(() => gradeTasks("# PRD\n", "x", false)).toThrow(/Task breakdown/);
  });
});
