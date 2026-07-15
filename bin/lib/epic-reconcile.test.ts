import { describe, expect, it } from "vitest";
import {
  classifyEvent,
  HALT_STATUSES,
  reconcile,
  type ReadFeatureState,
} from "./epic-reconcile";
import type { EpicManifest, Feature } from "./epic-manifest-schema";
import type { EpicRunState, FeatureRunRecord } from "./epic-run-state";
import type { PipelineState } from "./state";

function feat(id: string, dependsOn: string[] = []): Feature {
  return {
    id,
    title: id.toUpperCase(),
    description: `feature ${id}`,
    dependsOn,
  };
}

function manifest(features: Feature[]): EpicManifest {
  return {
    epicId: "watchlist",
    prompt: "build the watchlist",
    createdAt: "2026-06-28",
    features,
  };
}

/** Build a runState whose launched map is `{ id: { slug: <id>, ... } }`. */
function runState(
  launched: Record<string, Partial<FeatureRunRecord>>,
): EpicRunState {
  const features: Record<string, FeatureRunRecord> = {};
  for (const [id, rec] of Object.entries(launched)) {
    features[id] = {
      slug: rec.slug ?? id,
      launchedAt: rec.launchedAt ?? "2026-06-28T00:00:00Z",
      ...rec,
    };
  }
  return {
    epicSlug: "watchlist",
    repo: "/tmp/repo",
    manifestPath: "/tmp/repo/.flow/epics/watchlist/manifest.json",
    manifestSha: "sha",
    maxParallel: 3,
    createdAt: "2026-06-28T00:00:00Z",
    updatedAt: "2026-06-28T00:00:00Z",
    features,
  };
}

/** readFeatureState backed by a slug→phase map; unknown slug → null (orphan). */
function phases(map: Record<string, string>): ReadFeatureState {
  return (slug: string): PipelineState | null => {
    const phase = map[slug];
    if (phase === undefined) return null;
    return {
      slug,
      phase,
      repo: "/tmp/repo",
      updatedAt: "2026-06-28T00:00:00Z",
    };
  };
}

const ids = (features: Feature[]): string[] => features.map((f) => f.id);
const noState: ReadFeatureState = () => null;

describe("reconcile — Story 3: parallel launch up to the cap", () => {
  it("2 independent ready features + cap 3 + 0 running → both launch", () => {
    const m = manifest([feat("a"), feat("b")]);
    const result = reconcile({
      manifest: m,
      runState: runState({}),
      readFeatureState: noState,
      maxParallel: 3,
    });
    expect(ids(result.toLaunch).sort()).toEqual(["a", "b"]);
    expect(result.epicStatus).toBe("running");
    expect(result.board.every((r) => r.status === "ready")).toBe(true);
  });

  it("3 ready features + cap 2 + 0 running → launch exactly 2, leave the third ready", () => {
    const m = manifest([feat("a"), feat("b"), feat("c")]);
    const result = reconcile({
      manifest: m,
      runState: runState({}),
      readFeatureState: noState,
      maxParallel: 2,
    });
    expect(result.toLaunch).toHaveLength(2);
    expect(ids(result.toLaunch)).toEqual(["a", "b"]); // frontier order preserved
    expect(result.summary.ready).toBe(3);
  });

  it("an already-launched feature is never re-launched (idempotency)", () => {
    const m = manifest([feat("a"), feat("b")]);
    // `a` launched + still running; `b` not launched.
    const result = reconcile({
      manifest: m,
      runState: runState({ a: { slug: "a" } }),
      readFeatureState: phases({ a: "implementing" }),
      maxParallel: 3,
    });
    expect(ids(result.toLaunch)).toEqual(["b"]); // never re-includes `a`
    const rowA = result.board.find((r) => r.id === "a")!;
    expect(rowA.status).toBe("running");
    expect(result.summary.running).toBe(1);
  });

  it("running features consume cap slots (cap 2, 1 running → only 1 new launch)", () => {
    const m = manifest([feat("a"), feat("b"), feat("c")]);
    const result = reconcile({
      manifest: m,
      runState: runState({ a: { slug: "a" } }),
      readFeatureState: phases({ a: "reviewing" }),
      maxParallel: 2,
    });
    // 1 running ⇒ capacity = 2 − 1 = 1; frontier is {b,c} ⇒ launch 1.
    expect(result.toLaunch).toHaveLength(1);
    expect(ids(result.toLaunch)).toEqual(["b"]);
  });
});

