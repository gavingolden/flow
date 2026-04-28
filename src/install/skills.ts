import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { updateGitignoreBlock } from "../util/gitignore.js";

export interface InstallSkillsOptions {
  stack?: string;
  skipPipeline?: boolean;
}

export interface InstallSkillsResult {
  created: number;
  updated: number;
  skipped: number;
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
  let blocked = 0;
  for (const { name, sourceDir } of skillsToInstall) {
    const linkPath = path.join(targetDir, name);
    const result = await ensureSymlink(linkPath, sourceDir);
    if (result === "created") {
      console.error(pc.green(`  + ${name}`));
      created++;
    } else if (result === "updated") {
      console.error(pc.yellow(`  ~ ${name}  (relinked)`));
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

  // Skill symlinks resolve to absolute paths under the user's home and aren't
  // portable, so the repo's .gitignore must list them. The block reflects every
  // skill the install actually emitted (pipeline / universal / stacks honor
  // the user's flags), so deselected skills get their entries pruned.
  const gitignoreResult = await updateGitignoreBlock(repoRoot, {
    tag: "install-skills",
    comment: "(symlinks resolve to absolute paths and aren't portable)",
    paths: skillsToInstall.map((s) => `/.claude/skills/${s.name}`).sort(),
  });
  if (gitignoreResult !== "unchanged") {
    console.error(pc.dim(`      .gitignore ${gitignoreResult}`));
  }

  return { created, updated, skipped, blocked };
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
