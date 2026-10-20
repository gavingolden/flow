import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { checkKey, isReadOnlyVerifier } from "./check-dedupe";

/**
 * Same-tree memo: which read-only checks already passed on which exact tree,
 * stored in the worktree's private git folder
 * (`git rev-parse --git-path flow-verified-tree.json`) so it never shows up
 * as an untracked file and dies with the worktree. A later push-time
 * `flow-pre-commit` run on that same clean tree reuses the passes.
 *
 * node:child_process (not Bun.spawnSync) so the vitest cases run under node.
 */
export type VerifiedTreeMemo = {
  version: 1;
  tree: string;
  passed: Record<string, { name: string; durationMs: number; at: string }>;
};

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
    m.version === 1 &&
    typeof m.tree === "string" &&
    typeof m.passed === "object" &&
    m.passed !== null
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
 * Records the passing, non-skipped, read-only results of a run against
 * `tree`: merged into an existing entry for the same tree, replacing an entry
 * for a different one. A read-only check that FAILED this run is dropped from
 * the entry — an earlier pass on the same tree is no longer trustworthy.
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
    const passed: VerifiedTreeMemo["passed"] =
      existing && existing.tree === tree ? { ...existing.passed } : {};
    const at = new Date().toISOString();
    for (const r of results) {
      if (r.skipped || !isReadOnlyVerifier(r.argv)) continue;
      const key = checkKey(r.argv);
      if (r.passed) {
        passed[key] = { name: r.name, durationMs: r.durationMs, at };
      } else {
        delete passed[key];
      }
    }
    const memo: VerifiedTreeMemo = { version: 1, tree, passed };
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(memo), "utf8");
    fs.renameSync(tmp, p);
  } catch {
    // swallowed — a lost memo only costs a re-run.
  }
}
