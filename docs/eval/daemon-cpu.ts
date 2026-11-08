#!/usr/bin/env bun
/**
 * CPU-seconds each macOS daemon spends while a command runs.
 *
 *   bun docs/eval/daemon-cpu.ts [--repeat N] [--control] [--label L] -- <cmd...>
 *
 * Samples cumulative CPU time of the daemons in DAEMONS before and after the
 * command. `--control` then sleeps the same wall time and samples again; the
 * reported `net` is the run delta minus that idle delta, so background daemon
 * work on a loaded host cancels out. stdout is one JSON object; the command's
 * own output goes to stderr.
 */
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { parseDurationSec } from "../../bin/lib/worktree-orphans-ps";

export const DAEMONS = [
  "syspolicyd",
  "fseventsd",
  "mds",
  "mds_stores",
  "kernel_task",
  "launchservicesd",
] as const;
export type Daemon = (typeof DAEMONS)[number];
export type DaemonSample = { daemon: Daemon; pid: number; cpuSec: number };
type PerDaemon = Record<Daemon, number>;

export function parsePsTime(s: string): number {
  const sec = parseDurationSec(s);
  if (sec === null) throw new Error(`unparseable ps time: ${s}`);
  return sec;
}

export function parsePsOutput(stdout: string): DaemonSample[] {
  const out: DaemonSample[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const base = path.basename(m[3]);
    const daemon = DAEMONS.find((d) => d === base);
    if (!daemon) continue;
    out.push({ daemon, pid: Number(m[1]), cpuSec: parsePsTime(m[2]) });
  }
  return out;
}

export function parseTopKernelTask(stdout: string): DaemonSample | null {
  for (const line of stdout.split("\n")) {
    const m = /^\s*0\s+(\S+)\s*$/.exec(line);
    const cpuSec = m ? parseDurationSec(m[1]) : null;
    if (cpuSec !== null) return { daemon: "kernel_task", pid: 0, cpuSec };
  }
  return null;
}

function zeroed(): PerDaemon {
  return Object.fromEntries(DAEMONS.map((d) => [d, 0])) as PerDaemon;
}

export function diffSamples(
  before: DaemonSample[],
  after: DaemonSample[],
): { net: PerDaemon; pidExited: boolean } {
  const net = zeroed();
  const prior = new Map(before.map((s) => [`${s.daemon}:${s.pid}`, s.cpuSec]));
  const seen = new Set<string>();
  for (const s of after) {
    const key = `${s.daemon}:${s.pid}`;
    seen.add(key);
    net[s.daemon] += Math.max(0, s.cpuSec - (prior.get(key) ?? 0));
  }
  const pidExited = [...prior.keys()].some((k) => !seen.has(k));
  return { net, pidExited };
}

export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error("median of empty list");
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function sampleDaemons(): DaemonSample[] {
  const ps = spawnSync("ps", ["-A", "-o", "pid=,time=,comm="], {
    encoding: "utf8",
  });
  if (ps.status !== 0) throw new Error(`ps failed: ${ps.stderr}`);
  const samples = parsePsOutput(ps.stdout);
  const top = spawnSync("top", ["-l", "1", "-pid", "0", "-stats", "pid,time"], {
    encoding: "utf8",
  });
  const kernel = top.status === 0 ? parseTopKernelTask(top.stdout) : null;
  return kernel ? [...samples, kernel] : samples;
}

type Deps = {
  platform?: NodeJS.Platform;
  sample?: () => DaemonSample[];
  spawn?: (cmd: string[]) => number;
  sleep?: (sec: number) => void;
  now?: () => number;
  loadAvg1?: () => number;
  write?: (s: string) => void;
};

function parseArgs(argv: string[]) {
  const sep = argv.indexOf("--");
  const flags = sep === -1 ? argv : argv.slice(0, sep);
  const cmd = sep === -1 ? [] : argv.slice(sep + 1);
  let repeat = 1;
  let control = false;
  let label: string | undefined;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--repeat") repeat = Number(flags[++i]);
    else if (flags[i] === "--control") control = true;
    else if (flags[i] === "--label") label = flags[++i];
    else throw new Error(`unknown flag: ${flags[i]}`);
  }
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error("--repeat must be a positive integer");
  }
  if (cmd.length === 0) throw new Error("missing command after --");
  return { repeat, control, label, cmd };
}

export async function main(argv: string[], deps: Deps = {}): Promise<number> {
  const write = deps.write ?? ((s: string) => process.stdout.write(s));
  if ((deps.platform ?? process.platform) !== "darwin") {
    write(`${JSON.stringify({ skipped: "not-macos" })}\n`);
    return 0;
  }
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  const sample = deps.sample ?? sampleDaemons;
  const spawn =
    deps.spawn ??
    ((cmd: string[]) =>
      spawnSync(cmd[0], cmd.slice(1), { stdio: ["ignore", 2, 2] }).status ?? 1);
  const sleep =
    deps.sleep ??
    ((sec: number) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sec * 1000);
    });
  const now = deps.now ?? (() => performance.now());
  const loadAvg1 = deps.loadAvg1 ?? (() => os.loadavg()[0]);

  const runs = [];
  for (let i = 0; i < args.repeat; i++) {
    const load = loadAvg1();
    const before = sample();
    const t0 = now();
    const exitCode = spawn(args.cmd);
    const wallSec = (now() - t0) / 1000;
    const delta = diffSamples(before, sample());
    let net = delta.net;
    let control;
    if (args.control) {
      const cBefore = sample();
      sleep(wallSec);
      const cd = diffSamples(cBefore, sample());
      control = { wallSec, daemons: cd.net, pidExited: cd.pidExited };
      net = Object.fromEntries(
        DAEMONS.map((d) => [d, delta.net[d] - cd.net[d]]),
      ) as PerDaemon;
    }
    runs.push({
      wallSec,
      loadAvg1: load,
      exitCode,
      daemons: delta.net,
      pidExited: delta.pidExited,
      ...(control ? { control } : {}),
      net,
    });
  }
  const medianNet = Object.fromEntries(
    DAEMONS.map((d) => [d, median(runs.map((r) => r.net[d]))]),
  ) as PerDaemon;
  write(
    `${JSON.stringify({
      ...(args.label ? { label: args.label } : {}),
      host: {
        platform: deps.platform ?? process.platform,
        cpus: os.cpus().length,
        loadAvg1AtStart: runs[0].loadAvg1,
      },
      runs,
      medianNet,
      medianWallSec: median(runs.map((r) => r.wallSec)),
    })}\n`,
  );
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