describe("reconcile — Story 4: advance the frontier as PRs merge", () => {
  it("merge unblocks downstream on the next tick", () => {
    const m = manifest([feat("a"), feat("b", ["a"])]);
    // `a` launched + merged ⇒ `b` becomes ready / launchable.
    const result = reconcile({
      manifest: m,
      runState: runState({ a: { slug: "a", pr: 12 } }),
      readFeatureState: phases({ a: "merged" }),
      maxParallel: 3,
    });
    expect(ids(result.toLaunch)).toEqual(["b"]);
    const rowA = result.board.find((r) => r.id === "a")!;
    expect(rowA.status).toBe("merged");
    expect(rowA.pr).toBe(12);
    expect(result.summary.merged).toBe(1);
    expect(result.epicStatus).toBe("running");
  });

  it("a gated feature blocks its subtree but an independent branch still launches", () => {
    // a -> b   (a gated ⇒ b blocked);  x is independent and ready.
    const m = manifest([feat("a"), feat("b", ["a"]), feat("x")]);
    const result = reconcile({
      manifest: m,
      runState: runState({ a: { slug: "a", pr: 9 } }),
      readFeatureState: phases({ a: "gated" }),
      maxParallel: 3,
    });
    expect(ids(result.toLaunch)).toEqual(["x"]); // independent branch moves
    const rowA = result.board.find((r) => r.id === "a")!;
    const rowB = result.board.find((r) => r.id === "b")!;
    expect(rowA.status).toBe("gated");
    expect(rowB.status).toBe("blocked");
    expect(result.epicStatus).toBe("running"); // x keeps the epic alive
  });

  it("needs-human is surfaced and halts its downstream subtree", () => {
    const m = manifest([feat("a"), feat("b", ["a"])]);
    const result = reconcile({
      manifest: m,
      runState: runState({ a: { slug: "a" } }),
      readFeatureState: phases({ a: "needs-human" }),
      maxParallel: 3,
    });
    expect(result.toLaunch).toEqual([]); // b blocked, a halted
    expect(result.board.find((r) => r.id === "a")!.status).toBe("needs-human");
    expect(result.epicStatus).toBe("blocked");
  });
});

describe("reconcile — Story 6: terminal classification (done / blocked)", () => {
  it("frontier empty + nothing running + not all merged → blocked (deadlock)", () => {
    const m = manifest([feat("a"), feat("b", ["a"])]);
    const result = reconcile({
      manifest: m,
      runState: runState({ a: { slug: "a" } }),
      readFeatureState: phases({ a: "gated" }),
      maxParallel: 3,
    });
    expect(result.toLaunch).toEqual([]);
    expect(result.epicStatus).toBe("blocked");
  });

  it("all features merged → done", () => {
    const m = manifest([feat("a"), feat("b", ["a"])]);
    const result = reconcile({
      manifest: m,
      runState: runState({ a: { slug: "a" }, b: { slug: "b" } }),
      readFeatureState: phases({ a: "merged", b: "merged" }),
      maxParallel: 3,
    });
    expect(result.epicStatus).toBe("done");
    expect(result.toLaunch).toEqual([]);
    expect(result.summary.merged).toBe(2);
    expect(result.summary.total).toBe(2);
  });

  it("a launched feature with no state file is an orphan (surfaced, not running)", () => {
    const m = manifest([feat("a")]);
    const result = reconcile({
      manifest: m,
      runState: runState({ a: { slug: "a" } }),
      readFeatureState: noState, // no state for a's slug
      maxParallel: 3,
    });
    expect(result.board[0].status).toBe("orphan");
    expect(result.summary.running).toBe(0);
    // Sole feature orphaned, not merged, nothing running, frontier empty → blocked.
    expect(result.epicStatus).toBe("blocked");
  });
});

