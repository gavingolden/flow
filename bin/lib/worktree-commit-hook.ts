import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { git } from "./git";

/**
 * Every client-side hook name in githooks(5). A flow worktree's hooks folder
 * replaces the repo's own (`core.hooksPath` is all-or-nothing per worktree),
 * so each name gets a chaining shim — a name left out would silently switch
 * that consumer hook off inside pipeline worktrees.
 */
export const FLOW_HOOK_NAMES: readonly string[] = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-auto-gc",
  "post-rewrite",
  "reference-transaction",
  "post-index-change",
  "sendemail-validate",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
];

/** Marker line identifying a flow-written chaining shim. */
const CHAIN_HOOK_MARKER = "# flow:worktree-hook-chain v1";

/**
 * One POSIX `sh` body installed under every name in `FLOW_HOOK_NAMES`; it
 * dispatches on `basename $0`. At run time it finds the consumer's hooks
 * folder — the last non-`worktree`-scope `core.hooksPath` (relative values
 * resolve against `$PWD`, where git starts hooks), else the repo's default
 * `<common-dir>/hooks` — and runs the consumer's hook of the same name:
 * `exec` for every name (stdin reaches pre-push / reference-transaction),
 * except `prepare-commit-msg`, which runs first and is then followed by the
 * `Claude-Code-Session-Id:` trailer (`--if-exists doNothing` keeps an amend
 * idempotent). An absent hook is a no-op.
 *
 * NEVER resolve the folder with `git rev-parse --git-path hooks`: inside a
 * flow worktree that answers the flow folder itself and would loop. A
 * resolved folder equal to the flow folder is skipped for the same reason.
 * Git's hook environment (including a temporary `GIT_INDEX_FILE`) is passed
 * through untouched.
 *
 * Authored as `#!/bin/sh` — NOT a Bun shebang — because git invokes it on
 * every hook event and a per-event interpreter start is real latency.
 */
export const CHAIN_HOOK_SHIM = `#!/bin/sh
${CHAIN_HOOK_MARKER}
name=\${0##*/}
case "$0" in */*) own=\${0%/*} ;; *) own=. ;; esac
own=$(cd "$own" 2>/dev/null && pwd -P)

tab=$(printf '\\t')
dir=$(git config --type=path --show-scope --get-all core.hooksPath 2>/dev/null |
  { last=; while IFS=$tab read -r scope value; do
      [ "$scope" = worktree ] || last=$value
    done; printf '%s' "$last"; })
if [ -z "$dir" ]; then
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  [ -n "$common" ] && dir=$common/hooks
else
  case "$dir" in /*) ;; *) dir=$PWD/$dir ;; esac
fi

hook=
if [ -n "$dir" ]; then
  dir=$(cd "$dir" 2>/dev/null && pwd -P)
  if [ -n "$dir" ] && [ "$dir" != "$own" ] && [ -f "$dir/$name" ] && [ -x "$dir/$name" ]; then
    hook=$dir/$name
  fi
fi

if [ "$name" != prepare-commit-msg ]; then
  [ -n "$hook" ] && exec "$hook" "$@"
  exit 0
fi

if [ -n "$hook" ]; then
  "$hook" "$@" || exit $?
fi
if [ -n "$CLAUDE_CODE_SESSION_ID" ]; then
  git interpret-trailers --if-exists doNothing --in-place \\
    --trailer "Claude-Code-Session-Id: $CLAUDE_CODE_SESSION_ID" "$1"
fi
`;

/** Flow-owned hooks directory name, placed inside the worktree's git-dir. */
const FLOW_HOOKS_DIRNAME = "flow-hooks";

function absGitDirOf(dir: string): string {
  const gitDir = git(["rev-parse", "--git-dir"], dir);
  return path.isAbsolute(gitDir) ? gitDir : path.join(dir, gitDir);
}

function readConfig(args: string[], cwd: string): string | null {
  try {
    return git(["config", ...args], cwd);
  } catch {
    return null;
  }
}

/**
 * Machine-wide home of the one shim file every flow worktree's hook names
 * link to, so macOS scans that file once instead of once per hook copy per
 * worktree. The path embeds a hash of the shim body: a body change lands in a
 * new file, and old-hash files are left behind. Resolves `os.homedir()` at
 * call time (never `paths.ts` constants, which freeze at import) so a test
 * sandbox's `$HOME` is honoured.
 */
export function sharedHookShimPath(homeDir: string = os.homedir()): string {
  const hash = createHash("sha256")
    .update(CHAIN_HOOK_SHIM)
    .digest("hex")
    .slice(0, 12);
  return path.join(homeDir, ".flow", "hooks", `worktree-chain-shim-${hash}.sh`);
}

