/**
 * Discover what `flow install` should install: skills, agents, and helper
 * binaries from the flow source tree. Each entry pairs the absolute source
 * path with its target install path.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CLAUDE_AGENTS_DIR,
  CLAUDE_SKILLS_DIR,
  FLOW_COMPLETIONS_DIR,
  LOCAL_BIN_DIR,
} from "./paths";
import type { SymlinkKind, SymlinkRecord } from "./manifest";

const SKILL_TIERS = ["pipeline", "universal", "stacks"] as const;
const COMPLETION_SHELLS = ["bash", "zsh"] as const;

/**
 * Schema validators under `bin/lib/` that pipeline skills invoke as PATH
 * binaries. This is an EXPLICIT ALLOWLIST, deliberately NOT a recursive glob
 * of `bin/lib/` — that directory is overwhelmingly internal library code
 * (paths.ts, state.ts, git.ts, …) and a glob would symlink non-CLI modules
 * onto PATH. New validators must be added here by name.
 */
const VALIDATOR_MODULES = [
  "pr-review-result-schema.ts",
  "agent-finding-schema.ts",
  "fix-applier-schema.ts",
  "epic-manifest-schema.ts",
] as const;

/**
 * Helpers that exist under `bin/` but must NOT be symlinked onto a user's
 * PATH: maintainer-only, tree-mutating + tag-creating tools that should only
 * ever run from a flow checkout.
 */
const MAINTAINER_ONLY = new Set(["flow-release"]);

/**
 * Whether a `bin/` basename (e.g. `flow-new-worktree.ts`) is a helper that
 * `flow install` symlinks onto a user's PATH: a `.ts` file that is not a test,
 * not the `flow` wrapper, and not a maintainer-only tool. Shared with
 * flow-pre-commit's executable-mode gate so the installer and the gate cannot
 * disagree about which files must be tracked executable.
 */
export function isPathBoundHelper(name: string): boolean {
  return (
    name.endsWith(".ts") &&
    !name.endsWith(".test.ts") &&
    name !== "flow.ts" &&
    !MAINTAINER_ONLY.has(name.replace(/\.ts$/, ""))
  );
}

export type SourceEntry = {
  source: string;
  target: string;
  kind: SymlinkKind;
  /** Pretty name used in install summary output. */
  displayName: string;
};

export type InstallTargets = {
  skillsDir: string;
  agentsDir: string;
  binDir: string;
  completionsDir: string;
};

export const DEFAULT_TARGETS: InstallTargets = {
  skillsDir: CLAUDE_SKILLS_DIR,
  agentsDir: CLAUDE_AGENTS_DIR,
  binDir: LOCAL_BIN_DIR,
  completionsDir: FLOW_COMPLETIONS_DIR,
};

