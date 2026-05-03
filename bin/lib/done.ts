/**
 * `flow done <name>` — kill the window + remove the state file (after a
 * confirmation prompt unless --yes).
 *
 * `flow done --merged` — sweep all state files whose phase is `merged`
 * or `cancelled`, kill matching windows + remove their state. Confirms
 * once with the count + names before acting.
 *
 * `flow done --orphans` — sweep all state files whose tmux window is
 * gone (the rows `flow ls` annotates `(no window)`), regardless of
 * phase.
 *
 * `flow done --merged --orphans` — compose both filters in one sweep.
 * The preview tags each row `merged`, `orphan`, or `merged+orphan` so
 * an in-flight orphan a user meant to `flow new --resume` is visible
 * before confirming.
 */

import * as fs from "node:fs";
import { argsContainHelp, printVerbHelp } from "./help";
import {
  findWindowBySlug,
  killWindow,
  listWindows,
  windowExists,
  FLOW_SESSION,
} from "./tmux";
import { deleteState, listStates, readState, type PipelineState } from "./state";

const TERMINAL_PHASES = new Set(["merged", "cancelled"]);

export type DoneOptions = {
  merged?: boolean;
  orphans?: boolean;
  yes?: boolean;
};

/**
 * CLI shim for `bin/flow`'s `done` verb. Intercepts --help / -h before any
 * tmux query or state read, then parses --merged / --orphans / --yes / -y
 * and dispatches to `runDone`. The previous inline `runDoneVerb` lived in
 * `bin/flow`.
 */
export function runDoneCli(args: string[]): number {
  if (argsContainHelp(args)) {
    printVerbHelp("done");
    return 0;
  }
  const merged = args.includes("--merged");
  const orphans = args.includes("--orphans");
  const yes = args.includes("--yes") || args.includes("-y");
  const positional = args.filter((a) => !a.startsWith("-"));
  return runDone(positional[0], { merged, orphans, yes });
}

export function runDone(name: string | undefined, options: DoneOptions = {}): number {
  if (options.merged && options.orphans) return runDoneCombined(options);
  if (options.orphans) return runDoneOrphans(options);
  if (options.merged) return runDoneMerged(options);

  if (!name) {
    console.error("flow done: <name> is required (or pass --merged / --orphans).");
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

function runDoneMerged(options: DoneOptions): number {
  const states = listStates().filter((s) => TERMINAL_PHASES.has(s.phase));
  if (states.length === 0) {
    console.log("flow done: no merged or cancelled pipelines to close.");
    return 0;
  }
  return sweep(states, options, (s) => `  ${s.slug} (${s.phase})`);
}

function runDoneOrphans(options: DoneOptions): number {
  const windows = listWindows();
  const states = listStates().filter((s) => !findWindowBySlug(windows, s.slug));
  if (states.length === 0) {
    console.log("flow done: no orphan pipelines to close.");
    return 0;
  }
  return sweep(states, options, (s) => {
    const pr = s.pr ? ` #${s.pr}` : "";
    return `  ${s.slug} (${s.phase}${pr})`;
  });
}

function runDoneCombined(options: DoneOptions): number {
  const windows = listWindows();
  const reasons = new Map<string, { state: PipelineState; tag: "merged" | "orphan" | "merged+orphan" }>();

  for (const s of listStates()) {
    const isMerged = TERMINAL_PHASES.has(s.phase);
    const isOrphan = !findWindowBySlug(windows, s.slug);
    if (!isMerged && !isOrphan) continue;
    const tag = isMerged && isOrphan ? "merged+orphan" : isMerged ? "merged" : "orphan";
    reasons.set(s.slug, { state: s, tag });
  }

  if (reasons.size === 0) {
    console.log("flow done: no merged, cancelled, or orphan pipelines to close.");
    return 0;
  }

  const states = [...reasons.values()].map((r) => r.state);
  return sweep(states, options, (s) => {
    const pr = s.pr ? ` #${s.pr}` : "";
    return `  ${s.slug} (${s.phase}${pr}) [${reasons.get(s.slug)!.tag}]`;
  });
}

function sweep(
  states: PipelineState[],
  options: DoneOptions,
  format: (s: PipelineState) => string,
): number {
  console.log(`will close ${states.length} pipeline(s):`);
  for (const s of states) console.log(format(s));

  if (!options.yes) {
    if (!confirm("proceed?")) {
      console.log("aborted.");
      return 0;
    }
  }

  const windows = listWindows();
  for (const s of states) {
    if (findWindowBySlug(windows, s.slug)) killWindow(s.slug);
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
