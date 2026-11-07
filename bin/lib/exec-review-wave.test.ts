import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeGrant } from "./epic-grant";
import { appendManagerLog, readManagerLog } from "./epic-manager-log";
import { defaultExecDeps, type ExecReviewDeps } from "./exec-review-shared";
import { orderFrontier, runWaveReview } from "./exec-review-wave";
import { writeState } from "./state";

const CHARTER = "# Brief\n\n## Deciding on my behalf\n\n1. goal first\n";

let root: string;
let repo: string;
let home: string;
let stateDir: string;
let epicsDir: string;
let calls: string[];
let replyJson: object;
let headlessEnv: { ran: boolean; skipReason?: string; total_cost_usd?: number };

function w(p: string, c: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
}

function board(merged: string[]) {
  w(
    path.join(repo, ".flow/epics/e1/status.json"),
    JSON.stringify({
      version: 1,
      epicId: "e1",
      features: Object.fromEntries(
        ["f1", "f2", "f3", "f4", "f5", "w1"].map((id) => [
          id,
          merged.includes(id)
            ? { status: "merged", pr: Number(id.slice(1)) + 100 }
            : { status: "not-started" },
        ]),
      ),
    }),
  );
}

function deps(over: Partial<ExecReviewDeps> = {}): ExecReviewDeps {
  let t = 0;
  return {
    ...defaultExecDeps(),
    stateDir,
    homeDir: home,
    epicsDir,
    readConfig: () => undefined,
    now: () => new Date(Date.UTC(2026, 9, 26, 2, 0, t++)),
    random: () => "cd34",
    recordEvent: () => {},
    fetchPr: (pr) => ({ title: `PR ${pr} title`, body: `PR ${pr} body` }),
    spawnHeadless: (argv) => {
      const out = argv[argv.indexOf("--out") + 1];
      calls.push(
        fs.readFileSync(argv[argv.indexOf("--prompt-file") + 1], "utf8"),
      );
      if (!headlessEnv.ran) return headlessEnv;
      w(out, JSON.stringify({ result: JSON.stringify(replyJson) }));
      return { artifact: out, ...headlessEnv };
    },
    ...over,
  };
}

const good = (over: object = {}) => ({
  decision: "reorder",
  doorType: "two-way",
  confidence: "high",
  rationale: "f5 unblocks more",
  evidence: ["bin/lib/state.ts:3"],
  undo: "re-run the review",
  order: ["f5", "f3", "f4"],
  ...over,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "execwave-"));
  repo = path.join(root, "repo");
  home = path.join(root, "home");
  stateDir = path.join(root, "state");
  epicsDir = path.join(root, "epics");
  calls = [];
  headlessEnv = { ran: true, total_cost_usd: 0.4 };
  replyJson = good();
  w(path.join(home, ".flow", "product.md"), CHARTER);
  w(
    path.join(repo, ".flow/epics/e1/manifest.json"),
    JSON.stringify({
      epicId: "e1",
      prompt: "p",
      createdAt: "t",
      features: [
        { id: "f1", title: "One", description: "d", dependsOn: [] },
        { id: "f2", title: "Two", description: "d", dependsOn: ["f1"] },
        { id: "f3", title: "Three", description: "d", dependsOn: ["f1"] },
        { id: "f4", title: "Four", description: "d", dependsOn: ["f1"] },
        { id: "f5", title: "Five", description: "d", dependsOn: ["f1"] },
        {
          id: "w1",
          title: "Wait",
          description: "d",
          dependsOn: [],
          waitFor: "a thing",
        },
      ],
    }),
  );
  w(path.join(repo, ".flow/epics/e1/design.md"), "**Goal:** the epic goal\n");
  board(["f1", "f2"]);
  writeGrant(
    {
      version: 1,
      epic: "e1",
      classes: ["plan"],
      grantedAt: "t",
      grantedBy: "owner-cli",
    },
    stateDir,
  );
  appendManagerLog(
    "e1",
    {
      ts: "t0",
      kind: "grant",
      exec: { decisionId: "g", reviewKind: "plan", baselineMerged: ["f1"] },
    },
    stateDir,
  );
  // f2 merged since the grant; f4 is already launched (live state).
  writeState(
    {
      slug: "f4-run",
      phase: "implementing",
      repo,
      updatedAt: "2026-10-26T00:00:00.000Z",
      epic: { slug: "e1", featureId: "f4" },
    },
    stateDir,
  );
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const run = (d = deps()) => runWaveReview({ epic: "e1", repoRoot: repo }, d);
const manifestBytes = () =>
  fs.readFileSync(path.join(repo, ".flow/epics/e1/manifest.json"), "utf8");

