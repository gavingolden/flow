#!/usr/bin/env bun
/**
 * Rename a flow pipeline's tmux window display title without disturbing
 * its slug-keyed identity.
 *
 * The supervisor calls this in `/flow-pipeline` step 1 (triage) to set
 * a descriptive title on the window — e.g. `tmux:flow:csv-export` →
 * `tmux:flow:add CSV export`. Subsequent flow lookups
 * (`windowExists`, `listWindows`, `flow attach`, `flow done`,
 * `flow ls`) resolve via the `@flow-slug` user option, so they keep
 * working through the rename. Users can also call this directly when
 * they want a manual rename that survives.
 *
 * Usage:
 *   flow-rename-window <slug> <title>
 *   flow-rename-window <title>            # slug auto-resolved from $TMUX_PANE
 *   flow-rename-window --help
 *
 * Exits 0 on success, 1 if the slug doesn't resolve to a flow window,
 * 2 on argument-parse error.
 */

import {
  buildRenameArgs,
  findWindowBySlug,
  listWindows,
  type TmuxWindow,
} from "./lib/tmux";
import { resolveSlugAmbient } from "./lib/session-identity";

const HELP_TEXT = `flow-rename-window — rename a pipeline's tmux window display title

Usage:
  flow-rename-window <slug> <title>
  flow-rename-window --slug <slug> <title>
  flow-rename-window <title>     # slug auto-resolved from $TMUX_PANE's @flow-slug

The window keeps its @flow-slug user option, so 'flow attach <slug>',
'flow done <slug>', 'flow ls', and 'flow feature resume <slug>' continue
to find the window after the rename.`;

/** `slug` is undefined when only a title was given — caller resolves from pane. */
type ParseOk = { slug?: string; title: string };
type ParseHelp = { kind: "help" };
type ParseErr = { error: string };

export function parseArgs(argv: string[]): ParseOk | ParseHelp | ParseErr {
  for (const a of argv) {
    if (a === "--help" || a === "-h") return { kind: "help" };
    if (a === "--") break;
  }

  // Extract --slug <value> upfront so the remaining positional logic is unchanged.
  let slugFromFlag: string | undefined;
  const slugIdx = argv.indexOf("--slug");
  let remaining: string[];
  if (slugIdx >= 0) {
    const value = argv[slugIdx + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: "--slug requires a value" };
    }
    slugFromFlag = value;
    // Build remaining argv without --slug and its value token.
    remaining = [...argv.slice(0, slugIdx), ...argv.slice(slugIdx + 2)];
  } else {
    remaining = argv;
  }

  if (remaining.length === 0 && slugFromFlag === undefined) {
    return { error: "<title> is required" };
  }
  if (remaining.length > 2) {
    return {
      error:
        'too many positional arguments — quote the title (e.g. flow-rename-window slug "my title")',
    };
  }

  // Two remaining positionals alongside --slug means the caller passed a slug
  // positionally too → conflict. A lone positional with --slug is intentionally
  // treated as the title. (The `=== 2` length check precedes the index access so
  // remaining[0] is never read when remaining is empty.)
  if (
    slugFromFlag !== undefined &&
    remaining.length === 2 &&
    !remaining[0].startsWith("--")
  ) {
    return { error: "cannot combine positional <slug> with --slug" };
  }

  if (slugFromFlag !== undefined) {
    // --slug was provided: remaining is just [title] (possibly empty).
    if (remaining.length === 0) {
      return { error: "<title> is required" };
    }
    const [title] = remaining;
    if (!title.trim()) return { error: "<title> must not be empty" };
    return { slug: slugFromFlag, title };
  }

  // No --slug: fall back to the original positional logic.
  if (remaining.length === 0) {
    return { error: "<title> is required" };
  }
  if (remaining.length === 1) {
    const [title] = remaining;
    if (!title.trim()) return { error: "<title> must not be empty" };
    return { title };
  }
  const [slug, title] = remaining;
  if (!slug.trim()) return { error: "<slug> must not be empty" };
  if (!title.trim()) return { error: "<title> must not be empty" };
  return { slug, title };
}

export type SpawnResult = { exitCode: number; stderr: string };

export type Deps = {
  listWindows: () => TmuxWindow[];
  spawnTmux: (args: string[]) => SpawnResult;
  resolveSlug: () => string | null;
  writeErr: (s: string) => void;
  writeOut: (s: string) => void;
};

export function run(argv: string[], deps?: Partial<Deps>): number {
  const writeErr = deps?.writeErr ?? ((s) => process.stderr.write(s));
  const writeOut = deps?.writeOut ?? ((s) => process.stdout.write(s));

  const parsed = parseArgs(argv);
  if ("kind" in parsed) {
    writeOut(`${HELP_TEXT}\n`);
    return 0;
  }
  if ("error" in parsed) {
    writeErr(`flow-rename-window: ${parsed.error}\n`);
    writeErr(
      "usage: flow-rename-window [<slug>] <title>  |  flow-rename-window --slug <slug> <title>\n",
    );
    return 2;
  }

  const resolveSlug = deps?.resolveSlug ?? (() => resolveSlugAmbient());
  const slug = parsed.slug ?? resolveSlug();
  if (!slug) {
    writeErr(
      "flow-rename-window: no slug given and could not resolve from $TMUX_PANE's @flow-slug option.\n",
    );
    writeErr(
      "  pass <slug> explicitly, or run inside a tmux window created by `flow feature create`.\n",
    );
    return 2;
  }

  const lister = deps?.listWindows ?? listWindows;
  const spawn = deps?.spawnTmux ?? defaultSpawn;
  const window = findWindowBySlug(lister(), slug);
  if (!window) {
    writeErr(`flow-rename-window: no flow window matches slug '${slug}'.\n`);
    return 1;
  }
  const result = spawn(buildRenameArgs(window.id, parsed.title));
  if (result.exitCode !== 0) {
    writeErr(
      `flow-rename-window: tmux rename-window failed: ${result.stderr || "no stderr"}\n`,
    );
    return 1;
  }
  return 0;
}

function defaultSpawn(args: string[]): SpawnResult {
  try {
    const r = Bun.spawnSync(["tmux", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: r.exitCode ?? 1,
      stderr: r.stderr.toString().trim(),
    };
  } catch (e: unknown) {
    return {
      exitCode: 127,
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
