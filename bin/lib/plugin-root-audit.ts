/**
 * Expected-children audit for a flow-owned `.claude-plugin` plugin root
 * (`plugin-root.ts`'s materialization target). A separate module rather
 * than living inside `plugin-root.ts`, against AGENTS.md's <200-lines/file
 * target.
 *
 * Ownership is gated by the caller, not by this module: `plugin-root.ts` is
 * never imported here, so a caller is responsible for only passing roots
 * `scanPluginRoots` returned (i.e. already-verified flow-owned roots).
 *
 * Bounded, non-recursive walk: the top level of `root`, one level into
 * `root/bin/`, and one level into `root/.claude-plugin/`. Those three spots
 * are every channel a `--plugin-dir` root loads from today; going deeper
 * risks unbounded output on an interactive path for no additional coverage.
 *
 * MUST NEVER THROW: every fs read below goes through a try/catch that
 * collapses to an empty result, mirroring `scanPluginRoots`'s idiom
 * (`plugin-root.ts`).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type PluginRootEntryIssue = {
  relPath: string;
  reason: "unexpected-child" | "unmanaged-bin-entry" | "dangling-bin-symlink";
};

/** Ignored at every level — an OS-written artifact, never flow's and never
 * the user's to worry about. */
const IGNORED_ENTRIES = new Set([".DS_Store"]);

function readdirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Whether `root`'s manifest declares a `skills` key — mirroring
 * `pluginManifestFor`'s writer SHAPE, not mere key presence:
 * `pluginManifestFor` emits exactly `skills: ["./skills"]` (an array of
 * strings) and otherwise omits the key entirely, so a declared `skills` key
 * is only genuine when the parsed value is a NON-EMPTY array of strings.
 * Plain key presence would let a hand-edited-but-valid `plugin.json` declare
 * `"skills": []` (or `null`, or a scalar) to make `<root>/skills/**` an
 * unwalked, unreported subtree while the root stays loaded — an evasion
 * vector this stricter shape check closes. Deliberately NOT built on
 * `plugin-root.ts`'s `readFileOrNull` — that helper returns `string | null`
 * with no JSON parse, and treating a read/parse failure as "no skills key"
 * would turn an unrelated read error into a false `unexpected-child` report
 * on a legitimate `skills/` directory. Any read or parse failure, OR a
 * parseable-but-non-object manifest (bare `null`/string/number), is instead
 * treated as "unknown, so don't flag skills/" — a correct silent skip,
 * never a false positive.
 */
function manifestDeclaresSkills(root: string): boolean {
  try {
    const raw = fs.readFileSync(
      path.join(root, ".claude-plugin", "plugin.json"),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return true;
    const value = (parsed as Record<string, unknown>).skills;
    if (value === undefined) return false;
    // Non-EMPTY is load-bearing: `"skills": []` is the evasion the shape
    // check exists to close, and an empty array is vacuously "an array of
    // strings".
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((v) => typeof v === "string")
    );
  } catch {
    return true;
  }
}

function expectedRootChildren(root: string): Set<string> {
  const expected = new Set([".claude-plugin", "bin"]);
  if (manifestDeclaresSkills(root)) expected.add("skills");
  return expected;
}

/** Classification of a `bin/` entry that isn't a healthy live symlink:
 * `"unmanaged"` for a real (non-symlink) file — `listManagedSymlinks`
 * filters on `Dirent.isSymbolicLink()`, so `ensurePluginRoot`'s prune loop
 * never even sees it; flow never wrote it and never deletes it, so it
 * genuinely needs hand removal. `"dangling"` for a symlink that doesn't
 * resolve — `listManagedSymlinks` DOES pick this one up (a dangling link is
 * still a symlink), so `flow install --upgrade` genuinely repairs it: the
 * prune loop unlinks it if it's no longer in the desired set, and
 * `ensureSymlink`'s relink branch repairs it in place when the name is
 * still desired. `null` for a live symlink, which is deliberately not
 * reported at all. The caller routes `"unmanaged"` through the hand-removal
 * remediation and `"dangling"` through the self-healing
 * `flow install --upgrade` one. */
function classifyBinEntry(
  binDir: string,
  name: string,
): "unmanaged" | "dangling" | null {
  const entryPath = path.join(binDir, name);
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(entryPath);
  } catch {
    return null;
  }
  if (!lst.isSymbolicLink()) return "unmanaged";
  try {
    fs.statSync(entryPath);
    return null;
  } catch {
    return "dangling";
  }
}

export function unexpectedPluginRootEntries(
  root: string,
): PluginRootEntryIssue[] {
  const issues: PluginRootEntryIssue[] = [];

  const expected = expectedRootChildren(root);
  for (const name of readdirNames(root)) {
    if (IGNORED_ENTRIES.has(name)) continue;
    if (!expected.has(name)) {
      issues.push({ relPath: name, reason: "unexpected-child" });
    }
  }

  const binDir = path.join(root, "bin");
  for (const name of readdirNames(binDir)) {
    if (IGNORED_ENTRIES.has(name)) continue;
    const kind = classifyBinEntry(binDir, name);
    if (kind === "unmanaged") {
      issues.push({
        relPath: path.join("bin", name),
        reason: "unmanaged-bin-entry",
      });
    } else if (kind === "dangling") {
      issues.push({
        relPath: path.join("bin", name),
        reason: "dangling-bin-symlink",
      });
    }
  }

  const manifestDir = path.join(root, ".claude-plugin");
  for (const name of readdirNames(manifestDir)) {
    if (IGNORED_ENTRIES.has(name)) continue;
    if (name !== "plugin.json") {
      issues.push({
        relPath: path.join(".claude-plugin", name),
        reason: "unexpected-child",
      });
    }
  }

  return issues;
}
