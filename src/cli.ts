#!/usr/bin/env node
import { Command } from "commander";
import { installCommand } from "./commands/install.js";

const program = new Command();

program
  .name("flow")
  .description("Multi-phase AI agent dev orchestration")
  .version("0.0.1");

program
  .command("install")
  .description("Install flow's skills and scripts into the current repo (symlinked)")
  .option("--stack <names>", "comma-separated stack skills to include (e.g. svelte,supabase)")
  .option("--force", "replace tracked or real files in scripts/ with symlinks (also untracks the originals from git's index)")
  .option("--skip-pipeline", "omit pipeline skills (use for repos that aren't flow consumers)")
  .option("--upgrade", "remove orphan symlinks left by previous installs (idempotent re-sync)")
  .action(
    async (options: {
      stack?: string;
      force?: boolean;
      skipPipeline?: boolean;
      upgrade?: boolean;
    }) => {
      await installCommand(options);
    },
  );

await program.parseAsync();
