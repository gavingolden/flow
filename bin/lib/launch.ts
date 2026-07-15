/**
 * Bare `flow` launcher: `flow` with no verb starts an interactive Claude
 * session with the flow skills home added (`claude --add-dir
 * ~/.flow/claude-home`), so the installed flow skills load in an otherwise
 * ordinary interactive session — they no longer live in the global
 * `~/.claude/skills/`. Non-TTY invocations (a script, CI) keep printing the
 * top-level help so nothing hangs an interactive claude with no controlling
 * terminal.
 */

import * as fs from "node:fs";
import { FLOW_CLAUDE_HOME } from "./paths";
import { printTopHelp } from "./help";
import { dim } from "./color";

/**
 * The argv for the interactive launcher: `claude --add-dir <claude-home>`,
 * nothing more. Deliberately NO `--settings` and NO `FLOW_PIPELINE=1` — an
 * interactive session has no seed to ingest and must NOT suppress
 * `/flow-research`'s standalone tier (those are pipeline-session concerns).
 * `claudeHome` is an injectable seam (default `FLOW_CLAUDE_HOME`) so tests
 * never touch the developer's real `~/.flow`.
 */
export function buildInteractiveLaunchArgv(
  claudeHome: string = FLOW_CLAUDE_HOME,
): string[] {
  return ["claude", "--add-dir", claudeHome];
}

export type LaunchDeps = {
  /** Whether stdin is a TTY. Default: `process.stdin.isTTY === true`. */
  isTTY?: boolean;
  /** Skills-home path override. Default: `FLOW_CLAUDE_HOME`. */
  claudeHome?: string;
  /** Spawn seam. Default: `Bun.spawnSync` with inherited stdio. Returns the child exit code. */
  spawn?: (argv: string[]) => number;
  /** Directory-existence seam. Default: `fs.statSync(p).isDirectory()`. */
  existsDir?: (p: string) => boolean;
  /** Log seam for the missing-home notice. Default: `console.log`. */
  log?: (s: string) => void;
};

/**
 * Default spawn: run the argv synchronously, inheriting all three stdio
 * streams so the interactive claude owns the terminal, and return the child's
 * exit code. A missing `claude` on PATH surfaces as a one-line error and exit
 * 1 rather than an opaque stack trace.
 */
function defaultSpawn(argv: string[]): number {
  try {
    const result = Bun.spawnSync(argv, {
      stdio: ["inherit", "inherit", "inherit"],
    });
    return result.exitCode ?? 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `flow: could not launch claude — is it on your PATH? (${msg})`,
    );
    return 1;
  }
}

function defaultExistsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Runs the bare-`flow` launcher. On a TTY, spawns `claude --add-dir
 * <claude-home>` and returns its exit code — first emitting a dim notice
 * naming `flow install` when the home does not exist yet (the launch still
 * proceeds; `claude --add-dir <nonexistent>` is launch-safe). Off a TTY,
 * prints the top-level help and returns 0 without spawning.
 */
export function runLaunchCli(deps: LaunchDeps = {}): number {
  const isTTY = deps.isTTY ?? process.stdin.isTTY === true;
  const log = deps.log ?? ((s: string) => console.log(s));
  const existsDir = deps.existsDir ?? defaultExistsDir;
  const claudeHome = deps.claudeHome ?? FLOW_CLAUDE_HOME;
  const spawn = deps.spawn ?? defaultSpawn;

  if (!isTTY) {
    printTopHelp();
    return 0;
  }

  if (!existsDir(claudeHome)) {
    log(
      dim(
        `flow: skills home ${claudeHome} not found — run \`flow install\` to populate it; launching anyway`,
      ),
    );
  }

  return spawn(buildInteractiveLaunchArgv(claudeHome));
}
