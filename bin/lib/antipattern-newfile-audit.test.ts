import { describe, expect, it } from "vitest";
import { auditNewFileAntiPatterns } from "./antipattern-newfile-audit";

describe("auditNewFileAntiPatterns", () => {
  it("flags an entry whose location is an added file", () => {
    const entries = [{ location: "src/new.ts" }];
    const flagged = auditNewFileAntiPatterns(entries, ["src/new.ts"]);
    expect(flagged).toEqual([{ location: "src/new.ts" }]);
  });

  it("does not flag an entry whose location is a modified (not-added) file", () => {
    const entries = [{ location: "src/existing.ts" }];
    const flagged = auditNewFileAntiPatterns(entries, ["src/new.ts"]);
    expect(flagged).toEqual([]);
  });

  it("matches an added path when the location carries a :line suffix", () => {
    const entries = [{ location: "src/new.ts:42" }];
    const flagged = auditNewFileAntiPatterns(entries, ["src/new.ts"]);
    expect(flagged).toEqual([{ location: "src/new.ts:42" }]);
  });

  it("matches an added path when the location carries a :line:col suffix", () => {
    const entries = [{ location: "src/new.ts:42:7" }];
    const flagged = auditNewFileAntiPatterns(entries, ["src/new.ts"]);
    expect(flagged).toEqual([{ location: "src/new.ts:42:7" }]);
  });

  it("flags an added-file entry regardless of the self-declared introduced_by_this_pr flag", () => {
    const entries = [{ location: "src/new.ts", introduced_by_this_pr: true }];
    const flagged = auditNewFileAntiPatterns(entries, ["src/new.ts"]);
    expect(flagged).toEqual([
      { location: "src/new.ts", introduced_by_this_pr: true },
    ]);
  });

  it("flags nothing when addedFiles is empty", () => {
    const entries = [{ location: "src/new.ts" }, { location: "src/new.ts:9" }];
    const flagged = auditNewFileAntiPatterns(entries, []);
    expect(flagged).toEqual([]);
  });

  it("does not flag an entry whose path is not in addedFiles", () => {
    const entries = [{ location: "src/elsewhere.ts:3" }];
    const flagged = auditNewFileAntiPatterns(entries, [
      "src/new.ts",
      "src/other.ts",
    ]);
    expect(flagged).toEqual([]);
  });
});
