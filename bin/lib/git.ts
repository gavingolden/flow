import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/**
 * Runs a git command and returns trimmed stdout. Throws on non-zero exit
 * with the trimmed stderr (or a synthetic "git <subcmd> failed" message).
 *
 * Shared by the worktree helpers — `bin/flow-new-worktree.ts`,
 * `bin/lib/worktree-slot.ts`, `bin/lib/worktree-marker.ts`,
 * `bin/lib/worktree-fs.ts`. Other `bin/lib/*` modules predate this helper
 * and inline `spawnSync` directly; migrate them opportunistically.
 *
 * Exports `resolveDefaultBranch` (fail-open variant of `detectDefaultBranch`
 * from `bin/lib/worktree-fs.ts`) and `fastForwardCanonical` (used by
 * `bin/lib/setup.ts` to opportunistically advance the canonical install
 * tree before discovery).
 */
export function git(args: string[], cwd?: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(
      stderr || `git ${args[0]} failed with exit code ${result.status}`,
    );
  }
  return (result.stdout ?? "").trim();
}

export type Spawner = (
  cmd: string,
  args: string[],
  options: { cwd?: string; encoding: "utf8"; timeout?: number },
) => SpawnSyncReturns<string>;

const defaultSpawn: Spawner = (cmd, args, options) =>
  spawnSync(cmd, args, options);

/**
 * Fail-open default-branch resolver. Tries `git symbolic-ref
 * refs/remotes/origin/HEAD`, then parses `git remote show origin` for the
 * `HEAD branch:` line, then falls back to "main"/"master" only if
 * `git rev-parse --verify` confirms the corresponding remote-tracking ref
 * exists. Returns `null` on hard failure (no ref resolves) — the throwing
 * variant is `detectDefaultBranch` in `bin/lib/worktree-fs.ts`.
 */
export function resolveDefaultBranch(
  repoDir: string,
  spawn: Spawner = defaultSpawn,
): string | null {
  const symbolic = spawn("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  if (symbolic.status === 0 && symbolic.stdout) {
    const ref = symbolic.stdout.trim();
    if (ref.startsWith("refs/remotes/origin/")) {
      return ref.slice("refs/remotes/origin/".length);
    }
  }

  const remoteShow = spawn("git", ["remote", "show", "origin"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  if (remoteShow.status === 0 && remoteShow.stdout) {
    const match = remoteShow.stdout.match(/^\s*HEAD branch:\s*(\S+)\s*$/m);
    if (match && match[1] && match[1] !== "(unknown)") {
      return match[1];
    }
  }

  for (const candidate of ["main", "master"]) {
    const verify = spawn(
      "git",
      ["rev-parse", "--verify", `refs/remotes/origin/${candidate}`],
      { cwd: repoDir, encoding: "utf8" },
    );
    if (verify.status === 0) return candidate;
  }

  return null;
}

export type FastForwardStatus = "ahead" | "up-to-date" | "skipped";

export type FastForwardSkippedReason =
  | "dirty"
  | "non-default-branch"
  | "fetch-failed"
  | "no-default-branch"
  | "merge-failed"
  | "not-a-git-repo";

export type FastForwardResult = {
  status: FastForwardStatus;
  reason?: FastForwardSkippedReason;
  advanced?: number;
  /** Short HEAD SHA before the --ff-only merge (set on an `ahead` result). */
  beforeSha?: string;
  /** Short HEAD SHA after the --ff-only merge (set on an `ahead` result). */
  afterSha?: string;
};

export type FastForwardOptions = {
  canonicalRoot: string;
  spawn?: Spawner;
};

/**
 * Opportunistically fast-forwards `<canonicalRoot>` to `origin/<default>`.
 * Never throws — returns a typed `skipped` reason on any failure so callers
 * (`flow setup --upgrade`) can log and continue. Only advances when the
 * working tree is clean, the current branch matches the default, and the
 * fetch succeeds.
 */
export function fastForwardCanonical(
  opts: FastForwardOptions,
): FastForwardResult {
  const spawn = opts.spawn ?? defaultSpawn;
  const cwd = opts.canonicalRoot;

  const status = spawn("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
  });
  if (status.status !== 0) {
    return { status: "skipped", reason: "not-a-git-repo" };
  }
  if ((status.stdout ?? "").trim().length > 0) {
    return { status: "skipped", reason: "dirty" };
  }

  const defaultBranch = resolveDefaultBranch(cwd, spawn);
  if (!defaultBranch) {
    return { status: "skipped", reason: "no-default-branch" };
  }

  const head = spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (head.status !== 0 || (head.stdout ?? "").trim() !== defaultBranch) {
    return { status: "skipped", reason: "non-default-branch" };
  }

  const fetch = spawn("git", ["fetch", "origin", defaultBranch], {
    cwd,
    encoding: "utf8",
  });
  if (fetch.status !== 0) {
    return { status: "skipped", reason: "fetch-failed" };
  }

  const count = spawn(
    "git",
    ["rev-list", "--count", `HEAD..origin/${defaultBranch}`],
    { cwd, encoding: "utf8" },
  );
  const advanced = (() => {
    if (count.status !== 0) return 0;
    const n = Number((count.stdout ?? "").trim());
    return Number.isFinite(n) ? n : 0;
  })();

  if (advanced === 0) {
    return { status: "up-to-date" };
  }

  const shortHead = (): string | undefined => {
    const r = spawn("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
    });
    if (r.status !== 0) return undefined;
    const s = (r.stdout ?? "").trim();
    return s.length > 0 ? s : undefined;
  };

  const beforeSha = shortHead();

  const merge = spawn(
    "git",
    ["merge", "--ff-only", `origin/${defaultBranch}`],
    { cwd, encoding: "utf8" },
  );
  if (merge.status !== 0) {
    return { status: "skipped", reason: "merge-failed" };
  }

  const afterSha = shortHead();

  return { status: "ahead", advanced, beforeSha, afterSha };
}

