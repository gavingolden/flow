/**
 * `flow config` verb-group dispatch — mirrors `runEpicCli`. Routes the
 * `models` subcommand to `runConfigModelsCli`; a verb-position `--help` prints
 * the group help; an absent/unknown subcommand is a usage error (exit 2).
 */

import { isHelpFlag, printVerbHelp } from "./help";
import { runConfigModelsCli, type ConfigModelsOptions } from "./config-models";

export function runConfigCli(
  args: string[],
  options: ConfigModelsOptions = {},
): number {
  // Verb-level help guard FIRST — but only when the flag is in the verb
  // position (`flow config --help`); a subcommand-level `flow config models
  // --help` falls through to runConfigModelsCli's own argsContainHelp.
  if (isHelpFlag(args[0])) {
    printVerbHelp("config");
    return 0;
  }

  const sub = args[0];
  switch (sub) {
    case "models":
      return runConfigModelsCli(args.slice(1), options);
    case undefined:
      console.error("flow config: a subcommand is required.");
      console.error("usage: flow config models");
      return 2;
    default:
      console.error(`flow config: unknown config subcommand: ${sub}`);
      console.error("usage: flow config models");
      return 2;
  }
}
