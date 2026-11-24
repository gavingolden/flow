#!/usr/bin/env bun
/**
 * Background Gemini review helpers (lens + intent guess) behind one watchdog.
 *
 *   flow-review-bg start --worktree <dir> [--config <path>]
 *   flow-review-bg wait --worktree <dir> [--max-sec <n=540>]
 *   flow-review-bg supervise --worktree <dir> --generation <id>   (internal)
 *
 * `start` (called once from `flow-review-prep`) launches the watchdog, which
 * owns both helper children and enforces each give-up deadline. `wait` is a
 * read-only, re-runnable poll of `.flow-tmp/review-bg.json`: it never
 * launches. `supervise` refuses to run unless the state file names a matching
 * generation with a running helper, so the pre-approved verb cannot spend
 * quota on its own. Exit 0 on every outcome; 2 on usage errors.
 */

import { startHelpers } from "./lib/review-bg";
import {
  BG_HELPERS,
  bgPaths,
  helperPaths,
  readReviewBgState,
  readScope,
  realStateIO,
  watchdogLiveness,
  writeIfOwner,
  type BgHelper,
  type BgOutcome,
  type ReviewBgState,
  type StateIO,
} from "./lib/review-bg-state";
import {
  isCompleteEnvelope,
  runSupervise,
  SuperviseRefused,
} from "./lib/review-bg-supervise";

export type WaitReport = {
  done: boolean;
  elapsedSec: number;
  helpers: Record<
    BgHelper,
    Record<string, unknown> & {
      outcome: BgOutcome;
      ran: boolean | null;
      envelope: string;
    }
  >;
};

export type WaitDeps = {
  io: StateIO;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  isAlive?: (pid: number) => boolean;
  pidStartEpoch?: (pid: number) => number | null;
};

const DEFAULT_MAX_SEC = 540;

function realWaitDeps(): WaitDeps {
  return {
    io: realStateIO(),
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs: 5000,
  };
}

function parseEnvelope(text: string | null): Record<string, unknown> | null {
  if (!isCompleteEnvelope(text)) return null;
  const v = JSON.parse(text as string);
  return typeof v === "object" && v !== null ? v : null;
}

function snapshot(
  worktree: string,
  deps: WaitDeps,
): { helpers: WaitReport["helpers"]; resolved: boolean } {
  const { io } = deps;
  const scope = readScope(io, worktree);
  let state: ReviewBgState | null = readReviewBgState(
    io.readFile(bgPaths(worktree).state),
  );
  const notLaunched = state === null || state.head_sha !== scope.head_sha;

  // Record that the review called wait, so telemetry can name a skipped wait
  // even when the lens finishes after consolidation.
  if (!notLaunched && state !== null && state.awaitedAt === undefined) {
    state =
      writeIfOwner(
        worktree,
        state.generation,
        (s) => void (s.awaitedAt ??= Math.floor(deps.nowMs() / 1000)),
        io,
      ) ?? state;
  }

  // A dead watchdog with a helper still running will never resolve it.
  if (!notLaunched && state !== null) {
    const live = watchdogLiveness(
      state.watchdog,
      deps.isAlive,
      deps.pidStartEpoch,
    );
    if (live !== "alive") {
      const gen = state.generation;
      const stuck = BG_HELPERS.filter(
        (h) => state!.helpers[h].status === "running",
      );
      if (stuck.length > 0) {
        state =
          writeIfOwner(
            worktree,
            gen,
            (s) => {
              for (const h of stuck) {
                const hs = s.helpers[h];
                if (hs.status !== "running") continue;
                const complete = isCompleteEnvelope(
                  io.readFile(helperPaths(worktree, h).envelope),
                );
                hs.status = "done";
                hs.outcome = complete
                  ? "complete"
                  : "helper-exited-without-envelope";
                if (!complete) {
                  hs.skipReason = "helper-exited-without-envelope";
                  hs.skipClass = "ran-unusable";
                }
              }
            },
            io,
          ) ?? state;
      }
    }
  }

  const helpers = {} as WaitReport["helpers"];
  let resolved = true;
  for (const h of BG_HELPERS) {
    const hs = notLaunched || state === null ? null : state.helpers[h];
    if (hs === null) {
      helpers[h] = {
        outcome: "skipped",
        ran: false,
        skipReason: "gemini-not-launched",
        skipClass: "environment",
        envelope: helperPaths(worktree, h).envelope,
      };
      continue;
    }
    if (hs.status === "running") resolved = false;
    const envelope = helperPaths(worktree, h).envelope;
    const env = parseEnvelope(io.readFile(envelope));
    helpers[h] = {
      ...(env ?? {}),
      outcome: hs.outcome ?? "pending",
      ran:
        typeof env?.ran === "boolean"
          ? env.ran
          : hs.status === "running"
            ? null
            : false,
      ...(hs.skipReason !== undefined && { skipReason: hs.skipReason }),
      ...(hs.skipClass !== undefined && { skipClass: hs.skipClass }),
      envelope,
    };
  }
  return { helpers, resolved };
}

export async function runWait(
  opts: { worktree: string; maxSec: number },
  overrides: Partial<WaitDeps> = {},
): Promise<WaitReport> {
  const deps: WaitDeps = { ...realWaitDeps(), ...overrides };
  const t0 = deps.nowMs();
  for (;;) {
    const { helpers, resolved } = snapshot(opts.worktree, deps);
    const elapsedSec = Math.floor((deps.nowMs() - t0) / 1000);
    if (resolved || elapsedSec >= opts.maxSec) {
      return { done: resolved, elapsedSec, helpers };
    }
    await deps.sleep(deps.pollMs);
  }
}

const USAGE = [
  "usage: flow-review-bg start --worktree <dir> [--config <path>]",
  "       flow-review-bg wait --worktree <dir> [--max-sec <n>]",
  "       flow-review-bg supervise --worktree <dir> --generation <id>",
].join("\n");

function flags(argv: string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k?.startsWith("--") || v === undefined || v.startsWith("--")) {
      return null;
    }
    out[k.slice(2)] = v;
  }
  return out;
}

export async function run(
  argv: string[],
  writeOut: (line: string) => void = (l) => console.log(l),
): Promise<number> {
  const [verb, ...rest] = argv;
  const f = flags(rest);
  const usage = (msg: string): number => {
    console.error(`flow-review-bg: ${msg}\n${USAGE}`);
    return 2;
  };
  if (f === null) return usage("malformed flags");
  const worktree = f.worktree;
  if (worktree === undefined) return usage("--worktree is required");

  if (verb === "start") {
    writeOut(JSON.stringify(startHelpers({ worktree, config: f.config })));
    return 0;
  }
  if (verb === "wait") {
    const maxSec =
      f["max-sec"] === undefined ? DEFAULT_MAX_SEC : Number(f["max-sec"]);
    if (!Number.isFinite(maxSec) || maxSec < 0) return usage("bad --max-sec");
    writeOut(JSON.stringify(await runWait({ worktree, maxSec })));
    return 0;
  }
  if (verb === "supervise") {
    if (f.generation === undefined) return usage("--generation is required");
    try {
      await runSupervise({ worktree, generation: f.generation });
    } catch (e) {
      if (!(e instanceof SuperviseRefused)) throw e;
      console.error(`flow-review-bg: supervise refused: ${e.message}`);
    }
    return 0;
  }
  return usage(`unknown verb "${verb ?? ""}"`);
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
