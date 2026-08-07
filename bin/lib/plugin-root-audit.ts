/**
 * Expected-children audit for a flow-owned `.claude-plugin` plugin root
 * (`plugin-root.ts`'s materialization target). A separate module rather
 * than living inside `plugin-root.ts`, which already sits at 262 lines
 * against AGENTS.md's <200-lines/file target.
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
  reason: "unexpected-child" | "unmanaged-bin-entry";
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
 * Whether `root`'s manifest declares a `skills` key — key PRESENCE, not
 * truthiness, mirroring `pluginManifestFor`'s writer exactly: it omits the
 * `skills` key entirely when `includeSkills` is false and never emits a
 * falsy value, so key-presence is the correct mirror of what the writer
 * does. Deliberately NOT built on `plugin-root.ts`'s `readFileOrNull` —
 * that helper returns `string | null` with no JSON parse, and treating a
 * read/parse failure as "no skills key" would turn an unrelated read error
 * into a false `unexpected-child` report on a legitimate `skills/`
 * directory. Any read or parse failure here is instead treated as
 * "unknown, so don't flag skills/" — a correct silent skip, never a false
 * positive.
 */
function manifestDeclaresSkills(root: string): boolean {
  try {
    const raw = fs.readFileSync(
      path.join(root, ".claude-plugin", "plugin.json"),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return true;
    return "skills" in (parsed as Record<string, unknown>);
  } catch {
    return true;
  }
}

function expectedRootChildren(root: string): Set<string> {
  const expected = new Set([".claude-plugin", "bin"]);
  if (manifestDeclaresSkills(root)) expected.add("skills");
  return expected;
}

/** A `bin/` entry is "unmanaged" when it's a real (non-symlink) file, or a
 * symlink that does not resolve. A LIVE symlink is deliberately not
 * reported — `ensurePluginRoot`'s prune loop already removes any symlink
 * not in its desired set on the next materialization, so a live symlink is
 * the self-healing case, not drift. */
function isUnmanagedBinEntry(binDir: string, name: string): boolean {
  const entryPath = path.join(binDir, name);
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(entryPath);
  } catch {
    return false;
  }
  if (!lst.isSymbolicLink()) return true;
  try {
    fs.statSync(entryPath);
    return false;
  } catch {
    return true;
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
    if (isUnmanagedBinEntry(binDir, name)) {
      issues.push({
        relPath: path.join("bin", name),
        reason: "unmanaged-bin-entry",
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
