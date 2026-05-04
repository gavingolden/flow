import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyUpdate,
  checkWorktreeBranch,
  closestPhase,
  parseArgs,
  phaseError,
  runUpdate,
} from "./flow-state-update";
import { PIPELINE_PHASES, readState, writeState, type PipelineState } from "./lib/state";

let dir!: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-state-update-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(slug: string, overrides: Partial<PipelineState> = {}): void {
  writeState(
    {
      slug,
      phase: "starting",
      repo: "/tmp/repo",
      updatedAt: "2026-04-30T12:00:00Z",
      ...overrides,
    },
    dir,
  );
}

describe("parseArgs", () => {
  it("requires at least one update flag (empty argv)", () => {
    expect(parseArgs([])).toEqual({
      error: "at least one of --phase, --pr, --worktree, --auto-merge, --no-auto-merge is required",
    });
  });

  it("treats a leading flag as 'slug omitted' (auto-resolve path)", () => {
    // Previously rejected with 'slug must be the first positional argument'.
    // The supervisor now relies on this form: `flow-state-update --phase X`
    // resolves the slug from $TMUX_PANE.
    expect(parseArgs(["--phase", "implementing"])).toEqual({
      phase: "implementing",
    });
  });

  it("requires at least one update flag", () => {
    expect(parseArgs(["foo"])).toEqual({
      error: "at least one of --phase, --pr, --worktree, --auto-merge, --no-auto-merge is required",
    });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["foo", "--bogus", "x"])).toEqual({ error: "unknown flag: --bogus" });
  });

  it("rejects a flag with no value", () => {
    expect(parseArgs(["foo", "--phase"])).toEqual({ error: "--phase requires a value" });
  });

  it("rejects a flag whose value is the next flag", () => {
    expect(parseArgs(["foo", "--phase", "--pr"])).toEqual({ error: "--phase requires a value" });
  });

  it("rejects a non-integer --pr", () => {
    expect(parseArgs(["foo", "--pr", "abc"])).toEqual({
      error: "--pr must be a positive integer, got 'abc'",
    });
  });

  it("rejects a non-positive --pr", () => {
    expect(parseArgs(["foo", "--pr", "0"])).toEqual({
      error: "--pr must be a positive integer, got '0'",
    });
  });

  it("parses all three flags together", () => {
    expect(
      parseArgs(["csv-export", "--phase", "implementing", "--pr", "142", "--worktree", "/tmp/w"]),
    ).toEqual({
      slug: "csv-export",
      phase: "implementing",
      pr: 142,
      worktree: "/tmp/w",
    });
  });

  it("parses --auto-merge as autoMerge: true", () => {
    expect(parseArgs(["foo", "--auto-merge"])).toEqual({
      slug: "foo",
      autoMerge: true,
    });
  });

  it("parses --no-auto-merge as autoMerge: false", () => {
    expect(parseArgs(["foo", "--no-auto-merge"])).toEqual({
      slug: "foo",
      autoMerge: false,
    });
  });

  it("accepts --no-auto-merge alongside other flags", () => {
    expect(parseArgs(["foo", "--phase", "gating", "--no-auto-merge"])).toEqual({
      slug: "foo",
      phase: "gating",
      autoMerge: false,
    });
  });

  it.each([...PIPELINE_PHASES])("accepts canonical phase %s", (phase) => {
    expect(parseArgs(["foo", "--phase", phase])).toEqual({
      slug: "foo",
      phase,
    });
  });

  it("rejects an unknown --phase value with a near-match suggestion", () => {
    expect(parseArgs(["foo", "--phase", "implmenting"])).toEqual({
      error: "--phase 'implmenting' is not a valid pipeline phase; did you mean 'implementing'?",
    });
  });

  it("rejects an unknown --phase value with no near-match by listing the canonical set", () => {
    const result = parseArgs(["foo", "--phase", "totally-unknown-string-xyz"]);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toContain("not a valid pipeline phase");
    expect(result.error).toContain("valid phases:");
    expect(result.error).toContain("implementing");
  });
});

