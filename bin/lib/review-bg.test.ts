import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { realDeps as lensRealDeps, run as runLens } from "../flow-gemini-lens";
import {
  realDeps as guessRealDeps,
  run as runGuess,
} from "../flow-gemini-intent-guess";
import { godurToSec } from "./delegate-timeouts";
import { runSupervise } from "./review-bg-supervise";
import { strictDeps } from "./test-seams";
import {
  startHelpers,
  stopAndClearRun,
  writeSkippedState,
  type StartDeps,
} from "./review-bg";
import {
  bgPaths,
  giveUpSec,
  ownsState,
  readReviewBgState,
  realStateIO,
  resolveGeminiSkip,
  writeIfOwner,
  type ReviewBgState,
  type StateIO,
} from "./review-bg-state";

const WT = "/wt";
const P = bgPaths(WT);
const ENABLED = JSON.stringify({ review: { gemini: true } });
const SCOPE = (scope = "full", head = "abc") =>
  JSON.stringify({ head_sha: head, scope, started_at: "2026-01-01T00:00:00Z" });
const CONFIG = "/cfg.json";

function makeIO(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const removed: string[] = [];
  const mkdirs: string[] = [];
  const removedDirs: string[] = [];
  const io: StateIO = {
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => void files.set(p, c),
    rename: (a, b) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    removeFile: (p) => {
      removed.push(p);
      files.delete(p);
    },
    removeDir: (d) => void removedDirs.push(d),
    mkdirp: (d) => void mkdirs.push(d),
    fileExists: (p) => files.has(p),
    copyFile: (a, b) => {
      if (!files.has(a)) throw new Error("ENOENT");
      files.set(b, files.get(a)!);
    },
  };
  return { io, files, removed, mkdirs, removedDirs };
}

function makeDeps(seed: Record<string, string>, over: Partial<StartDeps> = {}) {
  const { io, files, removed, mkdirs, removedDirs } = makeIO({
    [P.reviewScope]: SCOPE(),
    [P.diff]: "diff",
    [CONFIG]: ENABLED,
    ...seed,
  });
  const runs: string[][] = [];
  const kills: Array<[number, string]> = [];
  const deps: StartDeps = {
    io,
    nowMs: () => 1_000_000,
    readCooldown: () => ({ live: false }),
    run: (argv) => {
      runs.push(argv);
      return { exitCode: 0, stdout: "4242\n" };
    },
    pidStartEpoch: () => 77,
    isAlive: () => false,
    killPid: (pid, sig) => void kills.push([pid, sig]),
    sleepMs: () => {},
    mintGeneration: () => "gen-new",
    ...over,
  };
  return { deps, files, removed, mkdirs, removedDirs, runs, kills };
}

const start = (d: ReturnType<typeof makeDeps>) =>
  startHelpers({ worktree: WT, config: CONFIG }, d.deps);

describe("giveUpSec", () => {
  it("is 17 and 15 minutes at the 10 minute default", () => {
    expect(giveUpSec("gemini-lens", 600)).toBe(1020);
    expect(giveUpSec("gemini-intent-guess", 600)).toBe(900);
  });
});

