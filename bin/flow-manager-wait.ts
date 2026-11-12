#!/usr/bin/env bun
/**
 * The global manager's background waiter. The manager skill starts it with
 * `run_in_background`; it polls the pipeline state files with ZERO model
 * calls, settles briefly to batch co-occurring events, then prints one JSON
 * line and exits, which wakes the manager session. Unbounded by default: a
 * background Bash command has no time limit locally, so there is no 9-minute
 * re-arm turn (the 540 s cap `flow-plan-review-wait` carries is deliberately
 * not copied).
 *
 *   flow-manager-wait [--ensure] [--interval <s=5>] [--settle <s=10>]
 *                     [--heartbeat <s>] [--stop-when-idle] [--max-sec <s=0>]
 *
 * `flow manage --stop-when-idle` is recorded in `manager.json`; the waiter
 * honours it without the flag, so the skill never has to pass it.
 *
 * `--ensure` is a foreground probe the skill runs at every turn end: it prints
 * `already-running` when a live waiter exists and `start-needed` otherwise,
 * and never becomes the long waiter itself. Events are written to `wake.json`
 * the moment they are found and stay there until `flow-manager-ctl ack`, so a
 * crash or `/clear` mid-wake loses nothing; a re-armed waiter re-emits them.
 * Exit 0 always, 2 on bad arguments.
 */

import * as fs from "node:fs";
import { OWNER_NEEDED_PHASES } from "./lib/epic-manage-board";
import { defaultExec, type ExecFn } from "./lib/epic-manage-observe";
import { readManagerConfig } from "./lib/manager-config";
import {
  fetchPrStates,
  mergedOutOfBand,
  type PrState,
} from "./lib/manager-heartbeat";
import { managerFile, managerHome } from "./lib/manager-home";
import {
  logPath,
  readManagerLog,
  type ManagerLogEntry,
} from "./lib/manager-log";
import { readNotes } from "./lib/manager-notes";
import { notifyOwnerNeeded } from "./lib/manager-owner-notify";
import { addProposal, readProposals } from "./lib/manager-proposals";
import { readManagerRecord } from "./lib/manager-record";
import { sendDailyReminder } from "./lib/manager-reminder";
import { readScope, stateInScope } from "./lib/manager-scope";
import { alertBudgetOnce, budgetReached } from "./lib/manager-spend";
import { writeManagerStatus } from "./lib/manager-status";
import {
  diffSnapshot,
  readSeen,
  unpickedRulings,
  writeSeen,
  type WakeEvent,
} from "./lib/manager-wait";
import {
  mergeEvents,
  readWaiter,
  readWake,
  waiterLive,
  writeWaiter,
  writeWake,
  wakePath,
} from "./lib/manager-waiter";
import { flowStateDir } from "./lib/paths";
import {
  FINISHED_PHASE_SET,
  listStates,
  type PipelineState,
} from "./lib/state";
import { recordEvent, type TelemetryEventName } from "./lib/telemetry";

const HELP =
  "usage: flow-manager-wait [--ensure] [--interval <s=5>] [--settle <s=10>] [--heartbeat <s>] [--stop-when-idle] [--max-sec <s=0>]";
const REREAD = "wake-protocol.md";

export type WaitArgs = {
  ensure: boolean;
  intervalSec: number;
  settleSec: number;
  heartbeatSec?: number;
  stopWhenIdle: boolean;
  maxSec: number;
};

export function parseArgs(argv: string[]): WaitArgs | { error: string } {
  const out: WaitArgs = {
    ensure: false,
    intervalSec: 5,
    settleSec: 10,
    stopWhenIdle: false,
    maxSec: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return { error: "help" };
    if (flag === "--ensure") out.ensure = true;
    else if (flag === "--stop-when-idle") out.stopWhenIdle = true;
    else if (
      flag === "--interval" ||
      flag === "--settle" ||
      flag === "--heartbeat" ||
      flag === "--max-sec"
    ) {
      const v = argv[++i];
      const n = v === undefined ? NaN : Number(v);
      const floor = flag === "--max-sec" || flag === "--settle" ? 0 : 1;
      if (!Number.isInteger(n) || n < floor) {
        return { error: `${flag} needs an integer >= ${floor}, got '${v}'` };
      }
      if (flag === "--interval") out.intervalSec = n;
      else if (flag === "--settle") out.settleSec = n;
      else if (flag === "--heartbeat") out.heartbeatSec = n;
      else out.maxSec = n;
    } else return { error: `unknown flag: ${flag}` };
  }
  return out;
}