describe("phaseError + closestPhase", () => {
  it("phaseError suggests a single Levenshtein-1 match", () => {
    expect(phaseError("implmenting")).toContain("'implementing'");
  });

  it("phaseError lists the canonical set for far-off typos", () => {
    const msg = phaseError("xxx-not-a-phase-at-all");
    expect(msg).toContain("valid phases:");
    for (const p of PIPELINE_PHASES) expect(msg).toContain(p);
  });

  it("closestPhase returns null when nothing is within distance 2", () => {
    expect(closestPhase("xxxxxxxxxxxxxxxx")).toBeNull();
  });

  it("closestPhase finds the nearest neighbour for a 1-char swap", () => {
    expect(closestPhase("triating")).toBe("triaging");
  });
});

describe("applyUpdate", () => {
  it("merges only provided fields", () => {
    const existing: PipelineState = {
      slug: "csv-export",
      phase: "starting",
      repo: "/tmp/repo",
      worktree: "/tmp/w",
      updatedAt: "2026-04-30T12:00:00Z",
    };
    const updated = applyUpdate(existing, { slug: "csv-export", phase: "implementing" });
    expect(updated.phase).toBe("implementing");
    expect(updated.worktree).toBe("/tmp/w"); // preserved
    expect(updated.repo).toBe("/tmp/repo"); // preserved
    expect(updated.updatedAt).not.toBe("2026-04-30T12:00:00Z"); // refreshed
  });

  it("sets pr when missing previously", () => {
    const existing: PipelineState = {
      slug: "csv-export",
      phase: "implementing",
      repo: "/tmp/repo",
      updatedAt: "2026-04-30T12:00:00Z",
    };
    const updated = applyUpdate(existing, { slug: "csv-export", pr: 142 });
    expect(updated.pr).toBe(142);
  });
});

describe("runUpdate", () => {
  it("returns 1 with a clear error when no state file exists", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = runUpdate(["missing", "--phase", "implementing"], dir);
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join("\n")).toContain("no state file for slug 'missing'");
    errSpy.mockRestore();
  });

  it("returns 2 with a clear error on bad args", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = runUpdate(["foo"], dir); // missing update flag
    expect(code).toBe(2);
    expect(errSpy.mock.calls.flat().join("\n")).toContain("at least one of --phase");
    errSpy.mockRestore();
  });

  it("merges fields and refreshes updatedAt", () => {
    seed("csv-export", { worktree: "/tmp/wt" });
    const code = runUpdate(["csv-export", "--phase", "implementing", "--pr", "142"], dir);
    expect(code).toBe(0);
    const got = readState("csv-export", dir);
    expect(got?.phase).toBe("implementing");
    expect(got?.pr).toBe(142);
    expect(got?.worktree).toBe("/tmp/wt");
    expect(got?.updatedAt).not.toBe("2026-04-30T12:00:00Z");
  });

  it("idempotent: applying the same update twice is safe", () => {
    seed("csv-export");
    expect(runUpdate(["csv-export", "--phase", "implementing"], dir)).toBe(0);
    expect(runUpdate(["csv-export", "--phase", "implementing"], dir)).toBe(0);
    const got = readState("csv-export", dir);
    expect(got?.phase).toBe("implementing");
  });

  it("persists autoMerge: false when --no-auto-merge is set, then flips back with --auto-merge", () => {
    seed("csv-export");
    expect(runUpdate(["csv-export", "--no-auto-merge"], dir)).toBe(0);
    expect(readState("csv-export", dir)?.autoMerge).toBe(false);
    expect(runUpdate(["csv-export", "--auto-merge"], dir)).toBe(0);
    expect(readState("csv-export", dir)?.autoMerge).toBe(true);
  });

  it("preserves autoMerge across phase-only updates", () => {
    seed("csv-export", { autoMerge: false });
    expect(runUpdate(["csv-export", "--phase", "gating"], dir)).toBe(0);
    const got = readState("csv-export", dir);
    expect(got?.autoMerge).toBe(false);
    expect(got?.phase).toBe("gating");
  });

  it("returns 3 and does not update state when the worktree's branch does not match the marker", () => {
    const fx = makeWorktreeFixture("expected-branch", "actual-branch");
    seed("csv-export", { worktree: fx.worktreeDir });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = runUpdate(["csv-export", "--phase", "implementing"], dir);
    errSpy.mockRestore();
    expect(code).toBe(3);
    // State must not have advanced past 'starting'.
    const got = readState("csv-export", dir);
    expect(got?.phase).toBe("starting");
    fx.cleanup();
  });

  it("returns 0 when the marker matches the worktree's current branch", () => {
    const fx = makeWorktreeFixture("matching-branch", "matching-branch");
    seed("csv-export", { worktree: fx.worktreeDir });
    const code = runUpdate(["csv-export", "--phase", "implementing"], dir);
    expect(code).toBe(0);
    fx.cleanup();
  });

  it("returns 2 and does not write state.json when --phase is a typo", () => {
    seed("csv-export");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = runUpdate(["csv-export", "--phase", "implmenting"], dir);
    errSpy.mockRestore();
    expect(code).toBe(2);
    const got = readState("csv-export", dir);
    expect(got?.phase).toBe("starting"); // unchanged from seed
  });

  it("auto-resolves the slug from $TMUX_PANE when omitted", () => {
    seed("csv-export");
    const code = runUpdate(["--phase", "implementing"], dir, {
      resolveSlug: () => "csv-export",
    });
    expect(code).toBe(0);
    expect(readState("csv-export", dir)?.phase).toBe("implementing");
  });

  it("prefers an explicit slug over the pane-resolved one (back-compat)", () => {
    seed("csv-export");
    seed("other-pipeline");
    const code = runUpdate(["csv-export", "--phase", "implementing"], dir, {
      // Pane resolver claims a different pipeline — explicit slug must win.
      resolveSlug: () => "other-pipeline",
    });
    expect(code).toBe(0);
    expect(readState("csv-export", dir)?.phase).toBe("implementing");
    expect(readState("other-pipeline", dir)?.phase).toBe("starting");
  });

  it("returns 2 with a clear error when no slug given and pane has none either", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = runUpdate(["--phase", "implementing"], dir, {
      resolveSlug: () => null,
    });
    expect(code).toBe(2);
    expect(errSpy.mock.calls.flat().join("\n")).toContain("@flow-slug");
    errSpy.mockRestore();
  });
});

