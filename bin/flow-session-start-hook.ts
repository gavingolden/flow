#!/usr/bin/env bun
/**
 * Claude Code SessionStart hook (matcher `clear`) for the /flow-pipeline
 * supervisor's checkpoint → /clear → auto-resume flow.
 *
 * After the user types `/clear` inside a flow pipeline window in which they
 * ran `/checkpoint` (or hit the step-4 auto-checkpoint), this hook injects a
 * one-line resume seed as `additionalContext` so the freshly-cleared session
 * auto-enters resume mode — the pipeline continues instead of leaving a blank
 * session. The seed text is the SAME string `flow feature resume` sends, reused
 * (not re-authored) from `flowPipelineResumeSeed`.
 *
 * Correctness constraint: the hook is global (`~/.claude/settings.json`) and
 * fires on EVERY `/clear` on the machine, so it MUST emit nothing — empty
 * stdout, exit 0 — unless ALL of: the tmux window resolves to a non-terminal
 * flow pipeline AND a `<worktree>/.flow-tmp/checkpoint.pending` marker is
 * present (written by `flow-checkpoint` on a ready verdict). A plain `/clear`
 * with no prior checkpoint leaves no marker → the hook no-ops and the session
 * clears normally. Modeled on `flow-stop-guard`'s "no-op when state.json
 * missing/terminal" discipline.
 *
 * Output (only on the emit path): the SessionStart additionalContext envelope
 *   { "hookSpecificOutput": { "hookEventName": "SessionStart",
 *       "additionalContext": "<resume seed>" } }
 * confirmed against the Claude Code hooks reference (code.claude.com/docs/en/hooks).
 */

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { readState, TERMINAL_PHASE_SET, type PipelineState } from "./lib/state";
import { flowPipelineResumeSeed } from "./lib/feature";
import { markerPath } from "./flow-checkpoint";

export type Deps = {
  readStdin: () => Promise<string>;
  tmuxPane: string | undefined;
  showFlowSlug: (pane: string) => string;
  loadState: (slug: string) => PipelineState | null;
  markerExists: (worktree: string) => boolean;
  writeOut: (s: string) => void;
};

/** The SessionStart additionalContext envelope carrying the resume seed. */
export function buildEnvelope(slug: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: flowPipelineResumeSeed(slug),
    },
  });
}

export async function run(deps: Deps): Promise<number> {
  // Drain stdin so the harness's pipe closes cleanly. The SessionStart payload
  // carries no field this hook needs — the decision is entirely disk-derived —
  // so a malformed / empty read is harmless.
  try {
    await deps.readStdin();
  } catch {
    // A stdin read hiccup must never break session start; fall through.
  }

  const pane = deps.tmuxPane;
  if (!pane) return 0;

  const slug = deps.showFlowSlug(pane).trim();
  if (slug.length === 0) return 0;

  const state = deps.loadState(slug);
  if (!state) return 0;

  // A terminal pipeline has nothing to resume — never inject a stray seed.
  // EXCEPT `gated`: a gated pipeline carrying a checkpoint marker is a
  // feedback-mode resume point (flow-resume-decide resolves it to
  // `gated-feedback`), so it falls through to the marker check below —
  // marker present → emit the seed, marker absent → no-op like any terminal.
  if (TERMINAL_PHASE_SET.has(state.phase) && state.phase !== "gated") return 0;

  // The one-shot marker is the deliberate opt-in: no /checkpoint → no marker →
  // no auto-resume, so the user keeps the choice to /clear without a checkpoint.
  const worktree = state.worktree;
  if (!worktree || !deps.markerExists(worktree)) return 0;

  deps.writeOut(buildEnvelope(slug) + "\n");
  return 0;
}

/** Reads the window's `@flow-slug` user option — mirrors flow-stop-guard. */
export function defaultShowFlowSlug(pane: string): string {
  const r = spawnSync(
    "tmux",
    ["show-options", "-w", "-t", pane, "-q", "-v", "@flow-slug"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return "";
  return r.stdout ?? "";
}

async function defaultReadStdin(): Promise<string> {
  // Bun.stdin reads to EOF; on a TTY (no piped input) this can hang, so the
  // helper bails after a short wait. Claude Code always pipes JSON when
  // invoking a SessionStart hook, so the hang case is only hit when a developer
  // runs the helper by hand. Copied from flow-stop-guard.
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    process.stdin.on("data", (c) => chunks.push(c as Uint8Array));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    setTimeout(finish, 250);
  });
}

if (import.meta.main) {
  run({
    readStdin: defaultReadStdin,
    tmuxPane: process.env.TMUX_PANE,
    showFlowSlug: defaultShowFlowSlug,
    loadState: (slug) => readState(slug),
    markerExists: (worktree) => {
      try {
        return fs.existsSync(markerPath(worktree));
      } catch {
        return false;
      }
    },
    writeOut: (s) => process.stdout.write(s),
  }).then((code) => process.exit(code));
}
