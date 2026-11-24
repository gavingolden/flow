import { describe, expect, it } from "vitest";
import {
  bgPaths,
  giveUpSec,
  ownsState,
  readReviewBgState,
  resolveGeminiSkip,
  startHelpers,
  writeIfOwner,
  writeSkippedState,
  type ReviewBgState,
  type StartDeps,
  type StateIO,
} from "./review-bg";

const WT = "/wt";
const P = bgPaths(WT);
const ENABLED = JSON.stringify({ review: { gemini: true } });
const SCOPE = (scope = "full", head = "abc") =>
  JSON.stringify({ head_sha: head, scope, started_at: "2026-01-01T00:00:00Z" });
const CONFIG = "/cfg.json";

function makeIO(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const removed: string[] = [];
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
    removeDir: () => {},
    mkdirp: () => {},
    fileExists: (p) => files.has(p),
    copyFile: (a, b) => {
      if (!files.has(a)) throw new Error("ENOENT");
      files.set(b, files.get(a)!);
    },
  };
  return { io, files, removed };
}

function makeDeps(seed: Record<string, string>, over: Partial<StartDeps> = {}) {
  const { io, files, removed } = makeIO({
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
  return { deps, files, removed, runs, kills };
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

describe("resolveGeminiSkip", () => {
  const base = (): ReviewBgState =>
    startHelpers({ worktree: WT, config: CONFIG }, makeDeps({}).deps);

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

  it("falls back to the state's recorded skip", () => {
    const s = startHelpers(
      { worktree: WT, config: CONFIG },
      makeDeps({ [CONFIG]: "{}" }).deps,
    );
    expect(resolveGeminiSkip("gemini-lens", s, null, "abc").skip_reason).toBe(
      "gemini-lens-disabled",
    );
  });
});
