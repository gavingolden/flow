/**
 * The one permission rule that lets an unattended `/flow-pipeline` run merge
 * under Claude Code's auto mode, plus a read-only reader for the user's
 * settings file.
 *
 * ACCEPTED RISK: once this rule is in `permissions.allow`, the auto-mode
 * classifier no longer reviews the merge — flow-merge-guard's own checks
 * (Test Steps clear or a fresh override token, no pending or failed CI,
 * `autoMerge` not false, the PR is this pipeline's own) are the only guard.
 * The sibling `flow-merge-guard <PR> --record-override` is deliberately NOT
 * covered, so recording a gate override still needs the classifier and a
 * fresh owner confirmation. The owner keeps the rule in their user-global
 * settings (one source of truth): flow reads that file, never writes it —
 * not into user settings, not into a consumer repo, not into launch settings.
 *
 * The rule only matches a standalone `flow-merge-guard merge …` Bash call;
 * a `$(…)` wrapper, a pipe, or a `cd … &&` prefix never matches.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const FLOW_MERGE_ALLOW_RULE = "Bash(flow-merge-guard merge *)";

const RULE_FAMILY_PREFIX = "Bash(flow-merge-guard";
const NARROWER_PREFIX = "Bash(flow-merge-guard merge";
const MAX_LINK_HOPS = 16;

export type MergeRuleStatus =
  | "present"
  | "broader"
  | "absent"
  | "missing-file"
  | "malformed";

/** `settings.json` under `CLAUDE_CONFIG_DIR` when set and non-empty, else `~/.claude/settings.json`. */
export function userSettingsPath(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir !== undefined && dir.length > 0
    ? path.join(dir, "settings.json")
    : path.join(homeDir, ".claude", "settings.json");
}

/** Where a possibly dangling symlink chain ends, so the owner is told which file to create. */
function followLinks(start: string): string {
  let current = start;
  for (let i = 0; i < MAX_LINK_HOPS; i++) {
    try {
      const target = fs.readlinkSync(current);
      current = path.resolve(path.dirname(current), target);
    } catch {
      return current;
    }
  }
  return current;
}

/**
 * Read-only, never throws. Follows symlinks (the owner's file is typically a
 * dotfiles link) and reports the resolved path so a warning names the real
 * file to edit.
 */
export function readMergeAllowRule(settingsPath: string): {
  status: MergeRuleStatus;
  resolvedPath: string;
  /** Set with `broader` when the exact rule is also present, so the fix is "remove", not "replace". */
  exactPresent?: true;
} {
  let resolvedPath: string;
  try {
    resolvedPath = fs.realpathSync(settingsPath);
  } catch {
    return { status: "missing-file", resolvedPath: followLinks(settingsPath) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    return { status: missing ? "missing-file" : "malformed", resolvedPath };
  }
  const allow = (parsed as { permissions?: { allow?: unknown } } | null)
    ?.permissions?.allow;
  const entries = Array.isArray(allow)
    ? allow.filter((e): e is string => typeof e === "string")
    : [];
  const exact = entries.includes(FLOW_MERGE_ALLOW_RULE);
  // A broader entry wins even beside the exact rule: it still pre-approves
  // `--record-override`. Entries starting `merge` match only the merge shape.
  const broader = entries.some(
    (e) => e.startsWith(RULE_FAMILY_PREFIX) && !e.startsWith(NARROWER_PREFIX),
  );
  if (broader) {
    return {
      status: "broader",
      resolvedPath,
      ...(exact ? { exactPresent: true as const } : {}),
    };
  }
  if (exact) return { status: "present", resolvedPath };
  return { status: "absent", resolvedPath };
}

/** The owner-facing fix for a `broader` status: what to do with the over-wide line. */
export function broaderRuleFix(
  resolvedPath: string,
  exactPresent: boolean,
): string {
  return exactPresent
    ? `remove the broader Bash(flow-merge-guard …) entry from permissions.allow in ${resolvedPath}; keep "${FLOW_MERGE_ALLOW_RULE}"`
    : `replace the broader Bash(flow-merge-guard …) entry in permissions.allow in ${resolvedPath} with "${FLOW_MERGE_ALLOW_RULE}"`;
}