describe("startHelpers launch", () => {
  it("snapshots the diff, records give-up times and the watchdog, spawns once", () => {
    const d = makeDeps({});
    const s = start(d);
    expect(d.files.get(P.snapshot)).toBe("diff");
    expect(s.diffSnapshot).toBe(P.snapshot);
    expect(s.helpers["gemini-lens"].giveUpAtSec).toBe(1000 + 1020);
    expect(s.helpers["gemini-intent-guess"].giveUpAtSec).toBe(1000 + 900);
    expect(s.watchdog).toEqual({ pid: 4242, pidStartEpoch: 77 });
    expect(d.runs).toHaveLength(1);
    expect(d.runs[0]).toEqual([
      "flow-spawn",
      "--detach",
      "--stdout",
      P.superviseLog,
      "--stderr",
      P.superviseLog,
      "--",
      "flow-review-bg",
      "supervise",
      "--worktree",
      WT,
      "--generation",
      "gen-new",
    ]);
    expect(readReviewBgState(d.files.get(P.state)!)?.watchdog?.pid).toBe(4242);
  });

  it("removes stale envelopes and outputs by exact name and nothing else", () => {
    const d = makeDeps({ [`${P.tmp}/agent-output-bug.json`]: "keep" });
    start(d);
    expect(d.removed.sort()).toEqual(
      [P.lensEnvelope, P.intentEnvelope, P.lensOut, P.intentOut].sort(),
    );
    expect(d.files.get(`${P.tmp}/agent-output-bug.json`)).toBe("keep");
  });

  it("marks both helpers spawn-failed on a non-zero spawn exit", () => {
    const d = makeDeps({}, { run: () => ({ exitCode: 1, stdout: "" }) });
    const s = start(d);
    expect(s.watchdog).toBeNull();
    for (const h of Object.values(s.helpers)) {
      expect(h).toMatchObject({
        status: "skipped",
        skipReason: "spawn-failed",
      });
    }
    expect(d.files.has(P.snapshot)).toBe(false);
    expect(s.diffSnapshot).toBeNull();
    expect(readReviewBgState(d.files.get(P.state)!)?.diffSnapshot).toBeNull();
    expect(d.removedDirs).toEqual([P.scratch]);
  });

  it("keeps a non-empty supervise log when the spawn fails", () => {
    const d = makeDeps(
      { [P.superviseLog]: "boom" },
      { run: () => ({ exitCode: 1, stdout: "" }) },
    );
    d.deps.io.removeDir = () => {
      throw Object.assign(new Error("not empty"), { code: "ENOTEMPTY" });
    };
    start(d);
    expect(d.files.get(P.superviseLog)).toBe("boom");
    expect(d.removed).not.toContain(P.superviseLog);
  });

  const failedSpawnOnRealFs = (
    runBody: (wt: string) => void,
    check: (wt: string, s: ReviewBgState) => void,
  ) => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "flow-review-bg-spawn-"));
    try {
      const tmp = path.join(wt, ".flow-tmp");
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, "diff.txt"), "diff");
      fs.writeFileSync(
        path.join(tmp, "review-scope.json"),
        JSON.stringify({ head_sha: "abc", scope: "full" }),
      );
      const cfg = path.join(wt, "cfg.json");
      fs.writeFileSync(cfg, ENABLED);
      const s = startHelpers(
        { worktree: wt, config: cfg },
        {
          io: realStateIO(),
          nowMs: () => 1_000_000,
          readCooldown: () => ({ live: false }),
          run: () => {
            runBody(wt);
            return { exitCode: 1, stdout: "" };
          },
          pidStartEpoch: () => 77,
          isAlive: () => false,
          killPid: () => {},
          sleepMs: () => {},
          mintGeneration: () => "gen-real",
        },
      );
      check(wt, s);
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  };

  it("keeps a non-empty supervise log and its scratch dir on the real filesystem when the spawn fails", () => {
    failedSpawnOnRealFs(
      (wt) => fs.writeFileSync(bgPaths(wt).superviseLog, "boom"),
      (wt, s) => {
        const bp = bgPaths(wt);
        expect(fs.readFileSync(bp.superviseLog, "utf8")).toBe("boom");
        expect(fs.existsSync(bp.scratch)).toBe(true);
        expect(fs.existsSync(bp.snapshot)).toBe(false);
        for (const h of Object.values(s.helpers)) {
          expect(h).toMatchObject({
            status: "skipped",
            skipReason: "spawn-failed",
          });
        }
      },
    );
  });

  it("removes an empty scratch dir on the real filesystem when the spawn fails", () => {
    failedSpawnOnRealFs(
      () => {},
      (wt, s) => {
        expect(fs.existsSync(bgPaths(wt).scratch)).toBe(false);
        for (const h of Object.values(s.helpers)) {
          expect(h.skipReason).toBe("spawn-failed");
        }
      },
    );
  });
});

