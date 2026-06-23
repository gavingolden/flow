/**
 * `flow epic <create|run|status|ls>` — the epic-designer/orchestrator verb.
 *
 * This is the SKELETON: only `create`'s slug + directory resolution is wired
 * here. The designer logic (writing design.md + manifest.json) lands in a
 * later feature (F4/F5), and the orchestrator RUN phase (run/status/ls) is
 * deferred — those subcommands surface a loud deferred message and exit 2.
 */

import { argsContainHelp, isHelpFlag, printVerbHelp } from "./help";
import { slugify } from "./slug";
import { epicDirRelative } from "./epic-manifest-schema";

export function runEpicCli(args: string[]): number {
  // STEP 1: verb-level help guard FIRST, before any side effect. Unlike
  // new.ts (which has no subcommands and so scans the whole args array), this
  // verb dispatches on a subcommand, so the verb-level guard must fire ONLY
  // when the help flag is in the verb position (`flow epic --help`). Using
  // argsContainHelp(args) here would also match a subcommand-level flag like
  // `flow epic create --help` and wrongly print the verb help — instead, let
  // that fall through to the switch so runCreate's own argsContainHelp(rest)
  // serves the create-specific help.
  if (isHelpFlag(args[0])) {
    printVerbHelp("epic");
    return 0;
  }

  // STEP 2: dispatch on the subcommand.
  const sub = args[0];
  switch (sub) {
    case "create":
      return runCreate(args.slice(1));
    case "run":
      console.error(
        "flow epic run: the epic orchestrator run phase is deferred — out of scope for this skeleton.",
      );
      return 2;
    case "status":
      console.error(
        "flow epic status is deferred — out of scope for this skeleton.",
      );
      return 2;
    case "ls":
      console.error(
        "flow epic ls is deferred — out of scope for this skeleton.",
      );
      return 2;
    case undefined:
      console.error("flow epic: a subcommand is required.");
      console.error("usage: flow epic <create|run|status|ls>");
      return 2;
    default:
      console.error(`flow epic: unknown epic subcommand: ${sub}`);
      console.error("usage: flow epic <create|run|status|ls>");
      return 2;
  }
}

function runCreate(rest: string[]): number {
  if (argsContainHelp(rest)) {
    console.log(`flow epic create — design an epic

Usage:
  flow epic create "<prompt>"

Mints an epic id from the prompt and resolves its repo-relative directory
under .flow/epics/<slug>. The designer logic that writes design.md and
manifest.json lands in a later feature (F4/F5); this skeleton only resolves
and prints the path.`);
    return 0;
  }

  const prompt = rest.join(" ").trim();
  if (!prompt) {
    console.error("flow epic create: a prompt is required.");
    console.error('usage: flow epic create "<prompt>"');
    return 2;
  }

  const slug = slugify(prompt);
  const dir = epicDirRelative(slug);

  // Deliberately resolve + print ONLY: no mkdir, no manifest write, no
  // absolute-path / git-rev-parse resolution. The designer that creates the
  // directory and its two files lands in F4/F5.
  console.log(dir);
  console.log(
    `flow epic create: resolved epic directory (slug '${slug}'). The designer that writes design.md + manifest.json lands in a later feature (F4/F5).`,
  );
  return 0;
}
