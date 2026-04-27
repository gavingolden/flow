import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { validateSkill } from "./quick_validate.ts";

const EXCLUDE_DIRS = new Set(["__pycache__", "node_modules"]);
const EXCLUDE_GLOBS = ["*.pyc"];
const EXCLUDE_FILES = new Set([".DS_Store"]);
const ROOT_EXCLUDE_DIRS = new Set(["evals"]);

function shouldExclude(relPath: string, _skillName: string): boolean {
  const parts = relPath.split("/");
  if (parts.some((p) => EXCLUDE_DIRS.has(p))) return true;
  if (parts.length > 1 && ROOT_EXCLUDE_DIRS.has(parts[1])) return true;
  const name = basename(relPath);
  if (EXCLUDE_FILES.has(name)) return true;
  return EXCLUDE_GLOBS.some((pat) => {
    const ext = pat.replace("*", "");
    return name.endsWith(ext);
  });
}

function collectFiles(dir: string, base: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(base, full);
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name)) {
        files.push(...collectFiles(full, base));
      }
    } else if (!shouldExclude(rel, basename(dir))) {
      files.push(rel);
    }
  }
  return files;
}

async function packageSkill(skillPath: string, outputDir?: string): Promise<string | null> {
  const resolved = resolve(skillPath);

  if (!existsSync(resolved)) {
    console.log(`Error: Skill folder not found: ${resolved}`);
    return null;
  }
  if (!statSync(resolved).isDirectory()) {
    console.log(`Error: Path is not a directory: ${resolved}`);
    return null;
  }
  if (!existsSync(join(resolved, "SKILL.md"))) {
    console.log(`Error: SKILL.md not found in ${resolved}`);
    return null;
  }

  console.log("Validating skill...");
  const { valid, message } = validateSkill(resolved);
  if (!valid) {
    console.log(`Validation failed: ${message}`);
    return null;
  }
  console.log(`${message}\n`);

  const skillName = basename(resolved);
  const parentDir = dirname(resolved);
  const outDir = outputDir ? resolve(outputDir) : process.cwd();
  if (outputDir) mkdirSync(outDir, { recursive: true });

  const outputFile = join(outDir, `${skillName}.skill`);
  const files = collectFiles(resolved, parentDir);

  for (const f of files) {
    console.log(`  Added: ${f}`);
  }

  const excludeArgs = [
    "-x",
    "*.pyc",
    "-x",
    "*__pycache__*",
    "-x",
    "*.DS_Store",
    "-x",
    "*node_modules*",
    "-x",
    `${skillName}/evals/*`,
  ];

  const proc = Bun.spawn(["zip", "-r", outputFile, skillName, ...excludeArgs], {
    cwd: parentDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;

  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.log(`Error creating .skill file: ${stderr}`);
    return null;
  }

  console.log(`\nSuccessfully packaged skill to: ${outputFile}`);
  return outputFile;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: bun run package_skill.ts <path/to/skill-folder> [output-directory]");
    process.exit(1);
  }

  console.log(`Packaging skill: ${args[0]}`);
  if (args[1]) console.log(`   Output directory: ${args[1]}`);
  console.log();

  const result = await packageSkill(args[0], args[1]);
  process.exit(result ? 0 : 1);
}
