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
 * `root/bin/`, one level into `root/.claude-plugin/`, and (Task 5) one level
 * into `root/skills/` when present. `root/agents` is checked at the TOP
 * level only (`checkAgentsRoot`), not walked into — it is itself a single
 * directory symlink per owning module, not a directory of per-file
 * symlinks (see `checkAgentsRoot`'s own doc comment). Those spots are every
 * channel a `--plugin-dir` root loads from today; going deeper risks
 * unbounded output on an interactive path for no additional coverage.
 *
 * MUST NEVER THROW: every fs read below goes through a try/catch that
 * collapses to an empty result, mirroring `scanPluginRoots`'s idiom
 * (`plugin-root.ts`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isFlowOwnedSymlink, ownershipRoots } from "./flow-owned-symlink";

export type PluginRootEntryIssue = {
  relPath: string;
  reason:
    | "unexpected-child"
    | "unmanaged-entry"
    | "dangling-symlink"
    | "foreign-live-bin-symlink";
};

/** The ownership roots a live `bin/` symlink is checked against — the same
 * flow-source / install-root pair `setup.ts`'s sweep already resolves. */
export type PluginRootOwnership = {
  flowSource: string;
  installRoot: string;
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
  // `agents` is unconditional (Task 5): an `agents/` directory inside a
  // flow-owned root is always legitimate, whether or not the module owns
  // any agent rows — an absent expected child is not itself drift (only an
  // UNEXPECTED one is), so there is no manifest-declaration gate to mirror
  // `manifestDeclaresSkills`' — a plugin manifest carries no `agents` key
  // to declare in the first place (`plugin-manifest.ts`'s `PluginManifest`
  // type has none).
  const expected = new Set([".claude-plugin", "bin", "agents"]);
  if (manifestDeclaresSkills(root)) expected.add("skills");
  return expected;
}

/** Classification of a `bin/`/`skills/`/`agents/` entry that isn't a
 * healthy live symlink: `"unmanaged"` for a real (non-symlink) file or
 * directory — `listManagedSymlinks` filters on `Dirent.isSymbolicLink()`,
 * so `ensurePluginRoot`'s prune loop never even sees it; flow never wrote
 * it and never deletes it, so it genuinely needs hand removal.
 * `"dangling"` for a symlink that doesn't resolve — `listManagedSymlinks`
 * DOES pick this one up (a dangling link is still a symlink), so
 * `flow install --upgrade` genuinely repairs it: the prune loop unlinks it
 * if it's no longer in the desired set, and `ensureSymlink`'s relink branch
 * repairs it in place when the name is still desired. `"foreign-live"` for
 * a LIVE symlink resolving outside every ownership root (wins PATH lookup
 * now, until the next `flow install --upgrade` prunes it) — checked only
 * when `roots` is non-null, i.e. only for `bin/`, the one subdir whose
 * entries join the session PATH; a live `skills/`/`agents/` symlink is
 * `null` regardless of target. `null` otherwise, for a live symlink —
 * INCLUDING a live directory symlink (a skill's target is a directory,
 * unlike a `bin/` entry's file), which is just as healthy: `fs.statSync`
 * follows the link and succeeds regardless of the resolved node's type, so
 * no dir/file branch is needed. The caller routes `"unmanaged"` through the
 * hand-removal remediation and `"dangling"` through the self-healing
 * `flow install --upgrade` one. */
function classifyEntry(
  dir: string,
  name: string,
  roots: readonly string[] | null,
): "unmanaged" | "dangling" | "foreign-live" | null {
  const entryPath = path.join(dir, name);
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(entryPath);
  } catch {
    return null;
  }
  if (!lst.isSymbolicLink()) return "unmanaged";
  try {
    fs.statSync(entryPath);
  } catch {
    return "dangling";
  }
  if (roots === null) return null;
  return isFlowOwnedSymlink(entryPath, roots) ? null : "foreign-live";
}

/** Walks one level into `<root>/<subdir>/`, pushing an issue for every
 * non-healthy entry — shared by the `bin/` and `skills/` one-level walks
 * below. `roots` is passed only for the `bin/` walk (the PATH-joining
 * subdir); `null` skips the foreign-live ownership check. NOT used for
 * `agents/` any more — see `checkAgentsRoot`'s own doc comment for why the
 * two subdirs' expected shapes diverged. */
function walkOneLevel(
  root: string,
  subdir: string,
  issues: PluginRootEntryIssue[],
  roots: readonly string[] | null = null,
): void {
  const dir = path.join(root, subdir);
  for (const name of readdirNames(dir)) {
    if (IGNORED_ENTRIES.has(name)) continue;
    const kind = classifyEntry(dir, name, roots);
    if (kind === "unmanaged") {
      issues.push({
        relPath: path.join(subdir, name),
        reason: "unmanaged-entry",
      });
    } else if (kind === "dangling") {
      issues.push({
        relPath: path.join(subdir, name),
        reason: "dangling-symlink",
      });
    } else if (kind === "foreign-live") {
      issues.push({
        relPath: path.join(subdir, name),
        reason: "foreign-live-bin-symlink",
      });
    }
  }
}

/**
 * Checks `<root>/agents` ITSELF, not its contents — unlike `skills/`, whose
 * per-skill-directory symlinks live one level INSIDE `root/skills/`,
 * `discoverAgents` (`sources.ts`) materializes `root/agents` as ONE
 * directory symlink for the whole owning module (Claude Code's plugin-root
 * discovery follows a symlinked directory but not a symlinked file, so a
 * per-file agent symlink is unusable — see that function's own doc
 * comment). `root/agents`'s children are therefore real `.md` files inside
 * the flow source tree, never individually-managed symlinks; walking one
 * level in and expecting each child to be a symlink (the old `walkOneLevel`
 * shape) would misreport every one of them as `unmanaged-entry`.
 */
function checkAgentsRoot(root: string, issues: PluginRootEntryIssue[]): void {
  const entryPath = path.join(root, "agents");
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(entryPath);
  } catch {
    return; // absent is not itself drift — mirrors expectedRootChildren's note
  }
  if (!lst.isSymbolicLink()) {
    issues.push({ relPath: "agents", reason: "unmanaged-entry" });
    return;
  }
  try {
    fs.statSync(entryPath);
  } catch {
    issues.push({ relPath: "agents", reason: "dangling-symlink" });
  }
  // A live directory symlink is healthy as-is — no further per-child check.
}

export function unexpectedPluginRootEntries(
  root: string,
  ownership: PluginRootOwnership,
): PluginRootEntryIssue[] {
  const issues: PluginRootEntryIssue[] = [];

  const expected = expectedRootChildren(root);
  for (const name of readdirNames(root)) {
    if (IGNORED_ENTRIES.has(name)) continue;
    if (!expected.has(name)) {
      issues.push({ relPath: name, reason: "unexpected-child" });
    }
  }

  // Hoisted out of the walk: `ownershipRoots` runs two `realpathSync` calls,
  // both loop-invariant — computing it once instead of per-entry avoids
  // ~2 redundant syscalls per `bin/` symlink on this interactive path
  // (`flow ls` / `flow version`).
  const roots = ownershipRoots(ownership.flowSource, ownership.installRoot);
  walkOneLevel(root, "bin", issues, roots);
  walkOneLevel(root, "skills", issues);
  checkAgentsRoot(root, issues);

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
