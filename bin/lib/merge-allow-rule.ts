/**
 * The permission rules that let an unattended `/flow-pipeline` run merge, and
 * record a confirmed gate override, under Claude Code's auto mode without a
 * permission prompt. They ship in flow's generated launch settings
 * (`ensureLaunchSettings`) and so apply to flow-launched sessions only —
 * never written into the owner's personal settings or a consumer repo.
 *
 * ACCEPTED RISK: the auto-mode classifier reviews neither the merge nor the
 * override recording. The guards are the pipeline's "merge anyway?" form (the
 * one conscious confirmation), flow-merge-guard's record-mode refusals (own
 * slug, own PR, phase `gated`) and its merge-mode checks (Test Steps clear or
 * a fresh override token, no pending or failed CI, `autoMerge` not false, the
 * PR is this pipeline's own). Nothing mechanical stops a model that skips the
 * form on its own gated PR; an override merge posts a disclosure comment on
 * the PR so it is visible. Full decision table: docs/configuration.md.
 *
 * Each rule only matches a standalone `flow-merge-guard …` Bash call; a `$(…)`
 * wrapper never matches.
 *
 * This module also holds the read-only conflict detectors over the owner's
 * personal settings (read via `./claude-user-settings`).
 */

import { readUserSettings, userSettingsPath } from "./claude-user-settings";

export const FLOW_MERGE_ALLOW_RULE = "Bash(flow-merge-guard merge *)";

const RULE_FAMILY_PREFIX = "Bash(flow-merge-guard";

export const FLOW_OVERRIDE_ALLOW_RULES = [
  "Bash(flow-merge-guard * --record-override)",
  "Bash(flow-merge-guard * --record-override *)",
] as const;

/**
 * Read-only, never throws. Returns a personal `permissions.ask` entry in the
 * `Bash(flow-merge-guard` family — "ask" beats flow's launch-settings "allow",
 * so any such entry brings back a prompt the pipeline already confirms.
 * `coversMerge` is true when the entry also matches `flow-merge-guard merge`
 * (every unattended merge would prompt); a merge-covering entry is preferred.
 * Reads through {@link readUserSettings}, which follows symlinks and reports
 * the resolved path so a warning names the real file to edit.
 */
export function findFlowMergeGuardAskEntry(settingsPath: string): {
  entry?: string;
  resolvedPath: string;
  coversMerge: boolean;
} {
  const read = readUserSettings(settingsPath);
  if (read.status !== "ok")
    return { resolvedPath: read.path, coversMerge: false };
  const ask = (read.settings.permissions as { ask?: unknown } | undefined)?.ask;
  const family = (Array.isArray(ask) ? ask : []).filter(
    (e): e is string =>
      typeof e === "string" && e.startsWith(RULE_FAMILY_PREFIX),
  );
  const mergeEntry = family.find((e) => !e.includes("--record-override"));
  if (mergeEntry !== undefined) {
    return { entry: mergeEntry, resolvedPath: read.path, coversMerge: true };
  }
  return family[0] === undefined
    ? { resolvedPath: read.path, coversMerge: false }
    : { entry: family[0], resolvedPath: read.path, coversMerge: false };
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

/** The one message doctor and `flow feature create/resume` share for a personal ask entry. */
export function personalAskEntryMessage(entry: string): string {
  return `a personal flow-merge-guard ask rule (${entry}) brings back a permission prompt flow's pipeline already confirms — delete it`;
}

/** Launch-time notice (never blocks): prints the doctor message when a personal ask entry exists. */
export function warnOnPersonalAskEntry(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  write: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const { entry, resolvedPath } = findFlowMergeGuardAskEntry(
    userSettingsPath(env, homeDir),
  );
  if (entry !== undefined) {
    write(`warning: ${personalAskEntryMessage(entry)} (${resolvedPath})\n`);
  }
}
