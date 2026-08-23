#!/usr/bin/env bun
/**
 * Dumb, bounded, restartable waiter. Owns ZERO state and ZERO decisions —
 * it only sleeps. Spawns `gh pr checks <PR> --watch --interval <interval>`
 * (discarding its output), races it against `--max-sec`, then sleeps until
 * `--min-sec` has elapsed since start, and always exits 0. A non-zero
 * `gh pr checks --watch` exit is treated as "still waiting", not a
 * failure — the caller re-derives the real verdict by re-running
 * `flow-ci-check` afterward, never from this process's exit code.
 *
 * "Restartable" means concretely: this process carries no durable state,
 * so killing it at any instant (SIGTERM/SIGINT, or the harness reclaiming
 * a backgrounded slot) loses nothing — the supervisor simply re-arms it.
 * The decision matrix and the wall-clock anchors that make a suspended
 * wait immune to fabricating `ci-hang` live entirely in `flow-ci-check.ts`
 * / `~/.flow/state/<slug>.json`, not here.
 *
 * `--max-sec` defaults to 540 so every invocation exits inside the Bash
 * tool's 600s background-run ceiling even under that interpretation; the
 * supervisor simply re-arms on the next wake.
 *
 * Usage:
 *   flow-ci-wait <PR> [--min-sec <n=60>] [--max-sec <n=540>] [--interval <n=60>]
 *
 * Exit codes:
 *   0 — always (the watch finished, timed out, or errored — all "done waiting")
 *   2 — bad CLI args
 */

import { registrySelfCheck } from "./lib/ci-observe";

const HELP =
  "usage: flow-ci-wait <PR> [--min-sec <n=60>] [--max-sec <n=540>] [--interval <n=60>]";

export type WaitArgs = {
  pr: number;
  minSec: number;
  maxSec: number;
  intervalSec: number;
};

export function parseArgs(argv: string[]): WaitArgs | { error: string } {
  if (argv.length === 0) return { error: "PR number is required" };
  if (argv.includes("--help") || argv.includes("-h")) return { error: "help" };
  const [first, ...rest] = argv;
  if (first.startsWith("--")) {
    return { error: "PR number must be the first positional argument" };
  }
  const pr = Number.parseInt(first, 10);
  if (!Number.isFinite(pr) || pr <= 0 || String(pr) !== first) {
    return { error: `PR must be a positive integer, got '${first}'` };
  }
  const out: WaitArgs = { pr, minSec: 60, maxSec: 540, intervalSec: 60 };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    const parsePositiveInt = (name: string): number | { error: string } => {
      if (!value) return { error: `${name} requires a value` };
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0 || String(n) !== value) {
        return { error: `${name} must be a positive integer, got '${value}'` };
      }
      return n;
    };
    switch (flag) {
      case "--min-sec": {
        const n = parsePositiveInt("--min-sec");
        if (typeof n !== "number") return n;
        out.minSec = n;
        i++;
        continue;
      }
      case "--max-sec": {
        const n = parsePositiveInt("--max-sec");
        if (typeof n !== "number") return n;
        out.maxSec = n;
        i++;
        continue;
      }
      case "--interval": {
        const n = parsePositiveInt("--interval");
        if (typeof n !== "number") return n;
        out.intervalSec = n;
        i++;
        continue;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  return out;
}

export type Deps = {
  spawnWatch?: (
    pr: number,
    intervalSec: number,
  ) => { exited: Promise<number>; kill: () => void };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

function defaultSpawnWatch(
  pr: number,
  intervalSec: number,
): { exited: Promise<number>; kill: () => void } {
  const proc = Bun.spawn(
    [
      "gh",
      "pr",
      "checks",
      String(pr),
      "--watch",
      "--interval",
      String(intervalSec),
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  return {
    exited: proc.exited,
    kill: () => {
      try {
        proc.kill();
      } catch {
        // best-effort — the process may already be gone.
      }
    },
  };
}

export async function run(argv: string[], deps: Deps = {}): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      console.log(HELP);
      return 0;
    }
    console.error(`flow-ci-wait: ${parsed.error}`);
    console.error(HELP);
    return 2;
  }

  const registryWarning = registrySelfCheck();
  if (registryWarning !== null) {
    process.stderr.write(`flow-ci-wait: ${registryWarning}\n`);
  }

  const spawnWatch = deps.spawnWatch ?? defaultSpawnWatch;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  const startMs = now();
  const child = spawnWatch(parsed.pr, parsed.intervalSec);

  let killed = false;
  const killOnce = (): void => {
    if (killed) return;
    killed = true;
    child.kill();
  };
  // A signal is an explicit "stop now" — killing the child at any instant
  // loses nothing (the supervisor simply re-arms it), so a signal must exit
  // promptly rather than still sleeping out the --min-sec floor below.
  // `once` (not `on`) is intentional: the first signal kills the child and
  // skips the floor; a second signal during teardown falls through to the
  // platform default.
  let signaled = false;
  const onSignal = (): void => {
    signaled = true;
    killOnce();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  try {
    await Promise.race([
      child.exited,
      sleep(parsed.maxSec * 1000).then(() => killOnce()),
    ]);
    // Every exit path — the watch finished on its own, or the max-sec race
    // fired — must guarantee the child is gone before this process returns.
    killOnce();
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }

  if (signaled) return 0;

  const elapsedMs = now() - startMs;
  const remainMs = parsed.minSec * 1000 - elapsedMs;
  if (remainMs > 0) await sleep(remainMs);

  return 0;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
