import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEpicBinding } from "./epic-binding";
import {
  writeEpicRunState,
  type EpicRunState,
  type FeatureRunRecord,
} from "./epic-run-state";
import { writeState, type PipelineState } from "./state";

let root!: string;
let stateDir!: string;
let epicsDir!: string;
let repoA!: string;
let repoB!: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-binding-"));
  stateDir = path.join(root, "state");
  epicsDir = path.join(root, "epics");
  repoA = path.join(root, "repoA");
  repoB = path.join(root, "repoB");
  for (const d of [stateDir, epicsDir, repoA, repoB]) {
    fs.mkdirSync(d, { recursive: true });
  }
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function state(slug: string, extra: Partial<PipelineState> = {}) {
  writeState(
    {
      slug,
      phase: "implementing",
      repo: repoA,
      updatedAt: "2026-07-03T00:00:00Z",
      ...extra,
    },
    stateDir,
  );
}

function run(
  epicSlug: string,
  features: Record<string, FeatureRunRecord>,
  repo = repoA,
) {
  const rec: EpicRunState = {
    epicSlug,
    repo,
    manifestPath: path.join(repo, ".flow/epics", epicSlug, "manifest.json"),
    manifestSha: "sha",
    createdAt: "2026-07-03T00:00:00Z",
    updatedAt: "2026-07-03T00:00:00Z",
    features,
  };
  writeEpicRunState(rec, epicsDir);
}

const bind = (slug: string) => resolveEpicBinding({ slug, stateDir, epicsDir });

describe("resolveEpicBinding", () => {
  it("should bind from the state tag alone", () => {
    state("s1", { epic: { slug: "e1", featureId: "f1" } });
    expect(bind("s1")).toEqual({
      kind: "bound",
      epicSlug: "e1",
      featureId: "f1",
      source: "state",
    });
  });

  it("should bind a hand-bound pipeline from run.json alone", () => {
    state("s1");
    run("e1", { f1: { slug: "s1", launchedAt: "2026-07-03T00:00:00Z" } });
    expect(bind("s1")).toEqual({
      kind: "bound",
      epicSlug: "e1",
      featureId: "f1",
      source: "run-json",
    });
  });

  it("should report a conflict when the tag and the record disagree", () => {
    state("s1", { epic: { slug: "e1", featureId: "f1" } });
    run("e1", { f2: { slug: "s1", launchedAt: "2026-07-03T00:00:00Z" } });
    expect(bind("s1").kind).toBe("conflict");
  });

  it("should accept a tag and a record that agree", () => {
    state("s1", { epic: { slug: "e1", featureId: "f1" } });
    run("e1", { f1: { slug: "s1", launchedAt: "2026-07-03T00:00:00Z" } });
    expect(bind("s1")).toMatchObject({ kind: "bound", source: "state" });
  });

  it("should report a conflict when two records match the slug", () => {
    state("s1");
    run("e1", { f1: { slug: "s1", launchedAt: "2026-07-03T00:00:00Z" } });
    run("e2", { f9: { slug: "s1", launchedAt: "2026-07-03T00:00:00Z" } });
    expect(bind("s1").kind).toBe("conflict");
  });

  it("should ignore an external record", () => {
    state("s1");
    run("e1", { f1: { external: "s1" } });
    expect(bind("s1")).toEqual({ kind: "none" });
  });

  it("should ignore a run.json recorded for a different repo", () => {
    state("s1");
    run(
      "e1",
      { f1: { slug: "s1", launchedAt: "2026-07-03T00:00:00Z" } },
      repoB,
    );
    expect(bind("s1")).toEqual({ kind: "none" });
  });

  it("should return none when nothing binds the slug", () => {
    state("s1");
    expect(bind("s1")).toEqual({ kind: "none" });
    expect(bind("missing")).toEqual({ kind: "none" });
  });
});
