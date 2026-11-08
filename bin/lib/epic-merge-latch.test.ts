import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeLatchFailure,
  formatLatchNote,
  latchEpicBinding,
} from "./epic-merge-latch";
import { LockTimeoutError } from "./lock";
import { reconcile, type ReadFeatureState } from "./epic-reconcile";
import {
  epicRunStatePath,
  INVALID_LAUNCH_RECORD_PREFIX,
  mutateEpicRunRecord,
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

describe("latchEpicBinding — slug reuse and repo guards", () => {
  const latch = (state: PipelineState) =>
    latchEpicBinding(state, { epicsDir: dir, now });
  const created = "2026-11-08T12:00:00.000Z";
  const withCreated = (createdAt?: string): PipelineState => ({
    ...st("email-delivery", "merged", 5),
    ...(createdAt ? { createdAt } : {}),
  });
  const gitRepo = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "flow-latch-repo-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: d });
    return d;
  };
  const tempRepos: string[] = [];
  afterEach(() => {
    for (const d of tempRepos.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("slug reuse: an older unmerged binding is untouched", () => {
    writeEpicRunState(
      run("email-epic", {
        f1: {
          slug: "email-delivery",
          launchedAt: "2026-08-03T03:16:42.218Z",
        },
      }),
      dir,
    );
    const before = raw("email-epic");
    const results = latch(withCreated(created));
    expect(raw("email-epic")).toBe(before);
    expect(results).toEqual([
      {
        epicSlug: "email-epic",
        featureId: "f1",
        lastStatus: "",
        wrote: false,
        skipped: "predates-pipeline",
      },
    ]);
    const note = formatLatchNote(results[0]!, "email-delivery");
    expect(note).toContain("email-epic/f1");
    expect(note).toContain("belongs to an earlier pipeline");
  });

  it("latches an epic launch whose createdAt is seconds before launchedAt", () => {
    writeEpicRunState(
      run("e", {
        b: { slug: "email-delivery", launchedAt: "2026-11-08T12:00:08.800Z" },
      }),
      dir,
    );
    expect(latch(withCreated(created))[0]?.wrote).toBe(true);
    expect(feature("e", "b")?.lastStatus).toBe("merged");
  });

  it("latches a hand bind made hours after the pipeline was created", () => {
    writeEpicRunState(
      run("e", {
        b: { slug: "email-delivery", launchedAt: "2026-11-08T18:00:00.000Z" },
      }),
      dir,
    );
    expect(latch(withCreated(created))[0]?.wrote).toBe(true);
  });

  it("latches as today when the state has no createdAt", () => {
    writeEpicRunState(
      run("e", {
        b: { slug: "email-delivery", launchedAt: "2026-08-03T00:00:00.000Z" },
      }),
      dir,
    );
    expect(latch(withCreated())[0]?.wrote).toBe(true);
  });

  it("latches as today when launchedAt is unparseable", () => {
    writeEpicRunState(run("e", { b: bound("email-delivery") }), dir);
    expect(latch(withCreated(created))[0]?.wrote).toBe(true);
  });

  it("other-repo: a binding in an unrelated git repo is skipped and not written", () => {
    const epicRepo = gitRepo();
    const pipelineRepo = gitRepo();
    tempRepos.push(epicRepo, pipelineRepo);
    writeEpicRunState(
      { ...run("e", { b: bound("email-delivery") }), repo: epicRepo },
      dir,
    );
    const before = raw("e");
    const results = latch({
      ...withCreated(),
      repo: pipelineRepo,
    });
    expect(raw("e")).toBe(before);
    expect(results[0]).toMatchObject({ wrote: false, skipped: "other-repo" });
    expect(formatLatchNote(results[0]!, "email-delivery")).toBe(
      "did not mark e/b merged: its epic is in a different repo",
    );
  });

  it("latches when run.repo and state.repo are the same string, without git", () => {
    writeEpicRunState(
      { ...run("e", { b: bound("email-delivery") }), repo: "/nonexistent/x" },
      dir,
    );
    expect(latch({ ...withCreated(), repo: "/nonexistent/x" })[0]?.wrote).toBe(
      true,
    );
  });

  it("fails open when state.repo no longer exists on disk", () => {
    const epicRepo = gitRepo();
    tempRepos.push(epicRepo);
    writeEpicRunState(
      { ...run("e", { b: bound("email-delivery") }), repo: epicRepo },
      dir,
    );
    expect(
      latch({ ...withCreated(), repo: "/nonexistent/moved" })[0]?.wrote,
    ).toBe(true);
  });
});

describe("describeLatchFailure", () => {
  it("explains a lock timeout without the lock path", () => {
    const text = describeLatchFailure(
      new LockTimeoutError("/home/u/.flow/epics/e/run.json.lock", 5000),
    );
    expect(text).toContain("still updating the epic board");
    expect(text).not.toContain("run.json.lock");
  });

  it("explains permission, disk-full and malformed-record failures", () => {
    const errno = (code: string) =>
      Object.assign(new Error(`${code}: raw`), { code });
    expect(describeLatchFailure(errno("EACCES"))).toContain("permissions");
    expect(describeLatchFailure(errno("EPERM"))).toContain("permissions");
    expect(describeLatchFailure(errno("EROFS"))).toContain("permissions");
    expect(describeLatchFailure(errno("ENOSPC"))).toBe("the disk is full");
    writeEpicRunState(run("e", { a: bound("a-slug") }), dir);
    let thrown: unknown;
    try {
      mutateEpicRunRecord("e", "a", () => ({ pr: 1 }) as FeatureRunRecord, {
        dir,
        now,
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toContain(INVALID_LAUNCH_RECORD_PREFIX);
    expect(describeLatchFailure(thrown)).toBe(
      "the epic board entry would have been malformed",
    );
  });

  it("falls back to the raw message", () => {
    expect(describeLatchFailure(new Error("boom"))).toBe("boom");
    expect(describeLatchFailure("odd")).toBe("odd");
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
