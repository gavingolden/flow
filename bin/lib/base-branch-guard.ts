import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { git } from "./git";
import { dimStderr } from "./color";
import { resolveHooksTarget, type HooksTarget } from "./hooks-target";
import {
  foreignHookNotice,
  newerHookNotice,
  upgradeNotice,
} from "./base-branch-guard-notices";
import { LEGACY_HOOK_BODIES } from "./base-branch-guard-legacy";

export { foreignHookNotice } from "./base-branch-guard-notices";
export { LEGACY_HOOK_BODIES } from "./base-branch-guard-legacy";

/**
 * POSIX shell `pre-commit` hook body. Refuses a commit (`exit 1`) when HEAD is
 * on the repo's default branch AND the commit is happening inside a flow
 * supervisor session; a no-op (`exit 0`) in every other case.
 *
 * Authored as `#!/bin/sh` — NOT a Bun shebang — because git invokes pre-commit
 * on EVERY commit, so the common path (no flow session) must exit 0 with
 * near-zero cost. For the same reason the default-branch idiom is inlined in
 * sh here rather than shelling out to the TS `detectDefaultBranch`: a Bun/TS
 * spawn would add a per-commit interpreter start and a runtime dependency.
 *
 * BOTH session gates are load-bearing: `CLAUDE_CODE_SESSION_ID` alone is set
 * for the user's own hand-driven Claude Code commits, so the flow-session slug
 * — the `FLOW_SLUG` env var (either launcher backend), falling back to the
 * tmux `@flow-slug` pane option (tmux backend) — is what narrows the guard to
 * a flow-supervisor session; without it the hook would block the user's own
 * legitimate commits to the base branch.
 *
 * Line 2 is a self-identifying marker (`# flow:base-branch-guard v<N>`), read
 * by `classifyPreCommitHook` below — see that function's doc comment for why
 * ownership detection moved off a byte-exact compare.
 */
export const BASE_BRANCH_GUARD_MARKER = "# flow:base-branch-guard v";
export const BASE_BRANCH_GUARD_VERSION = 3;

export const BASE_BRANCH_GUARD_HOOK = `#!/bin/sh
${BASE_BRANCH_GUARD_MARKER}${BASE_BRANCH_GUARD_VERSION}
# managed by flow — edits are overwritten on the next \`flow feature create\`.
[ -n "$CLAUDE_CODE_SESSION_ID" ] || exit 0
flow_slug=\${FLOW_SLUG:-}
if [ -z "$flow_slug" ] && [ -n "$TMUX_PANE" ]; then
  flow_slug=$(tmux show-options -w -t "$TMUX_PANE" -q -v @flow-slug 2>/dev/null)
fi
[ -n "$flow_slug" ] || exit 0

# origin/HEAD is the source of truth for the default branch; the local
# main/master fallback is load-bearing for repos with no origin/HEAD (a fresh
# "git init -b main" test repo has none).
default_branch=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
default_branch=\${default_branch#origin/}
if [ -z "$default_branch" ]; then
  if git show-ref --verify --quiet refs/heads/main; then
    default_branch=main
  elif git show-ref --verify --quiet refs/heads/master; then
    default_branch=master
  else
    default_branch=main
  fi
fi

current_branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || git rev-parse --abbrev-ref HEAD 2>/dev/null)

if [ "$current_branch" = "$default_branch" ]; then
  echo "flow: refusing to commit on the base branch '$default_branch' inside a flow session." >&2
  echo "flow: pipeline work belongs on a per-pipeline worktree behind a PR, not the base branch." >&2
  exit 1
fi
exit 0
`;

