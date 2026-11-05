import { describe, expect, it } from "vitest";
import { checkInlineBudget } from "./plan-runtime-budget";

const HEAD =
  "| Operation | Est. p99 | Execution model | Timeout / deadline |\n| --- | --- | --- | --- |\n";
const plan = (rd: string): string =>
  `# PRD\n\n### Runtime design\n\n${rd}\n\n# Task breakdown\n\n- x\n`;
const run = (t: string): string[] => {
  const m: string[] = [];
  checkInlineBudget(t, m);
  return m;
};
const row = (op: string, p99: string, exec: string): string =>
  plan(`${HEAD}| ${op} | ${p99} | ${exec} | 5 s |`);

describe("checkInlineBudget", () => {
  it("flags a ~65 s inline fan-out", () => {
    const m = run(
      row(
        "POST /reports",
        "~65 s (slowest of five parallel calls)",
        "inline, five-way parallel fan-out",
      ),
    );
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/POST \/reports.*65 s.*10 s interactive budget/);
  });
  it("passes the compressed fast inline form", () => {
    expect(
      run(row("export", "~40 ms", "inline — ~40 ms, timeout 2 s")),
    ).toEqual([]);
  });
  it("passes a queued 60 s row", () => {
    expect(run(row("generate", "60 s", "queue"))).toEqual([]);
  });
  it("passes an inline 8 s row", () => {
    expect(run(row("x", "8 s", "inline"))).toEqual([]);
  });
  it("flags a 2 min inline row and strips backticks from the operation", () => {
    const m = run(row("`sync`", "2 min", "**inline**"));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/row 'sync'.*120 s/);
  });
  it("reads the p99 from the Execution model cell when the p99 cell has none", () => {
    expect(run(row("x", "n/a", "inline — ~30 s, timeout 40 s"))).toHaveLength(
      1,
    );
  });
  it("skips an inline step that runs inside a worker, not on the request", () => {
    expect(run(row("Model call", "~60 s", "inline within the worker"))).toEqual(
      [],
    );
  });
  it("is silent with no Runtime design table", () => {
    expect(run(plan("Some prose only."))).toEqual([]);
    expect(run("# PRD\n\n# Task breakdown\n")).toEqual([]);
  });
  it("is silent for a none Runtime design", () => {
    expect(run(plan("none — UI-only change."))).toEqual([]);
  });
  it("is silent when the Est. p99 column is absent", () => {
    expect(
      run(
        plan(
          "| Operation | Execution model |\n| --- | --- |\n| x | inline, 60 s |",
        ),
      ),
    ).toEqual([]);
  });
});
