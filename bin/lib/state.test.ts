import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteState, listStates, readState, writeState, type PipelineState } from "./state";

let dir!: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-state-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(slug: string, overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    slug,
    phase: "starting",
    repo: "/tmp/repo",
    updatedAt: "2026-04-30T12:00:00Z",
    ...overrides,
  };
}

describe("state", () => {
  it("writes and reads back a pipeline state file", () => {
    writeState(fixture("csv-export", { phase: "reviewing", pr: 142 }), dir);
    const got = readState("csv-export", dir);
    expect(got).not.toBeNull();
    expect(got?.phase).toBe("reviewing");
    expect(got?.pr).toBe(142);
  });

  it("returns null for a missing slug", () => {
    expect(readState("missing", dir)).toBeNull();
  });

  it("returns null for malformed json", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
    expect(readState("bad", dir)).toBeNull();
  });

  it("listStates returns every well-formed state file", () => {
    writeState(fixture("a"), dir);
    writeState(fixture("b", { phase: "merged" }), dir);
    writeState(fixture("c", { phase: "planning" }), dir);
    const all = listStates(dir).map((s) => s.slug).sort();
    expect(all).toEqual(["a", "b", "c"]);
  });

  it("listStates skips non-json files", () => {
    writeState(fixture("a"), dir);
    fs.writeFileSync(path.join(dir, "ignore.txt"), "irrelevant");
    expect(listStates(dir).map((s) => s.slug)).toEqual(["a"]);
  });

  it("listStates returns [] when directory is missing", () => {
    expect(listStates(path.join(dir, "nope"))).toEqual([]);
  });

  it("deleteState removes the file and returns true", () => {
    writeState(fixture("a"), dir);
    expect(deleteState("a", dir)).toBe(true);
    expect(readState("a", dir)).toBeNull();
  });

  it("deleteState returns false for missing slug", () => {
    expect(deleteState("missing", dir)).toBe(false);
  });
});