describe("startHelpers skips", () => {
  it("writes disabled skips, a state file and spawns nothing when the gate is off", () => {
    const d = makeDeps({ [CONFIG]: "{}" });
    const s = start(d);
    expect(d.runs).toHaveLength(0);
    expect(s.helpers["gemini-lens"].skipReason).toBe("gemini-lens-disabled");
    expect(s.helpers["gemini-intent-guess"].skipReason).toBe(
      "gemini-intent-guess-disabled",
    );
    expect(JSON.parse(d.files.get(P.lensEnvelope)!)).toEqual({
      ran: false,
      skipReason: "gemini-lens-disabled",
      skipClass: "environment",
    });
    expect(d.files.has(P.state)).toBe(true);
    expect(d.mkdirs).not.toContain(P.scratch);
  });

  it("skips both with agy-cooldown while the cooldown is live", () => {
    const d = makeDeps(
      {},
      { readCooldown: () => ({ live: true, until: "x" }) },
    );
    const s = start(d);
    expect(d.runs).toHaveLength(0);
    expect(s.helpers["gemini-lens"].skipReason).toBe("agy-cooldown");
    expect(s.helpers["gemini-intent-guess"].skipReason).toBe("agy-cooldown");
    expect(d.mkdirs).not.toContain(P.scratch);
  });

  it("skips only the intent guess on a delta pass with intent-resolution.json", () => {
    const d = makeDeps({
      [P.reviewScope]: SCOPE("delta"),
      [P.intentResolution]: "{}",
    });
    const s = start(d);
    expect(s.helpers["gemini-intent-guess"].skipReason).toBe(
      "gemini-intent-guess-delta-reentry",
    );
    expect(s.helpers["gemini-lens"].status).toBe("running");
    expect(d.runs).toHaveLength(1);
  });
});

describe("adopt and supersede", () => {
  const running = (gen: string, head: string, scope = "full"): string => {
    const seed = makeDeps({});
    const s = startHelpers(
      { worktree: WT, config: CONFIG },
      {
        ...seed.deps,
        mintGeneration: () => gen,
      },
    );
    return JSON.stringify({ ...s, head_sha: head, scope });
  };

  it("adopts a live watchdog for the same head+scope without deleting output", () => {
    const d = makeDeps(
      {
        [P.state]: running("gen-old", "abc"),
        [P.lensOut]: "finished",
        [P.reviewScope]: JSON.stringify({
          head_sha: "abc",
          scope: "full",
          started_at: "2099-01-01T00:00:00Z",
        }),
      },
      { isAlive: () => true, pidStartEpoch: () => 77 },
    );
    const s = start(d);
    expect(s.generation).toBe("gen-old");
    expect(d.runs).toHaveLength(0);
    expect(d.files.get(P.lensOut)).toBe("finished");
    expect(d.removed).toEqual([]);
  });

  it("signals the old watchdog and waits for it to disappear before relaunching", () => {
    let alive = true;
    const d = makeDeps(
      { [P.state]: running("gen-old", "OLD"), [P.lensOut]: "stale" },
      {
        isAlive: () => alive,
        pidStartEpoch: () => 77,
        killPid: (pid, sig) => {
          expect([pid, sig]).toEqual([4242, "SIGTERM"]);
          alive = false;
        },
      },
    );
    const s = start(d);
    expect(alive).toBe(false);
    expect(s.generation).toBe("gen-new");
    expect(d.files.has(P.lensOut)).toBe(false);
    expect(d.runs).toHaveLength(1);
  });

  it("does not adopt a dead watchdog", () => {
    const d = makeDeps({ [P.state]: running("gen-old", "abc") });
    expect(start(d).generation).toBe("gen-new");
  });
});

describe("ownership-checked writes", () => {
  it("writeIfOwner refuses a foreign generation", () => {
    const d = makeDeps({});
    start(d);
    const wrote = writeIfOwner(
      WT,
      "someone-else",
      (s) => void (s.head_sha = "zzz"),
      d.deps.io,
    );
    expect(wrote).toBeNull();
    expect(ownsState(WT, "someone-else", d.deps.io)).toBe(false);
    expect(ownsState(WT, "gen-new", d.deps.io)).toBe(true);
    expect(readReviewBgState(d.files.get(P.state)!)?.head_sha).toBe("abc");
  });
});

