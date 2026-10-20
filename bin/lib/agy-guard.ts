#!/usr/bin/env bun
/**
 * Guard process flow-delegate runs in place of a bare `agy`. Usage:
 * `bun agy-guard.ts --deadline-ms <n> -- <cmd> [args...]`.
 *
 * flow-delegate starts the guard detached, so it leads its own session
 * outside the caller's process group; the guard then starts `<cmd>` in a
 * second new group and stops that whole group on every exit path (command
 * exit, deadline, signal, caller gone). agy forks helpers that outlive it,
 * so waiting on the one pid is not enough.
 *
 * `node:child_process.spawn` (not `Bun.spawn`) so the core runs under
 * vitest, where `Bun.spawn` is undefined. Signal handlers and the parent
 * watch are registered only inside `runGuard`: `agy-strays` imports
 * `DEADLINE_GRACE_MS` from here, and `flow reap` / `flow doctor` load it.
 */

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { writeSync } from "node:fs";
import { pidStartEpoch } from "./liveness";
import { startParentWatch } from "./parent-watch";

export const GUARD_DEADLINE_EXIT = 124;
export const GUARD_SPAWN_FAILED_EXIT = 127;
export const DEADLINE_GRACE_MS = 30_000;
export const KILL_GRACE_MS = 5_000;

export const GUARD_DEADLINE_MARKER =
  "flow-agy-guard: agy ran past its --print-timeout plus grace; stopped its process group";
export const GUARD_LEFTOVER_MARKER =
  "flow-agy-guard: agy exited but left helper processes running; stopped them";
export const GUARD_SPAWN_FAILED_MARKER = "flow-agy-guard: could not start agy";

export type GuardDeps = {
  spawnDetached: (
    cmd: string,
    args: string[],
  ) => {
    pid: number | undefined;
    onExit: (
      cb: (code: number | null, signal: NodeJS.Signals | null) => void,
    ) => void;
    onError: (cb: (e: Error) => void) => void;
  };
  killGroup: (pgid: number, signal: NodeJS.Signals | 0) => boolean;
  parentPid: number;
  parentStartEpoch: number | null;
  startParentWatch: typeof startParentWatch;
  writeErr: (line: string) => void;
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
  onSignal: (sig: NodeJS.Signals, cb: () => void) => void;
};

export function parseGuardArgs(
  argv: string[],
): { deadlineMs: number; command: string[] } | { error: string } {
  const usage = "usage: agy-guard --deadline-ms <n> -- <cmd> [args...]";
  if (argv[0] !== "--deadline-ms") return { error: usage };
  const raw = argv[1] ?? "";
  const deadlineMs = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs <= 0
  )
    return { error: `${usage} (bad --deadline-ms)` };
  if (argv[2] !== "--" || argv.length < 4) return { error: usage };
  return { deadlineMs, command: argv.slice(3) };
}

function realSpawnDetached(cmd: string, args: string[]) {
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  return {
    pid: child.pid,
    onExit: (
      cb: (code: number | null, signal: NodeJS.Signals | null) => void,
    ) => {
      child.on("exit", cb);
    },
    onError: (cb: (e: Error) => void) => {
      child.on("error", cb);
    },
  };
}

function realKillGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function realWriteErr(line: string): void {
  writeSync(2, `${line}\n`);
}

const GUARD_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export function runGuard(
  argv: string[],
  deps: Partial<GuardDeps> = {},
): Promise<number> {
  const parsed = parseGuardArgs(argv);
  const writeErr = (line: string): void => {
    try {
      (deps.writeErr ?? realWriteErr)(line);
    } catch {
      // EPIPE: the reader is gone; the group must still be stopped.
    }
  };
  if ("error" in parsed) {
    writeErr(parsed.error);
    return Promise.resolve(2);
  }

  const parentPid = deps.parentPid ?? process.ppid;
  const d: GuardDeps = {
    spawnDetached: deps.spawnDetached ?? realSpawnDetached,
    killGroup: deps.killGroup ?? realKillGroup,
    parentPid,
    parentStartEpoch:
      deps.parentStartEpoch !== undefined
        ? deps.parentStartEpoch
        : pidStartEpoch(parentPid),
    startParentWatch: deps.startParentWatch ?? startParentWatch,
    writeErr,
    setTimeoutFn: deps.setTimeoutFn ?? setTimeout,
    clearTimeoutFn: deps.clearTimeoutFn ?? clearTimeout,
    onSignal: deps.onSignal ?? ((sig, cb) => void process.on(sig, cb)),
  };

  return new Promise<number>((resolve) => {
    const [cmd, ...args] = parsed.command;
    const child = d.spawnDetached(cmd, args);
    const pgid = child.pid;
    let settled = false;
    let stopping = false;
    let stopWatch: () => void = () => {};
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    const kill = (sig: NodeJS.Signals): boolean =>
      pgid === undefined ? false : d.killGroup(pgid, sig);

    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== undefined) d.clearTimeoutFn(deadlineTimer);
      stopWatch();
      resolve(code);
    };

    // Polite stop, then a forced kill of the whole group after the grace.
    const stopGroup = (code: number, afterKill?: () => void): void => {
      if (settled || stopping) return;
      stopping = true;
      if (deadlineTimer !== undefined) d.clearTimeoutFn(deadlineTimer);
      stopWatch();
      kill("SIGTERM");
      d.setTimeoutFn(() => {
        kill("SIGKILL");
        afterKill?.();
        settle(code);
      }, KILL_GRACE_MS);
    };

    child.onError((e) => {
      if (settled) return;
      d.writeErr(`${GUARD_SPAWN_FAILED_MARKER}: ${e.message}`);
      settle(GUARD_SPAWN_FAILED_EXIT);
    });

    child.onExit((code, signal) => {
      if (settled || stopping) return;
      // Group members remaining after agy's own exit are leaked helpers.
      if (pgid !== undefined && d.killGroup(pgid, 0)) {
        kill("SIGKILL");
        d.writeErr(GUARD_LEFTOVER_MARKER);
      }
      const sigNum = signal ? osConstants.signals[signal] : undefined;
      settle(code ?? (sigNum !== undefined ? 128 + sigNum : 1));
    });

    if (settled) return;

    deadlineTimer = d.setTimeoutFn(
      () =>
        stopGroup(GUARD_DEADLINE_EXIT, () => d.writeErr(GUARD_DEADLINE_MARKER)),
      parsed.deadlineMs,
    );

    for (const sig of GUARD_SIGNALS) {
      d.onSignal(sig, () => stopGroup(128 + osConstants.signals[sig]));
    }

    // Caller gone: nothing is written, the reader of our stderr is gone too.
    stopWatch = d.startParentWatch({
      parentPid: d.parentPid,
      parentStartEpoch: d.parentStartEpoch,
      onGone: () => stopGroup(1),
    });
  });
}

if (import.meta.main) {
  process.exit(await runGuard(process.argv.slice(2)));
}