/** Lists every skill directory across all tiers under <flow-source>/skills/. */
export function discoverSkills(
  flowSource: string,
  targets = DEFAULT_TARGETS,
): SourceEntry[] {
  const skillsRoot = path.join(flowSource, "skills");
  const entries: SourceEntry[] = [];
  for (const tier of SKILL_TIERS) {
    const tierDir = path.join(skillsRoot, tier);
    if (!existsDir(tierDir)) continue;
    for (const dirent of fs.readdirSync(tierDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      entries.push({
        source: path.join(tierDir, dirent.name),
        target: path.join(targets.skillsDir, dirent.name),
        kind: "skill",
        displayName: dirent.name,
      });
    }
  }
  return entries;
}

/** Lists agent files under <flow-source>/agents/. Empty if dir absent. */
export function discoverAgents(
  flowSource: string,
  targets = DEFAULT_TARGETS,
): SourceEntry[] {
  const agentsRoot = path.join(flowSource, "agents");
  if (!existsDir(agentsRoot)) return [];
  return fs
    .readdirSync(agentsRoot, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => ({
      source: path.join(agentsRoot, d.name),
      target: path.join(targets.agentsDir, d.name),
      kind: "agent" as const,
      displayName: d.name,
    }));
}

/**
 * Lists helper binaries under <flow-source>/bin/. Excludes test files and
 * the `flow` wrapper itself (handled separately so its target name and
 * permissions can be controlled distinctly). Strips the .ts extension on
 * the install target — users invoke `flow-new-worktree`, not `.ts`.
 */
export function discoverHelpers(
  flowSource: string,
  targets = DEFAULT_TARGETS,
): SourceEntry[] {
  const binDir = path.join(flowSource, "bin");
  if (!existsDir(binDir)) return [];
  return fs
    .readdirSync(binDir, { withFileTypes: true })
    .filter(
      (d) => (d.isFile() || d.isSymbolicLink()) && isPathBoundHelper(d.name),
    )
    .map((d) => ({
      source: path.join(binDir, d.name),
      target: path.join(targets.binDir, d.name.replace(/\.ts$/, "")),
      kind: "bin" as const,
      displayName: d.name.replace(/\.ts$/, ""),
    }));
}

/**
 * Lists the schema validators under <flow-source>/bin/lib/ that pipeline
 * skills invoke as PATH binaries. Sourced from the explicit `VALIDATOR_MODULES`
 * allowlist rather than a recursive glob of `bin/lib/` — the directory is
 * overwhelmingly internal library code and a glob would symlink non-CLI
 * modules onto PATH. The `flow-` install-target prefix keeps the validators
 * in the same namespace as every other shipped helper, so pipeline skills
 * can invoke them by bare name regardless of cwd. Returns [] if `bin/lib`
 * is absent; filters the allowlist to files that physically exist.
 */
export function discoverValidators(
  flowSource: string,
  targets = DEFAULT_TARGETS,
): SourceEntry[] {
  const libDir = path.join(flowSource, "bin", "lib");
  if (!existsDir(libDir)) return [];
  return VALIDATOR_MODULES.filter((name) =>
    fs.existsSync(path.join(libDir, name)),
  ).map((name) => {
    const displayName = `flow-${name.replace(/\.ts$/, "")}`;
    return {
      source: path.join(libDir, name),
      target: path.join(targets.binDir, displayName),
      kind: "bin" as const,
      displayName,
    };
  });
}

/**
 * The flow wrapper itself. Symlinked to <binDir>/flow.
 *
 * Anchored to `installRoot`, never `flowSource`. Bun's `import.meta.path`
 * resolves the wrapper symlink to derive `resolveFlowSource()`, so pointing
 * `~/.local/bin/flow` at a worktree's wrapper would (a) dangle the moment
 * `flow-remove-worktree` runs and (b) poison every subsequent `flow install`
 * by collapsing `installRoot` onto the worktree path.
 */
export function flowWrapperEntry(
  installRoot: string,
  targets = DEFAULT_TARGETS,
): SourceEntry | null {
  const candidate = path.join(installRoot, "bin", "flow");
  if (!fs.existsSync(candidate)) return null;
  return {
    source: candidate,
    target: path.join(targets.binDir, "flow"),
    kind: "bin",
    displayName: "flow",
  };
}

/**
 * Lists shell completion scripts under <flow-source>/completions/. Each shell
 * we ship a script for becomes a `completion`-kind entry, symlinked into
 * ~/.flow/completions/flow.<shell>.
 */
export function discoverCompletions(
  flowSource: string,
  targets = DEFAULT_TARGETS,
): SourceEntry[] {
  const completionsDir = path.join(flowSource, "completions");
  if (!existsDir(completionsDir)) return [];
  const entries: SourceEntry[] = [];
  for (const shell of COMPLETION_SHELLS) {
    const filename = `flow.${shell}`;
    const source = path.join(completionsDir, filename);
    if (!fs.existsSync(source)) continue;
    entries.push({
      source,
      target: path.join(targets.completionsDir, filename),
      kind: "completion",
      displayName: filename,
    });
  }
  return entries;
}

/**
 * All entries `flow install` should install, in display order.
 *
 * Content discovery (skills/agents/helpers/completions) reads from
 * `flowSource` so step 5.5's `--source <worktree>` can pull in-flight skill
 * additions; the wrapper entry reads from `installRoot` so
 * `~/.local/bin/flow` always points at canonical even when discovery is
 * pointed at a worktree.
 */
export function discoverAll(
  flowSource: string,
  installRoot: string,
  targets = DEFAULT_TARGETS,
): SourceEntry[] {
  const all = [
    ...discoverSkills(flowSource, targets),
    ...discoverAgents(flowSource, targets),
    ...discoverHelpers(flowSource, targets),
    ...discoverValidators(flowSource, targets),
    ...discoverCompletions(flowSource, targets),
  ];
  const wrapper = flowWrapperEntry(installRoot, targets);
  if (wrapper) all.push(wrapper);
  return all;
}

/**
 * Builds the manifest record for an entry. The `source` field captured in the
 * manifest is the *recorded owner* — the canonical install-root path — not the
 * *content source* (which may be a per-pipeline worktree when `--source
 * <worktree>` overrides discovery). When `flowSource` and `installRoot` match
 * (the common case), the two are identical and the entry's source flows through
 * unchanged. When they diverge (the `--source <worktree>` case), the recorded
 * path is rebased onto `installRoot` so the manifest survives the worktree's
 * post-merge removal.
 */
export function entryToRecord(
  entry: SourceEntry,
  flowSource: string,
  installRoot: string,
): SymlinkRecord {
  return {
    source: canonicalizeRecordedSource(entry.source, flowSource, installRoot),
    target: entry.target,
    kind: entry.kind,
  };
}

/**
 * Rebase a `flowSource`-rooted path onto `installRoot`. Identity in the two
 * cases where rebasing is meaningless: when the two roots are the same (the
 * non-`--source` common case), and when `source` does not live under
 * `flowSource` (`path.relative` escapes with a leading `..`, or is absolute —
 * e.g. the `flow` wrapper, which is already `installRoot`-anchored). The
 * `..`-guard hardens what previously worked only because
 * `flow-new-worktree` guarantees canonical/worktree are same-depth siblings;
 * a non-sibling layout would otherwise produce a wrong `path.join` result.
 */
export function rebaseOntoInstallRoot(
  source: string,
  flowSource: string,
  installRoot: string,
): string {
  if (path.resolve(flowSource) === path.resolve(installRoot)) return source;
  const rel = path.relative(flowSource, source);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return source;
  return path.join(installRoot, rel);
}

export function canonicalizeRecordedSource(
  source: string,
  flowSource: string,
  installRoot: string,
): string {
  return rebaseOntoInstallRoot(source, flowSource, installRoot);
}

/**
 * The path the *live* symlink should point at, distinct from the *recorded*
 * source (`canonicalizeRecordedSource`). Prefer the canonical (installRoot)
 * path so the symlink survives a `--source <worktree>`'s post-merge removal —
 * but only when that canonical file actually exists on disk. A genuinely
 * worktree-only new file (no canonical counterpart yet) has no canonical path
 * to point at, so it falls back to the worktree `source` and stays invocable
 * on PATH for the introducing pipeline; the post-merge `flow install
 * --upgrade` follow-up re-links it to canonical once merged. `fs.existsSync`
 * never throws (returns false on any error), so this can't break the install.
 *
 * Additions vs modifications: this is intentionally additions-only for the
 * live PATH surface. A file that already EXISTS in canonical resolves to
 * canonical EVEN IF the worktree copy was modified in-flight — the check is
 * mere existence (`fs.existsSync(rebased)`), not content-equality — so a
 * bare-name invocation during the introducing pipeline exercises the
 * unmodified canonical copy, not the in-flight edit. This is the deliberate
 * cost of the "never dangle on worktree removal" invariant: `--source
 * <worktree>` picks up brand-new files but pins modified-existing content to
 * canonical. Practical impact is minimal — step 5.5 only fires on skill/agent
 * ADDITIONS, and skills load once per session — so no code change is needed
 * here; if mid-pipeline dogfooding of modifications is ever required, gate the
 * canonical preference on content-equality instead of bare existence.
 */
export function effectiveLinkSource(
  source: string,
  flowSource: string,
  installRoot: string,
): string {
  const rebased = rebaseOntoInstallRoot(source, flowSource, installRoot);
  return rebased !== source && fs.existsSync(rebased) ? rebased : source;
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
