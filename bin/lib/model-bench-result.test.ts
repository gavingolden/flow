import { describe, expect, it } from "vitest";
import type { EntryResult } from "../flow-delegate-fanout";
import { toBenchResult } from "./model-bench-result";

const slot = {
  caseId: "c1",
  arm: "n/a" as const,
  model: "m",
  repeat: 0,
  warmup: false,
};

function convert(env: EntryResult, artifact: string) {
  return toBenchResult({
    readFile: () => artifact,
    fixturesDir: "/fx",
    cases: [],
    slot,
    entry: { task: "t", prompt: "p", out: "/out/t.md" },
    env,
    schemaCache: new Map(),
  });
}

describe("toBenchResult — tool-denied empty answers", () => {
  it("labels a ran call whose tools were refused and whose answer is blank, and keeps the denied actions", () => {
    const r = convert(
      { task: "t", model: "m", ran: true, deniedActions: ["browser"] },
      JSON.stringify({ response: "  " }),
    );
    expect(r.failureClass).toBe("tool-denied-empty");
    expect(r.deniedActions).toEqual(["browser"]);
  });

  it("gives a non-empty answer no failure class even when a tool was refused", () => {
    const r = convert(
      { task: "t", model: "m", ran: true, deniedActions: ["browser"] },
      JSON.stringify({ response: "found it" }),
    );
    expect(r.failureClass).toBeUndefined();
    expect(r.deniedActions).toEqual(["browser"]);
  });

  it("gives a blank answer with no refused tool no failure class", () => {
    const r = convert(
      { task: "t", model: "m", ran: true },
      JSON.stringify({ response: "" }),
    );
    expect(r.failureClass).toBeUndefined();
  });
});
