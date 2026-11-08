/**
 * Pure keep-or-remove rules for the worktree sweep. No I/O: every fact a
 * verdict needs is gathered elsewhere (worktree-sweep-facts / -husks) and
 * handed in, so each guard is a one-line unit test.
 *
 * Guard order is the contract: the first failing guard wins and names the
 * hold reason the user sees.
 */

import type { Liveness } from "./liveness";
import { FINISHED_PHASE_SET } from "./state";

export type HoldReason =
  | "locked"
  | "flow-source"
  | "contains-launch-dir"
  | "no-branch"
  | "live-session"
  | "session-unknown"
  | "in-use-process"
  | "in-use-container"
  | "gh-unreachable"
  | "no-pr"
  | "pr-open"
  | "uncommitted-changes"
  | "local-config-differs"
  | "head-not-on-github"
  | "deadline-reached"
  | "registered-worktree"
  | "reserved-by-pipeline"
  | "too-recent"
  | "too-large-to-scan"
  | "unrecognized-contents";

export type HuskCause =
  | "unused-launch-folder"
  | "supabase-container-mounts"
  | "dev-server-cache"
  | "ide-project-files"
  | "mixed-caches";

export type PrFact = {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  headOid: string;
};

export type ProcFact = { pid: number; command: string };

export type WorktreeFacts = {
  path: string;
  repo: string;
  branch?: string;
  locked: boolean;
  isFlowSource: boolean;
  /** The directory the sweep was launched from is inside this folder. */
  containsLaunchDir: boolean;
  owners: Array<{
    slug: string;
    phase: string;
    liveness: Liveness;
    windowOpen: boolean;
  }>;
  /** `"unknown"` = the process table could not be read; fails closed. */
  processesInside: ProcFact[] | "unknown";
  /** `"unknown"` = Docker could not be checked; fails closed. */
  containersMounting: string[] | "unknown";
  prs: PrFact[] | "unreachable";
  dirty: boolean | "unknown";
  localConfigDiffers: boolean;
  headContained: boolean | "unknown";
  deadlineReached: boolean;
};

export type WorktreeVerdict =
  | {
      action: "remove";
      reason: "pr-merged" | "pr-closed";
      pr: number;
      headOid: string;
      deleteBranch: boolean;
    }
  | { action: "hold"; reason: HoldReason; detail?: string };

export const CACHE_SEGMENTS: ReadonlySet<string> = new Set([
  ".vite",
  ".svelte-kit",
  "node_modules",
  ".flow-tmp",
]);
export const HUSK_MIN_AGE_MS = 3_600_000;
export const HUSK_SCAN_CAP = 5000;

const hold = (reason: HoldReason, detail?: string): WorktreeVerdict =>
  detail === undefined
    ? { action: "hold", reason }
    : { action: "hold", reason, detail };

/** The PR a folder's fate hangs on: newest MERGED, else newest CLOSED. */
export function pickDecisivePr(prs: PrFact[]): PrFact | undefined {
  const newest = (state: PrFact["state"]): PrFact | undefined =>
    prs.filter((p) => p.state === state).sort((a, b) => b.number - a.number)[0];
  return newest("MERGED") ?? newest("CLOSED");
}

export function decideWorktree(f: WorktreeFacts): WorktreeVerdict {
  if (f.locked) return hold("locked");
  if (f.isFlowSource) return hold("flow-source");
  if (f.containsLaunchDir) return hold("contains-launch-dir");
  if (!f.branch) return hold("no-branch");

  const live = f.owners.find((o) => o.liveness === "alive" || o.windowOpen);
  if (live) return hold("live-session", live.slug);
  const unknown = f.owners.find(
    (o) => o.liveness === "unknown" && !FINISHED_PHASE_SET.has(o.phase),
  );
  if (unknown) return hold("session-unknown", unknown.slug);

  if (f.processesInside === "unknown") {
    return hold("in-use-process", "could not read running processes");
  }
  if (f.processesInside.length > 0) {
    return hold(
      "in-use-process",
      f.processesInside.map((p) => `${p.command} (pid ${p.pid})`).join(", "),
    );
  }
  if (f.containersMounting === "unknown") {
    return hold("in-use-container", "could not check Docker");
  }
  if (f.containersMounting.length > 0) {
    return hold("in-use-container", f.containersMounting.join(", "));
  }

  if (f.prs === "unreachable") return hold("gh-unreachable");
  if (f.prs.length === 0) return hold("no-pr");
  const open = f.prs.find((p) => p.state === "OPEN");
  if (open) return hold("pr-open", `#${open.number}`);

  if (f.deadlineReached) return hold("deadline-reached");
  if (f.dirty !== false) return hold("uncommitted-changes");
  if (f.localConfigDiffers) return hold("local-config-differs");
  if (f.headContained !== true) return hold("head-not-on-github");

  const pr = pickDecisivePr(f.prs);
  if (!pr) return hold("no-pr");
  return {
    action: "remove",
    reason: pr.state === "MERGED" ? "pr-merged" : "pr-closed",
    pr: pr.number,
    headOid: pr.headOid,
    deleteBranch: pr.state === "MERGED",
  };
}

