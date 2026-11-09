import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkpointBodyPath } from "./checkpoint-freshness";
import {
  appendJournal,
  logNoteOnce,
  readHistoryEvents,
  snapshotWorktreeArtifacts,
} from "./checkpoint-history";
import {
  loadAndRenderHistory,
  resolveHistoryKind,
} from "./checkpoint-history-load";
import { requestFilePath, writeState, type PipelineState } from "./state";

let root!: string;
let stateDir!: string;
let epicsDir!: string;
let repo!: string;
const SLUG = "demo-slug";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-load-"));
  stateDir = path.join(root, "state");
  epicsDir = path.join(root, "epics");
  repo = path.join(root, "repo");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(repo);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function seed(over: Partial<PipelineState> = {}): PipelineState {
  const state = {
    slug: SLUG,
    phase: "reviewing",
    repo,
    updatedAt: "2026-11-01T00:00:00Z",
    ...over,
  } as PipelineState;
  writeState(state, stateDir);
  return state;
}

const opts = () => ({ stateDir, epicsDir, resolveKind: () => null });

describe("loadAndRenderHistory", () => {
  it("should return null for a missing record", () => {
    expect(loadAndRenderHistory("nope-slug", opts())).toBeNull();
  });

  it("should write history.md and return the render", () => {
    seed();
    fs.writeFileSync(requestFilePath(SLUG, stateDir), "build the thing");
    const out = loadAndRenderHistory(SLUG, opts());
    expect(out?.path).toBe(
      path.join(stateDir, "checkpoints", SLUG, "history.md"),
    );
    expect(fs.readFileSync(out?.path as string, "utf8")).toBe(out?.doc.text);
    expect(out?.doc.text).toContain("build the thing");
  });

  it("should render an unlogged live note without logging it", () => {
    seed();
    const p = checkpointBodyPath(SLUG, stateDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "- [one-time] approve");
    const out = loadAndRenderHistory(SLUG, opts());
    expect(out?.doc.text).toContain("live, not yet logged");
    expect(readHistoryEvents(SLUG, stateDir)).toEqual([]);
  });

  it("should keep standing rules active in an epic-run window", () => {
    // The shared record sits at a finished epic phase; only the window kind says epic-run.
    seed({ phase: "epic-approved" });
    logNoteOnce(
      SLUG,
      "- [standing] keep going",
      { phase: "epic-approved", site: "manual" },
      stateDir,
    );
    const out = loadAndRenderHistory(SLUG, {
      ...opts(),
      resolveKind: () => "epic-run",
    });
    expect(out?.doc.active).toContain("[standing S1] keep going");
  });

  it("should read design.md from the canonical checkout after worktree removal", () => {
    seed({
      phase: "epic-approved",
      kind: "epic-design",
      worktree: path.join(root, "gone-worktree"),
    });
    const dir = path.join(repo, ".flow", "epics", SLUG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "design.md"), "**Goal:** Ship the epic.\n");
    const out = loadAndRenderHistory(SLUG, { ...opts(), kind: "epic-design" });
    expect(out?.doc.sections.find((s) => s.key === "plan")?.body).toContain(
      "Ship the epic.",
    );
  });

  it("should prefer body.md over the draft and read the snapshot after removal", () => {
    const wt = path.join(root, "wt");
    fs.mkdirSync(path.join(wt, ".flow-tmp"), { recursive: true });
    fs.writeFileSync(
      path.join(wt, ".flow-tmp", "pr-description-draft.md"),
      "## System changes\n- draft change\n",
    );
    fs.writeFileSync(
      path.join(wt, ".flow-tmp", "body.md"),
      "## System changes\n- merged change\n",
    );
    seed({ phase: "merged", worktree: wt });
    snapshotWorktreeArtifacts(SLUG, wt, stateDir);
    fs.rmSync(wt, { recursive: true, force: true });
    const out = loadAndRenderHistory(SLUG, opts());
    const shipped = out?.doc.sections.find((s) => s.key === "shipped")?.body;
    expect(shipped).toContain("merged change");
    expect(shipped).not.toContain("draft change");
    expect(out?.doc.status).not.toContain("Resume line");
  });

  it("should drop events older than the record (slug reuse)", () => {
    seed({ createdAt: "2026-11-05T00:00:00Z" });
    appendJournal(SLUG, "from the old run", "reviewing", stateDir);
    const log = path.join(stateDir, "checkpoints", SLUG, "history.jsonl");
    const old = fs
      .readFileSync(log, "utf8")
      .replace(/"at":"[^"]+"/, '"at":"2026-10-01T00:00:00Z"');
    fs.writeFileSync(log, old);
    const out = loadAndRenderHistory(SLUG, opts());
    expect(out?.doc.text).not.toContain("from the old run");
  });
});

describe("resolveHistoryKind", () => {
  it("should prefer opts.kind, then the ambient kind, then the record", () => {
    const state = seed({ kind: "feature" });
    expect(resolveHistoryKind(state, { kind: "epic-run" })).toBe("epic-run");
    expect(
      resolveHistoryKind(state, { resolveKind: () => "epic-design" }),
    ).toBe("epic-design");
    expect(resolveHistoryKind(state, { resolveKind: () => null })).toBe(
      "feature",
    );
    expect(
      resolveHistoryKind(state, {
        resolveKind: () => {
          throw new Error("no tmux");
        },
      }),
    ).toBe("feature");
  });
});
