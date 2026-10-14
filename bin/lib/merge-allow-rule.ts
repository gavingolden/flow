/**
 * The one permission rule that lets an unattended `/flow-pipeline` run merge
 * under Claude Code's auto mode, plus a read-only check for it in the user's
 * settings file (read via `./claude-user-settings`).
 *
 * ACCEPTED RISK: once this rule is in `permissions.allow`, the auto-mode
 * classifier no longer reviews the merge — flow-merge-guard's own checks
 * (Test Steps clear or a fresh override token, no pending or failed CI,
 * `autoMerge` not false, the PR is this pipeline's own) are the only guard.
 * The sibling `flow-merge-guard <PR> --record-override` is deliberately NOT
 * covered by that allow rule; it is covered by the owner's two
 * `permissions.ask` rules ({@link FLOW_OVERRIDE_ASK_RULES}), so it always
 * prompts, even in auto mode. Without them the classifier decides. The owner
 * keeps the rules in their user-global
 * settings (one source of truth): flow reads that file, never writes it —
 * not into user settings, not into a consumer repo, not into launch settings.
 *
 * The rule only matches a standalone `flow-merge-guard merge …` Bash call;
 * a `$(…)` wrapper, a pipe, or a `cd … &&` prefix never matches.
 */

import { readUserSettings } from "./claude-user-settings";

export const FLOW_MERGE_ALLOW_RULE = "Bash(flow-merge-guard merge *)";

const RULE_FAMILY_PREFIX = "Bash(flow-merge-guard";
const NARROWER_PREFIX = "Bash(flow-merge-guard merge";

export type MergeRuleStatus =
  | "present"
  | "broader"
  | "absent"
  | "missing-file"
  | "malformed";

/**
 * Read-only, never throws. Reads through {@link readUserSettings}, which
 * follows symlinks (the owner's file is typically a dotfiles link) and
 * reports the resolved path so a warning names the real file to edit.
 */
export function readMergeAllowRule(settingsPath: string): {
  status: MergeRuleStatus;
  resolvedPath: string;
  /** Set with `broader` when the exact rule is also present, so the fix is "remove", not "replace". */
  exactPresent?: true;
} {
  const read = readUserSettings(settingsPath);
  if (read.status !== "ok") {
    return { status: read.status, resolvedPath: read.path };
  }
  const resolvedPath = read.path;
  const allow = (read.settings.permissions as { allow?: unknown } | undefined)
    ?.allow;
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

export const FLOW_OVERRIDE_ASK_RULES = [
  "Bash(flow-merge-guard * --record-override)",
  "Bash(flow-merge-guard * --record-override *)",
] as const;

export type OverrideAskStatus =
  | "present"
  | "partial"
  | "absent"
  | "merge-covered"
  | "missing-file"
  | "malformed";

/**
 * Read-only, never throws. Checks that both override ask rules sit in
 * `permissions.ask`. An ask entry in the `Bash(flow-merge-guard` family that
 * does not name `--record-override` also covers `flow-merge-guard merge`, so
 * every unattended merge would prompt: reported first as `merge-covered`.
 */
export function readOverrideAskRule(settingsPath: string): {
  status: OverrideAskStatus;
  resolvedPath: string;
  /** The rules absent from `permissions.ask` (set with `partial` / `absent`). */
  missing: string[];
  /** The ask entry that would make every merge prompt (set with `merge-covered`). */
  mergeCovering?: string;
} {
  const read = readUserSettings(settingsPath);
  if (read.status !== "ok") {
    return { status: read.status, resolvedPath: read.path, missing: [] };
  }
  const resolvedPath = read.path;
  const ask = (read.settings.permissions as { ask?: unknown } | undefined)?.ask;
  const entries = Array.isArray(ask)
    ? ask.filter((e): e is string => typeof e === "string")
    : [];
  const mergeCovering = entries.find(
    (e) => e.startsWith(RULE_FAMILY_PREFIX) && !e.includes("--record-override"),
  );
  if (mergeCovering !== undefined) {
    return {
      status: "merge-covered",
      resolvedPath,
      missing: [],
      mergeCovering,
    };
  }
  const missing = FLOW_OVERRIDE_ASK_RULES.filter((r) => !entries.includes(r));
  if (missing.length === 0) return { status: "present", resolvedPath, missing };
  return {
    status:
      missing.length === FLOW_OVERRIDE_ASK_RULES.length ? "absent" : "partial",
    resolvedPath,
    missing,
  };
}
