import { describe, expect, it } from "vitest";
import { run, runWait, type WaitDeps } from "./flow-review-bg";
import {
  bgPaths,
  readReviewBgState,
  writeReviewBgState,
  type ReviewBgState,
  type StateIO,
} from "./lib/review-bg";

const WT = "/wt";
const P = bgPaths(WT);

function state(over: Partial<ReviewBgState> = {}): ReviewBgState {
  const h = (envelope: string, out: string, log: string) => ({
    status: "running" as const,
    startedAtSec: 0,
    giveUpAtSec: 1000,
    envelope,
    out,
    log,
    outcome: "pending" as const,
  });
  return {
    version: 1,
    generation: "g1",
    head_sha: "abc",
    scope: "full",
    review_started_at: null,
    configPath: "/cfg",
    watchdog: { pid: 55, pidStartEpoch: 9 },
    diffSnapshot: null,
    helpers: {
      "gemini-lens": h(P.lensEnvelope, P.lensOut, P.lensLog),
      "gemini-intent-guess": h(P.intentEnvelope, P.intentOut, P.intentLog),
    },
    ...over,
  };
}

function setup(
  st: ReviewBgState | null,
  head = "abc",
  over: Partial<WaitDeps> = {},
) {
  const files = new Map<string, string>([
    [P.reviewScope, JSON.stringify({ head_sha: head, scope: "full" })],
  ]);
  const io: StateIO = {
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => void files.set(p, c),
    rename: (a, b) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    removeFile: (p) => void files.delete(p),
    removeDir: () => {},
    mkdirp: () => {},
    fileExists: (p) => files.has(p),
    copyFile: () => {},
  };
  if (st) writeReviewBgState(WT, st, io);
  let now = 0;
  const sleeps: number[] = [];
  const deps: Partial<WaitDeps> = {
    io,
    nowMs: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    pollMs: 5000,
    isAlive: () => true,
    pidStartEpoch: () => 9,
    ...over,
  };
  return { files, io, deps, sleeps };
}

describe("runWait", () => {
  it("returns done:true with parsed envelope fields once both helpers resolved", async () => {
    const t = setup(state());
    writeReviewBgState(
      WT,
      state({
        helpers: {
          "gemini-lens": {
            ...state().helpers["gemini-lens"],
            status: "done",
            outcome: "complete",
          },
          "gemini-intent-guess": {
            ...state().helpers["gemini-intent-guess"],
            status: "skipped",
            outcome: "skipped",
            skipReason: "gemini-intent-guess-delta-reentry",
            skipClass: "environment",
          },
        },
      }),
      t.io,
    );
    t.files.set(P.lensEnvelope, '{"ran":true,"findingCount":2}\n');
    const r = await runWait({ worktree: WT, maxSec: 60 }, t.deps);
    expect(r.done).toBe(true);
    expect(r.helpers["gemini-lens"]).toMatchObject({
      outcome: "complete",
      ran: true,
      findingCount: 2,
      envelope: P.lensEnvelope,
    });
    expect(r.helpers["gemini-intent-guess"]).toMatchObject({
      outcome: "skipped",
      ran: false,
      skipReason: "gemini-intent-guess-delta-reentry",
    });
    expect(t.sleeps).toEqual([]);
  });

  it("stops at maxSec with done:false, and a re-run continues", async () => {
    const t = setup(state());
    const r1 = await runWait({ worktree: WT, maxSec: 12 }, t.deps);
    expect(r1.done).toBe(false);
    expect(r1.helpers["gemini-lens"]).toMatchObject({
      outcome: "pending",
      ran: null,
    });
    // The watchdog resolves the helpers between calls.
    const s = readReviewBgState(t.files.get(P.state)!)!;
    for (const h of Object.values(s.helpers)) {
      h.status = "done";
      h.outcome = "complete";
    }
    writeReviewBgState(WT, s, t.io);
    const r2 = await runWait({ worktree: WT, maxSec: 12 }, t.deps);
    expect(r2.done).toBe(true);
  });

  it("writes helper-exited-without-envelope back under the owner check when the watchdog is dead", async () => {
    const t = setup(state(), "abc", { isAlive: () => false });
    const r = await runWait({ worktree: WT, maxSec: 10 }, t.deps);
    expect(r.done).toBe(true);
    expect(r.helpers["gemini-lens"]).toMatchObject({
      outcome: "helper-exited-without-envelope",
      skipClass: "ran-unusable",
    });
    const s = readReviewBgState(t.files.get(P.state)!)!;
    expect(s.generation).toBe("g1");
    expect(s.helpers["gemini-lens"].outcome).toBe(
      "helper-exited-without-envelope",
    );
  });

  it("does not write back over a newer generation", async () => {
    let swapped = false;
    const t = setup(state(), "abc", {
      isAlive: () => {
        // a newer start lands between the read and the write-back
        if (!swapped) {
          swapped = true;
          writeReviewBgState(WT, state({ generation: "g2" }), t.io);
        }
        return false;
      },
    });
    const r = await runWait({ worktree: WT, maxSec: 0 }, t.deps);
    const s = readReviewBgState(t.files.get(P.state)!)!;
    expect(s.generation).toBe("g2");
    expect(s.helpers["gemini-lens"].status).toBe("running");
    expect(r.done).toBe(false);
  });

  it("reports gemini-not-launched without launching when no state matches the head", async () => {
    const t = setup(state(), "other-head");
    const r = await runWait({ worktree: WT, maxSec: 10 }, t.deps);
    expect(r.done).toBe(true);
    for (const h of Object.values(r.helpers)) {
      expect(h).toMatchObject({
        skipReason: "gemini-not-launched",
        skipClass: "environment",
        ran: false,
      });
    }
    expect(t.files.has(`${P.tmp}/review-bg.json.tmp`)).toBe(false);
  });
});

describe("run (CLI)", () => {
  it.each([
    [[]],
    [["start"]],
    [["wait", "--max-sec"]],
    [["bogus", "--worktree", "/w"]],
    [["supervise", "--worktree", "/w"]],
    [["wait", "--worktree", "/w", "--max-sec", "x"]],
  ])("exits 2 on usage error %j", async (argv) => {
    expect(await run(argv as string[], () => {})).toBe(2);
  });
});
