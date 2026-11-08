/**
 * Repo discovery and per-worktree facts for the worktree sweep. Every
 * subprocess runs through the injected `run` seam with a timeout, so tests
 * never reach git, gh or the machine. Verdicts live in worktree-sweep-rules.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseWorktreeListOutput } from "../flow-remove-worktree";
import type { Liveness } from "./liveness";
import type { PipelineState } from "./state";
import { FLOW_EXCLUDE_PATHS } from "./worktree-marker";
import type { OrphanProc } from "./worktree-orphans";
import { isUnderPath } from "./worktree-orphans";
import { canonicalizeWorktree } from "./worktree-orphans-ps";
import {
  defaultBranchOf,
  headContained,
  listPrs,
  localConfigDiffers,
  type PrIndex,
} from "./worktree-sweep-containment";
import type { UsageIndex } from "./worktree-sweep-usage";
import {
  pickDecisivePr,
  type PrFact,
  type WorktreeFacts,
} from "./worktree-sweep-rules";

export type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};
export type SweepRun = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number },
) => RunResult;

export type FactDeps = {
  run: SweepRun;
  listStates: () => PipelineState[];
  liveness: (s: PipelineState) => Liveness;
  windowOpen: (slug: string) => boolean;
  cwd: string;
  nowMs: () => number;
  /** Canonical paths of the running flow checkout (config source, install root). */
  flowSourcePaths: string[];
  /** `undefined` = process table unreadable. */
  listProcs: () => OrphanProc[] | undefined;
  /** `undefined` = working directories unreadable. */
  readCwds: (pids: number[]) => Map<number, string> | undefined;
  /** The sweep's own pid and its ancestors: never counted as "in use". */
  selfPids: number[];
};

const ok = (r: RunResult): boolean => r.status === 0 && !r.timedOut;

function listWorktrees(repo: string, deps: FactDeps) {
  const r = deps.run("git", ["worktree", "list", "--porcelain"], {
    cwd: repo,
    timeoutMs: 5_000,
  });
  return ok(r) ? parseWorktreeListOutput(r.stdout) : null;
}

function hasFlowFingerprint(dir: string): boolean {
  try {
    const exclude = fs.readFileSync(
      path.join(dir, ".git", "info", "exclude"),
      "utf8",
    );
    const lines = new Set(exclude.split("\n").map((l) => l.trim()));
    return FLOW_EXCLUDE_PATHS.every((p) => lines.has(p));
  } catch {
    return false;
  }
}

/** Primary checkouts of: pipeline-record repos, the launching directory's repo, and flow-fingerprinted siblings. */
export function discoverFlowRepos(deps: FactDeps): string[] {
  const seeds = new Set<string>([deps.cwd]);
  for (const s of deps.listStates()) if (s.repo) seeds.add(s.repo);
  const repos = new Set<string>();
  for (const seed of seeds) {
    const first = listWorktrees(seed, deps)?.[0];
    if (first) repos.add(canonicalizeWorktree(first.path));
  }
  for (const repo of [...repos]) {
    const parent = path.dirname(repo);
    let names: string[] = [];
    try {
      names = fs.readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = path.join(parent, name);
      try {
        if (!fs.lstatSync(path.join(dir, ".git")).isDirectory()) continue;
      } catch {
        continue;
      }
      if (hasFlowFingerprint(dir)) repos.add(canonicalizeWorktree(dir));
    }
  }
  return [...repos];
}

export function gatherWorktreeFacts(
  repo: string,
  deps: FactDeps,
  usage: UsageIndex,
  deadlineAtMs: number,
): WorktreeFacts[] {
  const entries = listWorktrees(repo, deps);
  if (!entries) return [];
  const candidates = entries.slice(1).filter((e) => !e.bare && !e.prunable);
  if (candidates.length === 0) return [];

  const owned = deps
    .listStates()
    .flatMap((s) =>
      [s.worktree, s.reservedWorktree]
        .filter((p): p is string => Boolean(p))
        .map((p) => ({ s, p: canonicalizeWorktree(p) })),
    );
  const defaultBranch = defaultBranchOf(repo, deps.run);
  const prIndex: PrIndex = candidates.some((e) => e.branch)
    ? listPrs(repo, deps.run)
    : new Map();

  return candidates.map((e) => {
    const wt = canonicalizeWorktree(e.path);
    const prs: WorktreeFacts["prs"] =
      prIndex === "unreachable"
        ? "unreachable"
        : (e.branch && prIndex.get(e.branch)) || [];
    const owners = owned
      .filter((o) => o.p === wt)
      .map(({ s }) => ({
        slug: s.slug,
        phase: s.phase,
        liveness: deps.liveness(s),
        windowOpen: deps.windowOpen(s.slug),
      }));
    const decisive = prs === "unreachable" ? undefined : pickDecisivePr(prs);
    const hasOpen =
      prs !== "unreachable" && prs.some((p) => p.state === "OPEN");
    // Only a folder that could actually be removed pays for the slow checks;
    // the rest get fail-closed placeholders the rules never reach.
    let dirty: WorktreeFacts["dirty"] = "unknown";
    let contained: WorktreeFacts["headContained"] = "unknown";
    let configDiffers = true;
    if (decisive && !hasOpen && !e.locked) {
      const st = deps.run("git", ["status", "--porcelain"], {
        cwd: wt,
        timeoutMs: 10_000,
      });
      dirty = ok(st) ? st.stdout.trim() !== "" : "unknown";
      contained = headContained(wt, repo, defaultBranch, decisive, deps.run);
      configDiffers = localConfigDiffers(wt, repo, deps.run);
    }
    return {
      path: wt,
      repo,
      branch: e.branch,
      locked: Boolean(e.locked),
      isFlowSource: deps.flowSourcePaths.some((p) => isUnderPath(p, wt)),
      owners,
      processesInside: usage.processesSkipped
        ? "unknown"
        : usage.processesInside(wt),
      containersMounting: usage.containersMounting(wt),
      prs,
      dirty,
      localConfigDiffers: configDiffers,
      headContained: contained,
      deadlineReached: deps.nowMs() >= deadlineAtMs,
    };
  });
}
