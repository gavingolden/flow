import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  epicRunStatePath,
  isEpicRunState,
  listEpicRunStates,
  readEpicRunState,
  writeEpicRunState,
  type EpicRunState,
} from "./epic-run-state";

let dir!: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-run-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(
  epicSlug: string,
  overrides: Partial<EpicRunState> = {},
): EpicRunState {
  return {
    epicSlug,
    repo: "/tmp/repo",
    manifestPath: `/tmp/repo/.flow/epics/${epicSlug}/manifest.json`,
    manifestSha: "abc123",
    maxParallel: 3,
    createdAt: "2026-06-28T12:00:00Z",
    updatedAt: "2026-06-28T12:00:00Z",
    features: {},
    ...overrides,
  };
}

describe("epic-run-state", () => {
  it("writes to the NESTED <slug>/run.json path, not a flat file", () => {
    writeEpicRunState(fixture("watchlist"), dir);
    expect(fs.existsSync(epicRunStatePath("watchlist", dir))).toBe(true);
    expect(epicRunStatePath("watchlist", dir)).toBe(
      path.join(dir, "watchlist", "run.json"),
    );
    // The flat shape state.ts uses must NOT exist.
    expect(fs.existsSync(path.join(dir, "watchlist.json"))).toBe(false);
  });

  it("round-trips a full state with launched features", () => {
    const full = fixture("watchlist", {
      features: {
        schema: {
          slug: "watchlist-schema",
          launchedAt: "2026-06-28T12:01:00Z",
          pr: 12,
          lastStatus: "merged",
        },
        backend: {
          slug: "watchlist-backend",
          launchedAt: "2026-06-28T12:05:00Z",
        },
      },
    });
    writeEpicRunState(full, dir);
    expect(readEpicRunState("watchlist", dir)).toEqual(full);
  });

  it("returns null for a missing slug", () => {
    expect(readEpicRunState("missing", dir)).toBeNull();
  });

  it("returns null for malformed json", () => {
    fs.mkdirSync(path.join(dir, "bad"), { recursive: true });
    fs.writeFileSync(path.join(dir, "bad", "run.json"), "{not json");
    expect(readEpicRunState("bad", dir)).toBeNull();
  });

  it.each([
    ["epicSlug", 42],
    ["repo", false],
    ["manifestPath", 1],
    ["manifestSha", null],
    ["maxParallel", "3"],
    ["createdAt", 0],
    ["updatedAt", 0],
  ])("type-guard rejects wrong-typed required field %s", (field, wrong) => {
    const base: Record<string, unknown> = fixture("offshape");
    base[field] = wrong;
    fs.mkdirSync(path.join(dir, "offshape"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "offshape", "run.json"),
      JSON.stringify(base),
    );
    expect(readEpicRunState("offshape", dir)).toBeNull();
  });

  it("type-guard rejects a features map whose value is off-shape", () => {
    fs.mkdirSync(path.join(dir, "bad-feat"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-feat", "run.json"),
      JSON.stringify(
        fixture("bad-feat", {
          // launchedAt missing → not a FeatureRunRecord.
          features: { x: { slug: "x" } } as never,
        }),
      ),
    );
    expect(readEpicRunState("bad-feat", dir)).toBeNull();
  });

  it("type-guard rejects an array / null root", () => {
    expect(isEpicRunState([])).toBe(false);
    expect(isEpicRunState(null)).toBe(false);
    expect(isEpicRunState("nope")).toBe(false);
  });

  it("type-guard accepts a feature record with optional pr + lastStatus omitted", () => {
    expect(
      isEpicRunState(
        fixture("ok", {
          features: { a: { slug: "ok-a", launchedAt: "2026-06-28T00:00:00Z" } },
        }),
      ),
    ).toBe(true);
  });

  it("listEpicRunStates returns every epic with a valid run.json", () => {
    writeEpicRunState(fixture("alpha"), dir);
    writeEpicRunState(fixture("beta", { maxParallel: 2 }), dir);
    const slugs = listEpicRunStates(dir)
      .map((s) => s.epicSlug)
      .sort();
    expect(slugs).toEqual(["alpha", "beta"]);
  });

  it("listEpicRunStates ignores subdirs without a run.json", () => {
    writeEpicRunState(fixture("real"), dir);
    // A stray epic dir with no run.json (e.g. partially cleaned) must be skipped.
    fs.mkdirSync(path.join(dir, "no-run-file"), { recursive: true });
    fs.writeFileSync(path.join(dir, "no-run-file", "other.txt"), "x");
    expect(listEpicRunStates(dir).map((s) => s.epicSlug)).toEqual(["real"]);
  });

  it("listEpicRunStates returns [] when the root is missing", () => {
    expect(listEpicRunStates(path.join(dir, "nope"))).toEqual([]);
  });
});
