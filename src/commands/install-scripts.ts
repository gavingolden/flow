import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { findGitRoot } from "../util/git.js";

interface InstallOptions {
  force?: boolean;
}

interface ScriptRef {
  name: string;
  sourceFile: string;
}

export async function installScriptsCommand(options: InstallOptions): Promise<void> {
  const scriptsRoot = resolveScriptsRoot();
  const repoRoot = await findGitRoot();
  if (!repoRoot) {
    console.error(pc.red("error: must be run from inside a git repository"));
    process.exit(1);
  }

  const targetDir = path.join(repoRoot, "scripts");

  // Source-equals-target safety: refuse to install over the source. This only
  // happens when the user runs `flow install-scripts` inside the flow repo
  // *and* templates/scripts/ has somehow been pointed at scripts/. The whole
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

  console.error(pc.dim(`flow: source     ${scriptsRoot}`));
  console.error(pc.dim(`flow: target     ${targetDir}`));
  console.error("");

  let created = 0;
  let updated = 0;
  let skipped = 0;
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

  console.error("");
  console.error(
    pc.bold(
      `flow: ${created} created, ${updated} relinked, ${skipped} unchanged, ${blocked} blocked.`,
    ),
  );

  if (created > 0 || updated > 0) {
    console.error("");
    console.error(pc.dim("Add these to your .gitignore so the symlinks don't get tracked:"));
    for (const { name } of scripts) {
      console.error(pc.dim(`  /scripts/${name}`));
    }
  }
}

function resolveScriptsRoot(): string {
  // From dist/commands/install-scripts.js → ../../templates/scripts
  // From src/commands/install-scripts.ts (dev mode) → ../../templates/scripts
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "templates", "scripts");
}

async function readScripts(scriptsRoot: string): Promise<ScriptRef[]> {
  const entries = await fs.readdir(scriptsRoot, { withFileTypes: true });
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
      // A real file lives there. Without --force, leave it alone — could be
      // the user's own customised version. With --force, replace it.
      if (!force) return "blocked";
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