export type HuskFacts = {
  path: string;
  repo: string;
  files: string[];
  topLevel: string[];
  scanTruncated: boolean;
  /** Max mtime over files AND every walked directory (root included). */
  newestMtimeMs: number;
  nowMs: number;
  registered: boolean;
  reservedByActive: boolean;
  processesInside: ProcFact[];
  processesUnknown: boolean;
  containsLaunchDir: boolean;
  /** `"unknown"` = Docker could not be checked; fails closed. */
  containersMounting: string[] | "unknown";
};

export type HuskVerdict =
  | {
      action: "remove";
      reason: "husk-empty" | "husk-cache-only";
      cause: HuskCause;
    }
  | {
      action: "hold";
      reason: HoldReason;
      topLevel?: string[];
      cause?: HuskCause;
      detail?: string;
    };

const isCacheFile = (rel: string): boolean =>
  rel.split("/").some((seg) => CACHE_SEGMENTS.has(seg));

function removeCause(f: HuskFacts): HuskCause {
  if (f.files.length === 0) {
    return (f.containersMounting !== "unknown" &&
      f.containersMounting.length > 0) ||
      f.topLevel.includes("supabase")
      ? "supabase-container-mounts"
      : "unused-launch-folder";
  }
  const onlyDevCache = f.files.every((rel) => {
    const segs = rel.split("/");
    return segs.includes(".vite") || segs.includes(".svelte-kit");
  });
  return onlyDevCache ? "dev-server-cache" : "mixed-caches";
}

export function decideHusk(f: HuskFacts): HuskVerdict {
  if (f.registered) return { action: "hold", reason: "registered-worktree" };
  if (f.containsLaunchDir) {
    return { action: "hold", reason: "contains-launch-dir" };
  }
  if (f.reservedByActive) {
    return { action: "hold", reason: "reserved-by-pipeline" };
  }
  if (f.processesUnknown) {
    return {
      action: "hold",
      reason: "in-use-process",
      detail: "could not read running processes",
    };
  }
  if (f.processesInside.length > 0) {
    return {
      action: "hold",
      reason: "in-use-process",
      detail: f.processesInside
        .map((p) => `${p.command} (pid ${p.pid})`)
        .join(", "),
    };
  }
  if (f.containersMounting === "unknown") {
    return {
      action: "hold",
      reason: "in-use-container",
      detail: "could not check Docker",
    };
  }
  if (f.nowMs - f.newestMtimeMs < HUSK_MIN_AGE_MS) {
    return { action: "hold", reason: "too-recent" };
  }
  if (f.scanTruncated) return { action: "hold", reason: "too-large-to-scan" };

  const unrecognized = f.files.filter((rel) => !isCacheFile(rel));
  if (unrecognized.length > 0) {
    const tops = [...new Set(unrecognized.map((rel) => rel.split("/")[0]))];
    return {
      action: "hold",
      reason: "unrecognized-contents",
      topLevel: tops,
      ...(tops.every((t) => t === ".idea")
        ? { cause: "ide-project-files" as const }
        : {}),
    };
  }
  return {
    action: "remove",
    reason: f.files.length === 0 ? "husk-empty" : "husk-cache-only",
    cause: removeCause(f),
  };
}