export type ChangedInstallPathsOptions = {
  canonicalRoot: string;
  beforeSha?: string;
  afterSha?: string;
  spawn?: Spawner;
};

/**
 * Maps the files changed across the advanced commit range to installed
 * skill/helper display names: a skill is the directory owning `SKILL.md`
 * under `skills/...`; a helper is `bin/<name>.ts` (basename, `.ts` dropped,
 * `.test.ts` ignored). Deduped, order-stable. Purely a reporting helper for
 * `flow setup --upgrade`'s changed-list — it NEVER throws: any git error,
 * missing SHA, or empty diff yields `[]`.
 */
export function changedInstallPaths(
  opts: ChangedInstallPathsOptions,
): string[] {
  const { canonicalRoot, beforeSha, afterSha } = opts;
  if (!beforeSha || !afterSha) return [];

  const spawn = opts.spawn ?? defaultSpawn;
  const diff = spawn(
    "git",
    ["-C", canonicalRoot, "diff", "--name-only", `${beforeSha}..${afterSha}`],
    { cwd: canonicalRoot, encoding: "utf8" },
  );
  if (diff.status !== 0) return [];

  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  for (const line of (diff.stdout ?? "").split("\n")) {
    const file = line.trim();
    if (file.length === 0) continue;

    if (file.startsWith("skills/")) {
      // The skill is the directory immediately above SKILL.md. For any path
      // under skills/<tier>/<name>/..., that's the segment at index 2.
      const parts = file.split("/");
      if (parts.length >= 4) add(parts[2]);
      continue;
    }

    if (file.startsWith("bin/")) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      // Only top-level helpers (bin/<name>.ts) are installed on PATH; nested
      // bin/lib/*.ts modules are not user-facing helpers.
      const parts = file.split("/");
      if (parts.length !== 2) continue;
      add(parts[1].slice(0, -".ts".length));
    }
  }

  return names;
}
