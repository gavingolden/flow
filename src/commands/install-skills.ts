import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import pc from "picocolors";

interface InstallOptions {
  global?: boolean;
  stack?: string;
  skipPipeline?: boolean;
}

export async function installSkillsCommand(options: InstallOptions): Promise<void> {
  const skillsRoot = resolveSkillsRoot();

  const tiers = await readTiers(skillsRoot);
  const requestedStacks = parseStacks(options.stack);
  validateStacks(requestedStacks, tiers.stacks);

  const target = await resolveTarget(options.global ?? false);
  const skillsToInstall = selectSkills({
    tiers,
    global: options.global ?? false,
    skipPipeline: options.skipPipeline ?? false,
    requestedStacks,
  });

  await fs.mkdir(target.dir, { recursive: true });

  console.error(pc.dim(`flow: source     ${skillsRoot}`));
  console.error(pc.dim(`flow: target     ${target.dir}`));
  console.error(pc.dim(`flow: scope      ${target.label}`));
  console.error("");

  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const { name, sourceDir } of skillsToInstall) {
    const linkPath = path.join(target.dir, name);
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
        pc.red(`  ! ${name}  (skipped — exists as a real directory or wrong symlink)`),
      );
      skipped++;
    }
  }

  console.error("");
  console.error(
    pc.bold(
      `flow: ${created} created, ${updated} relinked, ${skipped} unchanged.`,
    ),
  );
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
      pc.red(
        `error: unknown stack(s): ${unknown.join(", ")}. Available: ${list}`,
      ),
    );
    process.exit(1);
  }
}

interface Target {
  dir: string;
  label: string;
}

async function resolveTarget(global: boolean): Promise<Target> {
  if (global) {
    return {
      dir: path.join(os.homedir(), ".claude", "skills"),
      label: "global (~/.claude/skills/)",
    };
  }
  const repoRoot = await findGitRoot();
  if (!repoRoot) {
    console.error(
      pc.red(
        "error: must be run from inside a git repository (or use --global)",
      ),
    );
    process.exit(1);
  }
  return {
    dir: path.join(repoRoot, ".claude", "skills"),
    label: `repo (${repoRoot}/.claude/skills/)`,
  };
}

async function findGitRoot(): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

interface SelectArgs {
  tiers: Tiers;
  global: boolean;
  skipPipeline: boolean;
  requestedStacks: Set<string>;
}

function selectSkills({
  tiers,
  global,
  skipPipeline,
  requestedStacks,
}: SelectArgs): SkillRef[] {
  // Global install never includes pipeline (those skills only make sense inside
  // a flow-using target repo) and never includes stacks (each repo opts in).
  if (global) return tiers.universal;

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
