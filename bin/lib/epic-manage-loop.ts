/**
 * The `flow epic manage` loop: a zero-token, deterministic tick that re-derives
 * the epic board from live state every few seconds and launches the safe
 * frontier one feature at a time through a detached `flow epic launch` child.
 *
 * Hard rules (each a defect the deleted 2026-07 loop shipped with):
 *   - never trust run.json alone — `planLaunches` cross-checks states, GitHub,
 *     and git before any launch;
 *   - never sleep synchronously or wait on a lock >500 ms — Ctrl-C exits <1 s;
 *   - never kill a launch child on timeout (see epic-manage-launch.ts);
 *   - never spawn a model: no `claude` / `flow-claude-headless`, ever.
 * It never merges, repairs, retries, or writes run.json; drift is named on the
 * board and left to `/flow-epic-run reconcile-drift`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { validateDag } from "../flow-epic-dag";
import { readEpicMaxParallel } from "./epic-config";
import { appendManagerLog, readManagerLog } from "./epic-manager-log";
import { announce, iso, safely, type EventCtx } from "./epic-manage-events";
import { githubFresh, headSha, observe, plan } from "./epic-manage-plan";
import {
  makeSameManifest,
  planLaunches,
  type GuardResult,
} from "./epic-manage-guard";
import {
  expireHolds,
  launchArgs,
  persistMarker,
  seedLaunching,
  settleInFlight,
  startLaunch,
  type LaunchState,
} from "./epic-manage-launch";
import {
  fetchGithubSnapshot,
  listRepoStates,
  makeStrictSameRepository,
  probeGitRefs,
  resolveGithubRepo,
  type ExecFn,
  type GitRefs,
  type GithubSnapshot,
} from "./epic-manage-observe";
import { ownerNeededFor, renderManageBoard } from "./epic-manage-board";
import {
  removeManager,
  writeManager,
  type ManagerState,
} from "./epic-manage-state";
import {
  validateEpicManifest,
  type EpicManifest,
} from "./epic-manifest-schema";
import { reconcile, type ReconcileResult } from "./epic-reconcile";
import { readEpicRunState, type EpicRunState } from "./epic-run-state";
import { readCommittedStatus } from "./epic-status-schema";
import { deriveWorktreePath } from "./feature";
import { slugify } from "./slug";
import {
  buildSetOptionArgs,
  FLOW_PHASE_OPTION,
  FLOW_PHASE_SHORT_OPTION,
  FLOW_SESSION,
} from "./tmux";
import { readState, type PipelineState } from "./state";

export type LoopDeps = {
  exec: ExecFn;
  spawnLaunch: (
    args: string[],
    outPath: string,
  ) => Promise<{ exitCode: number }>;
  notify: (args: string[]) => void;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  write: (text: string) => void;
  isTty: boolean;
  stateDir?: string;
  epicsDir?: string;
  readMaxParallel?: () => number;
  headSha?: () => Promise<string | null>;
  /** Test seam: repo-scope predicate (default: strict same-repository for `manager.repo`). */
  sameRepo?: (repoPath: string) => boolean;
  /** `FLOW_NOTIFY` lookup for the board's "notifications off" hint (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Resolves on Enter (a TTY) after the final board; default waits for the stop signal only. */
  waitForEnter?: (signal: AbortSignal) => Promise<void>;
};

export type LoopConfig = {
  manager: ManagerState;
  manifestPath: string;
  statePollMs: number;
  githubPollMs: number;
};

export const DEFAULT_STATE_POLL_MS = 3_000;
export const DEFAULT_GITHUB_POLL_MS = 90_000;

export type LoopContext = LaunchState &
  EventCtx & {
    cfg: LoopConfig;
    sameRepo: (repoPath: string) => boolean;
    sameManifest: (runJsonManifestPath: string) => boolean;
    repoRef: { owner: string; name: string } | null;
    github: GithubSnapshot | null;
    lastGood: Extract<GithubSnapshot, { ok: true }> | null;
    lastFetchAt: number | null;
    observed: Set<string>;
    lastBoard: string;
    lastUpdatedAt: string;
    head: { value: string | null; at: number } | null;
    startedAtMs: number;
  };

/** Extension point for the sequencer executive: runs once per newly observed merge, before launch planning. */
export async function afterMergesObserved(
  _ctx: LoopContext,
  _merged: string[],
): Promise<void> {}

/** Extension point for frontier ordering; identity today. */
export function orderFrontier(ids: string[]): string[] {
  return ids;
}

export function createLoopContext(
  cfg: LoopConfig,
  deps: LoopDeps,
): LoopContext {
  const epic = cfg.manager.epicSlug;
  const sameRepo = deps.sameRepo ?? makeStrictSameRepository(cfg.manager.repo);
  const ctx: LoopContext = {
    epic,
    runId: cfg.manager.startedAt,
    failed: new Map(),
    launching: new Map(),
    inFlight: null,
    cfg,
    sameRepo,
    sameManifest: makeSameManifest(sameRepo, epic),
    repoRef: null,
    github: null,
    lastGood: null,
    lastFetchAt: null,
    notified: new Set(),
    activeHolds: new Set(),
    observed: new Set(),
    lastBoard: "",
    lastUpdatedAt: "",
    head: null,
    startedAtMs: deps.now(),
  };
  for (const e of readManagerLog(epic, deps.stateDir)) {
    if (e.key) ctx.notified.add(e.key);
  }
  seedLaunching(ctx, deps.now(), cfg.manager.launching, deps.stateDir);
  return ctx;
}

