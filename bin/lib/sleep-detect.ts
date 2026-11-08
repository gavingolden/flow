import { spawnSync } from "node:child_process";

export type SleepSpan = { sleptAt: string; wokeAt: string | null };
export type SysctlReader = (name: string) => string | null;

export type SleptRecord = {
  sleptAt: string;
  wokeAt: string | null;
  rerun: "passed" | "failed" | "slept-again";
};

const SYSCTL_TIMEOUT_MS = 2000;

export const defaultReadSysctl: SysctlReader = (name) => {
  try {
    const r = spawnSync("/usr/sbin/sysctl", ["-n", name], {
      encoding: "utf8",
      timeout: SYSCTL_TIMEOUT_MS,
    });
    if (r.error || r.status !== 0) return null;
    return r.stdout;
  } catch {
    return null;
  }
};

export function parseKernTime(out: string): number | null {
  const m = /\{\s*sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)\s*\}/.exec(out);
  if (!m) return null;
  const sec = Number(m[1]);
  const usec = Number(m[2]);
  if (!Number.isFinite(sec) || !Number.isFinite(usec) || sec === 0) return null;
  return sec * 1000 + Math.floor(usec / 1000);
}

export function sleepSince(
  startMs: number,
  deps: { platform?: NodeJS.Platform; readSysctl?: SysctlReader } = {},
): SleepSpan | null {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return null;
  const read = deps.readSysctl ?? defaultReadSysctl;
  try {
    const raw = read("kern.sleeptime");
    if (raw === null) return null;
    const sleptMs = parseKernTime(raw);
    if (sleptMs === null || sleptMs < startMs) return null;
    const wokeRaw = read("kern.waketime");
    const wokeMs = wokeRaw === null ? null : parseKernTime(wokeRaw);
    return {
      sleptAt: new Date(sleptMs).toISOString(),
      wokeAt:
        wokeMs !== null && wokeMs > sleptMs
          ? new Date(wokeMs).toISOString()
          : null,
    };
  } catch {
    return null;
  }
}

export function withSleepRerun<
  R extends { passed: boolean; durationMs: number },
>(
  first: R,
  startMs: number,
  rerun: () => R,
  deps: {
    sleepSince?: (startMs: number) => SleepSpan | null;
    now?: () => number;
  } = {},
): (R & { slept: SleptRecord }) | null {
  if (first.passed) return null;
  const detect = deps.sleepSince ?? ((ms: number) => sleepSince(ms));
  const now = deps.now ?? Date.now;
  const safeDetect = (ms: number): SleepSpan | null => {
    try {
      return detect(ms);
    } catch {
      return null;
    }
  };
  const span = safeDetect(startMs);
  if (!span) return null;
  const rerunStartMs = now();
  const second = rerun();
  let outcome: SleptRecord["rerun"];
  if (!second.passed && safeDetect(rerunStartMs)) outcome = "slept-again";
  else outcome = second.passed ? "passed" : "failed";
  return {
    ...second,
    slept: { sleptAt: span.sleptAt, wokeAt: span.wokeAt, rerun: outcome },
  };
}
