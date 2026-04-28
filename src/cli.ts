#!/usr/bin/env node
import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { runCommand } from "./commands/run.js";
import { installSkillsCommand } from "./commands/install-skills.js";
import { installScriptsCommand } from "./commands/install-scripts.js";

const program = new Command();

program
  .name("flow")
  .description("Multi-phase AI agent dev orchestration")
  .version("0.0.1");

program
  .command("start")
  .description("Start a new task: opens an interactive Claude Code session for triage")
  .argument("<prompt...>", "the user's request (will be joined with spaces)")
  .action(async (promptParts: string[]) => {
    await startCommand(promptParts.join(" "));
  });

program
  .command("run")
  .description("Run the pipeline on a triaged task: plan → worktree → implement")
  .argument("<task-id>", "the task id (filename without .md)")
  .action(async (taskId: string) => {
    await runCommand(taskId);
  });

program
  .command("install-skills")
  .description("Symlink flow's bundled skills into a target repo or ~/.claude/skills")
  .option("--global", "install universal skills into ~/.claude/skills (skips pipeline + stacks)")
  .option("--stack <names>", "comma-separated stack skills to include (e.g. svelte,supabase)")
  .option("--skip-pipeline", "omit pipeline skills (use for repos that aren't flow consumers)")
  .action(async (options: { global?: boolean; stack?: string; skipPipeline?: boolean }) => {
    await installSkillsCommand(options);
  });

program
  .command("install-scripts")
  .description("Symlink flow's bundled scripts into the current repo's scripts/ directory")
  .option("--force", "replace existing real files (default: skip with a warning)")
  .action(async (options: { force?: boolean }) => {
    await installScriptsCommand(options);
  });

await program.parseAsync();
