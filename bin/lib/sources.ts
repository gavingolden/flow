/**
 * Discover what `flow setup` should install: skills, agents, and helper
 * binaries from the flow source tree. Each entry pairs the absolute source
 * path with its target install path.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CLAUDE_AGENTS_DIR, CLAUDE_SKILLS_DIR, LOCAL_BIN_DIR } from "./paths";
import type { SymlinkKind, SymlinkRecord } from "./manifest";

const SKILL_TIERS = ["pipeline", "universal", "stacks"] as const;

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
};

export const DEFAULT_TARGETS: InstallTargets = {
  skillsDir: CLAUDE_SKILLS_DIR,
  agentsDir: CLAUDE_AGENTS_DIR,
  binDir: LOCAL_BIN_DIR,
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

/** The flow wrapper itself. Symlinked to <binDir>/flow. */
export function flowWrapperEntry(
  flowSource: string,
  targets = DEFAULT_TARGETS,
): SourceEntry | null {
  const candidate = path.join(flowSource, "bin", "flow");
  if (!fs.existsSync(candidate)) return null;
  return {
    source: candidate,
    target: path.join(targets.binDir, "flow"),
    kind: "bin",
    displayName: "flow",
  };
}

/** All entries `flow setup` should install, in display order. */
export function discoverAll(flowSource: string, targets = DEFAULT_TARGETS): SourceEntry[] {
  const all = [
    ...discoverSkills(flowSource, targets),
    ...discoverAgents(flowSource, targets),
    ...discoverHelpers(flowSource, targets),
  ];
  const wrapper = flowWrapperEntry(flowSource, targets);
  if (wrapper) all.push(wrapper);
  return all;
}

export function entryToRecord(entry: SourceEntry): SymlinkRecord {
  return { source: entry.source, target: entry.target, kind: entry.kind };
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
