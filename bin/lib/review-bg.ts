/**
 * `flow-review-bg start`: launch the two Gemini review helpers (lens + intent
 * guess) behind one detached watchdog and record the run in
 * `.flow-tmp/review-bg.json`. Pure core with injected deps — no `Bun.spawn`
 * (undefined under vitest); the real seams use `node:child_process`, resolved
 * lazily so importing this module has no side effect.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { isGeminiLensEnabled } from "../flow-gemini-lens";
import { readCooldown as realReadCooldown } from "./agy-cooldown";
import { godurToSec, resolveDelegateTimeout } from "./delegate-timeouts";
import type { SkipClass } from "./delegate-skip-class";
import { pidStartEpoch as realPidStartEpoch } from "./liveness";
import {
  bgPaths,
  giveUpSec,
  readReviewBgState,
  readScope,
  realStateIO,
  watchdogLiveness,
  writeAtomic,
  writeIfOwner,
  writeReviewBgState,
  type BgHelper,
  type BgHelperState,
  type ReviewBgState,
  type StateIO,
} from "./review-bg-state";

export * from "./review-bg-state";

export type StartDeps = {
  io: StateIO;
  nowMs: () => number;
  readCooldown: () => { live: boolean; until?: string };
  // Launches argv with stdin ignored and a hard timeout; exitCode -1 on error.
  run: (
    argv: string[],
    timeoutMs: number,
  ) => { exitCode: number; stdout: string };
  pidStartEpoch: (pid: number) => number | null;
  isAlive?: (pid: number) => boolean;
  killPid: (pid: number, sig: NodeJS.Signals) => void;
  sleepMs: (ms: number) => void;
  mintGeneration: () => string;
};

export function realStartDeps(): StartDeps {
  return {
    io: realStateIO(),
    nowMs: () => Date.now(),
    readCooldown: () => realReadCooldown(),
    run: (argv, timeoutMs) => {
      const r = spawnSync(argv[0]!, argv.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        encoding: "utf8",
      });
      return { exitCode: r.status ?? -1, stdout: r.stdout ?? "" };
    },
    pidStartEpoch: (pid) => realPidStartEpoch(pid),
    killPid: (pid, sig) => process.kill(pid, sig),
    sleepMs: (ms) =>
      void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    mintGeneration: () => randomUUID(),
  };
}

const SUPERSEDE_WAIT_MS = 6000;
const SKIP_ENVIRONMENT: SkipClass = "environment";

function emptyHelper(
  startedAtSec: number,
  envelope: string,
  out: string,
  log: string,
): BgHelperState {
  return {
    status: "running",
    startedAtSec,
    giveUpAtSec: null,
    envelope,
    out,
    log,
    outcome: "pending",
  };
}

function skipHelper(
  h: BgHelperState,
  reason: string,
  io: StateIO,
  skipClass: SkipClass = SKIP_ENVIRONMENT,
): void {
  h.status = "skipped";
  h.outcome = "skipped";
  h.giveUpAtSec = null;
  h.skipReason = reason;
  h.skipClass = skipClass;
  writeAtomic(
    io,
    h.envelope,
    `${JSON.stringify({ ran: false, skipReason: reason, skipClass })}\n`,
  );
}

function clearStale(worktree: string, io: StateIO): void {
  const p = bgPaths(worktree);
  for (const f of [p.lensEnvelope, p.intentEnvelope, p.lensOut, p.intentOut]) {
    io.removeFile(f);
  }
}

function supersede(old: ReviewBgState, deps: StartDeps): void {
  const wd = old.watchdog;
  if (
    wd === null ||
    watchdogLiveness(wd, deps.isAlive, deps.pidStartEpoch) !== "alive"
  ) {
    return;
  }
  try {
    deps.killPid(wd.pid, "SIGTERM");
  } catch {
    return;
  }
  for (let waited = 0; waited < SUPERSEDE_WAIT_MS; waited += 200) {
    if (watchdogLiveness(wd, deps.isAlive, deps.pidStartEpoch) !== "alive") {
      return;
    }
    deps.sleepMs(200);
  }
}

export function startHelpers(
  opts: { worktree: string; config?: string },
  deps: StartDeps = realStartDeps(),
): ReviewBgState {
  const { worktree } = opts;
  const { io } = deps;
  const p = bgPaths(worktree);
  const configPath = opts.config ?? `${homedir()}/.flow/config.json`;
  const scope = readScope(io, worktree);

  const existing = readReviewBgState(io.readFile(p.state));
  if (existing !== null) {
    const sameKey =
      existing.head_sha === scope.head_sha && existing.scope === scope.scope;
    const live =
      watchdogLiveness(existing.watchdog, deps.isAlive, deps.pidStartEpoch) ===
      "alive";
    if (sameKey && live) return existing;
    if (live) supersede(existing, deps);
  }

  clearStale(worktree, io);
  io.mkdirp(p.scratch);
  const startedAtSec = Math.floor(deps.nowMs() / 1000);
  const state: ReviewBgState = {
    version: 1,
    generation: deps.mintGeneration(),
    head_sha: scope.head_sha,
    scope: scope.scope,
    review_started_at: scope.started,
    configPath,
    watchdog: null,
    diffSnapshot: null,
    helpers: {
      "gemini-lens": emptyHelper(
        startedAtSec,
        p.lensEnvelope,
        p.lensOut,
        p.lensLog,
      ),
      "gemini-intent-guess": emptyHelper(
        startedAtSec,
        p.intentEnvelope,
        p.intentOut,
        p.intentLog,
      ),
    },
  };
  const lens = state.helpers["gemini-lens"];
  const guess = state.helpers["gemini-intent-guess"];
  const skipBoth = (reason: string) => {
    skipHelper(lens, reason, io);
    skipHelper(guess, reason, io);
    writeReviewBgState(worktree, state, io);
    return state;
  };

  let rawConfig = "";
  try {
    rawConfig = io.readFile(configPath) ?? "";
  } catch {
    rawConfig = "";
  }
  if (!isGeminiLensEnabled(rawConfig)) {
    skipHelper(lens, "gemini-lens-disabled", io);
    skipHelper(guess, "gemini-intent-guess-disabled", io);
    writeReviewBgState(worktree, state, io);
    return state;
  }
  const cooldown = deps.readCooldown();
  if (cooldown.live) return skipBoth("agy-cooldown");

  if (scope.scope === "delta" && io.fileExists(p.intentResolution)) {
    skipHelper(guess, "gemini-intent-guess-delta-reentry", io);
  }

  try {
    io.copyFile(p.diff, p.snapshot);
  } catch {
    return skipBoth("gemini-diff-unreadable");
  }
  state.diffSnapshot = p.snapshot;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    parsed = undefined;
  }
  const reader = () => parsed;
  const timeoutOf = (surface: "reviewLens" | "intentGuess") =>
    godurToSec(resolveDelegateTimeout(surface, reader));
  lens.giveUpAtSec =
    startedAtSec + giveUpSec("gemini-lens", timeoutOf("reviewLens"));
  if (guess.status === "running") {
    guess.giveUpAtSec =
      startedAtSec + giveUpSec("gemini-intent-guess", timeoutOf("intentGuess"));
  }
  writeReviewBgState(worktree, state, io);

  const r = deps.run(
    [
      "flow-spawn",
      "--detach",
      "--stdout",
      p.superviseLog,
      "--stderr",
      p.superviseLog,
      "--",
      "flow-review-bg",
      "supervise",
      "--worktree",
      worktree,
      "--generation",
      state.generation,
    ],
    30_000,
  );
  const pid = Number.parseInt(r.stdout.trim().split("\n").pop() ?? "", 10);
  if (r.exitCode !== 0 || !Number.isInteger(pid) || pid <= 0) {
    const failed = (h: BgHelperState) => {
      if (h.status === "running") skipHelper(h, "spawn-failed", io);
    };
    failed(lens);
    failed(guess);
    writeReviewBgState(worktree, state, io);
    return state;
  }
  const wd = { pid, pidStartEpoch: deps.pidStartEpoch(pid) };
  return (
    writeIfOwner(
      worktree,
      state.generation,
      (s) => void (s.watchdog = wd),
      io,
    ) ?? state
  );
}

export function writeSkippedState(
  worktree: string,
  reason: string,
  io: StateIO = realStateIO(),
  now: () => number = Date.now,
): ReviewBgState {
  const p = bgPaths(worktree);
  const scope = readScope(io, worktree);
  io.removeFile(p.lensOut);
  const t = Math.floor(now() / 1000);
  const mk = (envelope: string, out: string, log: string) => {
    const h = emptyHelper(t, envelope, out, log);
    h.status = "skipped";
    h.outcome = "skipped";
    h.skipReason = reason;
    h.skipClass = SKIP_ENVIRONMENT;
    return h;
  };
  const state: ReviewBgState = {
    version: 1,
    generation: randomUUID(),
    head_sha: scope.head_sha,
    scope: scope.scope,
    review_started_at: scope.started,
    configPath: "",
    watchdog: null,
    diffSnapshot: null,
    helpers: {
      "gemini-lens": mk(p.lensEnvelope, p.lensOut, p.lensLog),
      "gemini-intent-guess": mk(p.intentEnvelope, p.intentOut, p.intentLog),
    },
  };
  io.mkdirp(p.tmp);
  writeReviewBgState(worktree, state, io);
  return state;
}