describe("writeSkippedState", () => {
  it("clears stale envelopes and the intent guess output from an earlier pass", () => {
    const { io, files } = makeIO({
      [P.reviewScope]: SCOPE(),
      [P.lensEnvelope]: '{"ran":true}\n',
      [P.intentEnvelope]: '{"ran":true}\n',
      [P.intentOut]: "old",
    });
    writeSkippedState(WT, "gemini-helper-missing", io);
    expect(files.has(P.intentOut)).toBe(false);
    expect(JSON.parse(files.get(P.lensEnvelope)!).skipReason).toBe(
      "gemini-helper-missing",
    );
    expect(JSON.parse(files.get(P.intentEnvelope)!).ran).toBe(false);
  });

  it("writes a both-skipped state and removes agent-output-gemini.json", () => {
    const { io, files } = makeIO({
      [P.reviewScope]: SCOPE(),
      [P.lensOut]: "old",
    });
    const s = writeSkippedState(WT, "gemini-helper-missing", io);
    expect(files.has(P.lensOut)).toBe(false);
    expect(s.head_sha).toBe("abc");
    expect(s.helpers["gemini-lens"].skipReason).toBe("gemini-helper-missing");
    expect(readReviewBgState(files.get(P.state)!)).not.toBeNull();
  });
});

describe("startHelpers diff snapshot", () => {
  it("skips both as gemini-diff-unreadable and spawns nothing when the diff is missing", () => {
    const d = makeDeps({});
    d.files.delete(P.diff);
    const s = start(d);
    expect(d.runs).toHaveLength(0);
    expect(s.diffSnapshot).toBeNull();
    for (const h of Object.values(s.helpers)) {
      expect(h).toMatchObject({
        status: "skipped",
        skipReason: "gemini-diff-unreadable",
        skipClass: "environment",
      });
    }
    expect(JSON.parse(d.files.get(P.lensEnvelope)!).skipReason).toBe(
      "gemini-diff-unreadable",
    );
    expect(d.removedDirs).toContain(P.scratch);
  });
});

describe("resolveGeminiSkip", () => {
  const unawaited = (): ReviewBgState =>
    startHelpers({ worktree: WT, config: CONFIG }, makeDeps({}).deps);
  const base = (): ReviewBgState => ({ ...unawaited(), awaitedAt: 1 });

  it("names gemini-not-launched for no state or a different head", () => {
    expect(resolveGeminiSkip("gemini-lens", null, null, "abc")).toEqual({
      ran: false,
      skip_reason: "gemini-not-launched",
      skip_class: "environment",
    });
    expect(
      resolveGeminiSkip("gemini-lens", base(), null, "other").skip_reason,
    ).toBe("gemini-not-launched");
  });

  it("reports ran:true from a complete envelope", () => {
    expect(
      resolveGeminiSkip("gemini-lens", base(), '{"ran":true}\n', "abc"),
    ).toEqual({ ran: true, skip_reason: null, skip_class: null });
  });

  it("carries the envelope's own skip reason and class", () => {
    expect(
      resolveGeminiSkip(
        "gemini-lens",
        base(),
        '{"ran":false,"skipReason":"lens-timeout","skipClass":"ran-unusable"}',
        "abc",
      ),
    ).toEqual({
      ran: false,
      skip_reason: "lens-timeout",
      skip_class: "ran-unusable",
    });
  });

  it("derives the class via classifyDelegateSkip when the envelope omits it", () => {
    expect(
      resolveGeminiSkip(
        "gemini-lens",
        base(),
        '{"ran":false,"skipReason":"agy-cooldown"}',
        "abc",
      ).skip_class,
    ).toBe("environment");
  });

  it("names gemini-not-awaited while a helper is still running with no envelope", () => {
    expect(
      resolveGeminiSkip("gemini-intent-guess", base(), null, "abc"),
    ).toEqual({
      ran: false,
      skip_reason: "gemini-not-awaited",
      skip_class: "ran-unusable",
    });
  });

  it("names gemini-not-awaited for a launched helper nobody waited on, even with a complete envelope", () => {
    expect(
      resolveGeminiSkip("gemini-lens", unawaited(), '{"ran":true}\n', "abc"),
    ).toEqual({
      ran: false,
      skip_reason: "gemini-not-awaited",
      skip_class: "ran-unusable",
    });
  });

  it("falls back to the state's recorded skip", () => {
    const s = startHelpers(
      { worktree: WT, config: CONFIG },
      makeDeps({ [CONFIG]: "{}" }).deps,
    );
    expect(resolveGeminiSkip("gemini-lens", s, null, "abc").skip_reason).toBe(
      "gemini-lens-disabled",
    );
  });

  it("names helper-exited-without-envelope for a finished helper with no usable envelope", () => {
    const s = base();
    s.helpers["gemini-lens"] = {
      ...s.helpers["gemini-lens"],
      status: "done",
      outcome: "complete",
    };
    const expected = {
      ran: false,
      skip_reason: "helper-exited-without-envelope",
      skip_class: "ran-unusable",
    };
    expect(resolveGeminiSkip("gemini-lens", s, null, "abc")).toEqual(expected);
    expect(resolveGeminiSkip("gemini-lens", s, '{"ran":false}', "abc")).toEqual(
      expected,
    );
  });
});

