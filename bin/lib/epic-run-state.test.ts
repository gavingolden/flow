import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteEpicRunState,
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

  it("type-guard rejects a features map whose value has neither slug nor external", () => {
    fs.mkdirSync(path.join(dir, "bad-feat"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-feat", "run.json"),
      JSON.stringify(
        fixture("bad-feat", {
          // neither slug nor external → not a FeatureRunRecord.
          features: { x: { pr: 5 } } as never,
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

  it("type-guard accepts a slug-bound record with optional pr + lastStatus omitted", () => {
    expect(
      isEpicRunState(
        fixture("ok", {
          features: { a: { slug: "ok-a", launchedAt: "2026-06-28T00:00:00Z" } },
        }),
      ),
    ).toBe(true);
  });

  it("type-guard accepts a slug-bound record WITHOUT launchedAt (now optional)", () => {
    expect(
      isEpicRunState(
        fixture("nolaunch", { features: { a: { slug: "nolaunch-a" } } }),
      ),
    ).toBe(true);
  });

  it("type-guard accepts an external-completion record (external, no slug)", () => {
    expect(
      isEpicRunState(
        fixture("ext", {
          features: {
            a: { external: "PR #123", completedAt: "2026-06-28T00:00:00Z" },
          },
        }),
      ),
    ).toBe(true);
  });

  it("type-guard rejects a record with NEITHER a slug NOR an external ref", () => {
    expect(
      isEpicRunState(
        fixture("neither", { features: { a: { pr: 9 } } as never }),
      ),
    ).toBe(false);
  });

  it("type-guard rejects wrong-typed slug / external (present but not a string)", () => {
    expect(
      isEpicRunState(
        fixture("bad-slug", { features: { a: { slug: 5 } } as never }),
      ),
    ).toBe(false);
    expect(
      isEpicRunState(
        fixture("bad-ext", { features: { a: { external: 5 } } as never }),
      ),
    ).toBe(false);
  });

  it("type-guard accepts a record carrying priorSlugs (audit lineage)", () => {
    expect(
      isEpicRunState(
        fixture("redirected", {
          features: {
            a: {
              slug: "redirected-a-v2",
              launchedAt: "2026-06-28T00:00:00Z",
              priorSlugs: ["redirected-a"],
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("type-guard rejects a non-string-array priorSlugs (numbers)", () => {
    expect(
      isEpicRunState(
        fixture("bad-prior-arr", {
          features: {
            a: {
              slug: "bad-prior-arr-a",
              launchedAt: "2026-06-28T00:00:00Z",
              priorSlugs: [1, 2],
            },
          } as never,
        }),
      ),
    ).toBe(false);
  });

  it("type-guard rejects a non-array priorSlugs (string)", () => {
    expect(
      isEpicRunState(
        fixture("bad-prior-str", {
          features: {
            a: {
              slug: "bad-prior-str-a",
              launchedAt: "2026-06-28T00:00:00Z",
              priorSlugs: "redirected-a",
            },
          } as never,
        }),
      ),
    ).toBe(false);
  });

  it("type-guard accepts a state WITHOUT maxParallel (now optional)", () => {
    const s = fixture("nomax");
    delete (s as Partial<EpicRunState>).maxParallel;
    expect(isEpicRunState(s)).toBe(true);
  });

  it("tolerates an OLD run.json carrying dropped judgment-era fields and preserves them on rewrite", () => {
    // An old file from the tick-loop era: obsolete top-level runnerPhase/
    // modelJudge and per-feature retryCount/lastJudgment. The guard never checks
    // unknown keys and never strips them, so it validates and a read-modify-write
    // round-trips the obsolete keys untouched.
    const legacy = {
      ...fixture("legacy"),
      runnerPhase: "running",
      modelJudge: "sonnet",
      features: {
        a: {
          slug: "legacy-a",
          launchedAt: "2026-06-28T00:00:00Z",
          retryCount: 2,
          redirectCount: 1,
          lastJudgment: { action: "retry", reason: "flake", at: "t" },
        },
      },
    };
    fs.mkdirSync(path.join(dir, "legacy"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "legacy", "run.json"),
      JSON.stringify(legacy),
    );

    const read = readEpicRunState("legacy", dir);
    expect(read).not.toBeNull();
    // The obsolete keys survived the read (guard never strips them).
    const readRaw = read as unknown as Record<string, unknown>;
    expect(readRaw.runnerPhase).toBe("running");

    // Rewrite (a bind-style read-modify-write) and confirm they persist.
    writeEpicRunState(read!, dir);
    const reread = JSON.parse(
      fs.readFileSync(path.join(dir, "legacy", "run.json"), "utf8"),
    );
    expect(reread.runnerPhase).toBe("running");
    expect(reread.modelJudge).toBe("sonnet");
    expect(reread.features.a.retryCount).toBe(2);
    expect(reread.features.a.lastJudgment.reason).toBe("flake");
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

  it("deleteEpicRunState removes a populated dir and returns true", () => {
    writeEpicRunState(fixture("gone"), dir);
    expect(deleteEpicRunState("gone", dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, "gone"))).toBe(false);
  });

  it("deleteEpicRunState returns false for an absent dir without throwing", () => {
    expect(deleteEpicRunState("never", dir)).toBe(false);
  });

  it("deleteEpicRunState only removes the target slug", () => {
    writeEpicRunState(fixture("keep"), dir);
    writeEpicRunState(fixture("drop"), dir);
    expect(deleteEpicRunState("drop", dir)).toBe(true);
    expect(
      listEpicRunStates(dir)
        .map((s) => s.epicSlug)
        .sort(),
    ).toEqual(["keep"]);
  });
});
