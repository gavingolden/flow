#!/usr/bin/env node
import { Command } from "commander";
import { startCommand } from "./commands/start.js";

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

await program.parseAsync();
