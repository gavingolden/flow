import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUpdate, parseArgs, runUpdate } from "./flow-state-update";
import { readState, writeState, type PipelineState } from "./lib/state";

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
  it("requires a slug", () => {
    expect(parseArgs([])).toEqual({ error: "slug is required" });
  });

  it("rejects a flag in the slug position", () => {
    expect(parseArgs(["--phase", "x"])).toEqual({
      error: "slug must be the first positional argument",
    });
  });

  it("requires at least one update flag", () => {
    expect(parseArgs(["foo"])).toEqual({
      error: "at least one of --phase, --pr, --worktree is required",
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
});
