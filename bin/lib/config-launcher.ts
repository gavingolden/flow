/**
 * `flow config launcher` — get/set the recorded launcher backend in
 * `~/.flow/config.json`. Mirrors `config-models.ts`'s CLI shape: `get` (or no
 * arg) prints the recorded value, `set <plain|tmux>` persists via the
 * sibling-key-preserving `writeLauncherConfig`.
 */

import { argsContainHelp, printVerbHelp } from "./help";
import {
  isLauncherId,
  readLauncherConfig,
  writeLauncherConfig,
} from "./launcher-config";
import type { ReadConfigFile } from "./modules-config";

const USAGE = "usage: flow config launcher [get | set <plain|tmux>]";

export function runConfigLauncherCli(
  args: string[],
  options: { read?: ReadConfigFile; configPath?: string } = {},
): number {
  if (argsContainHelp(args)) {
    printVerbHelp("config");
    return 0;
  }

  const sub = args[0] ?? "get";
  if (sub === "get") {
    if (args.length > 1) {
      console.error(`flow config launcher: unexpected argument '${args[1]}'`);
      console.error(USAGE);
      return 2;
    }
    const recorded = readLauncherConfig(options.read);
    console.log(recorded ?? "plain (default)");
    return 0;
  }

  if (sub === "set") {
    const value = args[1];
    if (value === undefined) {
      console.error("flow config launcher set: a value is required.");
      console.error(USAGE);
      return 2;
    }
    if (!isLauncherId(value)) {
      console.error(
        `flow config launcher set: invalid launcher '${value}' — expected 'plain' or 'tmux'.`,
      );
      return 2;
    }
    writeLauncherConfig(value, {
      configPath: options.configPath,
      read: options.read,
    });
    console.log(`launcher: ${value}`);
    return 0;
  }

  console.error(`flow config launcher: unknown subcommand '${sub}'`);
  console.error(USAGE);
  return 2;
}
