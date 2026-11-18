#!/usr/bin/env bun
/**
 * Bounded generic waiter: every wait ends. Polls a pipeline's phase and/or a
 * condition command until it is met, the pipeline or window disappears, or
 * `--max-sec` passes. Replaces hand-rolled `until …; do sleep; done` loops,
 * which outlive their session when nothing bounds them.
 *
 * Usage:
 *   flow-wait --max-sec <1-28800> [--every <s=15>] [--state <slug> [--phase <p>[,<p>…]]]
 *             [--window @<id>] [-- <condition command…>]
 *
 * Exit codes: 0 met, 2 bad args, 3 timeout, 4 state-gone, 5 window-gone,
 * 6 phase-terminal, 7 parent-gone. Always prints one final JSON line
 * `{"outcome","elapsedSec","phase"?}` (a signalled run exits 128+signal and
 * only stops its condition's process group).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { pidStartEpoch } from "./lib/liveness";
import { pidExists, readPpid } from "./lib/parent-watch";
import { GRACE_MS } from "./lib/reap";
import { readState, statePath } from "./lib/state";
import { windowIdExists } from "./lib/tmux";
import {
  EXIT_CODES,
  owningClaude,
  ownerGone,
  parseWaitArgs,
  runWait,
  WAIT_USAGE,
  type GenericWaitDeps,
} from "./lib/wait-loop";
import { listOrphanProcs } from "./lib/worktree-orphans-ps";

const HELP = `${WAIT_USAGE}

The condition runs via sh -c (one argument is a shell string; several are an
argv) with stdin from /dev/null, at most 60 s per check.`;

const CONDITION_TIMEOUT_MS = 60_000;

let activeGroup: number | null = null;

function killGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // already gone
  }
}

function runConditionOnce(condition: string[]): Promise<boolean> {
  const argv =
    condition.length === 1
      ? ["-c", condition[0]]
      : ["-c", 'exec "$@"', "sh", ...condition];
  return new Promise((resolve) => {
    const child = spawn("sh", argv, { stdio: "ignore", detached: true });
    const pgid = child.pid;
    if (pgid === undefined) return resolve(false);
    activeGroup = pgid;
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeGroup = null;
      // A passing condition may still have left grandchildren behind.
      killGroup(pgid, "SIGTERM");
      resolve(ok);
    };
    const timer = setTimeout(() => {
      killGroup(pgid, "SIGTERM");
      setTimeout(() => killGroup(pgid, "SIGKILL"), GRACE_MS).unref();
      finish(false);
    }, CONDITION_TIMEOUT_MS);
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
}

function defaultDeps(): GenericWaitDeps {
  const procs = listOrphanProcs();
  const owner = procs ? owningClaude(process.pid, procs, pidStartEpoch) : null;
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    readState: (slug) => {
      if (!fs.existsSync(statePath(slug))) return { exists: false };
      return { exists: true, phase: readState(slug)?.phase };
    },
    // `--window` is a caller-supplied watch target, not flow-owned tmux state;
    // windowIdExists answers true when tmux is absent, so that degrades to
    // "keep waiting", never "gone".
    windowGone: (id) => !windowIdExists(id),
    runCondition: runConditionOnce,
    parentGone: () =>
      ownerGone(owner, {
        alive: pidExists,
        startEpochOf: pidStartEpoch,
        parentPid: () => readPpid(process.pid),
      }),
  };
}

export async function run(
  argv: string[],
  deps: GenericWaitDeps = defaultDeps(),
): Promise<number> {
  const parsed = parseWaitArgs(argv);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      console.log(HELP);
      return 0;
    }
    console.error(`flow-wait: ${parsed.error}`);
    console.error(WAIT_USAGE);
    return 2;
  }
  const result = await runWait(parsed, deps);
  console.log(JSON.stringify(result));
  return EXIT_CODES[result.outcome];
}

if (import.meta.main) {
  for (const [sig, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    process.once(sig, () => {
      if (activeGroup !== null) killGroup(activeGroup, "SIGTERM");
      process.exit(code);
    });
  }
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
