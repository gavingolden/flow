/**
 * The permission rules that let an unattended `/flow-pipeline` run merge under
 * Claude Code's auto mode while a gate override still prompts. They ship in
 * flow's generated launch settings (`ensureLaunchSettings`) and so apply to
 * flow-launched sessions only — never written into the owner's personal
 * settings or a consumer repo.
 *
 * ACCEPTED RISK: once the allow rule applies, the auto-mode classifier no
 * longer reviews the merge — flow-merge-guard's own checks (Test Steps clear
 * or a fresh override token, no pending or failed CI, `autoMerge` not false,
 * the PR is this pipeline's own) are the only guard. The sibling
 * `flow-merge-guard <PR> --record-override` is deliberately NOT covered by the
 * allow rule; the two `permissions.ask` rules ({@link FLOW_OVERRIDE_ASK_RULES})
 * make it always prompt, even in auto mode.
 *
 * The allow rule only matches a standalone `flow-merge-guard merge …` Bash
 * call; a `$(…)` wrapper, a pipe, or a `cd … &&` prefix never matches.
 *
 * This module also holds the read-only conflict detectors over the owner's
 * personal settings (read via `./claude-user-settings`).
 */

import { readUserSettings } from "./claude-user-settings";

export const FLOW_MERGE_ALLOW_RULE = "Bash(flow-merge-guard merge *)";

const RULE_FAMILY_PREFIX = "Bash(flow-merge-guard";

export const FLOW_OVERRIDE_ASK_RULES = [
  "Bash(flow-merge-guard * --record-override)",
  "Bash(flow-merge-guard * --record-override *)",
] as const;

/**
 * Read-only, never throws. Returns the first personal `permissions.ask` entry
 * in the `Bash(flow-merge-guard` family that does not name `--record-override`:
 * it also matches `flow-merge-guard merge`, so every unattended merge would
 * prompt. Reads through {@link readUserSettings}, which follows symlinks and
 * reports the resolved path so a warning names the real file to edit.
 */
export function findMergeCoveringAskEntry(settingsPath: string): {
  entry?: string;
  resolvedPath: string;
} {
  const read = readUserSettings(settingsPath);
  if (read.status !== "ok") return { resolvedPath: read.path };
  const ask = (read.settings.permissions as { ask?: unknown } | undefined)?.ask;
  const entries = Array.isArray(ask)
    ? ask.filter((e): e is string => typeof e === "string")
    : [];
  const entry = entries.find(
    (e) => e.startsWith(RULE_FAMILY_PREFIX) && !e.includes("--record-override"),
  );
  return entry === undefined
    ? { resolvedPath: read.path }
    : { entry, resolvedPath: read.path };
}

/**
 * Read-only, never throws. `autoMode.classifyAllShell` makes auto mode ignore
 * every Bash allow rule, so the merge pre-approval cannot apply.
 */
export function classifyAllShellOn(settingsPath: string): boolean {
  const read = readUserSettings(settingsPath);
  if (read.status !== "ok") return false;
  const autoMode = read.settings.autoMode as
    | { classifyAllShell?: unknown }
    | undefined;
  return autoMode?.classifyAllShell === true;
}
