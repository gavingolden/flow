#!/usr/bin/env node
import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { installSkillsCommand } from "./commands/install-skills.js";

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
  .command("install-skills")
  .description("Symlink flow's bundled skills into a target repo or ~/.claude/skills")
  .option("--global", "install universal skills into ~/.claude/skills (skips pipeline + stacks)")
  .option("--stack <names>", "comma-separated stack skills to include (e.g. svelte,supabase)")
  .option("--skip-pipeline", "omit pipeline skills (use for repos that aren't flow consumers)")
  .action(async (options: { global?: boolean; stack?: string; skipPipeline?: boolean }) => {
    await installSkillsCommand(options);
  });

await program.parseAsync();
