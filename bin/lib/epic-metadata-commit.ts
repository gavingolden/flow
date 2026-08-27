/**
 * Single seam owning the epic-metadata path predicate, the path-scoped board
 * commit, the never-forcing push, the dirty-probe, and the repo-committability
 * probe. `flow-epic-sync.ts`, `epic.ts`, and `flow-stop-guard.ts` all import
 * from here so the base-branch allowlist and both writers cannot drift apart.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { type GitRunner, defaultGit } from "./resume-probes";
import {
  EPIC_STATUS_FILENAME,
  EPICS_DIR_RELATIVE,
  epicDirRelative,
} from "./epic-manifest-schema";
import { resolveRepoRoot } from "./repo-root";
export { isCommittableOnBaseBranch } from "./base-branch-guard";

export type { GitRunner };

export type CommitSkipReason =
  | "not-a-repo"
  | "nothing-staged"
  | "commit-refused"
  | "git-error";

export type PushSkipReason =
  | "not-committed"
  | "detached-head"
  | "not-base-branch"
  | "no-remote"
  | "no-remote-branch"
  | "non-fast-forward"
  | "push-failed";

export type RepoState = "clean" | "rebase" | "merge" | "detached";

export function epicStatusRelPath(epicSlug: string): string {
  return `${epicDirRelative(epicSlug)}/${EPIC_STATUS_FILENAME}`;
}

function toRel(repoRoot: string, absPath: string): string | null {
  const rel = path.relative(repoRoot, absPath).split(path.sep).join("/");
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : rel;
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").slice(0, 200);
}

/**
 * Commits EXACTLY the board just written. Takes the ABSOLUTE path that was
 * just written (not a recomputed repoRoot+slug path) — both writers derive
 * the board path from a per-machine run-state cache that can go stale or
 * point cross-repo, and a recomputed path would then be a DIFFERENT file:
 * the commit would report `nothing-staged` while the real edit stayed dirty.
 */
export function commitEpicStatus(input: {
  writtenPath: string;
  epicSlug: string;
  message?: string;
  git?: GitRunner;
}): { committed: boolean; reason?: CommitSkipReason; detail?: string } {
  const git = input.git ?? defaultGit;
  try {
    const repoRoot = resolveRepoRoot(path.dirname(input.writtenPath));
    if (!repoRoot) return { committed: false, reason: "not-a-repo" };
    // `resolveRepoRoot` shells out to `git rev-parse --show-toplevel`, which
    // resolves symlinks in its answer (e.g. macOS's /var -> /private/var);
    // realpath-normalize writtenPath too, or a symlinked tmpdir-style path
    // would false-negative into "not-a-repo" even though it IS inside repoRoot.
    const realWritten = fs.realpathSync(input.writtenPath);
    const rel = toRel(repoRoot, realWritten);
    if (!rel) return { committed: false, reason: "not-a-repo" };

    const status = git(["status", "--porcelain", "--", rel], repoRoot);
    if (status.stdout.trim().length === 0) {
      return { committed: false, reason: "nothing-staged" };
    }
    const message =
      input.message ?? `chore(epic): sync ${input.epicSlug} status board`;

    // `git commit -- <path>` alone refuses a brand-new UNTRACKED path
    // ("pathspec did not match any files known to git"); a path-scoped
    // `git add -- <path>` first (never a bare, whole-index `git add`) makes
    // the first-ever write and a later modification commit identically,
    // without touching any OTHER staged path.
    const added = git(["add", "--", rel], repoRoot);
    if (added.exitCode !== 0) {
      return {
        committed: false,
        reason: "git-error",
        detail: firstLine(added.stderr),
      };
    }
    const committed = git(["commit", "-m", message, "--", rel], repoRoot);
    if (committed.exitCode !== 0) {
      return {
        committed: false,
        reason: "commit-refused",
        detail: firstLine(committed.stderr),
      };
    }
    return { committed: true };
  } catch (err) {
    return {
      committed: false,
      reason: "git-error",
      detail: firstLine(String(err)),
    };
  }
}

const defaultPushGit: GitRunner = (argv, cwd) => {
  const r = spawnSync("git", argv, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };
};

