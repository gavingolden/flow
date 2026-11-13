#!/usr/bin/env bun
/**
 * flow-manager-note — the manager's expiring coordination notes.
 *
 *   add  --about <slug>[,<slug>] --text <text>
 *   list [--about <slug>]
 *
 * A success prints exactly one JSON line and exits 0; a refusal or usage error
 * writes a message to stderr, exits 2, and changes nothing. `add` needs at
 * least one named slug with a live, unfinished state file (the others may be
 * finished or already cleaned up, so a note can name a pipeline that merged).
 */

import { appendNote, readNotes } from "./lib/manager-notes";
import { repoNameForPath } from "./lib/manager-scope";
import { FINISHED_PHASE_SET, readState } from "./lib/state";

const USAGE = `usage: flow-manager-note add --about <slug>[,<slug>] --text <text>
       flow-manager-note list [--about <slug>]`;
const MAX_TEXT = 1000;

export type NoteDeps = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  home?: string;
  now?: () => Date;
  random?: () => string;
};

function flagValues(
  args: string[],
  valued: string[],
): Record<string, string> | { error: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--") || !valued.includes(a.slice(2))) {
      return { error: `unknown argument: ${a}` };
    }
    const v = args[i + 1];
    if (v === undefined) return { error: `${a} requires a value` };
    out[a.slice(2)] = v;
    i++;
  }
  return out;
}

/** The manager's own notes never count as outside evidence; a pipeline's notes carry its slug. */
function noteAuthor(env: NodeJS.ProcessEnv): string {
  if (env.FLOW_MANAGER === "1") return "manager";
  return env.FLOW_SLUG || "owner";
}

export function run(argv: string[], deps: NoteDeps = {}): number {
  const out = (o: unknown) => console.log(JSON.stringify(o));
  const refuse = (msg: string) => {
    console.error(`flow-manager-note: ${msg}`);
    console.error(USAGE);
    return 2;
  };
  const [sub, ...rest] = argv;
  const flags = flagValues(rest, ["about", "text"]);
  if ("error" in flags) return refuse(flags.error);

  if (sub === "list") {
    if (flags.text !== undefined) return refuse("list takes only --about");
    const notes = readNotes(deps.home).filter(
      (n) => flags.about === undefined || n.about.includes(flags.about),
    );
    out({ ok: true, notes });
    return 0;
  }

  if (sub === "add") {
    const about = [
      ...new Set(
        (flags.about ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    if (about.length === 0)
      return refuse("add requires --about <slug>[,<slug>]");
    const text = (flags.text ?? "").trim();
    if (text === "") return refuse("add requires non-empty --text");
    if (text.length > MAX_TEXT) {
      return refuse(
        `--text is ${text.length} characters; the limit is ${MAX_TEXT}`,
      );
    }
    const live = about
      .map((slug) => readState(slug, deps.stateDir))
      .filter((s) => s !== null && !FINISHED_PHASE_SET.has(s.phase));
    if (live.length === 0) {
      return refuse(
        "none of the --about slugs has a live, unfinished pipeline state — nothing to attach the note to",
      );
    }
    const now = (deps.now ?? (() => new Date()))();
    const rand =
      deps.random?.() ??
      Math.floor(Math.random() * 0x10000)
        .toString(16)
        .padStart(4, "0");
    const note = {
      id: `note-${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}-${rand}`,
      ts: now.toISOString(),
      about,
      text,
      repo: repoNameForPath(live[0]!.repo),
      author: noteAuthor(deps.env ?? process.env),
    };
    appendNote(note, deps.home);
    out({ ok: true, id: note.id, about: note.about, repo: note.repo });
    return 0;
  }

  return refuse(
    sub ? `unknown subcommand: ${sub}` : "a subcommand is required",
  );
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
