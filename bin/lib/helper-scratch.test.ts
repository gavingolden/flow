import { describe, expect, it } from "vitest";
import { helperScratchPaths } from "./helper-scratch";

describe("helperScratchPaths", () => {
  it("nests under scratch/<helper>/<out-basename>", () => {
    const p = helperScratchPaths(
      "/w/.flow-tmp/agent-output-gemini.json",
      "gemini-lens",
    );
    expect(p.raw).toBe(
      "/w/.flow-tmp/scratch/gemini-lens/agent-output-gemini.json/agy-raw",
    );
    expect(p.schema).toBe(
      "/w/.flow-tmp/scratch/gemini-lens/agent-output-gemini.json/schema.json",
    );
  });

  it("gives distinct outs disjoint scratch dirs", () => {
    expect(
      helperScratchPaths("/w/.flow-tmp/a.json", "gemini-lens").dir,
    ).not.toBe(helperScratchPaths("/w/.flow-tmp/b.json", "gemini-lens").dir);
  });
});
