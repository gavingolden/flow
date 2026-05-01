/**
 * `flow done <name>` — kill the window + remove the state file (after a
 * confirmation prompt unless --yes).
 *
 * `flow done --all-merged` — sweep all state files whose phase is `merged`
 * or `cancelled`, kill matching windows + remove their state. Confirms
 * once with the count + names before acting.
 */

import * as fs from "node:fs";
import { killWindow, listWindows, windowExists, FLOW_SESSION } from "./tmux";
import { deleteState, listStates, readState } from "./state";

const TERMINAL_PHASES = new Set(["merged", "cancelled"]);

export type DoneOptions = {
  allMerged?: boolean;
  yes?: boolean;
};

export function runDone(name: string | undefined, options: DoneOptions = {}): number {
  if (options.allMerged) return runDoneAllMerged(options);

  if (!name) {
    console.error("flow done: <name> is required (or pass --all-merged).");
    return 1;
  }

  const hasWindow = windowExists(name);
  const hasState = readState(name) !== null;

  if (!hasWindow && !hasState) {
    console.error(`flow done: no window or state for '${name}'.`);
    return 1;
  }

  if (!options.yes) {
    if (!confirm(`close pipeline '${name}'?`)) {
      console.log("aborted.");
      return 0;
    }
  }

  let warned = false;
  if (hasWindow) {
    killWindow(name);
  } else {
    console.warn(`  (no tmux window for '${name}' — state file existed alone)`);
    warned = true;
  }
  if (hasState) {
    deleteState(name);
  } else if (!warned) {
    console.warn(`  (no state file for '${name}' — window existed alone)`);
  }

  console.log(`closed: ${FLOW_SESSION}:${name}`);
  return 0;
}

function runDoneAllMerged(options: DoneOptions): number {
  const states = listStates().filter((s) => TERMINAL_PHASES.has(s.phase));
  if (states.length === 0) {
    console.log("flow done: no merged or cancelled pipelines to close.");
    return 0;
  }

  console.log(`will close ${states.length} pipeline(s):`);
  for (const s of states) console.log(`  ${s.slug} (${s.phase})`);

  if (!options.yes) {
    if (!confirm("proceed?")) {
      console.log("aborted.");
      return 0;
    }
  }

  const liveWindows = new Set(listWindows().map((w) => w.name));
  for (const s of states) {
    if (liveWindows.has(s.slug)) killWindow(s.slug);
    deleteState(s.slug);
    console.log(`closed: ${s.slug}`);
  }
  return 0;
}

function confirm(prompt: string): boolean {
  process.stdout.write(`${prompt} [y/N] `);
  // Bun supports synchronous stdin reads via fs.readSync(0, ...). Avoid
  // require() so this module stays pure ESM (matches the rest of bin/lib).
  const buf = Buffer.alloc(16);
  let len = 0;
  try {
    len = fs.readSync(0, buf, 0, buf.length, null);
  } catch {
    return false;
  }
  const answer = buf.subarray(0, len).toString("utf8").trim().toLowerCase();
  return answer === "y" || answer === "yes";
}