function tmpSibling(target: string): string {
  const rand = randomBytes(4).toString("hex");
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${rand}.tmp`,
  );
}

function shimFileIsCurrent(shimPath: string): boolean {
  try {
    return (
      fs.readFileSync(shimPath, "utf8") === CHAIN_HOOK_SHIM &&
      (fs.statSync(shimPath).mode & 0o777) === 0o755
    );
  } catch {
    return false;
  }
}

/**
 * Temp file + rename, never an in-place write: a write-through via a hook
 * link can corrupt the shared inode, and rename detaches it.
 */
function ensureSharedHookShim(): string {
  const shimPath = sharedHookShimPath();
  if (shimFileIsCurrent(shimPath)) return shimPath;
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  const tmpPath = tmpSibling(shimPath);
  fs.writeFileSync(tmpPath, CHAIN_HOOK_SHIM, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(tmpPath, 0o755);
  fs.renameSync(tmpPath, shimPath);
  return shimPath;
}

function copyIsCurrent(hookPath: string): boolean {
  try {
    return (
      !fs.lstatSync(hookPath).isSymbolicLink() && shimFileIsCurrent(hookPath)
    );
  } catch {
    return false;
  }
}

function linkIsCurrent(hookPath: string, shimPath: string): boolean {
  try {
    return (
      fs.lstatSync(hookPath).isSymbolicLink() &&
      fs.readlinkSync(hookPath) === shimPath
    );
  } catch {
    return false;
  }
}

const NO_SYMLINK_CODES = new Set(["ENOTSUP", "EPERM", "EOPNOTSUPP", "ENOSYS"]);

function installHookCopy(hookPath: string): void {
  const tmpPath = tmpSibling(hookPath);
  fs.writeFileSync(tmpPath, CHAIN_HOOK_SHIM, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(tmpPath, 0o755);
  fs.renameSync(tmpPath, hookPath);
}

/**
 * Installs the chaining shims into a single flow worktree, scoped so they
 * never fire for the user's primary repo or other worktrees. Each hook name
 * is an absolute symlink to the one shared shim (`sharedHookShimPath`);
 * where the filesystem refuses symlinks it falls back to a per-name copy.
 * Idempotent — `git config` set is idempotent and every link or copy is
 * replaced atomically (temp + rename) because a live pipeline may fire a
 * hook while another launch rewrites the folder. Removes nothing else.
 *
 * Resolves the hooks dir via `git rev-parse --git-dir` run *from the
 * worktree* — the per-worktree `.git/worktrees/<name>/` path, NOT
 * `--git-common-dir`. `--git-common-dir` would resolve to the shared
 * primary `.git/`, leaking the hooks into the user's primary repo and
 * every other worktree.
 *
 * This is DELIBERATELY the opposite polarity of `bin/lib/hooks-target.ts`'s
 * `resolveHooksTarget`, which resolves the MAIN worktree for the
 * base-branch guard: the chaining shims here must apply only inside
 * one worktree (each worktree gets its own), while the base-branch
 * guard must protect the base branch's own checkout regardless of which
 * worktree `flow feature create` happens to run from. The two installers
 * look symmetric — do not "unify" them. `worktree-commit-hook.test.ts`
 * pins this worktree-scoped behaviour; it must NOT start resolving the
 * main worktree.
 */
export function installWorktreeHooks(worktreeDir: string): void {
  const hooksDir = path.join(absGitDirOf(worktreeDir), FLOW_HOOKS_DIRNAME);

  // Each config write takes the SHARED config lock that live parallel
  // pipelines also need, so write only when the value is not already current.
  if (
    readConfig(["--get", "extensions.worktreeConfig"], worktreeDir) !== "true"
  ) {
    git(["config", "extensions.worktreeConfig", "true"], worktreeDir);
  }
  if (
    readConfig(["--worktree", "--get", "core.hooksPath"], worktreeDir) !==
    hooksDir
  ) {
    git(["config", "--worktree", "core.hooksPath", hooksDir], worktreeDir);
  }

  const shimPath = ensureSharedHookShim();
  fs.mkdirSync(hooksDir, { recursive: true });
  let warned = false;
  for (const name of FLOW_HOOK_NAMES) {
    const hookPath = path.join(hooksDir, name);
    if (linkIsCurrent(hookPath, shimPath)) continue;
    const tmpPath = tmpSibling(hookPath);
    try {
      fs.symlinkSync(shimPath, tmpPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !NO_SYMLINK_CODES.has(code)) throw err;
      if (!warned) {
        process.stderr.write(
          `flow: symlinks unavailable in ${hooksDir}; installed hook copies instead (each copy is scanned by macOS separately)\n`,
        );
        warned = true;
      }
      if (!copyIsCurrent(hookPath)) installHookCopy(hookPath);
      continue;
    }
    fs.renameSync(tmpPath, hookPath);
  }
}

/**
 * Re-installs the shims into every worktree of `repoDir`'s repository whose
 * git folder already holds a `flow-hooks/` folder — i.e. worktrees flow
 * itself set up, possibly with an older (single-hook) layout. Prunable
 * entries and directories that no longer exist are skipped (neither repaired
 * nor failed); the primary checkout and plain sibling worktrees have no
 * `flow-hooks/` and are left alone.
 */
export function repairFlowWorktreeHooks(repoDir: string): {
  repaired: string[];
  failed: Array<{ dir: string; error: string }>;
} {
  const repaired: string[] = [];
  const failed: Array<{ dir: string; error: string }> = [];
  const listing = git(["worktree", "list", "--porcelain"], repoDir);
  for (const block of listing.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const dir = lines
      .find((l) => l.startsWith("worktree "))
      ?.slice("worktree ".length);
    if (!dir) continue;
    if (lines.some((l) => l === "prunable" || l.startsWith("prunable "))) {
      continue;
    }
    if (!fs.existsSync(dir)) continue;
    try {
      const flowDir = path.join(absGitDirOf(dir), FLOW_HOOKS_DIRNAME);
      if (!fs.existsSync(flowDir)) continue;
      installWorktreeHooks(dir);
      repaired.push(dir);
    } catch (err) {
      failed.push({
        dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { repaired, failed };
}