describe("runWaveReview", () => {
  it("makes no call without a grant", () => {
    fs.rmSync(path.join(stateDir, "managers"), { recursive: true });
    expect(run()).toEqual({ ran: false, skipReason: "no-grant" });
    expect(calls).toHaveLength(0);
  });

  it("reports status-missing without a committed board", () => {
    fs.rmSync(path.join(repo, ".flow/epics/e1/status.json"));
    expect(run()).toMatchObject({ ran: false, skipReason: "status-missing" });
  });

  it("covers every newly merged feature with exactly one call, then reports nothing-new", () => {
    board(["f1", "f2", "f3"]);
    const r = run();
    expect(r).toMatchObject({ ran: true, mergedFeatureIds: ["f2", "f3"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("PR 102 title");
    expect(calls[0]).toContain("PR 103 body");
    expect(calls[0]).not.toContain("PR 101");
    expect(run()).toMatchObject({ ran: false, skipReason: "nothing-new" });
    expect(calls).toHaveLength(1);
  });

  it("applies a valid reorder of exactly the unstarted features and orderFrontier honours it", () => {
    replyJson = good({ order: ["f5", "f3"] });
    const r = run();
    expect(r).toMatchObject({
      ran: true,
      action: "reorder",
      order: ["f5", "f3"],
    });
    expect(calls[0]).toContain(
      "unstarted feature ids (the only ids a reorder may contain): f3, f5",
    );
    const d = readManagerLog("e1", stateDir).find(
      (e) => e.kind === "exec-decision",
    );
    expect(d?.exec).toMatchObject({
      reviewKind: "wave",
      action: "reorder",
      mergedFeatureIds: ["f2"],
      order: ["f5", "f3"],
    });
    expect(orderFrontier("e1", ["f3", "f5", "f9"], stateDir)).toEqual([
      "f5",
      "f3",
      "f9",
    ]);
  });

  it("escalates a reorder that names a started or wait feature", () => {
    replyJson = good({ order: ["f5", "f3", "f4"] });
    expect(run()).toMatchObject({ ran: true, action: "escalate" });
    expect(orderFrontier("e1", ["f3", "f5"], stateDir)).toEqual(["f3", "f5"]);
  });

  it("a proposal is logged and never changes the manifest", () => {
    const before = manifestBytes();
    replyJson = good({
      decision: "propose",
      proposal: { kind: "cut", featureId: "f5", text: "drop f5" },
    });
    const r = run();
    expect(r).toMatchObject({
      ran: true,
      action: "propose",
      proposal: { kind: "cut", featureId: "f5" },
    });
    expect(manifestBytes()).toBe(before);
    expect(readManagerLog("e1", stateDir).at(-1)?.exec?.proposal?.text).toBe(
      "drop f5",
    );
    expect(orderFrontier("e1", ["f3", "f5"], stateDir)).toEqual(["f3", "f5"]);
  });

  it("continues, and records the batch so the next run is nothing-new", () => {
    replyJson = good({ decision: "continue", order: undefined });
    expect(run()).toMatchObject({ ran: true, action: "continue" });
    expect(run()).toMatchObject({ ran: false, skipReason: "nothing-new" });
  });

  it("downgrades a medium-confidence reorder to continue", () => {
    replyJson = good({ confidence: "medium", order: ["f5", "f3"] });
    expect(run()).toMatchObject({ ran: true, action: "continue" });
    expect(orderFrontier("e1", ["f3", "f5"], stateDir)).toEqual(["f3", "f5"]);
  });

  it("a headless failure logs a skip and leaves the batch pending", () => {
    headlessEnv = {
      ran: false,
      skipReason: "budget-exceeded",
      total_cost_usd: 3.2,
    };
    expect(run()).toMatchObject({
      ran: false,
      skipReason: "budget-exceeded",
      mergedFeatureIds: ["f2"],
    });
    expect(readManagerLog("e1", stateDir).at(-1)).toMatchObject({
      kind: "exec-skip",
      reason: "budget-exceeded",
    });
    headlessEnv = { ran: true };
    expect(run()).toMatchObject({ ran: true });
  });

  it("an invalid envelope skips and leaves the batch pending", () => {
    replyJson = { decision: "reorder" };
    expect(run()).toMatchObject({ ran: false, skipReason: "envelope-invalid" });
    replyJson = good();
    expect(run()).toMatchObject({ ran: true });
  });

  it("skips with charter-missing when the owner's brief has no charter", () => {
    w(path.join(home, ".flow", "product.md"), "# only a brief\n");
    expect(run()).toMatchObject({ ran: false, skipReason: "charter-missing" });
    expect(calls).toHaveLength(0);
  });

  it("a re-grant keeps the earliest baseline so merges during a withdrawal are reviewed", () => {
    appendManagerLog(
      "e1",
      {
        ts: "t9",
        kind: "grant",
        exec: {
          decisionId: "g2",
          reviewKind: "plan",
          baselineMerged: ["f1", "f2"],
        },
      },
      stateDir,
    );
    expect(run()).toMatchObject({ ran: true, mergedFeatureIds: ["f2"] });
  });

  it("excludes features bound in run.json from the unstarted ids", () => {
    w(
      path.join(epicsDir, "e1", "run.json"),
      JSON.stringify({
        epicSlug: "e1",
        repo,
        manifestPath: path.join(repo, ".flow/epics/e1/manifest.json"),
        manifestSha: "x",
        createdAt: "t",
        updatedAt: "t",
        features: { f3: { slug: "f3-run", launchedAt: "t" } },
      }),
    );
    run();
    expect(calls[0]).toContain("(the only ids a reorder may contain): f5");
  });
});

describe("orderFrontier", () => {
  it("returns the frontier unchanged when no reorder was applied", () => {
    expect(orderFrontier("e1", ["b", "a"], stateDir)).toEqual(["b", "a"]);
  });

  it("uses the newest applied reorder", () => {
    for (const [i, order] of [
      ["a", "b"],
      ["b", "a"],
    ].entries()) {
      appendManagerLog(
        "e1",
        {
          ts: `t${i}`,
          kind: "exec-decision",
          exec: {
            decisionId: `d${i}`,
            reviewKind: "wave",
            action: "reorder",
            order,
          },
        },
        stateDir,
      );
    }
    expect(orderFrontier("e1", ["a", "b"], stateDir)).toEqual(["b", "a"]);
  });
});
