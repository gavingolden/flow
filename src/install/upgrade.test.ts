import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installScripts } from "./scripts.js";
import { installSkills } from "./skills.js";

// Each test stands up a tmp git repo, copies a small fake source tree into
// it (or hand-points at a real one), and asserts the install behavior. This
// matches the real-git pattern in src/util/git.test.ts and gitignore.test.ts.
//
// We can't override `resolveScriptsRoot` / `resolveSkillsRoot` directly —
// they read `import.meta.url` — so the tests use the real source roots
// (templates/scripts and skills) and inject orphans via the gitignore
// managed block.

let repoRoot!: string;

async function setupRepo(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-upgrade-"));
  await execa("git", ["init", "-q", "--initial-branch=main", tmp]);
  await execa("git", ["-C", tmp, "config", "user.email", "t@e.test"]);
  await execa("git", ["-C", tmp, "config", "user.name", "t"]);
  return tmp;
}

beforeEach(async () => {
  repoRoot = await setupRepo();
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

// Resolve the same source roots the install modules use (and a known-real
// existing skill to point synthetic symlinks at, so the "is-managed" check
// passes for our orphans).
function projectRoot(): string {
  // src/install/upgrade.test.ts → ../../
  return path.resolve(import.meta.dirname, "..", "..");
}

function scriptsRoot(): string {
  return path.join(projectRoot(), "templates", "scripts");
}

function skillsRoot(): string {
  return path.join(projectRoot(), "skills");
}

async function realSkillSourceDir(): Promise<string> {
  const pipelineDir = path.join(skillsRoot(), "pipeline");
  const entries = await fs.readdir(pipelineDir, { withFileTypes: true });
  const dir = entries.find((e) => e.isDirectory());
  if (!dir) throw new Error("no pipeline skill found to point orphan at");
  return path.join(pipelineDir, dir.name);
}

async function realScriptSourceFile(): Promise<string> {
  const entries = await fs.readdir(scriptsRoot(), { withFileTypes: true });
  const file = entries.find(
    (e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"),
  );
  if (!file) throw new Error("no script source file found to point orphan at");
  return path.join(scriptsRoot(), file.name);
}

// Seed a `# managed by flow <tag>` block. Called *before* installX runs so
// install sees the prior path set and computes orphans against it.
async function seedManagedBlock(tag: string, paths: string[]): Promise<void> {
  const lines = [
    `# managed by flow ${tag}`,
    "# (symlinks resolve to absolute paths and aren't portable)",
    ...paths,
    `# end flow ${tag}`,
    "",
  ];
  await fs.writeFile(path.join(repoRoot, ".gitignore"), lines.join("\n"));
}

async function readGitignore(): Promise<string> {
  return fs.readFile(path.join(repoRoot, ".gitignore"), "utf8");
}

async function isSymlink(p: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(p);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function isTracked(p: string): Promise<boolean> {
  const rel = path.relative(repoRoot, p);
  const result = await execa(
    "git",
    ["-C", repoRoot, "ls-files", "--error-unmatch", "--", rel],
    { reject: false },
  );
  return result.exitCode === 0;
}

// --- Skills orphan removal ---

describe("installSkills --upgrade orphan removal", () => {
  it("removes a symlink whose target resolves under the source tree", async () => {
    const skillsTarget = path.join(repoRoot, ".claude", "skills");
    await fs.mkdir(skillsTarget, { recursive: true });
    const orphanLink = path.join(skillsTarget, "old-skill");
    const realSrc = await realSkillSourceDir();
    await fs.symlink(realSrc, orphanLink);
    await seedManagedBlock("install-skills", ["/.claude/skills/old-skill"]);

    const result = await installSkills(repoRoot, { upgrade: true });

    expect(result.removed).toBe(1);
    expect(await pathExists(orphanLink)).toBe(false);
    const ignore = await readGitignore();
    expect(ignore).not.toContain("/.claude/skills/old-skill");
  });

  it("leaves a user-pointed symlink alone but still drops the gitignore entry", async () => {
    const skillsTarget = path.join(repoRoot, ".claude", "skills");
    await fs.mkdir(skillsTarget, { recursive: true });
    const orphanLink = path.join(skillsTarget, "user-pointed");
    const outsideTarget = await fs.mkdtemp(path.join(os.tmpdir(), "flow-user-"));
    try {
      await fs.symlink(outsideTarget, orphanLink);
      await seedManagedBlock("install-skills", ["/.claude/skills/user-pointed"]);

      const result = await installSkills(repoRoot, { upgrade: true });

      expect(result.removed).toBe(0);
      expect(await isSymlink(orphanLink)).toBe(true);
      const ignore = await readGitignore();
      expect(ignore).not.toContain("/.claude/skills/user-pointed");
    } finally {
      await fs.rm(outsideTarget, { recursive: true, force: true });
    }
  });

  it("leaves a real directory alone but still drops the gitignore entry", async () => {
    const skillsTarget = path.join(repoRoot, ".claude", "skills");
    await fs.mkdir(skillsTarget, { recursive: true });
    const orphanDir = path.join(skillsTarget, "real-dir");
    await fs.mkdir(orphanDir);
    await fs.writeFile(path.join(orphanDir, "SKILL.md"), "# user content");
    await seedManagedBlock("install-skills", ["/.claude/skills/real-dir"]);

    const result = await installSkills(repoRoot, { upgrade: true });

    expect(result.removed).toBe(0);
    expect(await pathExists(orphanDir)).toBe(true);
    const ignore = await readGitignore();
    expect(ignore).not.toContain("/.claude/skills/real-dir");
  });

  it("untracks an orphan that was tracked in git's index", async () => {
    const skillsTarget = path.join(repoRoot, ".claude", "skills");
    await fs.mkdir(skillsTarget, { recursive: true });
    const orphanLink = path.join(skillsTarget, "tracked-orphan");
    const realSrc = await realSkillSourceDir();
    await fs.symlink(realSrc, orphanLink);
    await seedManagedBlock("install-skills", ["/.claude/skills/tracked-orphan"]);
    // -f because .gitignore lists the path; we need the index entry to test
    // the untrack path.
    await execa(
      "git",
      ["-C", repoRoot, "add", "-f", ".claude/skills/tracked-orphan"],
    );
    expect(await isTracked(orphanLink)).toBe(true);

    const first = await installSkills(repoRoot, { upgrade: true });
    expect(first.removed).toBe(1);
    expect(await isTracked(orphanLink)).toBe(false);

    const second = await installSkills(repoRoot, { upgrade: true });
    expect(second.removed).toBe(0);
  });

  it("reports 0 removed when there are no orphans", async () => {
    // Seed the block with the *current* path set so nothing is an orphan.
    // The skills modules read the actual source tree so we have to seed
    // accordingly. To keep the test focused, seed only one entry that
    // overlaps with the source set — the other current paths flow through
    // unchanged.
    const pipelineDir = path.join(skillsRoot(), "pipeline");
    const entries = await fs.readdir(pipelineDir, { withFileTypes: true });
    const firstSkill = entries.find((e) => e.isDirectory())!.name;
    await seedManagedBlock("install-skills", [
      `/.claude/skills/${firstSkill}`,
    ]);

    const result = await installSkills(repoRoot, { upgrade: true });
    expect(result.removed).toBe(0);
  });

  it("plain install (no --upgrade) leaves orphan symlink in place", async () => {
    const skillsTarget = path.join(repoRoot, ".claude", "skills");
    await fs.mkdir(skillsTarget, { recursive: true });
    const orphanLink = path.join(skillsTarget, "old-skill");
    const realSrc = await realSkillSourceDir();
    await fs.symlink(realSrc, orphanLink);
    await seedManagedBlock("install-skills", ["/.claude/skills/old-skill"]);

    const result = await installSkills(repoRoot, {});

    expect(result.removed).toBe(0);
    expect(await isSymlink(orphanLink)).toBe(true);
    const ignore = await readGitignore();
    // The block is rewritten with the new path set (existing behavior),
    // so the old-skill entry naturally drops from the gitignore.
    expect(ignore).not.toContain("/.claude/skills/old-skill");
  });
});

// --- Scripts orphan removal ---

describe("installScripts --upgrade orphan removal", () => {
  it("removes a symlink whose target resolves under the source tree", async () => {
    const scriptsTarget = path.join(repoRoot, "scripts");
    await fs.mkdir(scriptsTarget, { recursive: true });
    const orphanLink = path.join(scriptsTarget, "old-script.ts");
    const realSrc = await realScriptSourceFile();
    await fs.symlink(realSrc, orphanLink);
    await seedManagedBlock("install-scripts", ["/scripts/old-script.ts"]);

    const result = await installScripts(repoRoot, { upgrade: true });

    expect(result.removed).toBe(1);
    expect(await pathExists(orphanLink)).toBe(false);
    const ignore = await readGitignore();
    expect(ignore).not.toContain("/scripts/old-script.ts");
  });

  it("leaves a user-pointed symlink alone but still drops the gitignore entry", async () => {
    const scriptsTarget = path.join(repoRoot, "scripts");
    await fs.mkdir(scriptsTarget, { recursive: true });
    const orphanLink = path.join(scriptsTarget, "user-pointed.ts");
    const outsideFile = await fs.mkdtemp(path.join(os.tmpdir(), "flow-user-"));
    const outsideTarget = path.join(outsideFile, "user.ts");
    await fs.writeFile(outsideTarget, "// user");
    try {
      await fs.symlink(outsideTarget, orphanLink);
      await seedManagedBlock("install-scripts", ["/scripts/user-pointed.ts"]);

      const result = await installScripts(repoRoot, { upgrade: true });

      expect(result.removed).toBe(0);
      expect(await isSymlink(orphanLink)).toBe(true);
      const ignore = await readGitignore();
      expect(ignore).not.toContain("/scripts/user-pointed.ts");
    } finally {
      await fs.rm(outsideFile, { recursive: true, force: true });
    }
  });

  it("leaves a real file alone but still drops the gitignore entry", async () => {
    const scriptsTarget = path.join(repoRoot, "scripts");
    await fs.mkdir(scriptsTarget, { recursive: true });
    const orphanFile = path.join(scriptsTarget, "real-file.ts");
    await fs.writeFile(orphanFile, "// user content");
    await seedManagedBlock("install-scripts", ["/scripts/real-file.ts"]);

    const result = await installScripts(repoRoot, { upgrade: true });

    expect(result.removed).toBe(0);
    expect(await pathExists(orphanFile)).toBe(true);
    const ignore = await readGitignore();
    expect(ignore).not.toContain("/scripts/real-file.ts");
  });

  it("untracks an orphan that was tracked in git's index; second run is a no-op", async () => {
    const scriptsTarget = path.join(repoRoot, "scripts");
    await fs.mkdir(scriptsTarget, { recursive: true });
    const orphanLink = path.join(scriptsTarget, "tracked.ts");
    const realSrc = await realScriptSourceFile();
    await fs.symlink(realSrc, orphanLink);
    await seedManagedBlock("install-scripts", ["/scripts/tracked.ts"]);
    await execa(
      "git",
      ["-C", repoRoot, "add", "-f", "scripts/tracked.ts"],
    );
    expect(await isTracked(orphanLink)).toBe(true);

    const first = await installScripts(repoRoot, { upgrade: true });
    expect(first.removed).toBe(1);
    expect(await isTracked(orphanLink)).toBe(false);

    const second = await installScripts(repoRoot, { upgrade: true });
    expect(second.removed).toBe(0);
  });

  it("plain install (no --upgrade) leaves orphan symlink in place", async () => {
    const scriptsTarget = path.join(repoRoot, "scripts");
    await fs.mkdir(scriptsTarget, { recursive: true });
    const orphanLink = path.join(scriptsTarget, "old-script.ts");
    const realSrc = await realScriptSourceFile();
    await fs.symlink(realSrc, orphanLink);
    await seedManagedBlock("install-scripts", ["/scripts/old-script.ts"]);

    const result = await installScripts(repoRoot, {});

    expect(result.removed).toBe(0);
    expect(await isSymlink(orphanLink)).toBe(true);
    const ignore = await readGitignore();
    expect(ignore).not.toContain("/scripts/old-script.ts");
  });
});
