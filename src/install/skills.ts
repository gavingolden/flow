import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import pc from "picocolors";
import {
  readManagedBlockPaths,
  updateGitignoreBlock,
} from "../util/gitignore.js";
import { removeOrphanIfManaged } from "./orphan.js";
import {
  INCLUDE_MARKER,
  renderWithTriageContract,
} from "./triage-contract.js";

export interface InstallSkillsOptions {
  stack?: string;
  skipPipeline?: boolean;
  upgrade?: boolean;
}

export interface InstallSkillsResult {
  created: number;
  updated: number;
  skipped: number;
  removed: number;
  blocked: number;
}

export async function installSkills(
  repoRoot: string,
  options: InstallSkillsOptions,
): Promise<InstallSkillsResult> {
  const skillsRoot = resolveSkillsRoot();
  const tiers = await readTiers(skillsRoot);
  const requestedStacks = parseStacks(options.stack);
  validateStacks(requestedStacks, tiers.stacks);

  const targetDir = path.join(repoRoot, ".claude", "skills");
  const skillsToInstall = selectSkills({
    tiers,
    skipPipeline: options.skipPipeline ?? false,
    requestedStacks,
  });

  await fs.mkdir(targetDir, { recursive: true });

  console.error(pc.bold("flow: installing skills"));
  console.error(pc.dim(`      source ${skillsRoot}`));
  console.error(pc.dim(`      target ${targetDir}`));

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let removed = 0;
  let blocked = 0;
  for (const { name, sourceDir } of skillsToInstall) {
    const installPath = path.join(targetDir, name);
    // Skills that embed the include marker can't be symlinked: their on-disk
    // body must contain the resolved partial bytes, otherwise Claude Code
    // sees the literal `<!-- include: ... -->` comment and the contract
    // never reaches the chat. Render-and-write for those; symlink the rest
    // so dev edits propagate without a re-install for unaffected skills.
    const needsRender = await skillNeedsRender(sourceDir);
    const result = needsRender
      ? await ensureRendered(installPath, sourceDir, repoRoot)
      : await ensureSymlink(installPath, sourceDir);
    if (result === "created") {
      console.error(pc.green(`  + ${name}`));
      created++;
    } else if (result === "updated") {
      console.error(
        pc.yellow(
          `  ~ ${name}  (${needsRender ? "re-rendered" : "relinked"})`,
        ),
      );
      updated++;
    } else if (result === "exists") {
      console.error(pc.dim(`  = ${name}  (already linked)`));
      skipped++;
    } else {
      console.error(
        pc.red(`  ! ${name}  (blocked — exists as a real directory or wrong symlink)`),
      );
      blocked++;
    }
  }

  // --upgrade: orphan-removal sweep. See scripts.ts for the rationale —
  // gitignore-driven detection only ever cleans up things flow definitely
  // managed (real dirs and user-pointed symlinks are left alone).
  //
  // Orphan detection is anchored to the *whole* source tree, not the
  // currently-selected subset: an "orphan" is a path absent from source,
  // not a path the user happened to deselect with --skip-pipeline / --stack.
  // Otherwise `flow install --upgrade --skip-pipeline` would delete every
  // pipeline skill the previous install put down. The gitignore block still
  // reflects the selected subset (existing behavior — deselected skills
  // drop out of the block on the rewrite below).
  const currentPaths = skillsToInstall.map((s) => `/.claude/skills/${s.name}`);
  const allSourcePaths = [
    ...tiers.pipeline,
    ...tiers.universal,
    ...tiers.stacks,
  ].map((s) => `/.claude/skills/${s.name}`);
  const removedOrphans: string[] = [];
  if (options.upgrade) {
    const previousPaths = await readManagedBlockPaths(repoRoot, "install-skills");
    const sourceSet = new Set(allSourcePaths);
    const orphans = previousPaths.filter((p) => !sourceSet.has(p));
    for (const orphan of orphans) {
      const name = path.basename(orphan);
      const removedNow = await removeOrphanIfManaged({
        repoRoot,
        gitignorePath: orphan,
        sourceRoot: skillsRoot,
        expectedPrefix: "/.claude/skills/",
      });
      if (removedNow) {
        console.error(pc.magenta(`  - ${name}  (removed)`));
        removedOrphans.push(orphan);
        removed++;
      }
    }
    if (removedOrphans.length > 0) {
      await execa(
        "git",
        [
          "rm",
          "--cached",
          "--quiet",
          "--ignore-unmatch",
          "--",
          ...removedOrphans.map((p) => p.replace(/^\//, "")),
        ],
        { cwd: repoRoot },
      );
    }
  }

  // Skill symlinks resolve to absolute paths under the user's home, and
  // rendered skills embed user-machine-specific paths in their bodies — both
  // are non-portable across checkouts, so the repo's .gitignore must list
  // them. They share the same managed block because they share the same
  // install dir. The block reflects every skill the install actually emitted
  // (pipeline / universal / stacks honor the user's flags), so deselected
  // skills get their entries pruned.
  const gitignoreResult = await updateGitignoreBlock(repoRoot, {
    tag: "install-skills",
    comment:
      "(symlinks resolve to absolute paths and rendered skills embed machine-local paths — neither is portable)",
    paths: [...currentPaths].sort(),
  });
  if (gitignoreResult !== "unchanged") {
    console.error(pc.dim(`      .gitignore ${gitignoreResult}`));
  }

  return { created, updated, skipped, removed, blocked };
}

function resolveSkillsRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "skills");
}

