/**
 * Shared, skill-agnostic resume probes used by BOTH `flow-resume-decide.ts`
 * (the feature pipeline resume decider) and `flow-epic-resume-decide.ts` (the
 * epic-designer resume decider). These probes answer pure I/O questions — "is
 * the worktree present? does a PR exist for this branch? what is the HEAD
 * subject?" — and know nothing about either skill's phase set, so they are the
 * genuinely-common surface the two thin deciders share (the Q7 middle ground).
 *
 * This is an INTERNAL import module: no shebang, no `import.meta.main`, NOT on
 * PATH. The feature-specific probes (`probePlan`, `probeSkillAdditions`,
 * `probeCi`, `resolveDefaultBranch`) stay in `flow-resume-decide.ts`.
 */

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

export type WorktreeInfo =
  | { kind: "absent-from-state" }
  | { kind: "missing-on-disk"; path: string }
  | { kind: "present"; path: string };

export type PrInfo =
  | { kind: "none" }
  | {
      kind: "found";
      state: "OPEN" | "MERGED" | "CLOSED";
      number: number;
      url: string;
    };

export type HeadCommit = { subject: string; body: string };

type CmdResult = { stdout: string; stderr: string; exitCode: number };
export type GhRunner = (argv: string[]) => CmdResult;
export type GitRunner = (argv: string[], cwd: string) => CmdResult;

export const defaultGh: GhRunner = (argv) => {
  const r = spawnSync("gh", argv, { encoding: "utf8" });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };
};

export const defaultGit: GitRunner = (argv, cwd) => {
  const r = spawnSync("git", argv, { cwd, encoding: "utf8" });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };
};

/** Probes the worktree path's status. Used by the runner to build Inputs.worktree. */
export function probeWorktree(
  stateWorktree: string | undefined,
  git: GitRunner,
): WorktreeInfo {
  if (!stateWorktree) return { kind: "absent-from-state" };
  if (!fs.existsSync(stateWorktree)) {
    return { kind: "missing-on-disk", path: stateWorktree };
  }
  const r = git(["rev-parse", "--is-inside-work-tree"], stateWorktree);
  if (r.exitCode !== 0 || r.stdout.trim() !== "true") {
    // Directory exists but isn't a git checkout — treat as missing-on-disk
    // for safety; the supervisor escalates either way.
    return { kind: "missing-on-disk", path: stateWorktree };
  }
  return { kind: "present", path: stateWorktree };
}

/** Reads the HEAD commit's subject + body via `git log -1 --pretty=%B`. */
export function probeHeadCommit(
  worktreePath: string,
  git: GitRunner,
): HeadCommit | null {
  const r = git(["log", "-1", "--pretty=%B"], worktreePath);
  if (r.exitCode !== 0) return null;
  const lines = r.stdout.replace(/\n+$/, "").split("\n");
  const subject = lines[0] ?? "";
  const body = lines.slice(1).join("\n").replace(/^\n+/, "");
  return { subject, body };
}

/**
 * Looks up the current branch's PR via `gh pr view <branch>`. Maps gh's
 * "no PRs found" stderr to {kind: "none"}; treats anything else as not-found
 * (the resume tree should not crash on transient gh errors).
 */
export function probePr(branch: string, gh: GhRunner): PrInfo {
  const r = gh(["pr", "view", branch, "--json", "number,state,url"]);
  if (r.exitCode !== 0) {
    if (/no pull requests? found|no pull request associated/i.test(r.stderr)) {
      return { kind: "none" };
    }
    return { kind: "none" };
  }
  try {
    const parsed = JSON.parse(r.stdout) as {
      number?: number;
      state?: string;
      url?: string;
    };
    if (
      typeof parsed.number !== "number" ||
      typeof parsed.url !== "string" ||
      (parsed.state !== "OPEN" &&
        parsed.state !== "MERGED" &&
        parsed.state !== "CLOSED")
    ) {
      return { kind: "none" };
    }
    return {
      kind: "found",
      number: parsed.number,
      state: parsed.state,
      url: parsed.url,
    };
  } catch {
    return { kind: "none" };
  }
}

/** Computes the worktree's current branch (used for `gh pr view <branch>`). */
export function probeBranch(
  worktreePath: string,
  git: GitRunner,
): string | null {
  const r = git(["branch", "--show-current"], worktreePath);
  if (r.exitCode !== 0) return null;
  const branch = r.stdout.trim();
  return branch.length > 0 ? branch : null;
}
