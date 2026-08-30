import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Pure anchor-extraction module, moved out of `bin/flow-candidate-issues.ts`
 * so `bin/lib/issue-body-rubric.ts` can consume it without a `lib -> bin`
 * import. `resolveAnchorRepoRoot` is a DIFFERENT contract from
 * `bin/lib/repo-root.ts`'s `resolveRepoRoot(cwd: string): string | null` —
 * that resolver is nullable-by-design and off-limits (11+ call sites across
 * the epic machinery depend on the null path); this one takes an optional
 * plan-file path and never returns null, falling back to `process.cwd()`.
 * Two same-named, differently-typed exports in `bin/lib/` would be a live
 * foot-gun, hence the distinct name.
 */

/**
 * Matches every `[anchor: path/to/file.ext[:line[,line...]]]` file-path
 * citation. A leading/trailing backtick around the path is tolerated and
 * stripped by callers (the rubric asks authors to write anchors bare, but a
 * backticked one must not false-positive as missing). Only file-shaped
 * anchors match — command/PR/issue/quote anchors are presence-only and not
 * path-checked. The extension must start with a letter so a
 * rubric-sanctioned measured number or version (`1.8s`, `0.7%`, `v2.1.234`)
 * never looks like a file path.
 */
export const ANCHOR_RE =
  /\[anchor:\s*`?([^\s\]:`]+\.[A-Za-z][A-Za-z0-9]*)`?(?::\d+(?:,\d+)*)?/g;

/**
 * Extracts every `[anchor: path/to/file.ext[:line[,line...]]]` file-path
 * citation from a block of text. `~/`-prefixed anchors are dropped too —
 * they read as a repo-relative path to `resolve()` but can never exist
 * under a repo root, so keeping them would always false-positive as
 * missing.
 */
export function extractPathAnchors(details: string): string[] {
  const out: string[] = [];
  for (const m of details.matchAll(ANCHOR_RE)) {
    if (m[1].startsWith("~/") || m[1] === "~") continue;
    out.push(m[1]);
  }
  return out;
}

/**
 * Resolves the repo root to check `[anchor: …]` file paths against:
 * `git rev-parse --show-toplevel` run from `planMdFile`'s directory,
 * stderr swallowed (a fixture plan living outside a git repo, as vitest's
 * `os.tmpdir()` fixtures do, must not leak "not a git repository" onto the
 * process's own stderr), falling back to `process.cwd()` on any failure or
 * when `planMdFile` is not supplied. Never throws, never returns null —
 * `lintFollowUpReferences` depends on a non-null root for `resolve()` /
 * `relative()`.
 */
export function resolveAnchorRepoRoot(planMdFile: string | undefined): string {
  const cwd = planMdFile ? dirname(planMdFile) : process.cwd();
  try {
    const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    if (res.status === 0 && res.stdout.trim()) {
      return res.stdout.trim();
    }
  } catch {
    // fall through to cwd fallback
  }
  return process.cwd();
}
