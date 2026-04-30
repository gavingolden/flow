import pc from "picocolors";
import { findGitRoot } from "../util/git.js";
import { installScripts } from "../install/scripts.js";
import { installSkills } from "../install/skills.js";

export interface InstallOptions {
  stack?: string;
  force?: boolean;
  skipPipeline?: boolean;
  upgrade?: boolean;
}

export async function installCommand(options: InstallOptions): Promise<void> {
  const repoRoot = await findGitRoot();
  if (!repoRoot) {
    console.error(pc.red("error: must be run from inside a git repository"));
    process.exit(1);
  }

  const skills = await installSkills(repoRoot, {
    stack: options.stack,
    skipPipeline: options.skipPipeline,
    upgrade: options.upgrade,
  });
  console.error("");
  const scripts = await installScripts(repoRoot, {
    force: options.force,
    upgrade: options.upgrade,
  });

  console.error("");
  console.error(
    pc.bold(
      `flow: skills ${skills.created} created, ${skills.updated} relinked, ` +
        `${skills.skipped} unchanged, ${skills.removed} removed, ${skills.blocked} blocked.`,
    ),
  );
  console.error(
    pc.bold(
      `flow: scripts ${scripts.created} created, ${scripts.updated} relinked, ` +
        `${scripts.skipped} unchanged, ${scripts.removed} removed, ${scripts.blocked} blocked.`,
    ),
  );
}
