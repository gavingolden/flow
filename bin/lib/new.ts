/**
 * `flow new <description>` — slugify, create a tmux window, write initial
 * state. The supervisor skill (PR 2) takes over from there. Does not
 * auto-attach by default; the user runs `flow attach <slug>` separately.
 *
 * `flow new --resume <name>` — re-launch a crashed supervisor session in
 * its existing tmux window (or recreate the window if tmux died too) using
 * the resume seed prompt. Refuses if there is no state for `<name>` or if
 * the existing pane has a live process.
 */

import * as fs from "node:fs";
import { slugify } from "./slug";
import {
  createWindow,
  respawnWindow,
  windowExists,
  isPaneAlive,
  FLOW_SESSION,
} from "./tmux";
import { readState, writeState, nowIso } from "./state";

export type NewOptions = {
  /** Override the cwd for the new window (default: process.cwd()). */
  cwd?: string;
  /** Override the command launched in the window. */
  command?: string[];
  /** Resume a crashed pipeline rather than start a new one. */
  resume?: boolean;
  /** Override the state directory (test seam). */
  stateDir?: string;
};

export function runNew(input: string, options: NewOptions = {}): number {
  if (options.resume) return runResume(input, options);
  return runFresh(input, options);
}

function runFresh(description: string, options: NewOptions): number {
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
      `  attach with \`flow attach ${slug}\`, resume with \`flow new --resume ${slug}\`,`,
    );
    console.error("  or pick a different description.");
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
  const existing = readState(slug, options.stateDir);
  writeState(
    {
      slug,
      phase: "starting",
      repo,
      worktree: existing?.worktree,
      updatedAt: nowIso(),
    },
    options.stateDir,
  );

  console.log(`${FLOW_SESSION}:${slug}`);
  console.log(`  attach with: flow attach ${slug}`);
  return 0;
}

function runResume(name: string, options: NewOptions): number {
  if (!name || name.trim() === "") {
    console.error("flow new --resume: <name> is required.");
    console.error("usage: flow new --resume <name>");
    return 1;
  }

  const slug = slugify(name);
  if (!slug || slug !== name) {
    console.error(`flow new --resume: '${name}' is not a valid pipeline name.`);
    console.error("  pass the slug as printed by `flow ls`.");
    return 1;
  }

  const state = readState(slug, options.stateDir);
  if (!state) {
    console.error(`flow new --resume: no pipeline state for '${slug}'.`);
    console.error("  run `flow new <description>` to start a fresh pipeline.");
    return 1;
  }

  if (!state.repo || !fs.existsSync(state.repo)) {
    // The repo path recorded at `flow new` time has moved or been deleted.
    // tmux would surface this as an opaque "-c: no such directory" — give
    // the user the actual cause so they can decide to recreate the state.
    console.error(`flow new --resume: pipeline '${slug}' was launched against`);
    console.error(`  ${state.repo || "(no repo recorded)"}`);
    console.error(`  but that path no longer exists. Move the repo back, or`);
    console.error(`  run \`flow done ${slug}\` and start fresh with \`flow new\`.`);
    return 1;
  }

  const exists = windowExists(slug);
  if (exists && isPaneAlive(slug)) {
    console.error(`flow new --resume: pipeline '${slug}' is still running.`);
    console.error(`  attach with \`flow attach ${slug}\` instead of resuming.`);
    return 1;
  }

  const command = options.command ?? resumeCommand(slug);
  const result = exists
    ? respawnWindow(slug, state.repo, command)
    : createWindow(slug, state.repo, command);
  if (!result.ok) {
    console.error(`flow new --resume: tmux failed to ${exists ? "respawn" : "create"} the window.`);
    if (result.stderr) console.error(`  ${result.stderr}`);
    return 1;
  }

  // Phase + worktree + pr stay as the crash left them. The supervisor's
  // first real transition is what updates state.json.
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

function resumeCommand(slug: string): string[] {
  // The supervisor parses this prefix to detect resume mode and walk the
  // decision tree in references/failure-recovery.md section (b).
  const prompt = `Use the /flow-pipeline skill in --resume mode for: ${slug}`;
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
