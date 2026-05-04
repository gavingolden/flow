/**
 * Discover what `flow setup` should install: skills, agents, and helper
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
export function discoverSkills(flowSource: string, targets = DEFAULT_TARGETS): SourceEntry[] {
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
export function discoverAgents(flowSource: string, targets = DEFAULT_TARGETS): SourceEntry[] {
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
export function discoverHelpers(flowSource: string, targets = DEFAULT_TARGETS): SourceEntry[] {
  const binDir = path.join(flowSource, "bin");
  if (!existsDir(binDir)) return [];
  return fs
    .readdirSync(binDir, { withFileTypes: true })
    .filter((d) => (d.isFile() || d.isSymbolicLink()) && d.name.endsWith(".ts"))
    .filter((d) => !d.name.endsWith(".test.ts"))
    .filter((d) => d.name !== "flow.ts") // wrapper itself, if present
    .map((d) => ({
      source: path.join(binDir, d.name),
      target: path.join(targets.binDir, d.name.replace(/\.ts$/, "")),
      kind: "bin" as const,
      displayName: d.name.replace(/\.ts$/, ""),
    }));
}

/**
 * The flow wrapper itself. Symlinked to <binDir>/flow.
 *
 * Anchored to `installRoot`, never `flowSource`. Bun's `import.meta.path`
 * resolves the wrapper symlink to derive `resolveFlowSource()`, so pointing
 * `~/.local/bin/flow` at a worktree's wrapper would (a) dangle the moment
 * `flow-remove-worktree` runs and (b) poison every subsequent `flow setup`
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
 * All entries `flow setup` should install, in display order.
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

export function canonicalizeRecordedSource(
  source: string,
  flowSource: string,
  installRoot: string,
): string {
  if (path.resolve(flowSource) === path.resolve(installRoot)) return source;
  const rel = path.relative(flowSource, source);
  return path.join(installRoot, rel);
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
