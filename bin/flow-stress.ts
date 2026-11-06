#!/usr/bin/env bun
/**
 * `flow-stress --cpu <n> [--max-sec <s>] -- <cmd> [args…]` — run a command
 * under CPU contention and ALWAYS remove the load afterwards.
 *
 * The burners live in one fresh process group (a detached `__burn` leader
 * that spawns its siblings into the same group); the command runs in its own
 * group with inherited stdio. On command exit, `--max-sec` timeout, or
 * SIGINT/SIGTERM/SIGHUP both groups get SIGTERM, then SIGKILL after the
 * reaper's grace. Each burner also stops on its own at the deadline and as
 * soon as this process is gone, so a SIGKILLed helper cannot leak load.
 *
 * Exit: the command's code; 124 on timeout; 128+signo on a signal; 2 on a
 * usage error; 127 when the command cannot be started.
 *
 * Parent death is detected with `process.kill(parentPid, 0)`, never
 * `process.ppid`: Bun caches ppid and never updates it after the parent dies.
 */

import * as os from "node:os";
import { GRACE_MS } from "./lib/reap";

export const MAX_SEC_DEFAULT = 600;
export const MAX_SEC_CAP = 3600;

const USAGE = "usage: flow-stress --cpu <n> [--max-sec <s>] -- <cmd> [args…]";
const BURN_SLICE_MS = 200;

export type StressArgs = { cpu: number; maxSec: number; cmd: string[] };

function intFlag(name: string, raw: string | undefined): number | string {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return `${name} needs a whole number (got: ${raw ?? "nothing"})`;
  }
  return Number(raw);
}

export function parseStressArgs(
  argv: string[],
  cores: number,
): StressArgs | { usageError: string } {
  const sep = argv.indexOf("--");
  if (sep === -1 || sep === argv.length - 1) {
    return { usageError: `a command after -- is required\n${USAGE}` };
  }
  const flags = argv.slice(0, sep);
  let cpu: number | undefined;
  let maxSec = MAX_SEC_DEFAULT;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f !== "--cpu" && f !== "--max-sec") {
      return { usageError: `unknown argument: ${f}\n${USAGE}` };
    }
    const v = intFlag(f, flags[++i]);
    if (typeof v === "string") return { usageError: `${v}\n${USAGE}` };
    if (f === "--cpu") cpu = v;
    else maxSec = v;
  }
  if (cpu === undefined) return { usageError: `--cpu is required\n${USAGE}` };
  if (cpu < 1 || cpu > cores) {
    return { usageError: `--cpu must be between 1 and ${cores} (cores)` };
  }
  if (maxSec < 1 || maxSec > MAX_SEC_CAP) {
    return { usageError: `--max-sec must be between 1 and ${MAX_SEC_CAP}` };
  }
  return { cpu, maxSec, cmd: argv.slice(sep + 1) };
}

export function shouldStopBurning(s: {
  nowMs: number;
  deadlineMs: number;
  parentAlive: boolean;
}): boolean {
  return !s.parentAlive || s.nowMs >= s.deadlineMs;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function groupAlive(pgid: number): boolean {
  return pidAlive(-pgid);
}

function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // already gone
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function terminateGroup(pgid: number): Promise<void> {
  signalGroup(pgid, "SIGTERM");
  for (let waited = 0; waited < GRACE_MS && groupAlive(pgid); waited += 50) {
    await sleep(50);
  }
  if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL");
}

function selfArgv(extra: string[]): string[] {
  return [process.execPath, process.argv[1], "__burn", ...extra];
}

async function burn(
  parentPid: number,
  deadlineMs: number,
  count: number,
): Promise<number> {
  const kids = Array.from({ length: count - 1 }, () =>
    Bun.spawn(selfArgv([String(parentPid), String(deadlineMs), "1"]), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
  for (;;) {
    const sliceEnd = Date.now() + BURN_SLICE_MS;
    while (Date.now() < sliceEnd) {
      // busy
    }
    if (
      shouldStopBurning({
        nowMs: Date.now(),
        deadlineMs,
        parentAlive: pidAlive(parentPid),
      })
    ) {
      break;
    }
  }
  for (const k of kids) k.kill();
  return 0;
}

const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const;

async function runStress(args: StressArgs): Promise<number> {
  const deadlineMs = Date.now() + args.maxSec * 1000;
  const burner = Bun.spawn(
    selfArgv([String(process.pid), String(deadlineMs), String(args.cpu)]),
    { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  let cmd: ReturnType<typeof Bun.spawn>;
  try {
    cmd = Bun.spawn(args.cmd, {
      detached: true,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (e) {
    process.stderr.write(`flow-stress: cannot start ${args.cmd[0]}: ${e}\n`);
    await terminateGroup(burner.pid);
    return 127;
  }

  let override: number | null = null;
  const stopCmd = (code: number): void => {
    if (override === null) override = code;
    void terminateGroup(burner.pid);
    void terminateGroup(cmd.pid);
  };
  for (const [name, signo] of Object.entries(SIGNALS)) {
    process.on(name as NodeJS.Signals, () => stopCmd(128 + signo));
  }
  const timer = setTimeout(() => stopCmd(124), args.maxSec * 1000);

  const exitCode = await cmd.exited;
  clearTimeout(timer);
  await Promise.all([terminateGroup(burner.pid), terminateGroup(cmd.pid)]);
  if (override !== null) return override;
  return cmd.signalCode
    ? 128 + (os.constants.signals[cmd.signalCode] ?? 0)
    : exitCode;
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === "__burn") {
    return burn(Number(argv[1]), Number(argv[2]), Number(argv[3]));
  }
  const parsed = parseStressArgs(argv, os.cpus().length);
  if ("usageError" in parsed) {
    process.stderr.write(`flow-stress: ${parsed.usageError}\n`);
    return 2;
  }
  return runStress(parsed);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
