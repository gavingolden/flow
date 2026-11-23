/**
 * Runners for the `flow-untracked` verbs that act on several items or leave
 * the ledger: `file --all`, `drop --all`, `done`, `launch`, `verdict --json`,
 * plus the badge-refresh seam. The turn-end hook's recorder lives next to the
 * merge seeder in `untracked-merge-seed.ts`.
 * Pure over a `PipelineState` plus injected seams, so the entrypoint
 * (`bin/flow-untracked.ts`) stays a thin CLI and every verb is unit-testable.
 *
 * Nothing here runs unless the user's reply asked for it: `fileAll` /
 * `launchItem` are the only outward-facing verbs and the pause contract fires
 * them only on an explicit reply (`.claude/rules/flow-supervisor-contracts.md` "Auto-issue-create exemption").
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  EFFORT_LEVELS,
  MODEL_ALIASES,
  type PipelineState,
  type UntrackedItem,
} from "./state";
import { closeVerdict, isOpenItem, windowLine } from "./close-verdict";
import { publishStateBadges } from "./tmux";

const isWork = (i: UntrackedItem): boolean => i.kind !== "manual";

export type FileAllResult = {
  state: PipelineState;
  filed: Array<{ id: number; url: string }>;
  failure?: { id: number; message: string; error: unknown };
};

/**
 * Files every open work item (manual checks are never filed). A failure on
 * item N keeps items filed before it persisted, stops, and leaves the rest
 * open — the caller reports the failure and exits non-zero.
 */
export function fileAll(
  state: PipelineState,
  deps: { fileOne: (s: PipelineState, id: number) => PipelineState },
): FileAllResult {
  const filed: Array<{ id: number; url: string }> = [];
  let cur = state;
  const targets = (state.untracked ?? []).filter(
    (i) => isOpenItem(i) && isWork(i),
  );
  for (const t of targets) {
    try {
      cur = deps.fileOne(cur, t.id);
    } catch (e) {
      return {
        state: cur,
        filed,
        failure: { id: t.id, message: (e as Error).message, error: e },
      };
    }
    const url = cur.untracked?.find((i) => i.id === t.id)?.filedAs;
    if (url !== undefined) filed.push({ id: t.id, url });
  }
  return { state: cur, filed };
}

export function dropAll(
  state: PipelineState,
  now: () => string = () => new Date().toISOString(),
): { state: PipelineState; dropped: number[] } {
  const dropped: number[] = [];
  const at = now();
  const untracked = (state.untracked ?? []).map((i) => {
    if (!isOpenItem(i)) return i;
    dropped.push(i.id);
    return { ...i, droppedAt: at };
  });
  return { state: { ...state, untracked }, dropped };
}

/** Marks manual items done: one by id, or every open manual item. */
export function doneItem(
  state: PipelineState,
  id: number | "all",
  now: () => string = () => new Date().toISOString(),
): { state: PipelineState; done: number[] } {
  const items = state.untracked ?? [];
  if (id !== "all") {
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error(`no untracked item #${id}`);
    if (isWork(item)) {
      throw new Error(
        `#${id} is a work item, not a manual check — use file #${id}, drop #${id} or launch #${id}`,
      );
    }
  }
  const done: number[] = [];
  const at = now();
  const untracked = items.map((i) => {
    const hit = id === "all" ? !isWork(i) && isOpenItem(i) : i.id === id;
    if (!hit || i.doneAt !== undefined) return i;
    done.push(i.id);
    return { ...i, doneAt: at };
  });
  return { state: { ...state, untracked }, done };
}

export type SpawnLaunch = (
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
) => { stdout: string; exitCode: number };

export function defaultSpawnLaunch(): SpawnLaunch {
  return (argv, env, cwd) => {
    const r = spawnSync(argv[0], argv.slice(1), {
      encoding: "utf8",
      env,
      ...(cwd && existsSync(cwd) ? { cwd } : {}),
    });
    return { stdout: r.stdout ?? "", exitCode: r.status ?? 1 };
  };
}

/** The child must not be mistaken for this pipeline (flow#618 class). */
export function scrubLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.FLOW_SLUG;
  delete out.TMUX_PANE;
  return out;
}

/**
 * Starts a follow-up pipeline for one item. `launchedAs` is recorded only on
 * exit 0 plus a `flow:<slug>` line; any other outcome throws and the item
 * stays open. Only model/effort words pass through to `flow feature create`.
 */
export function launchItem(
  state: PipelineState,
  id: number,
  opts: { model?: string; effort?: string },
  deps: { spawnLaunch: SpawnLaunch; env?: NodeJS.ProcessEnv },
): { state: PipelineState; slug: string } {
  const items = state.untracked ?? [];
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) throw new Error(`no untracked item #${id}`);
  const item = items[idx];
  if (item.launchedAs !== undefined) return { state, slug: item.launchedAs };
  if (!isWork(item)) {
    throw new Error(
      `#${id} is a manual check, not a work item — use done #${id} or drop #${id}`,
    );
  }
  if (!isOpenItem(item)) throw new Error(`#${id} is already decided`);
  if (
    opts.model !== undefined &&
    !(MODEL_ALIASES as readonly string[]).includes(opts.model)
  ) {
    throw new Error(
      `invalid model '${opts.model}' (one of: ${MODEL_ALIASES.join(", ")})`,
    );
  }
  if (
    opts.effort !== undefined &&
    !(EFFORT_LEVELS as readonly string[]).includes(opts.effort)
  ) {
    throw new Error(
      `invalid effort '${opts.effort}' (one of: ${EFFORT_LEVELS.join(", ")})`,
    );
  }
  const description = item.body ? `${item.title}\n\n${item.body}` : item.title;
  const argv = ["flow", "feature", "create", description];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("--effort", opts.effort);
  // The child resolves its repo from cwd; the pipeline's worktree may be gone.
  const r = deps.spawnLaunch(
    argv,
    scrubLaunchEnv(deps.env ?? process.env),
    state.repo,
  );
  const m = /^flow:(\S+)\s*$/m.exec(r.stdout);
  if (r.exitCode !== 0 || !m) {
    throw new Error(
      `flow feature create did not confirm a launch (exit ${r.exitCode}); #${id} stays open`,
    );
  }
  const next = [...items];
  next[idx] = { ...item, launchedAs: m[1] };
  return { state: { ...state, untracked: next }, slug: m[1] };
}

export function verdictJson(state: PipelineState): string {
  const v = closeVerdict(state);
  return JSON.stringify({
    verdict: v.kind,
    reason: v.reason,
    window: windowLine(v),
    openItems: v.openItems.map((i) => ({
      id: i.id,
      title: i.title,
      kind: i.kind ?? "work",
    })),
    steps: v.steps,
  });
}

/** Best-effort badge refresh after a ledger change; never throws. */
export function defaultPublishBadges(state: PipelineState): void {
  try {
    publishStateBadges(state);
  } catch {
    // publish-only; a tmux failure must not fail the verb
  }
}
