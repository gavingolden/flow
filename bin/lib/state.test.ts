import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteState,
  isLegitimateEndPhase,
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

  it("readState returns null when state JSON is missing the phase field", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "no-phase.json"),
      JSON.stringify({ slug: "no-phase", repo: "/tmp/repo", updatedAt: "2026-05-17T00:00:00Z" }),
    );
    expect(readState("no-phase", dir)).toBeNull();
  });

  it("readState returns null when state JSON has wrong-type phase", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-phase.json"),
      JSON.stringify({ slug: "bad-phase", phase: 42, repo: "/tmp/repo", updatedAt: "2026-05-17T00:00:00Z" }),
    );
    expect(readState("bad-phase", dir)).toBeNull();
  });

  it("readState returns null when state JSON has wrong-type pr", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-pr.json"),
      JSON.stringify({
        slug: "bad-pr",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        pr: "not-a-number",
      }),
    );
    expect(readState("bad-pr", dir)).toBeNull();
  });

  it("readState returns null when state JSON has null for an optional field", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "null-opt.json"),
      JSON.stringify({
        slug: "null-opt",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        autoMerge: null,
      }),
    );
    expect(readState("null-opt", dir)).toBeNull();
  });

  it("readState returns null when state JSON has wrong-type worktree", () => {
    // f-coverage-2: optional `worktree` field had no wrong-type test
    // (asymmetric with `pr` and `autoMerge`).
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-worktree.json"),
      JSON.stringify({
        slug: "bad-worktree",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        worktree: 42,
      }),
    );
    expect(readState("bad-worktree", dir)).toBeNull();
  });

  it.each([
    ["slug", 42],
    ["repo", 99],
    ["updatedAt", false],
  ])(
    "readState returns null when required field %s has wrong type",
    (field, wrongValue) => {
      // f-coverage-4: of slug/phase/repo/updatedAt, only phase had a
      // wrong-type test. Mirror the phase test for the remaining three.
      fs.mkdirSync(dir, { recursive: true });
      const base: Record<string, unknown> = {
        slug: "ok-slug",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
      };
      base[field] = wrongValue;
      fs.writeFileSync(
        path.join(dir, `bad-${field}.json`),
        JSON.stringify(base),
      );
      expect(readState(`bad-${field}`, dir)).toBeNull();
    },
  );

  it("readState returns null for a JSON array root", () => {
    // f-coverage-1: `typeof x !== 'object' || x === null || Array.isArray(x)`
    // has three guard branches. Cover the Array.isArray branch directly so
    // dropping it doesn't silently pass.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "array-root.json"),
      JSON.stringify(["slug", "phase", "repo", "updatedAt"]),
    );
    expect(readState("array-root", dir)).toBeNull();
  });

  it("readState returns null for a JSON null root", () => {
    // f-coverage-1: cover the `x === null` guard branch.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "null-root.json"), "null");
    expect(readState("null-root", dir)).toBeNull();
  });

  it("readState returns null for a JSON primitive root", () => {
    // f-coverage-1: cover the `typeof x !== 'object'` guard branch.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "primitive-root.json"),
      JSON.stringify("just-a-string"),
    );
    expect(readState("primitive-root", dir)).toBeNull();
  });

  it("readState round-trips a full state with every optional field", () => {
    const full: PipelineState = {
      slug: "full",
      phase: "reviewing",
      repo: "/tmp/repo",
      updatedAt: "2026-05-17T00:00:00Z",
      pr: 142,
      worktree: "/tmp/worktree-full",
      autoMerge: false,
    };
    writeState(full, dir);
    expect(readState("full", dir)).toEqual(full);
  });

  it("listStates skips off-shape JSON files alongside valid ones", () => {
    writeState(fixture("real"), dir);
    fs.writeFileSync(
      path.join(dir, "off-shape.json"),
      JSON.stringify({ random: "shape" }),
    );
    expect(listStates(dir).map((s) => s.slug)).toEqual(["real"]);
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
