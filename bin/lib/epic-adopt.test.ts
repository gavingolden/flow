import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeReadClosedSubIssues } from "./epic-adopt";
import type { GhRunner } from "./resume-probes";

function tempEpicsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "epic-adopt-"));
}

function writeProjection(
  epicsDir: string,
  slug: string,
  projection: unknown,
): void {
  const dir = path.join(epicsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "projection.json"),
    JSON.stringify(projection),
  );
}

/** A GhRunner stub returning a fixed payload and recording each invocation. */
function ghReturning(
  stdout: string,
  exitCode = 0,
): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = (argv) => {
    calls.push(argv);
    return { stdout, stderr: "", exitCode };
  };
  return { gh, calls };
}

describe("makeReadClosedSubIssues", () => {
  it("maps a closed feature id to its sub-issue number", () => {
    const epicsDir = tempEpicsDir();
    writeProjection(epicsDir, "watchlist", {
      features: { foundation: { issueNumber: 310 }, b: { issueNumber: 102 } },
    });
    const { gh } = ghReturning(
      JSON.stringify([{ number: 310, stateReason: "COMPLETED" }]),
    );
    const read = makeReadClosedSubIssues(gh, epicsDir);
    const adopted = read({
      epicSlug: "watchlist",
      featureIds: ["foundation", "b"],
    });
    expect(adopted.get("foundation")).toBe(310);
    expect(adopted.has("b")).toBe(false);
    expect(adopted.size).toBe(1);
  });

  it("does NOT adopt an open sub-issue (number absent from the closed list)", () => {
    const epicsDir = tempEpicsDir();
    writeProjection(epicsDir, "watchlist", {
      features: { a: { issueNumber: 101 }, b: { issueNumber: 102 } },
    });
    // Only 101 is closed; b's issue (102) is still open.
    const { gh } = ghReturning(
      JSON.stringify([{ number: 101, stateReason: "NOT_PLANNED" }]),
    );
    const read = makeReadClosedSubIssues(gh, epicsDir);
    const adopted = read({ epicSlug: "watchlist", featureIds: ["a", "b"] });
    expect(adopted.get("a")).toBe(101);
    expect(adopted.has("b")).toBe(false);
  });

  it("returns an empty Map when gh exits non-zero", () => {
    const epicsDir = tempEpicsDir();
    writeProjection(epicsDir, "watchlist", {
      features: { a: { issueNumber: 101 } },
    });
    const { gh } = ghReturning("", 1);
    const read = makeReadClosedSubIssues(gh, epicsDir);
    expect(read({ epicSlug: "watchlist", featureIds: ["a"] }).size).toBe(0);
  });

  it("returns an empty Map (never throws) when the gh runner throws", () => {
    const epicsDir = tempEpicsDir();
    writeProjection(epicsDir, "watchlist", {
      features: { a: { issueNumber: 101 } },
    });
    const gh: GhRunner = () => {
      throw new Error("spawn gh ENOENT");
    };
    const read = makeReadClosedSubIssues(gh, epicsDir);
    expect(() =>
      read({ epicSlug: "watchlist", featureIds: ["a"] }),
    ).not.toThrow();
    expect(read({ epicSlug: "watchlist", featureIds: ["a"] }).size).toBe(0);
  });

  it("returns an empty Map (never throws) on malformed / non-array gh stdout", () => {
    const epicsDir = tempEpicsDir();
    writeProjection(epicsDir, "watchlist", {
      features: { a: { issueNumber: 101 } },
    });
    const read = (stdout: string) =>
      makeReadClosedSubIssues(ghReturning(stdout).gh, epicsDir);
    // Unparseable stdout, a non-array JSON payload, and a `[null]` element
    // (which passes Array.isArray but would throw on `.number` without a guard).
    for (const stdout of ["not json", '{"x":1}', "[null]"]) {
      expect(() =>
        read(stdout)({ epicSlug: "watchlist", featureIds: ["a"] }),
      ).not.toThrow();
      expect(
        read(stdout)({ epicSlug: "watchlist", featureIds: ["a"] }).size,
      ).toBe(0);
    }
  });

  it("returns an empty Map (and fires no gh call) when projection.json is missing", () => {
    const epicsDir = tempEpicsDir(); // nothing written
    const { gh, calls } = ghReturning(
      JSON.stringify([{ number: 101, stateReason: "COMPLETED" }]),
    );
    const read = makeReadClosedSubIssues(gh, epicsDir);
    expect(read({ epicSlug: "missing", featureIds: ["a"] }).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("returns an empty Map when projection.json is corrupt", () => {
    const epicsDir = tempEpicsDir();
    const dir = path.join(epicsDir, "watchlist");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "projection.json"), "{ not valid json");
    const { gh } = ghReturning(JSON.stringify([{ number: 101 }]));
    const read = makeReadClosedSubIssues(gh, epicsDir);
    expect(read({ epicSlug: "watchlist", featureIds: ["a"] }).size).toBe(0);
  });

  it("fires exactly ONE gh call for an N-feature projection", () => {
    const epicsDir = tempEpicsDir();
    writeProjection(epicsDir, "watchlist", {
      features: {
        a: { issueNumber: 1 },
        b: { issueNumber: 2 },
        c: { issueNumber: 3 },
      },
    });
    const { gh, calls } = ghReturning(
      JSON.stringify([{ number: 1 }, { number: 3 }]),
    );
    const read = makeReadClosedSubIssues(gh, epicsDir);
    const adopted = read({
      epicSlug: "watchlist",
      featureIds: ["a", "b", "c"],
    });
    expect(calls).toHaveLength(1);
    // Pin the gh query shape so a regression to `--state open` or a wrong
    // label is caught behaviorally, not only in production.
    expect(calls[0]).toContain("issue");
    expect(calls[0]).toContain("list");
    expect(calls[0]).toContain("--label");
    expect(calls[0]).toContain("flow-epic");
    expect(calls[0]).toContain("--state");
    expect(calls[0]).toContain("closed");
    expect([...adopted.keys()].sort()).toEqual(["a", "c"]);
    expect(adopted.get("a")).toBe(1);
    expect(adopted.get("c")).toBe(3);
  });

  it("returns an empty Map and fires no gh call for empty featureIds", () => {
    const epicsDir = tempEpicsDir();
    writeProjection(epicsDir, "watchlist", {
      features: { a: { issueNumber: 101 } },
    });
    const { gh, calls } = ghReturning(JSON.stringify([{ number: 101 }]));
    const read = makeReadClosedSubIssues(gh, epicsDir);
    expect(read({ epicSlug: "watchlist", featureIds: [] }).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
