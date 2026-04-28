#!/usr/bin/env node
import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { runCommand } from "./commands/run.js";
import { installCommand } from "./commands/install.js";

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
  .command("install")
  .description("Install flow's skills and scripts into the current repo (symlinked)")
  .option("--stack <names>", "comma-separated stack skills to include (e.g. svelte,supabase)")
  .option("--force", "replace existing real files in scripts/ (default: skip with a warning)")
  .option("--skip-pipeline", "omit pipeline skills (use for repos that aren't flow consumers)")
  .action(
    async (options: { stack?: string; force?: boolean; skipPipeline?: boolean }) => {
      await installCommand(options);
    },
  );

await program.parseAsync();
