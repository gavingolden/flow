import { describe, expect, it } from "vitest";
import {
  agyLensesScratchDir,
  helperScratchPaths,
  removeEmptyScratchDirs,
} from "./helper-scratch";

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

describe("removeEmptyScratchDirs", () => {
  const paths = helperScratchPaths(
    "/w/.flow-tmp/agent-output-gemini.json",
    "gemini-lens",
  );

  it("removes the per-output folder then the per-helper folder, never the scratch root", () => {
    const removed: string[] = [];
    removeEmptyScratchDirs(paths, (d) => void removed.push(d));
    expect(removed).toEqual([
      "/w/.flow-tmp/scratch/gemini-lens/agent-output-gemini.json",
      "/w/.flow-tmp/scratch/gemini-lens",
    ]);
  });

  it.each(["ENOENT", "ENOTEMPTY"])(
    "swallows %s and still tries the parent",
    (code) => {
      const removed: string[] = [];
      removeEmptyScratchDirs(paths, (d) => {
        removed.push(d);
        throw Object.assign(new Error(code), { code });
      });
      expect(removed).toHaveLength(2);
    },
  );

  it("rethrows any other error", () => {
    expect(() =>
      removeEmptyScratchDirs(paths, () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }),
    ).toThrow("denied");
  });
});

describe("agyLensesScratchDir", () => {
  it("nests under .flow-tmp/scratch/agy-lenses", () => {
    expect(agyLensesScratchDir("/w")).toBe("/w/.flow-tmp/scratch/agy-lenses");
  });
});