function heartbeat(ctx: LoopContext, deps: LoopDeps, status?: "done"): void {
  const first = [...ctx.launching][0];
  safely(() =>
    writeManager(
      {
        ...ctx.cfg.manager,
        heartbeatAt: iso(deps.now()),
        launching: first
          ? { featureId: first[0], startedAt: iso(first[1]) }
          : null,
        ...(status ? { status } : {}),
      },
      deps.stateDir,
    ),
  );
}

export async function tick(
  ctx: LoopContext,
  deps: LoopDeps,
): Promise<{ done: boolean; launched?: string }> {
  await Promise.resolve();
  settleInFlight(ctx);
  const now = deps.now();
  const o = observe(ctx, deps);
  const planned = await plan(ctx, deps, o, {
    onMerged: (fresh) => afterMergesObserved(ctx, fresh),
    beat: () => heartbeat(ctx, deps),
  });
  const { result } = planned;
  let { guard } = planned;

  const states = new Map(o.repoStates.map((s) => [s.slug, s]));
  const ownerNeeded = ownerNeededFor(result.board, states);
  const done = result.epicStatus === "done" && ctx.inFlight === null;
  const failure =
    ctx.github && !ctx.github.ok && !githubFresh(ctx, now)
      ? ctx.github.error
      : null;
  announce(ctx, deps, {
    ownerNeeded,
    guard,
    githubPaused: failure,
    doneTotal: done ? result.summary.total : null,
  });

  let launched: string | undefined;
  if (!done && ctx.inFlight === null) {
    const candidates = guard.verdicts.flatMap((v) =>
      v.action === "launch" ? [v] : [],
    );
    const id = orderFrontier(candidates.map((v) => v.id))[0];
    const verdict = candidates.find((v) => v.id === id);
    if (verdict) {
      launched = verdict.id;
      const args = launchArgs(ctx.epic, verdict.id, verdict.overrides);
      startLaunch(ctx, deps, verdict.id, args);
      heartbeat(ctx, deps);
      safely(() =>
        appendManagerLog(
          ctx.epic,
          {
            ts: iso(now),
            kind: "launch",
            featureId: verdict.id,
            slug: slugify(verdict.id),
            window: verdict.id,
            reason: `flow ${args.join(" ")}`,
            key: `launch:${verdict.id}@${now}`,
          },
          deps.stateDir,
        ),
      );
      guard = planned.replan();
    }
  }

  const head = await headSha(ctx, deps);
  const gh = ctx.github;
  const render = (updatedAt: string): string =>
    renderManageBoard({
      epicSlug: ctx.epic,
      result,
      manager: ctx.cfg.manager,
      headSha: head,
      notifyOn: (deps.env ?? process.env).FLOW_NOTIFY === "1",
      ownerNeeded,
      guard,
      github:
        gh === null
          ? null
          : {
              ok: githubFresh(ctx, now),
              ageMs: now - (ctx.lastGood?.at ?? ctx.startedAtMs),
              ...(gh.ok ? {} : { error: gh.error }),
            },
      updatedAt,
      final: done,
    });
  // `updated` only moves when something else on the board changed, so an idle
  // epic redraws nothing.
  let text = render(ctx.lastUpdatedAt || iso(now));
  if (text !== ctx.lastBoard) {
    ctx.lastUpdatedAt = iso(now);
    text = render(ctx.lastUpdatedAt);
    ctx.lastBoard = text;
    deps.write(deps.isTty ? `\x1b[2J\x1b[H${text}\n` : `${text}\n`);
  }
  if (done) heartbeat(ctx, deps, "done");
  return { done, ...(launched ? { launched } : {}) };
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

export function installStopHandlers(
  controller: AbortController,
  onStop: () => void,
): () => void {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handler = (): void => {
    onStop();
    controller.abort();
  };
  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}

/** Badge the manage window `managing` once (best effort, only inside tmux): it has no state file to publish one. */
async function publishManagingBadge(
  ctx: LoopContext,
  deps: LoopDeps,
): Promise<void> {
  if (!(deps.env ?? process.env).TMUX) return;
  const target = `${FLOW_SESSION}:${ctx.cfg.manager.window}`;
  for (const option of [FLOW_PHASE_OPTION, FLOW_PHASE_SHORT_OPTION]) {
    try {
      await deps.exec(
        "tmux",
        buildSetOptionArgs(target, option, "managing"),
        ctx.cfg.manager.repo,
        5_000,
      );
    } catch {
      // a missing badge must never stop the sequencer
    }
  }
}

export async function runManagerLoop(
  cfg: LoopConfig,
  deps: LoopDeps,
  signal: AbortSignal,
): Promise<number> {
  const ctx = createLoopContext(cfg, deps);
  let lastError = "";
  await publishManagingBadge(ctx, deps);
  try {
    while (!signal.aborted) {
      heartbeat(ctx, deps);
      try {
        const r = await tick(ctx, deps);
        lastError = "";
        if (r.done) {
          await (deps.waitForEnter ?? ((s) => deps.sleep(2 ** 31 - 1, s)))(
            signal,
          );
          break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== lastError) {
          deps.write(
            `sequencer: ${msg} — retrying in ${cfg.statePollMs / 1000}s\n`,
          );
        }
        lastError = msg;
      }
      await deps.sleep(cfg.statePollMs, signal);
    }
  } finally {
    persistMarker(ctx, deps.stateDir);
    safely(() =>
      appendManagerLog(
        cfg.manager.epicSlug,
        { ts: iso(deps.now()), kind: "stopped" },
        deps.stateDir,
      ),
    );
    safely(() => removeManager(cfg.manager.epicSlug, deps.stateDir));
  }
  return 0;
}