describe("stopAndClearRun", () => {
  const liveState = (): string => {
    const seed = makeDeps({});
    return JSON.stringify(
      startHelpers({ worktree: WT, config: CONFIG }, seed.deps),
    );
  };

  it("kills a recorded live watchdog before it deletes the state and outputs", () => {
    let alive = true;
    const order: string[] = [];
    const d = makeDeps(
      {
        [P.state]: liveState(),
        [P.lensOut]: "stale",
        [P.snapshot]: "diff",
      },
      {
        isAlive: () => alive,
        pidStartEpoch: () => 77,
        killPid: (pid, sig) => {
          order.push(`kill:${pid}:${sig}:state=${d.files.has(P.state)}`);
          alive = false;
        },
      },
    );
    stopAndClearRun(WT, d.deps);
    expect(order).toEqual(["kill:4242:SIGTERM:state=true"]);
    for (const f of [P.state, P.lensOut, P.snapshot]) {
      expect(d.files.has(f), f).toBe(false);
    }
    expect(d.removedDirs).toContain(P.scratch);
  });

  it("kills nothing when there is no state or no recorded watchdog", () => {
    const none = makeDeps({ [P.lensOut]: "stale" });
    stopAndClearRun(WT, none.deps);
    expect(none.kills).toEqual([]);
    expect(none.files.has(P.lensOut)).toBe(false);

    const state = JSON.parse(liveState());
    state.watchdog = null;
    const noWd = makeDeps({ [P.state]: JSON.stringify(state) });
    stopAndClearRun(WT, noWd.deps);
    expect(noWd.kills).toEqual([]);
    expect(noWd.files.has(P.state)).toBe(false);
  });

  it("writeSkippedState stops a live watchdog before overwriting its state", () => {
    let alive = true;
    const d = makeDeps(
      { [P.state]: liveState() },
      {
        isAlive: () => alive,
        pidStartEpoch: () => 77,
        killPid: () => {
          alive = false;
        },
      },
    );
    const kills: number[] = [];
    const killPid = d.deps.killPid;
    d.deps.killPid = (pid, sig) => {
      kills.push(pid);
      killPid(pid, sig);
    };
    writeSkippedState(
      WT,
      "gemini-helper-missing",
      d.deps.io,
      undefined,
      d.deps,
    );
    expect(kills).toEqual([4242]);
    expect(alive).toBe(false);
    expect(readReviewBgState(d.files.get(P.state)!)?.watchdog).toBeNull();
  });
});

