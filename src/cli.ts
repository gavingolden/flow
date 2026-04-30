#!/usr/bin/env node
import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { runCommand } from "./commands/run.js";
import { runAllCommand } from "./commands/run-all.js";
import { installCommand } from "./commands/install.js";
import { logCommand } from "./commands/log.js";
import { statusCommand } from "./commands/status.js";
import { approveCommand } from "./commands/approve.js";
import { reviseCommand } from "./commands/revise.js";

const program = new Command();

program
  .name("flow")
  .description("Multi-phase AI agent dev orchestration")
  .version("0.0.1");

program
  .command("start")
  .description(
    "[deprecated] Start a new task: opens an interactive Claude Code session for triage. " +
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
  .argument(
    "[task]",
    "task id, path to the task .md file, or path to a phase/run subdir (omit with --all)",
  )
  .option("--detach", "fork into a detached process tree and exit the parent immediately")
  .option("--all", "drain every triaged task by spawning a worker per task")
  .option(
    "--max <n>",
    "with --all: bound concurrent workers (default: min(cpus, 4))",
  )
  .option("--watch", "with --all: keep polling for new triaged tasks after the initial drain")
  .option(
    "--watch-interval <seconds>",
    "with --all --watch: poll cadence in seconds (default: 5)",
  )
  .action(
    async (
      taskId: string | undefined,
      opts: {
        detach?: boolean;
        all?: boolean;
        max?: string;
        watch?: boolean;
        watchInterval?: string;
      },
    ) => {
      if (opts.all) {
        if (taskId) {
          console.error(
            "error: --all is incompatible with a positional task argument",
          );
          process.exit(2);
        }
        let max: number | undefined;
        if (opts.max != null) {
          const n = Number.parseInt(opts.max, 10);
          if (!Number.isInteger(n) || n < 1 || String(n) !== opts.max.trim()) {
            console.error("error: --max must be a positive integer");
            process.exit(2);
          }
          max = n;
        }
        let watchIntervalMs: number | undefined;
        if (opts.watchInterval != null) {
          if (!opts.watch) {
            console.error(
              "error: --watch-interval requires --watch (the interval is meaningless without watch mode)",
            );
            process.exit(2);
          }
          const s = Number.parseInt(opts.watchInterval, 10);
          if (!Number.isInteger(s) || s < 1 || String(s) !== opts.watchInterval.trim()) {
            console.error("error: --watch-interval must be a positive integer (seconds)");
            process.exit(2);
          }
          watchIntervalMs = s * 1000;
        }
        await runAllCommand({
          max,
          watch: opts.watch,
          watchIntervalMs,
          detach: opts.detach,
        });
        return;
      }
      if (!taskId) {
        console.error("error: missing task argument (or pass --all)");
        process.exit(2);
      }
      // Reject `--max` / `--watch` / `--watch-interval` when `--all` is
      // not set so a typo (`flow run <id> --watch`) doesn't silently
      // ignore the flag.
      if (opts.max != null || opts.watch || opts.watchInterval != null) {
        console.error(
          "error: --max, --watch, and --watch-interval require --all",
        );
        process.exit(2);
      }
      await runCommand(taskId, { detach: opts.detach });
    },
  );

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
  .command("status")
  .description(
    "Show task roster (id, status, phase, PR, last-updated, cost). " +
      "Pass an id to drill into one task; --all also includes archived tasks.",
  )
  .argument("[id]", "task id (omit to list every active task)")
  .option("--all", "also include archived tasks under .orchestrator/tasks/archive/")
  .option("--json", "emit a single JSON document instead of the human-readable table")
  .action(
    async (id: string | undefined, opts: { all?: boolean; json?: boolean }) => {
      const code = await statusCommand(id, opts);
      if (code !== 0) process.exit(code);
    },
  );

program
  .command("approve")
  .description(
    "Clear a plan-pending-review checkpoint: transition the task to `planned` " +
      "and re-spawn `flow run --detach` so the pipeline picks up at implement.",
  )
  .argument("<task>", "task id or path to the task .md file")
  .option("--no-resume", "skip the detached re-spawn (status transitions only)")
  .action(async (taskId: string, opts: { resume?: boolean }) => {
    const code = await approveCommand(taskId, { resume: opts.resume });
    if (code !== 0) process.exit(code);
  });

program
  .command("revise")
  .description(
    "Record a redirection for a paused plan: append the message to the task's " +
      "`## Revision notes`, revert to `worktree-ready`, and re-spawn the " +
      "pipeline so the plan phase re-runs with the new notes threaded in. " +
      "Message comes from `--message <text>` or piped stdin.",
  )
  .argument("<task>", "task id or path to the task .md file")
  .option("-m, --message <text>", "revision message (otherwise read from stdin)")
  .option("--no-resume", "skip the detached re-spawn (status transitions only)")
  .action(
    async (
      taskId: string,
      opts: { message?: string; resume?: boolean },
    ) => {
      const code = await reviseCommand(taskId, {
        message: opts.message,
        resume: opts.resume,
      });
      if (code !== 0) process.exit(code);
    },
  );

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
