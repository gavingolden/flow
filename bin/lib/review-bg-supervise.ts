/**
 * The `flow-review-bg` watchdog: owns the two Gemini helper children, enforces
 * each give-up deadline, and records the outcome in `.flow-tmp/review-bg.json`
 * with no `wait` call involved. Modelled on `agy-guard.ts`: children are
 * spawned via `node:child_process` (not `Bun.spawn`, undefined under vitest)
 * as their own process-group leaders, and signal handlers are registered only
 * inside `runSupervise`.
 *
 * Deliberately never group-kills agy itself: flow-delegate's agy-guard sits
 * outside the helper's group and stops agy when flow-delegate dies.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { rmdirIfEmpty } from "./helper-scratch";
import { GRACE_MS } from "./reap";
import {
  bgPaths,
  BG_HELPERS,
  helperPaths,
  isTrustedConfigPath,
  readReviewBgState,
  realStateIO,
  writeEnvelopeIfOwner,
  writeIfOwner,
  type BgHelper,
  type BgOutcome,
  type ReviewBgState,
  type StateIO,
} from "./review-bg-state";

export type SuperviseChild = {
  pid: number | undefined;
  onExit: (cb: () => void) => void;
  onError: (cb: () => void) => void;
};

export type SuperviseDeps = {
  io: StateIO;
  spawnChild: (
    argv: string[],
    stdoutPath: string,
    stderrPath: string,
  ) => SuperviseChild;
  killGroup: (pid: number, sig: NodeJS.Signals) => void;
  groupAlive: (pid: number) => boolean;
  nowSec: () => number;
  sleep: (ms: number) => Promise<void>;
  onSignal: (sig: NodeJS.Signals, cb: () => void) => void;
  pollMs: number;
  graceMs: number;
};

const HELPER_BIN: Record<BgHelper, string> = {
  "gemini-lens": "flow-gemini-lens",
  "gemini-intent-guess": "flow-gemini-intent-guess",
};
const TIMEOUT_OUTCOME: Record<BgHelper, BgOutcome> = {
  "gemini-lens": "lens-timeout",
  "gemini-intent-guess": "intent-guess-timeout",
};
const HARD_CAP_MARGIN_SEC = 30;
const SIGNAL_EXIT_WAIT_MS = 3000;

export function realSuperviseDeps(): SuperviseDeps {
  return {
    io: realStateIO(),
    spawnChild: (argv, stdoutPath, stderrPath) => {
      const outFd = openSync(stdoutPath, "a", 0o600);
      const errFd = openSync(stderrPath, "a", 0o600);
      try {
        const child = spawn(argv[0]!, argv.slice(1), {
          detached: true,
          stdio: ["ignore", outFd, errFd],
        });
        return {
          pid: child.pid,
          onExit: (cb) => void child.on("exit", cb),
          onError: (cb) => void child.on("error", cb),
        };
      } finally {
        closeSync(outFd);
        closeSync(errFd);
      }
    },
    killGroup: (pid, sig) => {
      try {
        process.kill(-pid, sig);
      } catch {
        // already gone
      }
    },
    groupAlive: (pid) => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    nowSec: () => Math.floor(Date.now() / 1000),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    onSignal: (sig, cb) => void process.on(sig, cb),
    pollMs: 5000,
    graceMs: GRACE_MS,
  };
}

export class SuperviseRefused extends Error {}

export function isCompleteEnvelope(text: string | null): boolean {
  if (text === null || text.length === 0 || !text.endsWith("\n")) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

type Tracked = { child: SuperviseChild; exited: boolean };

export async function runSupervise(
  opts: { worktree: string; generation: string },
  overrides: Partial<SuperviseDeps> = {},
): Promise<ReviewBgState> {
  const deps: SuperviseDeps = { ...realSuperviseDeps(), ...overrides };
  const { io } = deps;
  const { worktree, generation } = opts;
  const paths = bgPaths(worktree);

  const initial = readReviewBgState(io.readFile(paths.state));
  if (initial === null || initial.generation !== generation) {
    throw new SuperviseRefused("no review-bg state for this generation");
  }
  if (!isTrustedConfigPath(worktree, initial.configPath)) {
    throw new SuperviseRefused("state names an untrusted config path");
  }
  const snapshotPath = paths.snapshot;
  const running = BG_HELPERS.filter(
    (h) => initial.helpers[h].status === "running",
  );
  if (running.length === 0) {
    throw new SuperviseRefused("no helper is running in this state");
  }

  const tracked = new Map<BgHelper, Tracked>();
  const resolved = new Set<BgHelper>();
  let lost = false;
  let stopped = false;

  const commit = (
    helper: BgHelper,
    outcome: BgOutcome,
    reason?: string,
  ): void => {
    const s = writeIfOwner(
      worktree,
      generation,
      (st) => {
        const h = st.helpers[helper];
        h.status = "done";
        h.outcome = outcome;
        if (reason !== undefined) {
          h.skipReason = reason;
          h.skipClass = "ran-unusable";
        }
      },
      io,
    );
    if (s === null) lost = true;
    resolved.add(helper);
  };

  const killAll = (sig: NodeJS.Signals): void => {
    for (const t of tracked.values()) {
      if (!t.exited && t.child.pid !== undefined) {
        deps.killGroup(t.child.pid, sig);
      }
    }
  };

  for (const helper of running) {
    const h = { ...initial.helpers[helper], ...helperPaths(worktree, helper) };
    const child = deps.spawnChild(
      [
        HELPER_BIN[helper],
        "--worktree",
        worktree,
        "--diff-file",
        initial.diffSnapshot === null ? paths.diff : snapshotPath,
        "--out",
        h.out,
        "--config",
        initial.configPath,
      ],
      h.envelope,
      h.log,
    );
    const rec: Tracked = { child, exited: false };
    child.onExit(() => void (rec.exited = true));
    child.onError(() => void (rec.exited = true));
    tracked.set(helper, rec);
  }

  const giveUp = async (helper: BgHelper): Promise<void> => {
    const t = tracked.get(helper)!;
    const pid = t.child.pid;
    if (pid !== undefined) {
      deps.killGroup(pid, "SIGTERM");
      await deps.sleep(deps.graceMs);
      if (deps.groupAlive(pid)) deps.killGroup(pid, "SIGKILL");
    }
    const h = helperPaths(worktree, helper);
    if (isCompleteEnvelope(io.readFile(h.envelope))) {
      commit(helper, "complete");
      return;
    }
    const reason = TIMEOUT_OUTCOME[helper];
    io.removeFile(h.out);
    if (
      !writeEnvelopeIfOwner(
        worktree,
        generation,
        h.envelope,
        { ran: false, skipReason: reason, skipClass: "ran-unusable" },
        io,
      )
    ) {
      lost = true;
    }
    commit(helper, reason, reason);
  };

  const mainLoop = async (): Promise<void> => {
    const hardCap =
      Math.max(...running.map((h) => initial.helpers[h].giveUpAtSec ?? 0)) +
      HARD_CAP_MARGIN_SEC;
    while (!stopped && !lost && resolved.size < running.length) {
      const now = deps.nowSec();
      for (const helper of running) {
        if (resolved.has(helper) || stopped || lost) continue;
        const t = tracked.get(helper)!;
        const h = {
          ...initial.helpers[helper],
          ...helperPaths(worktree, helper),
        };
        if (t.exited) {
          if (isCompleteEnvelope(io.readFile(h.envelope))) {
            commit(helper, "complete");
          } else {
            commit(
              helper,
              "helper-exited-without-envelope",
              "helper-exited-without-envelope",
            );
          }
        } else if (h.giveUpAtSec !== null && now >= h.giveUpAtSec) {
          await giveUp(helper);
        } else if (now >= hardCap) {
          await giveUp(helper);
        }
      }
      if (resolved.size < running.length && !stopped && !lost) {
        await deps.sleep(deps.pollMs);
      }
    }
  };

  let trigger: () => void = () => {};
  const stopSignal = new Promise<void>((r) => (trigger = r));
  const stopAll = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    killAll("SIGTERM");
    for (let waited = 0; waited < SIGNAL_EXIT_WAIT_MS; waited += 100) {
      if ([...tracked.values()].every((t) => t.exited)) break;
      await deps.sleep(100);
    }
    for (const t of tracked.values()) {
      if (!t.exited && t.child.pid !== undefined) {
        if (deps.groupAlive(t.child.pid))
          deps.killGroup(t.child.pid, "SIGKILL");
      }
    }
    for (const helper of running) {
      if (!resolved.has(helper)) {
        commit(
          helper,
          "helper-exited-without-envelope",
          "helper-exited-without-envelope",
        );
      }
    }
    trigger();
  };
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    deps.onSignal(sig, () => void stopAll());
  }

  await Promise.race([mainLoop(), stopSignal]);
  if (stopped) await stopSignal;

  if (lost) {
    // A newer generation owns the state: stop our children, touch nothing.
    killAll("SIGTERM");
  } else if (!stopped) {
    const done = readReviewBgState(io.readFile(paths.state));
    io.removeFile(snapshotPath);
    for (const helper of running) {
      if (done?.helpers[helper].outcome === "complete") {
        io.removeFile(helperPaths(worktree, helper).log);
      }
    }
    if (running.every((h) => done?.helpers[h].outcome === "complete")) {
      io.removeFile(paths.superviseLog);
    }
    rmdirIfEmpty(paths.scratch, io.removeDir);
  }
  return readReviewBgState(io.readFile(paths.state)) ?? initial;
}
