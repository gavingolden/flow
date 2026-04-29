#!/usr/bin/env node
import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { runCommand } from "./commands/run.js";
import { installCommand } from "./commands/install.js";
import { logCommand } from "./commands/log.js";

const program = new Command();

program
  .name("flow")
  .description("Multi-phase AI agent dev orchestration")
  .version("0.0.1");

program
  .command("start")
  .description(
    "Start a new task: opens an interactive Claude Code session for triage. " +
      "If no prompt is given as arguments, reads it from stdin (e.g. `flow start <<EOF … EOF`).",
  )
  .argument(
    "[prompt...]",
    "the user's request (joined with spaces); omit to read from piped stdin",
  )
  .action(async (promptParts: string[] = []) => {
    await startCommand(promptParts);
  });

program
  .command("run")
  .description("Run the pipeline on a triaged task: plan → worktree → implement")
  .argument("<task-id>", "the task id (filename without .md)")
  .option("--detach", "fork into a detached process tree and exit the parent immediately")
  .action(async (taskId: string, opts: { detach?: boolean }) => {
    await runCommand(taskId, { detach: opts.detach });
  });

program
  .command("log")
  .description("Pretty-print phase logs for a task (jsonl viewer)")
  .argument("[id]", "the task id (omit to list available task ids)")
  .option("--phase <name>", "filter to log files whose phase matches <name>")
  .option("--follow", "tail the most recent phase log file")
  .option("--raw", "emit the original jsonl bytes verbatim (suitable for jq)")
  .action(
    async (
      id: string | undefined,
      opts: { phase?: string; follow?: boolean; raw?: boolean },
    ) => {
      const code = await logCommand(id, opts);
      if (code !== 0) process.exit(code);
    },
  );

program
  .command("install")
  .description("Install flow's skills and scripts into the current repo (symlinked)")
  .option("--stack <names>", "comma-separated stack skills to include (e.g. svelte,supabase)")
  .option("--force", "replace tracked or real files in scripts/ with symlinks (also untracks the originals from git's index)")
  .option("--skip-pipeline", "omit pipeline skills (use for repos that aren't flow consumers)")
  .action(
    async (options: { stack?: string; force?: boolean; skipPipeline?: boolean }) => {
      await installCommand(options);
    },
  );

await program.parseAsync();