describe("config snapshot", () => {
  const TIMED = JSON.stringify({
    review: { gemini: true },
    delegate: { timeouts: { reviewLens: "3m", intentGuess: "2m" } },
  });

  it("freezes the source text, points state.configPath at it, and ignores later edits", () => {
    const d = makeDeps({ [CONFIG]: TIMED });
    const s = start(d);
    expect(d.files.get(P.configSnapshot)).toBe(TIMED);
    expect(s.configPath).toBe(P.configSnapshot);
    expect(s.configSource).toBe(CONFIG);
    d.files.set(CONFIG, ENABLED);
    expect(d.files.get(P.configSnapshot)).toBe(TIMED);
  });

  it("keeps the caller's path on a skipped run and writes no snapshot", () => {
    const d = makeDeps({ [CONFIG]: JSON.stringify({}) });
    const s = start(d);
    expect(s.configPath).toBe(CONFIG);
    expect(s.configSource).toBe(CONFIG);
    expect(d.files.has(P.configSnapshot)).toBe(false);
  });

  it("removes the snapshot when the spawn fails and when the run is cleared", () => {
    const failed = makeDeps({}, { run: () => ({ exitCode: 1, stdout: "" }) });
    start(failed);
    expect(failed.files.has(P.configSnapshot)).toBe(false);

    const d = makeDeps({});
    start(d);
    expect(d.files.has(P.configSnapshot)).toBe(true);
    stopAndClearRun(WT, d.deps);
    expect(d.files.has(P.configSnapshot)).toBe(false);
  });

  it("supersedes a live same-head run started from a different --config", () => {
    const first = makeDeps({});
    start(first);
    const d = makeDeps(
      { [P.state]: first.files.get(P.state)!, "/other.json": ENABLED },
      { isAlive: () => true, pidStartEpoch: () => 77 },
    );
    const s = startHelpers({ worktree: WT, config: "/other.json" }, d.deps);
    expect(s.generation).toBe("gen-new");
    expect(s.configSource).toBe("/other.json");
    expect(d.kills.length).toBeGreaterThan(0);
    expect(d.runs).toHaveLength(1);
  });
});

describe("watchdog and helpers share one config", () => {
  it("watchdog give-up matches each helper's own --config timeout", async () => {
    const d = makeDeps({
      [CONFIG]: JSON.stringify({
        review: { gemini: true },
        delegate: { timeouts: { reviewLens: "3m", intentGuess: "2m" } },
      }),
    });
    const started = start(d);
    const snapshotText = d.files.get(P.configSnapshot)!;

    // Drive the real supervise loop to record the argv it hands each helper.
    const argvs: string[][] = [];
    await runSupervise(
      { worktree: WT, generation: started.generation },
      {
        io: d.deps.io,
        spawnChild: (argv) => {
          argvs.push(argv);
          return {
            pid: 100 + argvs.length,
            onExit: (cb) => cb(),
            onError: () => {},
          };
        },
        killGroup: () => {},
        groupAlive: () => false,
        nowSec: () => 1000,
        sleep: async () => {},
        onSignal: () => {},
        pollMs: 5000,
        graceMs: 0,
      },
    );
    expect(argvs.map((a) => a[0])).toEqual([
      "flow-gemini-lens",
      "flow-gemini-intent-guess",
    ]);

    const seen: Record<string, string> = {};
    const fakes = (name: string, argv: string[]) => {
      const cfg = argv[argv.indexOf("--config") + 1]!;
      expect(cfg).toBe(started.configPath);
      expect(cfg).toBe(P.configSnapshot);
      return {
        readConfig: (path: string) => {
          expect(path).toBe(P.configSnapshot);
          return snapshotText;
        },
        runDelegate: (a: string[]) => {
          seen[name] = a[a.indexOf("--timeout") + 1]!;
          return { ran: false, skipReason: "agy-not-found" };
        },
        readFile: () => "diff",
        writeFile: () => {},
        removeFile: () => {},
        removeDir: () => {},
        mkdirp: () => {},
        writeOut: () => {},
        fileExists: () => false,
      };
    };
    runLens(
      argvs[0]!.slice(1),
      strictDeps(lensRealDeps(), fakes("gemini-lens", argvs[0]!)),
    );
    runGuess(
      argvs[1]!.slice(1),
      strictDeps(guessRealDeps(), fakes("gemini-intent-guess", argvs[1]!)),
    );

    for (const helper of ["gemini-lens", "gemini-intent-guess"] as const) {
      expect(started.helpers[helper].giveUpAtSec).toBe(
        started.helpers[helper].startedAtSec +
          giveUpSec(helper, godurToSec(seen[helper]!)),
      );
    }
    expect(seen["gemini-lens"]).toBe("3m");
    expect(seen["gemini-intent-guess"]).toBe("2m");
  });
});