describe("classifyEvent — the /flow-epic-run event taxonomy (derived from ReconcileResult)", () => {
  it("green: in-flight/ready work, nothing halted", () => {
    const m = manifest([feat("a"), feat("b")]);
    const result = reconcile({
      manifest: m,
      runState: runState({}),
      readFeatureState: noState,
      maxParallel: 3,
    });
    expect(result.epicStatus).toBe("running");
    expect(classifyEvent(result)).toEqual({ kind: "green" });
  });

  it("green: a running feature with nothing halted", () => {
    const m = manifest([feat("a"), feat("b")]);
    const result = reconcile({
      manifest: m,
      runState: runState({ a: { slug: "a" } }),
      readFeatureState: phases({ a: "implementing" }),
      maxParallel: 3,
    });
    expect(classifyEvent(result)).toEqual({ kind: "green" });
  });

  it("halt: a single halted (needs-human) feature surfaces its id", () => {
    const m = manifest([feat("a"), feat("b", ["a"])]);
    const result = reconcile({
      manifest: m,
      runState: runState({ a: { slug: "a" } }),
      readFeatureState: phases({ a: "needs-human" }),
      maxParallel: 3,
    });
    expect(classifyEvent(result)).toEqual({ kind: "halt", haltedIds: ["a"] });
  });

  it("halt: outranks deadlock — a gated feature with an independent branch still running is a halt, not green", () => {
    const m = manifest([feat("a"), feat("b", ["a"]), feat("x")]);
    const result = reconcile({
      manifest: m,
      runState: runState({ a: { slug: "a", pr: 9 } }),
      readFeatureState: phases({ a: "gated" }),
      maxParallel: 3,
    });
    expect(result.epicStatus).toBe("running"); // x keeps the epic alive
    expect(classifyEvent(result)).toEqual({ kind: "halt", haltedIds: ["a"] });
  });

  it("halt: reports every halted id (gated + orphan)", () => {
    const m = manifest([feat("a"), feat("b")]);
    const result = reconcile({
      manifest: m,
      runState: runState({ a: { slug: "a" }, b: { slug: "b" } }),
      // a gated; b launched but no state file → orphan. Both are HALT_STATUSES.
      readFeatureState: phases({ a: "gated" }),
      maxParallel: 3,
    });
    const event = classifyEvent(result);
    expect(event.kind).toBe("halt");
    expect(event.kind === "halt" && event.haltedIds.sort()).toEqual(["a", "b"]);
  });

  it("deadlock: epicStatus blocked + zero halted blockers + not all merged", () => {
    // A 2-node cycle: neither feature can ever enter the frontier, neither is
    // launched, so both rows are board-status "blocked" (NOT a HALT_STATUS).
    const m = manifest([feat("a", ["b"]), feat("b", ["a"])]);
    const result = reconcile({
      manifest: m,
      runState: runState({}),
      readFeatureState: noState,
      maxParallel: 3,
    });
    expect(result.epicStatus).toBe("blocked");
    expect(result.board.every((r) => !HALT_STATUSES.has(r.status))).toBe(true);
    expect(classifyEvent(result)).toEqual({ kind: "deadlock" });
  });

  it("done: all features merged", () => {
    const m = manifest([feat("a"), feat("b", ["a"])]);
    const result = reconcile({
      manifest: m,
      runState: runState({ a: { slug: "a" }, b: { slug: "b" } }),
      readFeatureState: phases({ a: "merged", b: "merged" }),
      maxParallel: 3,
    });
    expect(result.epicStatus).toBe("done");
    expect(classifyEvent(result)).toEqual({ kind: "done" });
  });
});

describe("reconcile — external completion", () => {
  /** A runState with an explicit external record (no slug) for `id`. */
  function externalRunState(
    id: string,
    ref: string,
    others: Record<string, FeatureRunRecord> = {},
  ): EpicRunState {
    return {
      epicSlug: "watchlist",
      repo: "/tmp/repo",
      manifestPath: "/tmp/repo/.flow/epics/watchlist/manifest.json",
      manifestSha: "sha",
      maxParallel: 3,
      createdAt: "2026-06-28T00:00:00Z",
      updatedAt: "2026-06-28T00:00:00Z",
      features: {
        [id]: { external: ref, completedAt: "2026-06-28T00:00:00Z" },
        ...others,
      },
    };
  }

  it("classifies an external record as merged without reading any pipeline state", () => {
    const m = manifest([feat("a")]);
    // readFeatureState throws if called — an external record must not touch it.
    const throwingState: ReadFeatureState = () => {
      throw new Error(
        "readFeatureState must not be called for an external record",
      );
    };
    const result = reconcile({
      manifest: m,
      runState: externalRunState("a", "PR #123"),
      readFeatureState: throwingState,
      maxParallel: 3,
    });
    const row = result.board.find((r) => r.id === "a")!;
    expect(row.status).toBe("merged");
    expect(row.external).toBe(true);
    expect(row.slug).toBeUndefined();
    expect(result.summary.merged).toBe(1);
    expect(result.epicStatus).toBe("done");
  });

  it("an external-completed dependency unblocks its dependents (they become ready)", () => {
    const m = manifest([feat("a"), feat("b", ["a"])]);
    const result = reconcile({
      manifest: m,
      // a completed external; b not launched → b should be ready (dep satisfied).
      runState: externalRunState("a", "PR #7"),
      readFeatureState: noState,
      maxParallel: 3,
    });
    const b = result.board.find((r) => r.id === "b")!;
    expect(b.status).toBe("ready");
    expect(result.toLaunch.map((f) => f.id)).toContain("b");
  });
});
