import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { checkKey, isReadOnlyVerifier } from "./check-dedupe";

/**
 * Same-tree memo: which read-only checks already passed on which exact tree,
 * stored in the worktree's private git folder
 * (`git rev-parse --git-path flow-verified-tree.json`) so it never shows up
 * as an untracked file and dies with the worktree. A later `flow-pre-commit`
 * run on that same tree reuses the passes when it is a push-time run or passes
 * `--reuse-verified-tree`, and only for passes that are fresh (see
 * `reusablePasses`) and for checks that never failed on the tree.
 *
 * node:child_process (not Bun.spawnSync) so the vitest cases run under node.
 */
export type VerifiedTreeMemo = {
  version: 2;
  tree: string;
  passed: Record<string, { name: string; durationMs: number; at: string }>;
  /** Read-only checks that failed on this tree; never replayable as a pass. */
  failed: Record<string, { name: string; at: string }>;
};

export const VERIFIED_TREE_MAX_AGE_MS = 30 * 60 * 1000;

const MEMO_FILENAME = "flow-verified-tree.json";

function gitOut(
  args: string[],
  cwd: string | undefined,
  env?: NodeJS.ProcessEnv,
): string | null {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env },
  });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

/**
 * Identity of the content a check would see: `HEAD^{tree}` on a clean tree;
 * on a dirty one, the tree `git add -A` would produce, computed over a temp
 * COPY of the index (untracked non-ignored files count) so the real index is
 * never touched. `null` outside a repo or when the tree cannot be computed.
 */
export function workingTreeId(cwd?: string): string | null {
  const headTree = gitOut(["rev-parse", "--verify", "HEAD^{tree}"], cwd);
  if (!headTree) return null;
  const status = gitOut(
    [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ],
    cwd,
  );
  if (status === null) return null;
  if (status === "") return headTree;

  const realIndex = gitOut(
    ["rev-parse", "--path-format=absolute", "--git-path", "index"],
    cwd,
  );
  if (!realIndex) return null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-verified-tree-"));
  try {
    const tmpIndex = path.join(tmpDir, "index");
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex);
    const env = { GIT_INDEX_FILE: tmpIndex };
    if (gitOut(["add", "-A"], cwd, env) === null) return null;
    return gitOut(["write-tree"], cwd, env) || null;
  } catch {
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function memoPath(cwd?: string): string | null {
  const p = gitOut(
    ["rev-parse", "--path-format=absolute", "--git-path", MEMO_FILENAME],
    cwd,
  );
  return p || null;
}

function isMemo(v: unknown): v is VerifiedTreeMemo {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    m.version === 2 &&
    typeof m.tree === "string" &&
    typeof m.passed === "object" &&
    m.passed !== null &&
    typeof m.failed === "object" &&
    m.failed !== null
  );
}

/** The recorded memo, or `null` when missing, unreadable, or malformed. */
export function readVerifiedTree(cwd?: string): VerifiedTreeMemo | null {
  try {
    const p = memoPath(cwd);
    if (!p) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
    return isMemo(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The memo's passes a run on `tree` may replay at `nowMs`: same tree, never
 * failed on it, a parseable timestamp, and no older than `maxAgeMs`. A
 * future-dated entry (negative age) counts as stale.
 */
export function reusablePasses(
  memo: VerifiedTreeMemo | null,
  tree: string | null,
  nowMs: number,
  maxAgeMs: number = VERIFIED_TREE_MAX_AGE_MS,
): Map<string, { name: string; durationMs: number }> {
  const out = new Map<string, { name: string; durationMs: number }>();
  if (!memo || !tree || memo.tree !== tree) return out;
  for (const [key, entry] of Object.entries(memo.passed)) {
    if (Object.hasOwn(memo.failed, key)) continue;
    const at = Date.parse(entry.at);
    if (Number.isNaN(at)) continue;
    const age = nowMs - at;
    if (age < 0 || age > maxAgeMs) continue;
    out.set(key, { name: entry.name, durationMs: entry.durationMs });
  }
  return out;
}

/** Deletes the memo when it belongs to `tree`; no-op otherwise. Never throws. */
export function discardVerifiedTree(tree: string | null, cwd?: string): void {
  try {
    if (!tree) return;
    const p = memoPath(cwd);
    if (!p) return;
    if (readVerifiedTree(cwd)?.tree !== tree) return;
    fs.rmSync(p, { force: true });
  } catch {
    // swallowed — the memo is an optimisation only.
  }
}

/**
 * Records the passing, non-skipped, read-only results of a run against
 * `tree`: merged into an existing entry for the same tree, replacing an entry
 * for a different one. A read-only check that FAILED this run moves from
 * `passed` to `failed`, and a later pass of a key in `failed` on the same tree
 * is refused — a check that ever failed on a tree is never replayable there.
 * Never throws; the memo is an optimisation only.
 */
export function recordVerifiedTree(
  tree: string,
  results: Array<{
    argv: readonly string[];
    name: string;
    passed: boolean;
    durationMs: number;
    skipped?: boolean;
  }>,
  cwd?: string,
): void {
  try {
    const p = memoPath(cwd);
    if (!p) return;
    const existing = readVerifiedTree(cwd);
    const same = existing && existing.tree === tree ? existing : null;
    const passed: VerifiedTreeMemo["passed"] = { ...same?.passed };
    const failed: VerifiedTreeMemo["failed"] = { ...same?.failed };
    const at = new Date().toISOString();
    for (const r of results) {
      if (r.skipped || !isReadOnlyVerifier(r.argv)) continue;
      const key = checkKey(r.argv);
      if (r.passed) {
        if (Object.hasOwn(failed, key)) continue;
        passed[key] = { name: r.name, durationMs: r.durationMs, at };
      } else {
        delete passed[key];
        failed[key] = { name: r.name, at };
      }
    }
    const memo: VerifiedTreeMemo = { version: 2, tree, passed, failed };
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(memo), "utf8");
    fs.renameSync(tmp, p);
  } catch {
    // swallowed — a lost memo only costs a re-run.
  }
}
