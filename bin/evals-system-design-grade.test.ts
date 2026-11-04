import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSuite } from "./lib/eval-suite";
import {
  extractTaskBreakdown,
  gradeTasks,
} from "../evals/system-design-defaults/grade-tasks";

const EVALS_ROOT = path.resolve(__dirname, "..", "evals");

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

  it("--absent still fails an affirmative queue line that carries a negation word", () => {
    for (const line of [
      "Enqueue a Cloud Tasks task instead of calling the model inline.",
      "Add a background job so the handler does not block.",
      "Enqueue the call without blocking the request.",
    ]) {
      const plan = `# Task breakdown\n\n${line}\n`;
      expect(gradeTasks(plan, "enqueue|cloud tasks|background job", true)).toBe(
        false,
      );
    }
  });

  it("--absent discounts a negation that precedes the match in the same clause", () => {
    const plan =
      "# Task breakdown\n\nDo not add a queue worker; stays inline.\n";
    expect(gradeTasks(plan, "queue worker", true)).toBe(true);
  });

  it("compiles a (?i)-free pattern and throws without a section", () => {
    expect(() => gradeTasks(PLAN, "idempoten|timeout", false)).not.toThrow();
    expect(() => gradeTasks("# PRD\n", "x", false)).toThrow(/Task breakdown/);
  });
});

const DURABLE = [
  "# Task breakdown",
  "",
  "### Task 1: scheduled refresh",
  "- The scheduler tick enqueues one Cloud Tasks task per report; the worker is idempotent (idempotency key = report id).",
  "- Worker timeout 5 min, below the 10 min dispatch deadline.",
  "- Every model call goes through the spend ledger.",
].join("\n");

const INLINE = [
  "# Task breakdown",
  "",
  "### Task 1: handler",
  "- The handler awaits the five model calls and returns the report.",
  "- It stays inline, no queue for the interactive budget of 10 s.",
].join("\n");

describe("committed case.json graders", () => {
  const loaded = loadSuite(path.join(EVALS_ROOT, "system-design-defaults"));
  if (!loaded.ok) throw new Error(loaded.reason);
  const verdicts = (id: string, plan: string) => {
    const scenario = loaded.value.scenarios.find((s) => s.id === id);
    if (!scenario) throw new Error(`missing scenario ${id}`);
    const out: Record<string, boolean> = {};
    for (const g of scenario.graders) {
      const argv = g.argv;
      if (
        g.kind !== "command" ||
        !argv?.some((a) => a.endsWith("grade-tasks.ts"))
      )
        continue;
      const pattern = argv[3];
      out[g.id] = gradeTasks(plan, pattern, argv.includes("--absent"));
    }
    return out;
  };

  it("s1: a durable plan passes every grader, an inline plan fails them", () => {
    const durable = verdicts("s1-report-endpoint", DURABLE);
    expect(Object.keys(durable).length).toBeGreaterThan(0);
    expect(Object.values(durable).every(Boolean)).toBe(true);
    const inline = verdicts("s1-report-endpoint", INLINE);
    expect(inline["idempotency"]).toBe(false);
    expect(inline["cost-bound"]).toBe(false);
  });

  it("s2: a durable plan passes every grader, an inline plan fails scheduler-enqueues", () => {
    const durable = verdicts("s2-nightly-refresh", DURABLE);
    expect(Object.values(durable).every(Boolean)).toBe(true);
    expect(verdicts("s2-nightly-refresh", INLINE)["scheduler-enqueues"]).toBe(
      false,
    );
  });

  it("s3: no-queue fails the durable plan and passes the inline plan", () => {
    expect(verdicts("s3-fast-paid-control", DURABLE)["no-queue"]).toBe(false);
    expect(verdicts("s3-fast-paid-control", INLINE)["no-queue"]).toBe(true);
  });

  it("cost-bound does not match an interactive/latency budget alone", () => {
    const plan =
      "# Task breakdown\n\nFive calls exceed the 10 s interactive budget.\n";
    expect(verdicts("s1-report-endpoint", plan)["cost-bound"]).toBe(false);
    expect(verdicts("s2-nightly-refresh", plan)["cost-bound"]).toBe(false);
  });
});