function resolveDefaultBranch(repoRoot: string, git: GitRunner): string {
  const symbolic = git(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    repoRoot,
  );
  if (symbolic.exitCode === 0 && symbolic.stdout.trim()) {
    return symbolic.stdout.trim().replace(/^origin\//, "");
  }
  for (const b of ["main", "master"]) {
    if (
      git(["show-ref", "--verify", "--quiet", `refs/heads/${b}`], repoRoot)
        .exitCode === 0
    ) {
      return b;
    }
  }
  return "main";
}

/**
 * Pushes EXACTLY the branch's HEAD to its already-existing remote branch.
 * NEVER forces, NEVER creates a remote ref, and only ever runs on the repo's
 * default branch — `git push origin HEAD:<branch>` publishes every local
 * commit on that branch, not just the board commit, so from a
 * mid-implementation feature-pipeline worktree an ungated push would publish
 * unverified code past the pipeline's own verify/CI gate.
 */
export function pushEpicStatus(input: { repoRoot: string; git?: GitRunner }): {
  pushed: boolean;
  reason?: PushSkipReason;
  detail?: string;
} {
  const git = input.git ?? defaultPushGit;
  const repoRoot = input.repoRoot;
  try {
    const headRef = git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
    if (headRef.exitCode !== 0 || headRef.stdout.trim() === "HEAD") {
      return { pushed: false, reason: "detached-head" };
    }
    const branch = headRef.stdout.trim();
    if (branch !== resolveDefaultBranch(repoRoot, git)) {
      return { pushed: false, reason: "not-base-branch" };
    }
    if (git(["remote", "get-url", "origin"], repoRoot).exitCode !== 0) {
      return { pushed: false, reason: "no-remote" };
    }
    if (
      git(["ls-remote", "--exit-code", "--heads", "origin", branch], repoRoot)
        .exitCode !== 0
    ) {
      return { pushed: false, reason: "no-remote-branch" };
    }

    const pushed = git(
      [
        "-c",
        "core.askPass=",
        "-c",
        "credential.helper=",
        "push",
        "origin",
        `HEAD:${branch}`,
      ],
      repoRoot,
    );
    if (pushed.exitCode !== 0) {
      const reason: PushSkipReason =
        /non-fast-forward|fetch first|rejected/i.test(pushed.stderr)
          ? "non-fast-forward"
          : "push-failed";
      return { pushed: false, reason, detail: firstLine(pushed.stderr) };
    }
    return { pushed: true };
  } catch (err) {
    return {
      pushed: false,
      reason: "push-failed",
      detail: firstLine(String(err)),
    };
  }
}

function parsePorcelainPath(line: string): string {
  const raw = line.slice(3);
  const arrowIdx = raw.indexOf(" -> ");
  const p = (arrowIdx === -1 ? raw : raw.slice(arrowIdx + 4)).trim();
  return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
}

/**
 * Never throws, fail-open to []. Includes staged, unstaged, AND untracked
 * (porcelain lists untracked by default) — intended, so a brand-new epic dir
 * is also un-strandable.
 */
export function dirtyEpicMetadata(input: {
  repoRoot: string;
  git?: GitRunner;
}): string[] {
  const git = input.git ?? defaultGit;
  try {
    if (!input.repoRoot) return [];
    if (!fs.existsSync(path.join(input.repoRoot, EPICS_DIR_RELATIVE)))
      return [];
    const result = git(
      ["status", "--porcelain", "--", EPICS_DIR_RELATIVE],
      input.repoRoot,
    );
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map(parsePorcelainPath);
  } catch {
    return [];
  }
}

/** Never throws — any failure returns "clean". Worktrees have a FILE, not a
 * dir, at .git, so the git-dir must be resolved via `rev-parse --git-dir`
 * rather than assumed to be `<repoRoot>/.git`. */
export function repoCommitState(input: {
  repoRoot: string;
  git?: GitRunner;
}): RepoState {
  const git = input.git ?? defaultGit;
  try {
    const gitDirResult = git(["rev-parse", "--git-dir"], input.repoRoot);
    if (gitDirResult.exitCode !== 0) return "clean";
    const gitDirRaw = gitDirResult.stdout.trim();
    const gitDir = path.isAbsolute(gitDirRaw)
      ? gitDirRaw
      : path.join(input.repoRoot, gitDirRaw);

    if (
      fs.existsSync(path.join(gitDir, "rebase-apply")) ||
      fs.existsSync(path.join(gitDir, "rebase-merge"))
    ) {
      return "rebase";
    }
    if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) return "merge";
    return git(["symbolic-ref", "-q", "HEAD"], input.repoRoot).exitCode !== 0
      ? "detached"
      : "clean";
  } catch {
    return "clean";
  }
}
