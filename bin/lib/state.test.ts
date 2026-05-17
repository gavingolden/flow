import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteState,
  isLegitimateEndPhase,
  isMainStateFile,
  isPipelinePhase,
  listStates,
  PENDING_PHASES,
  PIPELINE_PHASES,
  PIPELINE_PHASE_SET,
  readState,
  STEP_PHASES,
  TERMINAL_PHASES,
  writeState,
  type PipelineState,
} from "./state";

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

  it("listStates skips legacy <slug>.turn.json files", () => {
    writeState(fixture("real"), dir);
    fs.writeFileSync(
      path.join(dir, "legacy.turn.json"),
      JSON.stringify({ slug: "legacy", turnId: "x", blockCount: 1, lastPhase: "verifying", lastStopAt: "x" }) + "\n",
    );
    expect(listStates(dir).map((s) => s.slug)).toEqual(["real"]);
  });

  it("listStates ignores turn-tracking files in the turns/ subdirectory", () => {
    // Regression guard for the phantom-pipeline bug: turn-tracking files
    // used to live at `<dir>/<slug>.turn.json` and `listStates`'s
    // `.endsWith('.json')` filter picked them up as state files whose
    // JSON.parse cast yielded `{ slug: '<slug>.turn', phase: undefined }`.
    // Moving them to a sibling `turns/` subdirectory keeps `listStates`
    // (which reads `dir` non-recursively) blind to them.
    writeState(fixture("real"), dir);
    fs.mkdirSync(path.join(dir, "turns"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "turns", "real.json"),
      JSON.stringify({ slug: "real", turnId: "x", blockCount: 1, lastPhase: "verifying", lastStopAt: "x" }) + "\n",
    );
    expect(listStates(dir).map((s) => s.slug)).toEqual(["real"]);
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

describe("isMainStateFile", () => {
  // Direct boundary coverage for the predicate `listStates` uses to filter
  // legacy `<slug>.X.json` turn-tracking files out of the state dir root.
  // The commit body promises rejection of "any other `<slug>.X.json`" shape,
  // not just `.turn.json` — this table documents that intent.
  it.each([
    ["real.json", true],
    ["a-b_c.json", true],
    ["legacy.turn.json", false],
    ["foo.bak.json", false],
    ["foo.tmp.json", false],
    ["foo.bar.json", false],
    [".json", false],
    ["foo", false],
    ["", false],
  ])("isMainStateFile(%j) === %s", (name, expected) => {
    expect(isMainStateFile(name)).toBe(expected);
  });
});

describe("phase constants", () => {
  it("TERMINAL_PHASES, PENDING_PHASES, STEP_PHASES are pairwise disjoint", () => {
    const pairs: Array<[readonly string[], readonly string[], string]> = [
      [TERMINAL_PHASES, PENDING_PHASES, "TERMINAL ∩ PENDING"],
      [TERMINAL_PHASES, STEP_PHASES, "TERMINAL ∩ STEP"],
      [PENDING_PHASES, STEP_PHASES, "PENDING ∩ STEP"],
    ];
    for (const [a, b, label] of pairs) {
      const overlap = a.filter((v) => b.includes(v));
      expect(overlap, label).toEqual([]);
    }
  });

  it("PIPELINE_PHASES is the union of TERMINAL, PENDING, STEP", () => {
    const expected = new Set([...STEP_PHASES, ...PENDING_PHASES, ...TERMINAL_PHASES]);
    expect(new Set(PIPELINE_PHASES)).toEqual(expected);
  });

  it("PIPELINE_PHASE_SET membership matches PIPELINE_PHASES", () => {
    for (const p of PIPELINE_PHASES) {
      expect(PIPELINE_PHASE_SET.has(p)).toBe(true);
    }
    expect(PIPELINE_PHASE_SET.has("not-a-phase")).toBe(false);
  });

  it("includes the new pending-end phases for the Stop hook", () => {
    expect(PENDING_PHASES).toContain("triaged-no-change");
    expect(PENDING_PHASES).toContain("triage-pending-clarification");
    expect(PENDING_PHASES).toContain("approval-pending-clarification");
  });

  it("isPipelinePhase narrows known phases", () => {
    expect(isPipelinePhase("implementing")).toBe(true);
    expect(isPipelinePhase("merged")).toBe(true);
    expect(isPipelinePhase("plan-pending-review")).toBe(true);
    expect(isPipelinePhase("implmenting")).toBe(false);
    expect(isPipelinePhase("")).toBe(false);
  });

  it("isLegitimateEndPhase is true for terminal + pending only", () => {
    for (const p of TERMINAL_PHASES) expect(isLegitimateEndPhase(p)).toBe(true);
    for (const p of PENDING_PHASES) expect(isLegitimateEndPhase(p)).toBe(true);
    for (const p of STEP_PHASES) expect(isLegitimateEndPhase(p)).toBe(false);
  });
});
