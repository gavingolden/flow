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

export interface InstallScriptsOptions {
  force?: boolean;
  upgrade?: boolean;
}

export interface InstallScriptsResult {
  created: number;
  updated: number;
  skipped: number;
  removed: number;
  blocked: number;
}

export async function installScripts(
  repoRoot: string,
  options: InstallScriptsOptions,
): Promise<InstallScriptsResult> {
  const scriptsRoot = resolveScriptsRoot();
  const targetDir = path.join(repoRoot, "scripts");

  // Source-equals-target safety: refuse to install over the source. This only
  // happens when the user runs install inside the flow repo *and*
  // templates/scripts/ has somehow been pointed at scripts/. The whole
  // architecture (templates/scripts/ as source) is designed to make source ≠
  // target, but check anyway — getting this wrong unlinks the source files.
  if (path.resolve(scriptsRoot) === path.resolve(targetDir)) {
    console.error(
      pc.red(
        `error: source and target are the same directory (${targetDir}). ` +
          `Refusing to install — would unlink the source files.`,
      ),
    );
    process.exit(1);
  }

  const scripts = await readScripts(scriptsRoot);

  await fs.mkdir(targetDir, { recursive: true });

  console.error(pc.bold("flow: installing scripts"));
  console.error(pc.dim(`      source ${scriptsRoot}`));
  console.error(pc.dim(`      target ${targetDir}`));

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let removed = 0;
  let blocked = 0;
  for (const { name, sourceFile } of scripts) {
    const linkPath = path.join(targetDir, name);
    const result = await ensureSymlink(linkPath, sourceFile, options.force ?? false);
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
        pc.red(`  ! ${name}  (skipped — real file in the way; use --force to replace)`),
      );
      blocked++;
    }
  }

  // --upgrade: remove orphan symlinks (paths previously listed in the
  // managed gitignore block but no longer present in the source tree).
  // Detection is gitignore-driven, not symlink-scan: the managed block is
  // the canonical record of what flow installed, so its diff vs. the
  // current source is the only safe definition of an orphan. A scan of
  // scripts/ would risk deleting user-pointed symlinks.
  const currentPaths = scripts.map((s) => `/scripts/${s.name}`);
  const removedOrphans: string[] = [];
  if (options.upgrade) {
    const previousPaths = await readManagedBlockPaths(repoRoot, "install-scripts");
    const currentSet = new Set(currentPaths);
    const orphans = previousPaths.filter((p) => !currentSet.has(p));
    for (const orphan of orphans) {
      const name = path.basename(orphan);
      const removedNow = await removeOrphanIfManaged({
        repoRoot,
        gitignorePath: orphan,
        sourceRoot: scriptsRoot,
        expectedPrefix: "/scripts/",
      });
      if (removedNow) {
        console.error(pc.magenta(`  - ${name}  (removed)`));
        removedOrphans.push(orphan);
        removed++;
      }
    }
    if (removedOrphans.length > 0) {
      // Idempotent: --ignore-unmatch keeps the call safe when the path was
      // never tracked in git's index (e.g. user wrote it ignored from day one).
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

  // Symlinks resolve to absolute paths on the user's machine, so they must be
  // ignored. The block lists every script the source tree currently exposes
  // (not just newly linked ones), so deletions in templates/scripts/ flow
  // through on the next install.
  const gitignoreResult = await updateGitignoreBlock(repoRoot, {
    tag: "install-scripts",
    comment: "(symlinks resolve to absolute paths and aren't portable)",
    paths: [...currentPaths].sort(),
  });
  if (gitignoreResult !== "unchanged") {
    console.error(pc.dim(`      .gitignore ${gitignoreResult}`));
  }

  // --force completes the file→symlink transition by:
  //   (a) Deleting any stale companion <name>.test.ts files. The install
  //       doesn't symlink test files (they're flow-internal — Bun-only
  //       imports, won't load through a consumer's vitest), so a target
  //       repo with old tracked tests for replaced scripts is left with
  //       tests that assert against a now-gone implementation. Delete them.
  //   (b) Untracking the originals from git's index. Without this, the
  //       .gitignore entry doesn't help: git keeps following the path and
  //       would commit the symlink as new content. The same git rm --cached
  //       sweep also catches the deletions from (a).
  // Idempotent: second run finds no typechanges or deletions to clean up.
  if (options.force) {
    const deletedTests = await deleteStaleCompanionTests(targetDir, scripts);
    const untracked = await untrackChangedScripts(repoRoot, targetDir);
    if (deletedTests.length > 0) {
      console.error(pc.dim(`      deleted ${deletedTests.length} stale companion test file(s)`));
    }
    if (untracked.length > 0) {
      console.error(pc.dim(`      untracked ${untracked.length} previously-tracked file(s):`));
      for (const p of untracked) {
        console.error(pc.dim(`        ${p}`));
      }
    }
  }

  return { created, updated, skipped, removed, blocked };
}

async function deleteStaleCompanionTests(
  targetDir: string,
  scripts: ScriptRef[],
): Promise<string[]> {
  const deleted: string[] = [];
  for (const { name } of scripts) {
    const testName = name.replace(/\.ts$/, ".test.ts");
    const testPath = path.join(targetDir, testName);
    const stat = await fs.lstat(testPath).catch(() => null);
    if (stat && !stat.isSymbolicLink() && stat.isFile()) {
      await fs.unlink(testPath);
      deleted.push(testPath);
    }
  }
  return deleted;
}

async function untrackChangedScripts(
  repoRoot: string,
  targetDir: string,
): Promise<string[]> {
  const relTarget = path.relative(repoRoot, targetDir);
  // D = deleted (from stale-test cleanup); T = typechange (file→symlink).
  // Both leave a tracked path that's no longer a real script in the working
  // tree, so the index entry should go.
  const { stdout } = await execa(
    "git",
    ["diff", "--diff-filter=DT", "--name-only", "--", relTarget],
    { cwd: repoRoot },
  );
  const paths = stdout.split("\n").filter(Boolean);
  if (paths.length === 0) return [];
  await execa("git", ["rm", "--cached", "--quiet", ...paths], { cwd: repoRoot });
  return paths;
}

interface ScriptRef {
  name: string;
  sourceFile: string;
}

function resolveScriptsRoot(): string {
  // From dist/install/scripts.js → ../../templates/scripts
  // From src/install/scripts.ts (dev mode) → ../../templates/scripts
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "templates", "scripts");
}

