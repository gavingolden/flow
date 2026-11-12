import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { readKeepAwakeSettings } from "./keep-awake-config";
import { pidStartEpoch } from "./liveness";
import {
  appendRow,
  defaultIsLive,
  readRows,
  type ProcRegistryRow,
} from "./proc-registry";
import { sleepSync } from "./sleep";
import { STEP_PHASES, type PipelinePhase, type PipelineState } from "./state";

export const KEEP_AWAKE_RENEW_AFTER_MS = 15 * 60_000;
export const CAFFEINATE_PATH = "/usr/bin/caffeinate";

export const KEEP_AWAKE_HOLD_PHASES: ReadonlySet<PipelinePhase> =
  new Set<PipelinePhase>([
    ...STEP_PHASES,
    "ci-wait-pending",
    "plan-review-pending",
    "epic-plan-review-pending",
  ]);

export function holderArgv(
  watchPid: number | undefined,
  maxSec: number,
): string[] {
  return [
    CAFFEINATE_PATH,
    "-i",
    "-s",
    ...(watchPid === undefined ? [] : ["-w", String(watchPid)]),
    "-t",
    String(maxSec),
  ];
}

export type KeepAwakeDeps = {
  platform: NodeJS.Platform;
  envOff: () => boolean;
  enabled: () => boolean;
  maxSec: () => number;
  nowMs: () => number;
  hasCaffeinate: () => boolean;
  pidLive: (pid: number) => boolean;
  spawnDetached: (argv: string[]) => number | null;
  startEpoch: (pid: number) => number | null;
  readRows: (slug: string) => ProcRegistryRow[];
  appendRow: (slug: string, row: ProcRegistryRow) => boolean;
  isLive: (row: ProcRegistryRow) => boolean;
  kill: (pid: number, sig: NodeJS.Signals) => void;
  sleepMs: (ms: number) => void;
};

export type KeepAwakeOutcome = {
  action: "acquired" | "kept" | "released" | "none";
  skip?: "env-off" | "not-darwin" | "disabled" | "no-caffeinate";
};

const RELEASE_POLL_MS = 20;
const RELEASE_WAIT_MS = 200;

const defaultDeps: Omit<KeepAwakeDeps, "enabled" | "maxSec"> = {
  platform: process.platform,
  envOff: () => process.env.FLOW_KEEP_AWAKE === "0",
  nowMs: Date.now,
  hasCaffeinate: () => fs.existsSync(CAFFEINATE_PATH),
  pidLive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  spawnDetached: (argv) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      detached: true,
      stdio: "ignore",
      cwd: os.homedir(),
    });
    child.on("error", () => {});
    child.unref();
    return child.pid ?? null;
  },
  startEpoch: (pid) => pidStartEpoch(pid),
  readRows: (slug) => readRows(slug).rows,
  appendRow: (_slug, row) => appendRow(row).written,
  isLive: defaultIsLive,
  kill: (pid, sig) => process.kill(pid, sig),
  sleepMs: sleepSync,
};

const isHolder = (row: ProcRegistryRow): boolean =>
  row.argv[0] === CAFFEINATE_PATH ||
  row.argv[0]?.split("/").pop() === "caffeinate";

function release(rows: ProcRegistryRow[], d: KeepAwakeDeps): void {
  for (const row of rows) {
    try {
      if (!d.isLive(row)) continue;
      d.kill(row.pid, "SIGTERM");
      for (
        let waited = 0;
        waited < RELEASE_WAIT_MS && d.pidLive(row.pid);
        waited += RELEASE_POLL_MS
      ) {
        d.sleepMs(RELEASE_POLL_MS);
      }
      if (d.pidLive(row.pid) && d.isLive(row)) d.kill(row.pid, "SIGKILL");
    } catch {
      // already gone, or not ours to signal
    }
  }
}

export function syncKeepAwake(
  state: PipelineState,
  deps: Partial<KeepAwakeDeps> = {},
): KeepAwakeOutcome {
  let snapshot: ReturnType<typeof readKeepAwakeSettings> | undefined;
  const settings = () => (snapshot ??= readKeepAwakeSettings());
  const d: KeepAwakeDeps = {
    enabled: () => settings().enabled,
    maxSec: () => settings().maxSec,
    ...defaultDeps,
    ...deps,
  };
  try {
    const holders = d
      .readRows(state.slug)
      .filter((r) => isHolder(r) && d.pidLive(r.pid) && d.isLive(r));
    const hold = (KEEP_AWAKE_HOLD_PHASES as ReadonlySet<string>).has(
      state.phase,
    );
    const skip: KeepAwakeOutcome["skip"] = d.envOff()
      ? "env-off"
      : d.platform !== "darwin"
        ? "not-darwin"
        : !d.enabled()
          ? "disabled"
          : !d.hasCaffeinate()
            ? "no-caffeinate"
            : undefined;
    if (!hold || skip) {
      release(holders, d);
      if (holders.length > 0) return { action: "released" };
      return skip ? { action: "none", skip } : { action: "none" };
    }

    const watchPid =
      state.pid !== undefined && d.pidLive(state.pid) ? state.pid : undefined;
    const maxSec = d.maxSec();
    const argv = holderArgv(watchPid, maxSec);
    const renewAfterMs = Math.min(
      KEEP_AWAKE_RENEW_AFTER_MS,
      (maxSec * 1000) / 4,
    );
    const now = d.nowMs();
    const fresh = holders
      .filter((r) => {
        const age = now - r.recordedAt;
        return (
          r.argv.length === argv.length &&
          r.argv.every((a, i) => a === argv[i]) &&
          Number.isFinite(age) &&
          age < renewAfterMs
        );
      })
      .sort((a, b) => b.recordedAt - a.recordedAt)[0];
    if (fresh) {
      release(
        holders.filter((r) => r !== fresh),
        d,
      );
      return { action: "kept" };
    }

    const child = d.spawnDetached(argv);
    if (child === null) return { action: "none" };
    const startEpoch = d.startEpoch(child);
    if (startEpoch === null) {
      d.kill(child, "SIGTERM");
      return { action: "none" };
    }
    const registered = d.appendRow(state.slug, {
      pid: child,
      pgid: child,
      startEpoch,
      slug: state.slug,
      class: "default",
      argv,
      recordedAt: now,
      sessionPid: state.pid ?? null,
      sessionStartEpoch: state.procStartedAt ?? null,
    });
    if (!registered) {
      d.kill(child, "SIGTERM");
      return { action: "none" };
    }
    release(holders, d);
    return { action: "acquired" };
  } catch {
    return { action: "none" };
  }
}