// --- checkWorktreeBranch + worktree fixture --------------------------------

type WorktreeFixture = { worktreeDir: string; cleanup: () => void };

/**
 * Builds a tmpdir with a real (single-worktree) git repo on `actualBranch`,
 * and a `.flow-branch` marker claiming the branch is `expectedBranch`. When
 * the two differ, the guard should report mismatch.
 */
function makeWorktreeFixture(expectedBranch: string, actualBranch: string): WorktreeFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-guard-"));
  const worktreeDir = path.join(root, "wt");
  fs.mkdirSync(worktreeDir);
  spawnSync("git", ["init", "-b", actualBranch], { cwd: worktreeDir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: worktreeDir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: worktreeDir });
  spawnSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: worktreeDir });
  fs.writeFileSync(path.join(worktreeDir, ".flow-branch"), expectedBranch + "\n");
  return {
    worktreeDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe(checkWorktreeBranch, () => {
  it("returns ok when the worktree path is undefined (early phases)", () => {
    expect(checkWorktreeBranch(undefined)).toEqual({ kind: "ok" });
  });

  it("returns ok with a warning when the worktree directory is missing", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = checkWorktreeBranch("/tmp/does-not-exist-flow-guard-test-xyz");
    expect(result).toEqual({ kind: "ok" });
    expect(errSpy.mock.calls.flat().join("\n")).toContain("does not exist");
    errSpy.mockRestore();
  });

  it("returns ok with a warning when the marker file is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-guard-noMarker-"));
    spawnSync("git", ["init", "-b", "main"], { cwd: tmp });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = checkWorktreeBranch(tmp);
    expect(result).toEqual({ kind: "ok" });
    expect(errSpy.mock.calls.flat().join("\n")).toContain(".flow-branch missing");
    errSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns ok when marker and current branch match", () => {
    const fx = makeWorktreeFixture("foo", "foo");
    expect(checkWorktreeBranch(fx.worktreeDir)).toEqual({ kind: "ok" });
    fx.cleanup();
  });

  it("returns mismatch with both branch names when they diverge", () => {
    const fx = makeWorktreeFixture("expected", "actual");
    expect(checkWorktreeBranch(fx.worktreeDir)).toEqual({
      kind: "mismatch",
      expected: "expected",
      actual: "actual",
    });
    fx.cleanup();
  });
});
