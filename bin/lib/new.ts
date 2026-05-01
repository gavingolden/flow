/**
 * `flow new <description>` — slugify, create a tmux window, write initial
 * state. The supervisor skill (PR 2) takes over from there. Does not
 * auto-attach by default; the user runs `flow attach <slug>` separately.
 */

import * as fs from "node:fs";
import { slugify } from "./slug";
import { createWindow, windowExists, FLOW_SESSION } from "./tmux";
import { readState, writeState, nowIso } from "./state";

export type NewOptions = {
  /** Override the cwd for the new window (default: process.cwd()). */
  cwd?: string;
  /** Override the command launched in the window. */
  command?: string[];
};

export function runNew(description: string, options: NewOptions = {}): number {
  if (!description || description.trim() === "") {
    console.error("flow new: description is required.");
    console.error("usage: flow new <description>");
    return 1;
  }

  const slug = slugify(description);
  if (!slug) {
    console.error(`flow new: '${description}' produces an empty slug.`);
    return 1;
  }

  const cwd = options.cwd ?? process.cwd();
  const repo = resolveRepoRoot(cwd);
  if (!repo) {
    console.error(`flow new: ${cwd} is not inside a git repository.`);
    return 1;
  }

  if (windowExists(slug)) {
    console.error(`flow new: window '${FLOW_SESSION}:${slug}' already exists.`);
    console.error(
      "  attach with `flow attach " +
        slug +
        "` or pick a different description. (--resume comes in PR 9.)",
    );
    return 1;
  }

  const command = options.command ?? defaultCommand(description);
  const result = createWindow(slug, repo, command);
  if (!result.ok) {
    console.error(`flow new: tmux failed to create the window.`);
    if (result.stderr) console.error(`  ${result.stderr}`);
    return 1;
  }

  // Write the initial state file. The supervisor (PR 2) overwrites
  // worktree + phase + pr at each transition. Pre-existing state for the
  // same slug shouldn't happen because windowExists() blocked above; if it
  // does (e.g. external tmux reset), the new write supersedes.
  const existing = readState(slug);
  writeState({
    slug,
    phase: "starting",
    repo,
    worktree: existing?.worktree,
    updatedAt: nowIso(),
  });

  console.log(`${FLOW_SESSION}:${slug}`);
  console.log(`  attach with: flow attach ${slug}`);
  return 0;
}

function defaultCommand(description: string): string[] {
  // The supervisor skill is invoked by the chat session itself, not by
  // passing the slash command on the CLI. We launch claude with an initial
  // prompt that tells the user (and the LLM, once active) what to do.
  const prompt = `Use the /flow-pipeline skill for: ${description}`;
  return ["claude", prompt];
}

function resolveRepoRoot(cwd: string): string | null {
  const r = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) return null;
  const out = r.stdout.toString().trim();
  if (!out || !fs.existsSync(out)) return null;
  return out;
}