async function readScripts(scriptsRoot: string): Promise<ScriptRef[]> {
  const entries = await fs.readdir(scriptsRoot, { withFileTypes: true });
  // Tests stay flow-internal: their imports use Bun-only APIs and target
  // repos' vitest configs typically refuse to load files outside the
  // workspace root, so symlinking *.test.ts breaks consumer test runs.
  return entries
    .filter((e) => e.isFile())
    .filter((e) => e.name.endsWith(".ts"))
    .filter((e) => !e.name.endsWith(".test.ts"))
    .map((e) => ({ name: e.name, sourceFile: path.join(scriptsRoot, e.name) }));
}

type LinkResult = "created" | "updated" | "exists" | "blocked";

async function ensureSymlink(
  linkPath: string,
  sourceFile: string,
  force: boolean,
): Promise<LinkResult> {
  const existing = await readLink(linkPath);
  if (existing === null) {
    const stat = await statIfExists(linkPath);
    if (stat) {
      // A real path lives here. Without --force, leave it alone — could be
      // the user's own customised version. With --force, replace it — but
      // only if it's a regular file. A directory at the install target is
      // unusual and we shouldn't recursively delete it; treat it as blocked.
      if (!force || stat.isDirectory()) return "blocked";
      await fs.unlink(linkPath);
      await fs.symlink(sourceFile, linkPath);
      return "updated";
    }
    await fs.symlink(sourceFile, linkPath);
    return "created";
  }
  const resolved = path.resolve(path.dirname(linkPath), existing);
  if (resolved === sourceFile) return "exists";
  await fs.unlink(linkPath);
  await fs.symlink(sourceFile, linkPath);
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
