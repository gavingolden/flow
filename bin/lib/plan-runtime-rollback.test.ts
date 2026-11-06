import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkRollback } from "./plan-runtime-rollback";

const plan = (tasks: string, prdExtra = ""): string =>
  `# PRD\n\n### Runtime design\n${prdExtra}\n\n# Task breakdown\n\n${tasks}\n`;
const run = (t: string): string[] => {
  const m: string[] = [];
  checkRollback(t, m);
  return m;
};

const MIGRATION =
  "### Task 1: Migrate\n\n- alter table sections add column content text.";

describe("checkRollback", () => {
  it("flags a migration with no Rollback line", () => {
    expect(run(plan(MIGRATION))[0]).toMatch(/no '\*\*Rollback:\*\*' line/);
  });
  it("flags a named task titled Rollback whose body is TBD", () => {
    const t = `${MIGRATION}\n\n### Task 2: Rollback\n\nTBD`;
    const m = run(plan(t, "**Rollback:** Task 2"));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/Task 2.*no rollback step/);
  });
  it("flags a rollback task with a verb but no mechanism", () => {
    const t = `${MIGRATION}\n\n### Task 2: Rollback\n\nWe can revert if needed.`;
    expect(run(plan(t, "**Rollback:** Task 2"))[0]).toMatch(/no rollback step/);
  });
  it("flags a rollback task with a mechanism but no rollback verb", () => {
    const t = `${MIGRATION}\n\n### Task 2: Deploy\n\n- Run the migration script.`;
    expect(run(plan(t, "**Rollback:** Task 2"))[0]).toMatch(/no rollback step/);
  });
  it("accepts a rollback split across several named tasks", () => {
    const t = `${MIGRATION}\n\n### Task 2: Consumer\n\n- Dual-read.\n\n### Task 5: Script\n\n- Run the down migration and verify the column is gone.`;
    expect(run(plan(t, "**Rollback:** Tasks 2 and Task 5"))).toEqual([]);
  });
  it("triggers on inflected alters/drops and accepts 'flag off'", () => {
    const t = `### Task 1: Migration that alters the sections table and drops the old indexes.\n\n### Task 2: Flip\n\n- Turn the flag off and verify.`;
    expect(run(plan(t))[0]).toMatch(/no '\*\*Rollback:\*\*' line/);
    expect(run(plan(t, "**Rollback:** Task 2"))).toEqual([]);
  });
  it("flags a Rollback line that names no task", () => {
    expect(run(plan(MIGRATION, "**Rollback:** we can undo it"))[0]).toMatch(
      /names no task/,
    );
  });
  it("flags a named task that does not exist", () => {
    expect(run(plan(MIGRATION, "**Rollback:** Task 9"))[0]).toMatch(
      /no such task/,
    );
  });
  it("flags none when a trigger is present", () => {
    expect(run(plan(MIGRATION, "**Rollback:** none — easy"))[0]).toMatch(
      /says 'none'/,
    );
  });
  it("passes a task whose criterion runs the down migration", () => {
    const t = `${MIGRATION}\n\n### Task 2: Verify reversibility\n\n- Acceptance: run the down migration and check the column is gone.`;
    expect(run(plan(t, "**Rollback:** Task 2"))).toEqual([]);
  });
  it("passes a payload change with a traffic-shift-back step", () => {
    const t =
      "### Task 1: Change the queue payload shape.\n\n- Old shape still accepted.\n\n### Task 2: Rollout\n\n- Deploy a canary, then verify; shift traffic back to the previous revision if errors rise.";
    expect(run(plan(t, "**Rollback:** Task 2"))).toEqual([]);
  });
  it("is silent for a docs-only plan", () => {
    expect(run(plan("### Task 1: Docs\n\n- Update the README."))).toEqual([]);
  });
  it("accepts none for a plan with no trigger", () => {
    expect(
      run(plan("- Update docs.", "**Rollback:** none — docs only")),
    ).toEqual([]);
  });
  it("does not trigger on a purely additive migration", () => {
    expect(
      run(plan("- create table reports and create index on reports(id).")),
    ).toEqual([]);
  });
  it.each([
    "- drop the cache before the test.",
    "- fix the dropdown menu.",
    "- alter the copy on the landing page.",
  ])("does not trigger on %s", (line) => {
    expect(run(plan(line))).toEqual([]);
  });
  it("flags the kept r2-rollout eval plan", () => {
    const text = readFileSync(
      "docs/eval/system-design-references/with-refs-v2/r2-rollout/run-1/plan.md",
      "utf8",
    );
    expect(run(text).length).toBeGreaterThan(0);
  });
  it("does not trigger on a new versioned message payload", () => {
    const t =
      "### Task 1: Worker\n\n- Define the versioned message payload for the new queue.";
    expect(run(plan(t))).toEqual([]);
  });
  it("flags the kept r6-api run-1 plan, which alters tables and backfills", () => {
    const text = readFileSync(
      "docs/eval/system-design-references/with-refs-v2/r6-api/run-1/plan.md",
      "utf8",
    );
    expect(run(text).join("\n")).toMatch(/Rollback/);
  });
});
