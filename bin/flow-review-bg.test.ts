import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run, runWait, type WaitDeps } from "./flow-review-bg";
import { startHelpers } from "./lib/review-bg";
import {
  bgPaths,
  readReviewBgState,
  realStateIO,
  writeReviewBgState,
  type ReviewBgState,
  type StateIO,
} from "./lib/review-bg-state";

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
  it("recovers complete from a whole envelope when the watchdog is dead", async () => {
    const t = setup(state(), "abc", { isAlive: () => false });
    t.files.set(P.lensEnvelope, '{"ran":true,"findingCount":1}\n');
    const r = await runWait({ worktree: WT, maxSec: 10 }, t.deps);
    expect(r.helpers["gemini-lens"]).toMatchObject({
      outcome: "complete",
      ran: true,
    });
    expect(r.helpers["gemini-lens"].skipReason).toBeUndefined();
    expect(r.helpers["gemini-intent-guess"].outcome).toBe(
      "helper-exited-without-envelope",
    );
  });

  it("stamps awaitedAt on the first snapshot", async () => {
    const t = setup(state());
    await runWait({ worktree: WT, maxSec: 0 }, t.deps);
    expect(readReviewBgState(t.files.get(P.state)!)?.awaitedAt).toBeTypeOf(
      "number",
    );
  });

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

  it("reports a missing-envelope reason for a finished helper with no usable envelope", async () => {
    const h = state().helpers["gemini-lens"];
    const t = setup(
      state({
        helpers: {
          "gemini-lens": { ...h, status: "done", outcome: "complete" },
          "gemini-intent-guess": {
            ...h,
            status: "done",
            outcome: "complete",
          },
        },
      }),
    );
    const r = await runWait({ worktree: WT, maxSec: 10 }, t.deps);
    expect(r.done).toBe(true);
    for (const e of Object.values(r.helpers)) {
      expect(e).toMatchObject({
        ran: false,
        skipReason: "helper-exited-without-envelope",
        skipClass: "ran-unusable",
      });
    }
  });

  it("keeps a helper's own skip reason from its envelope instead of the missing-envelope fallback", async () => {
    const h = state().helpers["gemini-lens"];
    const t = setup(
      state({
        helpers: {
          "gemini-lens": { ...h, status: "done", outcome: "complete" },
          "gemini-intent-guess": { ...h, status: "done", outcome: "complete" },
        },
      }),
    );
    t.files.set(
      P.lensEnvelope,
      '{"ran":false,"skipReason":"agy-quota","skipClass":"environment"}\n',
    );
    const r = await runWait({ worktree: WT, maxSec: 10 }, t.deps);
    expect(r.helpers["gemini-lens"]).toMatchObject({
      ran: false,
      skipReason: "agy-quota",
      skipClass: "environment",
    });
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
    [["wait", "--worktree", "/w", "--timeout", "30"]],
    [["start", "--worktree", "/w", "--max-sec", "5"]],
    [["supervise", "--worktree", "/w", "--generation", "g", "--config", "x"]],
    [["wait", "--worktree", ""]],
    [["wait", "--worktree", "   "]],
    [["wait", "--worktree", "/w", "--max-sec", ""]],
    [["wait", "--worktree", "/w", "--worktree", "/x"]],
    [["wait", "--worktree", "/w", "--__proto__", "x"]],
  ])("exits 2 on usage error %j", async (argv) => {
    expect(await run(argv as string[], () => {})).toBe(2);
  });
});

describe("run (CLI) against a real worktree", () => {
  it("accepts every production call shape", async () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "flow-review-bg-"));
    try {
      // Pins the disabled gate (sandboxed HOME has no flow config, and diff.txt
      // is absent), so the real start can never spawn a watchdog.
      const emptyBin = path.join(wt, "empty-bin");
      fs.mkdirSync(emptyBin);
      const out: string[] = [];
      vi.stubEnv("PATH", emptyBin);
      try {
        expect(await run(["start", "--worktree", wt], (l) => out.push(l))).toBe(
          0,
        );
      } finally {
        vi.unstubAllEnvs();
      }
      const started = JSON.parse(out.join("\n"));
      expect(started.helpers["gemini-lens"].skipReason).toBe(
        "gemini-lens-disabled",
      );
      expect(started.helpers["gemini-intent-guess"].skipReason).toBe(
        "gemini-intent-guess-disabled",
      );
      expect(started.watchdog).toBeNull();
      expect(fs.existsSync(bgPaths(wt).superviseLog)).toBe(false);
      expect(
        await run(["wait", "--worktree", wt, "--max-sec", "0"], () => {}),
      ).toBe(0);

      const tmp = path.join(wt, ".flow-tmp");
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(
        path.join(tmp, "review-scope.json"),
        JSON.stringify({ head_sha: "abc", scope: "full" }),
      );
      fs.writeFileSync(path.join(tmp, "diff.txt"), "");
      const cfg = path.join(wt, "cfg.json");
      fs.writeFileSync(cfg, JSON.stringify({ review: { gemini: true } }));
      const runs: string[][] = [];
      startHelpers(
        { worktree: wt, config: cfg },
        {
          io: realStateIO(),
          nowMs: () => 1_000_000,
          readCooldown: () => ({ live: false }),
          run: (argv) => {
            runs.push(argv);
            return { exitCode: 0, stdout: "4242\n" };
          },
          pidStartEpoch: () => 1,
          isAlive: () => false,
          killPid: () => {},
          sleepMs: () => {},
          mintGeneration: () => "gen-prod",
        },
      );
      const spawned = runs[0]!;
      const supervise = spawned.slice(spawned.indexOf("flow-review-bg") + 1);
      expect(supervise[0]).toBe("supervise");
      // Drop the run record so the real supervise verb refuses rather than
      // launching helpers.
      fs.rmSync(bgPaths(wt).state);
      expect(await run(supervise, () => {})).toBe(0);
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it("start with gemini off then wait reports both disabled skips", async () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "flow-review-bg-"));
    try {
      const tmp = path.join(wt, ".flow-tmp");
      fs.mkdirSync(tmp);
      fs.writeFileSync(
        path.join(tmp, "review-scope.json"),
        JSON.stringify({ head_sha: "abc", scope: "full" }),
      );
      fs.writeFileSync(path.join(tmp, "diff.txt"), "");
      const cfg = path.join(wt, "cfg.json");
      fs.writeFileSync(cfg, "{}");
      const emptyBin = path.join(wt, "empty-bin");
      fs.mkdirSync(emptyBin);
      vi.stubEnv("PATH", emptyBin);
      try {
        expect(
          await run(["start", "--worktree", wt, "--config", cfg], () => {}),
        ).toBe(0);
      } finally {
        vi.unstubAllEnvs();
      }
      const out: string[] = [];
      expect(await run(["wait", "--worktree", wt], (l) => out.push(l))).toBe(0);
      const report = JSON.parse(out[0]!);
      expect(report.helpers["gemini-intent-guess"].skipReason).toBe(
        "gemini-intent-guess-disabled",
      );
      expect(report.helpers["gemini-lens"].skipReason).toBe(
        "gemini-lens-disabled",
      );
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it("supervise without a matching state is refused and exits 0", async () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "flow-review-bg-"));
    try {
      expect(
        await run(
          ["supervise", "--worktree", wt, "--generation", "nope"],
          () => {},
        ),
      ).toBe(0);
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("executable bit", () => {
  it("is executable", () => {
    const p = path.join(import.meta.dirname ?? ".", "flow-review-bg.ts");
    expect(fs.statSync(p).mode & 0o111).not.toBe(0);
  });
});