interface Tiers {
  pipeline: SkillRef[];
  universal: SkillRef[];
  stacks: SkillRef[];
}

interface SkillRef {
  name: string;
  sourceDir: string;
}

async function readTiers(skillsRoot: string): Promise<Tiers> {
  return {
    pipeline: await readTier(path.join(skillsRoot, "pipeline")),
    universal: await readTier(path.join(skillsRoot, "universal")),
    stacks: await readTier(path.join(skillsRoot, "stacks")),
  };
}

async function readTier(dir: string): Promise<SkillRef[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, sourceDir: path.join(dir, e.name) }));
}

function parseStacks(stack: string | undefined): Set<string> {
  if (!stack) return new Set();
  return new Set(
    stack
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function validateStacks(requested: Set<string>, available: SkillRef[]): void {
  const availableNames = new Set(available.map((s) => s.name));
  const unknown = [...requested].filter((s) => !availableNames.has(s));
  if (unknown.length > 0) {
    const list = [...availableNames].sort().join(", ");
    console.error(
      pc.red(`error: unknown stack(s): ${unknown.join(", ")}. Available: ${list}`),
    );
    process.exit(1);
  }
}

interface SelectArgs {
  tiers: Tiers;
  skipPipeline: boolean;
  requestedStacks: Set<string>;
}

function selectSkills({
  tiers,
  skipPipeline,
  requestedStacks,
}: SelectArgs): SkillRef[] {
  const out: SkillRef[] = [];
  if (!skipPipeline) out.push(...tiers.pipeline);
  out.push(...tiers.universal);
  for (const stack of tiers.stacks) {
    if (requestedStacks.has(stack.name)) out.push(stack);
  }
  return out;
}

type LinkResult = "created" | "updated" | "exists" | "blocked";

async function ensureSymlink(
  linkPath: string,
  targetDir: string,
): Promise<LinkResult> {
  const existing = await readLink(linkPath);
  if (existing === null) {
    const stat = await statIfExists(linkPath);
    if (stat) {
      // A real file/dir already lives there — don't clobber.
      return "blocked";
    }
    await fs.symlink(targetDir, linkPath);
    return "created";
  }
  const resolved = path.resolve(path.dirname(linkPath), existing);
  if (resolved === targetDir) return "exists";
  await fs.unlink(linkPath);
  await fs.symlink(targetDir, linkPath);
  return "updated";
}

/**
 * Renders a skill that embeds the triage-contract include marker into a real
 * directory under `<targetDir>/.claude/skills/<name>/`. Replaces a stale
 * symlink (left behind by a pre-render install) with a real directory.
 *
 * Rendering is unconditional on every install (no content-hash skip): an
 * upstream edit to `triage-contract.md` must propagate even when the skill
 * body itself is unchanged, and the cost of one fs write per install is
 * trivial.
 */
export async function ensureRendered(
  installPath: string,
  sourceDir: string,
  repoRoot: string,
): Promise<LinkResult> {
  const existing = await statIfExists(installPath);
  let result: LinkResult;
  if (existing === null) {
    result = "created";
  } else if (existing.isSymbolicLink()) {
    // Stale symlink from before render-mode landed. Replace with a real dir.
    await fs.unlink(installPath);
    result = "updated";
  } else if (existing.isDirectory()) {
    result = "updated";
  } else {
    // A regular file at the install path is unexpected — don't clobber.
    return "blocked";
  }

  await fs.mkdir(installPath, { recursive: true });
  const sourceEntries = (
    await fs.readdir(sourceDir, { withFileTypes: true })
  ).filter((entry) => entry.isFile());
  const sourceNames = new Set(sourceEntries.map((entry) => entry.name));

  // Sweep stale files left behind by a prior install (e.g. an upstream rename
  // or deletion). Without this, `.claude/skills/<name>/` accumulates orphan
  // files across upgrades and Claude Code may load stale partials that no
  // longer match the source. The symlink path doesn't have this issue
  // because the link target itself is the source dir — there's nothing
  // separate to sweep.
  const installedEntries = await fs.readdir(installPath, {
    withFileTypes: true,
  });
  for (const entry of installedEntries) {
    if (sourceNames.has(entry.name)) continue;
    await fs.rm(path.join(installPath, entry.name), {
      recursive: true,
      force: true,
    });
  }

  for (const entry of sourceEntries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(installPath, entry.name);
    const raw = await fs.readFile(sourcePath, "utf8");
    const rendered = await renderWithTriageContract(raw, { repoRoot });
    await fs.writeFile(targetPath, rendered);
  }
  return result;
}

async function skillNeedsRender(sourceDir: string): Promise<boolean> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const raw = await fs.readFile(
      path.join(sourceDir, entry.name),
      "utf8",
    );
    if (raw.includes(INCLUDE_MARKER)) return true;
  }
  return false;
}

async function readLink(p: string): Promise<string | null> {
  try {
    return await fs.readlink(p);
  } catch {
    return null;
  }
}

async function statIfExists(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}
