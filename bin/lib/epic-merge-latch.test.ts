import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatLatchNote, latchEpicBinding } from "./epic-merge-latch";
import { reconcile, type ReadFeatureState } from "./epic-reconcile";
import {
  epicRunStatePath,
  readEpicRunState,
  writeEpicRunState,
  type EpicRunState,
  type FeatureRunRecord,
} from "./epic-run-state";
import type { PipelineState } from "./state";

let dir!: string;
const now = () => "2026-07-03T00:00:00Z";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-latch-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(
  epicSlug: string,
  features: Record<string, FeatureRunRecord>,
): EpicRunState {
  return {
    epicSlug,
    repo: "/tmp/repo",
    manifestPath: `/tmp/repo/.flow/epics/${epicSlug}/manifest.json`,
    manifestSha: "sha",
    maxParallel: 3,
    createdAt: "2026-06-28T00:00:00Z",
    updatedAt: "2026-06-28T00:00:00Z",
    features,
  };
}

function st(slug: string, phase: string, pr?: number): PipelineState {
  return {
    slug,
    phase,
    repo: "/tmp/repo",
    updatedAt: "2026-06-28T00:00:00Z",
    ...(pr !== undefined ? { pr } : {}),
  };
}

const bound = (slug: string, extra: Partial<FeatureRunRecord> = {}) => ({
  slug,
  launchedAt: "x",
  ...extra,
});
const raw = (epic: string) =>
  fs.readFileSync(epicRunStatePath(epic, dir), "utf8");
const feature = (epic: string, id: string) =>
  readEpicRunState(epic, dir)?.features[id];

describe("latchEpicBinding", () => {
  it("incident replay: a latched merge survives state-file deletion through the real reconcile", () => {
    writeEpicRunState(
      run("e", { a: { external: "PR#1", completedAt: "x" }, b: bound("b") }),
      dir,
    );
    const results = latchEpicBinding(st("b", "merged", 977), {
      epicsDir: dir,
      now,
    });
    expect(results).toEqual([
      {
        epicSlug: "e",
        featureId: "b",
        lastStatus: "merged",
        pr: 977,
        wrote: true,
      },
    ]);
    const noState: ReadFeatureState = () => null;
    const result = reconcile({
      manifest: {
        epicId: "e",
        prompt: "p",
        createdAt: "2026-06-28",
        features: [
          { id: "a", title: "A", description: "a", dependsOn: [] },
          { id: "b", title: "B", description: "b", dependsOn: ["a"] },
          { id: "c", title: "C", description: "c", dependsOn: ["b"] },
        ],
      },
      runState: readEpicRunState("e", dir)!,
      readFeatureState: noState,
      maxParallel: 3,
    });
    const rowB = result.board.find((r) => r.id === "b")!;
    expect(rowB.status).toBe("merged");
    expect(rowB.slug).toBe("b");
    expect(rowB.external).toBeUndefined();
    expect(result.summary.merged).toBe(2);
    expect(result.board.find((r) => r.id === "c")!.status).toBe("ready");
  });

  it("already latched: wrote false and the file is byte-identical", () => {
    writeEpicRunState(
      run("e", { b: bound("b", { lastStatus: "merged", pr: 977 }) }),
      dir,
    );
    const before = raw("e");
    const results = latchEpicBinding(st("b", "merged", 977), {
      epicsDir: dir,
      now,
    });
    expect(results.map((r) => r.wrote)).toEqual([false]);
    expect(raw("e")).toBe(before);
  });

  it("a binding naming another pipeline is untouched", () => {
    writeEpicRunState(run("e", { b: bound("other") }), dir);
    const before = raw("e");
    expect(
      latchEpicBinding(st("b", "merged", 1), { epicsDir: dir, now }),
    ).toEqual([]);
    expect(raw("e")).toBe(before);
  });

  it("an external record is untouched", () => {
    writeEpicRunState(run("e", { b: { external: "PR#9" } }), dir);
    const before = raw("e");
    expect(
      latchEpicBinding(st("b", "merged", 9), { epicsDir: dir, now }),
    ).toEqual([]);
    expect(raw("e")).toBe(before);
  });

  it("no launch record anywhere: [] and no file created", () => {
    expect(
      latchEpicBinding(st("b", "merged", 1), { epicsDir: dir, now }),
    ).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("a gated pipeline keeps its slug, gains the pr and the phase; no note", () => {
    writeEpicRunState(run("e", { b: bound("b") }), dir);
    const [r] = latchEpicBinding(st("b", "gated", 7), { epicsDir: dir, now });
    expect(feature("e", "b")).toMatchObject({
      slug: "b",
      lastStatus: "gated",
      pr: 7,
    });
    expect(formatLatchNote(r, "b")).toBeNull();
  });

  it("a recorded merge stays merged when the closing phase is cancelled", () => {
    writeEpicRunState(
      run("e", { b: bound("b", { lastStatus: "merged" }) }),
      dir,
    );
    const [r] = latchEpicBinding(st("b", "cancelled", 5), {
      epicsDir: dir,
      now,
    });
    expect(feature("e", "b")).toMatchObject({ lastStatus: "merged", pr: 5 });
    expect(r.lastStatus).toBe("merged");
  });

  it("latches the same pipeline bound in two epics", () => {
    writeEpicRunState(run("e1", { x: bound("b") }), dir);
    writeEpicRunState(run("e2", { y: bound("b") }), dir);
    const results = latchEpicBinding(st("b", "merged", 3), {
      epicsDir: dir,
      now,
    });
    expect(results.map((r) => r.epicSlug).sort()).toEqual(["e1", "e2"]);
    expect(feature("e1", "x")?.lastStatus).toBe("merged");
    expect(feature("e2", "y")?.lastStatus).toBe("merged");
  });

  it("latches a pipeline that carries no epic tag", () => {
    writeEpicRunState(run("e", { b: bound("b") }), dir);
    const state = st("b", "merged", 3);
    expect(state.epic).toBeUndefined();
    expect(latchEpicBinding(state, { epicsDir: dir, now })).toHaveLength(1);
  });
});

describe("formatLatchNote", () => {
  it("names the epic and PR for a merged result", () => {
    expect(
      formatLatchNote(
        {
          epicSlug: "e",
          featureId: "b",
          lastStatus: "merged",
          pr: 977,
          wrote: true,
        },
        "b",
      ),
    ).toBe("kept b merged on epic e (PR #977)");
    expect(
      formatLatchNote(
        { epicSlug: "e", featureId: "b", lastStatus: "merged", wrote: true },
        "b",
      ),
    ).toBe("kept b merged on epic e");
  });
});