export type WaitDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  home?: string;
  stateDir?: string;
  pid?: number;
  kill?: (pid: number, signal: 0) => void;
  exec?: ExecFn;
  notify?: (args: string[]) => void;
  out?: (line: string) => void;
  record?: (event: TelemetryEventName, attrs: Record<string, unknown>) => void;
};

function defaultNotify(args: string[]): void {
  try {
    Bun.spawn(["flow-notify", ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).unref();
  } catch {
    // a missing flow-notify never stops the waiter
  }
}

const hhmm = (d: Date): string =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export async function run(
  argv: string[],
  deps: WaitDeps = {},
): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    if (args.error === "help") {
      console.log(HELP);
      return 0;
    }
    console.error(`flow-manager-wait: ${args.error}`);
    console.error(HELP);
    return 2;
  }
  const home = deps.home ?? managerHome();
  const nowMs = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const out = deps.out ?? ((l: string) => console.log(l));
  const notify = deps.notify ?? defaultNotify;
  const exec = deps.exec ?? defaultExec;
  const record = deps.record ?? ((e, a) => recordEvent(e, a));
  const wakeFile = wakePath(home);
  const emit = (outcome: string, events: WakeEvent[] = []): void =>
    out(JSON.stringify({ outcome, events, wakeFile, reread: REREAD }));

  if (args.ensure) {
    const live = waiterLive(readWaiter(home), nowMs(), deps.kill);
    emit(live ? "already-running" : "start-needed");
    return 0;
  }

  const unacked = readWake(home)?.events ?? [];
  if (unacked.length > 0) {
    emit("wake", unacked);
    return 0;
  }

  const startMs = nowMs();
  const startedAt = new Date(startMs).toISOString();
  const pid = deps.pid ?? process.pid;
  const heartbeatMs =
    (args.heartbeatSec ??
      readManagerRecord(home)?.heartbeatSec ??
      readManagerConfig().heartbeatSec) * 1000;
  const stopWhenIdle = readManagerRecord(home)?.stopWhenIdle === true;
  writeWaiter({ version: 1, pid, startedAt, aliveAt: startedAt }, home);

  let signaled = false;
  const onSignal = (): void => {
    signaled = true;
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  let pending: WakeEvent[] = [];
  let firstEventMs = 0;
  let lastHeartbeat = startMs;
  let reminderDay = "";
  let budgetStamp = -1;
  let budgetLine: string | undefined;
  let hiddenOutOfScope = new Set<string>();
  let lastSeenJson = "";
  let rulingLog: ManagerLogEntry[] = [];
  let rulingStamp = -1;

  try {
    for (;;) {
      if (signaled) return 0;
      const ms = nowMs();
      const now = new Date(ms);
      const mine = readWaiter(home);
      if (mine && mine.startedAt !== startedAt) {
        emit("superseded");
        return 0;
      }
      writeWaiter(
        { version: 1, pid, startedAt, aliveAt: now.toISOString() },
        home,
      );

      const states = listStates(deps.stateDir ?? flowStateDir());
      const scope = readScope(home);
      const notices = readManagerRecord(home)?.notices ?? false;
      const inScope = (s: PipelineState): boolean => stateInScope(s, scope);
      const scoped = states.filter(inScope);

      const logStamp = mtime(logPath(home));
      if (logStamp !== rulingStamp) {
        rulingStamp = logStamp;
        rulingLog = readManagerLog({}, home).filter((e) =>
          e.kind.startsWith("ruling-"),
        );
      }
      const unpicked = unpickedRulings(rulingLog, states, now);

      const diff = diffSnapshot(readSeen(home), states, now, {
        inScope,
        scope,
        stopWhenIdle: args.stopWhenIdle || stopWhenIdle,
        unpicked,
      });
      const bySlug = new Map(states.map((s) => [s.slug, s]));
      let events = diff.events.filter((e) => {
        if (e.kind !== "stale") return true;
        const s = e.slug ? bySlug.get(e.slug) : undefined;
        if (!s) return false;
        if (OWNER_NEEDED_PHASES.has(s.phase)) return false;
        addProposal(
          {
            id: `stale-cancel:${s.slug}`,
            kind: "stale-cancel",
            repo: e.repo ?? "unknown",
            slug: s.slug,
            ...(s.epic ? { epic: s.epic.slug } : {}),
            text: `${s.slug} has had no activity for 7+ days (phase ${s.phase}); cancel it?`,
            recommendation: "cancel",
            createdAt: now.toISOString(),
          },
          home,
        );
        return true;
      });

      if (ms - lastHeartbeat >= heartbeatMs) {
        lastHeartbeat = ms;
        const outOfScopeNeeding = notices
          ? states.filter(
              (s) =>
                !inScope(s) &&
                !FINISHED_PHASE_SET.has(s.phase) &&
                OWNER_NEEDED_PHASES.has(s.phase),
            )
          : [];
        const prStates: Map<string, PrState> = await fetchPrStates(
          [...scoped, ...outOfScopeNeeding],
          exec,
        );
        const oob = mergedOutOfBand(scoped, prStates);
        for (const e of oob) {
          const entry = e.slug ? diff.next.pipelines[e.slug] : undefined;
          if (!entry || entry.oobFired === e.to) continue;
          entry.oobFired = e.to;
          events.push(e);
        }
        const closedOut = mergedOutOfBand(outOfScopeNeeding, prStates);
        hiddenOutOfScope = new Set(
          closedOut.flatMap((e) => (e.slug ? [e.slug] : [])),
        );
        record("manager.heartbeat", {
          targets: scoped.length + outOfScopeNeeding.length,
          mergedOutOfBand: oob.length,
        });
      }

      const seenJson = JSON.stringify(diff.next);
      if (seenJson !== lastSeenJson) {
        writeSeen(diff.next, home);
        lastSeenJson = seenJson;
      }
      notifyOwnerNeeded(events, states, notify, now, home);

      const day = now.toDateString();
      if (reminderDay !== day) {
        const remStates = notices ? states : scoped;
        if (sendDailyReminder(now, remStates, notify, home)) reminderDay = day;
      }

      if (logStamp !== budgetStamp) {
        budgetStamp = logStamp;
        const b = budgetReached(now, { home });
        if (b.reached) {
          alertBudgetOnce(now, notify, home);
          budgetLine = `Executive reviews are paused: today's $${b.capUsd.toFixed(2)} limit is reached ($${b.spentUsd.toFixed(2)} spent).`;
        } else budgetLine = undefined;
      }

      writeManagerStatus(
        states.filter((s) => !hiddenOutOfScope.has(s.slug)),
        now,
        {
          openProposals: readProposals(home).length,
          liveNotes: readNotes(home).length,
          aliveAt: hhmm(now),
          ...(budgetLine ? { budgetLine } : {}),
          ...(unpicked.length > 0
            ? { unpicked: unpicked.map((u) => u.slug) }
            : {}),
        },
        home,
      );

      if (events.length > 0) {
        const merged = mergeEvents(readWake(home)?.events ?? [], events);
        writeWake(merged, now, home);
        if (pending.length === 0) firstEventMs = ms;
        pending = mergeEvents(pending, events);
      }
      events = [];

      if (pending.length > 0 && ms - firstEventMs >= args.settleSec * 1000) {
        const all = readWake(home)?.events ?? pending;
        record("manager.wake", {
          events: all.length,
          kinds: [...new Set(all.map((e) => e.kind))],
          settleMs: ms - firstEventMs,
        });
        emit("wake", all);
        return 0;
      }
      if (args.maxSec > 0 && ms - startMs >= args.maxSec * 1000) {
        emit("timeout");
        return 0;
      }
      await sleep(args.intervalSec * 1000);
    }
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