function extractMarkerVersion(contents: string): number | null {
  const idx = contents.indexOf(BASE_BRANCH_GUARD_MARKER);
  if (idx === -1) return null;
  const after = contents.slice(idx + BASE_BRANCH_GUARD_MARKER.length);
  const match = after.match(/^(\d+)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

export type PreCommitHookClass =
  | "absent"
  | "own-current"
  | "own-outdated"
  | "own-newer"
  | "own-legacy"
  | "foreign";

/**
 * Classifies an existing `pre-commit` hook's contents. Marker matching is
 * SUBSTRING-CONTAINS (mirroring pre-commit's `is_our_script`), not a
 * line-anchored regex, so trailing-whitespace/CRLF churn can't re-trigger
 * the misclassification a byte-exact compare caused: a hook that predates
 * the marker (v1/v2, still installed in the wild — e.g. econ-data's
 * `.githooks/pre-commit`) byte-compares foreign against a NEWER
 * `BASE_BRANCH_GUARD_HOOK` even though flow owns it, so re-installing over
 * it warned forever instead of upgrading it in place.
 */
export function classifyPreCommitHook(
  contents: string | null,
): PreCommitHookClass {
  if (!contents || contents.trim().length === 0) return "absent";

  const version = extractMarkerVersion(contents);
  if (version !== null) {
    if (version === BASE_BRANCH_GUARD_VERSION) return "own-current";
    return version < BASE_BRANCH_GUARD_VERSION ? "own-outdated" : "own-newer";
  }

  const legacyBodies = LEGACY_HOOK_BODIES["base-branch"] ?? [];
  if (legacyBodies.includes(contents)) return "own-legacy";
  return "foreign";
}

/**
 * Machine-global sidecar path, resolved at CALL TIME (never a module-scope
 * const) — `HOME` is captured at import time, before vitest.setup.ts swaps
 * `$HOME` for a sandbox, so an eager constant would make the test suite
 * write into the developer's real `~/.flow/hooks/`. Mirrors `flowConfigPath`
 * in `bin/lib/paths.ts`.
 */
export function baseBranchGuardSidecarPath(): string {
  return path.join(os.homedir(), ".flow", "hooks", "base-branch-guard.sh");
}

/**
 * Idempotently ensures the shared, machine-global sidecar guard exists and
 * is current. Every foreign repo's remediation snippet sources this ONE
 * file, so a future `BASE_BRANCH_GUARD_VERSION` bump upgrades the guard in
 * every foreign repo with no user action.
 */
export function ensureGuardSidecar(): string {
  const sidecarPath = baseBranchGuardSidecarPath();
  let needsWrite = true;
  if (fs.existsSync(sidecarPath)) {
    try {
      const version = extractMarkerVersion(
        fs.readFileSync(sidecarPath, "utf8"),
      );
      needsWrite = version === null || version < BASE_BRANCH_GUARD_VERSION;
    } catch {
      needsWrite = true;
    }
  }
  if (needsWrite) {
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    fs.writeFileSync(sidecarPath, BASE_BRANCH_GUARD_HOOK, "utf8");
    fs.chmodSync(sidecarPath, 0o644); // sourced, not executed
  }
  return sidecarPath;
}

function isTracked(hookPath: string, mainWorktree: string): boolean {
  try {
    git(["ls-files", "--error-unmatch", hookPath], mainWorktree);
    return true;
  } catch {
    return false;
  }
}

export type BaseBranchGuardInstall = {
  installed: boolean;
  reason: "installed" | "idempotent" | "upgraded" | "foreign" | "newer";
  hookPath: string;
  sidecarPath?: string;
};

function installForeign(
  target: HooksTarget,
  hookPath: string,
): BaseBranchGuardInstall {
  let sidecarPath: string | undefined;
  try {
    sidecarPath = ensureGuardSidecar();
  } catch {
    sidecarPath = undefined;
  }
  if (sidecarPath) {
    console.error(dimStderr(foreignHookNotice(target, hookPath, sidecarPath)));
  } else {
    console.error(
      dimStderr(
        `flow feature create: base-branch guard not installed — ${hookPath} is not flow's, and the shared guard sidecar could not be prepared.`,
      ),
    );
  }
  return { installed: false, reason: "foreign", hookPath, sidecarPath };
}

/**
 * Idempotently installs the base-branch guard as the MAIN worktree's
 * `pre-commit` hook (never the ephemeral per-worktree checkout — see
 * `resolveHooksTarget`). Upgrades a flow-owned hook in place (marker or
 * registered legacy body), never downgrades a newer one, never clobbers a
 * foreign hook, and never writes into a husky-managed `_` dir (husky
 * regenerates it, so anything flow wrote there would be silently destroyed).
 */
export function installBaseBranchGuard(
  repoDir: string,
): BaseBranchGuardInstall {
  const target = resolveHooksTarget(repoDir);
  const hookPath = path.join(target.hooksDir, "pre-commit");

  if (target.manager === "husky") {
    return installForeign(target, hookPath);
  }

  const existing = fs.existsSync(hookPath)
    ? fs.readFileSync(hookPath, "utf8")
    : null;
  const classification = classifyPreCommitHook(existing);

  if (classification === "absent") {
    fs.mkdirSync(target.hooksDir, { recursive: true });
    fs.writeFileSync(hookPath, BASE_BRANCH_GUARD_HOOK, "utf8");
    fs.chmodSync(hookPath, 0o755);
    return { installed: true, reason: "installed", hookPath };
  }

  if (classification === "own-current") {
    return { installed: true, reason: "idempotent", hookPath };
  }

  if (classification === "own-outdated" || classification === "own-legacy") {
    const tracked = isTracked(hookPath, target.mainWorktree);
    const fromDescription =
      classification === "own-outdated"
        ? `v${extractMarkerVersion(existing ?? "") ?? "?"}`
        : "a legacy (pre-versioning) hook";
    fs.writeFileSync(hookPath, BASE_BRANCH_GUARD_HOOK, "utf8");
    fs.chmodSync(hookPath, 0o755);
    console.error(
      upgradeNotice(
        hookPath,
        fromDescription,
        tracked,
        BASE_BRANCH_GUARD_VERSION,
      ),
    );
    return { installed: true, reason: "upgraded", hookPath };
  }

  if (classification === "own-newer") {
    const newerVersion = extractMarkerVersion(existing ?? "");
    console.error(newerHookNotice(hookPath, newerVersion));
    return { installed: false, reason: "newer", hookPath };
  }

  return installForeign(target, hookPath);
}

/**
 * Pure refuse/allow decision mirrored by the sh hook above, factored out so the
 * branching logic is unit-testable without spawning a real commit. Refuses ONLY
 * when both flow-session markers are present AND HEAD is the default branch.
 */
export function baseBranchGuardDecision(input: {
  sessionId?: string;
  flowSlug?: string;
  currentBranch: string;
  defaultBranch: string;
}): "refuse" | "allow" {
  const sessionMarked = Boolean(input.sessionId) && Boolean(input.flowSlug);
  if (sessionMarked && input.currentBranch === input.defaultBranch) {
    return "refuse";
  }
  return "allow";
}
