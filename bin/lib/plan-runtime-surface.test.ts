import { describe, expect, it } from "vitest";
import { listTaskRuntimeFiles } from "./plan-runtime-surface";

const plan = (files: string) =>
  `# Task breakdown\n\n### Task 1: x\n\n- **Contract:**\n  - **Files:** ${files}\n  - **Interfaces:** none\n`;

describe("listTaskRuntimeFiles", () => {
  it("returns a plain runtime path", () => {
    expect(listTaskRuntimeFiles(plan("create src/api/reports.ts"))).toEqual([
      "src/api/reports.ts",
    ]);
  });

  it("reads paths from a soft-wrapped Files line", () => {
    expect(
      listTaskRuntimeFiles(plan("create src/App.svelte,\n    src/jobs/x.ts")),
    ).toEqual(["src/jobs/x.ts"]);
  });

  it("exempts eval fixture paths", () => {
    expect(
      listTaskRuntimeFiles(
        plan("create evals/system-design-defaults/s1/fixture/src/api/app.ts"),
      ),
    ).toEqual([]);
  });

  it("exempts test and markdown files", () => {
    expect(
      listTaskRuntimeFiles(plan("src/jobs/x.test.ts, docs/api/README.md")),
    ).toEqual([]);
  });
});
