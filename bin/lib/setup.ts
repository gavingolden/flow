/**
 * `flow setup` and `flow setup --upgrade`: globally install flow's skills,
 * agents, and helper binaries via symlinks under ~/.claude/ and ~/.local/bin/.
 *
 * Manifest at ~/.flow/installed.json records every symlink so --upgrade can
 * reap orphans deterministically. Real files at install targets are never
 * touched without --force, preserving user-authored content with the same
 * name.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CLAUDE_SETTINGS_PATH, resolveFlowSource, SETUP_LOCK_PATH } from "./paths";
import {
  readManifest,
  writeManifest,
  type Manifest,
  type SymlinkRecord,
} from "./manifest";
import {
  DEFAULT_TARGETS,
  discoverAll,
  entryToRecord,
  type InstallTargets,
  type SourceEntry,
} from "./sources";
import { ensureSymlink, removeIfManagedSymlink, type LinkResult } from "./symlink";
import { withFileLock } from "./lock";
import { applyShellRcCompletions } from "./setup-rc";
import { ensureStopHook } from "./settings-merge";
import { fastForwardCanonical, resolveDefaultBranch } from "./git";

const STOP_HOOK_COMMAND = "flow-stop-guard";

export type SetupOptions = {
  upgrade?: boolean;
  force?: boolean;
  /** Override the flow source root (default: derived from this module's path). */
  flowSource?: string;
  /**
   * Override the canonical install root recorded in the manifest. Distinct
   * from `flowSource`: when `flow setup --source <worktree>` is used,
   * `flowSource` points at the per-pipeline worktree (so discovery picks up
   * its in-flight skills/agents) while `installRoot` stays on the canonical
   * install location. Defaults to `resolveFlowSource()` in production —
   * tests override to keep manifest paths inside the fixture.
   */
  installRoot?: string;
  /** Override install target directories (default: ~/.claude/, ~/.local/bin/). */
  targets?: InstallTargets;
  /** Skip the tmux-on-PATH preflight (test-only). */
  skipPreflight?: boolean;
  /** Manifest path override (test-only; default: ~/.flow/installed.json). */
  manifestPath?: string;
  /** Suppress stdout output. */
  quiet?: boolean;
  /** Setup-lock path override (test-only; default: ~/.flow/setup.lock). */
  lockPath?: string;
  /** Lock-acquisition timeout in ms (test-only; default: 30000). */
  lockTimeoutMs?: number;
  /**
   * If true, skip the rc-file editing step. If rc files already carry the
   * managed `completions` block from a prior run, the existing blocks are
   * removed (set/unset is symmetric).
   */
  noCompletions?: boolean;
  /**
   * If true, skip the Claude Code settings.json hook merge. Users who manage
   * their settings.json by hand pass `--no-hooks` to avoid the merge.
   */
  noHooks?: boolean;
  /**
   * Override the path to the Claude Code settings.json file. Test-only.
   * Production reads from `~/.claude/settings.json`.
   */
  settingsPath?: string;
  /**
   * Override the home directory used to resolve shell rc files. Test-only.
   * Production reads from os.homedir().
   */
  homeDir?: string;
  /**
   * On `--upgrade`, fast-forward `<installRoot>` to `origin/<default>` before
   * the lock acquires (so two parallel pipelines don't serialize on the
   * network round-trip). Defaults to `true` whenever `upgrade` is true;
   * ignored on non-upgrade runs. Set false to opt out via
   * `flow setup --upgrade --no-pull-canonical`.
   */
  pullCanonicalFirst?: boolean;
};

export type SetupSummary = {
  created: number;
  updated: number;
  skipped: number;
  blocked: number;
  removed: number;
};

export function runSetup(options: SetupOptions = {}): SetupSummary {
  const flowSource = options.flowSource ?? resolveFlowSource();
  const installRoot = options.installRoot ?? resolveFlowSource();
  const targets = options.targets ?? DEFAULT_TARGETS;
  const log = options.quiet ? () => undefined : (msg: string) => console.log(msg);

  if (!options.skipPreflight) preflight(targets);

  // Outside the lock so two parallel pipelines don't serialize on a network
  // round-trip. Best-effort — log and continue on any failure (same priority
  // as applyShellRcCompletions / ensureStopHook below).
  if (options.upgrade && options.pullCanonicalFirst !== false) {
    const ff = fastForwardCanonical({ canonicalRoot: installRoot, log });
    if (ff.status === "ahead") {
      log(`      canonical: fast-forwarded ${ff.advanced} commits`);
    } else if (ff.status === "skipped") {
      log(`      canonical: skipped (${ff.reason})`);
    }
  }

  // Serialize symlink + manifest writes against any concurrent `flow setup`
  // invocation. Without the lock, two parallel pipelines that both run
  // `flow setup --upgrade` can race on the same skill/agent symlink.
  return withFileLock(
    options.lockPath ?? SETUP_LOCK_PATH,
    () => runUnderLock(flowSource, installRoot, targets, log, options),
    { timeoutMs: options.lockTimeoutMs },
  );
}

function runUnderLock(
  flowSource: string,
  installRoot: string,
  targets: InstallTargets,
  log: (msg: string) => void,
  options: SetupOptions,
): SetupSummary {
  const entries = discoverAll(flowSource, installRoot, targets);
  const summary: SetupSummary = { created: 0, updated: 0, skipped: 0, blocked: 0, removed: 0 };

  log(`flow: setup`);
  log(`      source ${flowSource}`);

  for (const entry of entries) {
    const result = ensureSymlink(entry.target, entry.source, options.force ?? false);
    logResult(entry, result, log);
    summary[bucketFor(result)]++;
  }

  if (options.upgrade) {
    summary.removed = reapOrphans(entries, options.manifestPath, log, installRoot);
  }

  // Edit the user's shell rc files to source the completion scripts. Run
  // before the manifest write so a failure here doesn't leave a manifest
  // claiming files that aren't wired up. The helper is a no-op when no rc
  // files exist and logs its own actions.
  applyShellRcCompletions(
    targets,
    { remove: options.noCompletions, homeDir: options.homeDir },
    log,
  );

  if (!options.noHooks) {
    const settingsPath = options.settingsPath ?? CLAUDE_SETTINGS_PATH;
    const result = ensureStopHook(settingsPath, STOP_HOOK_COMMAND);
    if (result.changed) {
      log(`  + hooks/Stop:${STOP_HOOK_COMMAND}  (registered in ${settingsPath})`);
    } else if (result.reason) {
      log(`  ! hooks/Stop:${STOP_HOOK_COMMAND}  (${result.reason}: ${result.error ?? "no detail"})`);
    }
  }

  // Write the manifest as the union of "what we just installed" + entries
  // that still exist from a prior run that we didn't reap (they remain valid
  // claims). On a fresh install the union is just the new entries.
  const manifest = mergeManifest(entries, flowSource, installRoot);
  writeManifest(manifest, options.manifestPath);

  printSummary(summary, log);
  return summary;
}

function preflight(targets: InstallTargets): void {
  if (!commandOnPath("tmux")) {
    console.error(
      "error: tmux is not on PATH.\n" +
        "  flow uses tmux for pipeline windows. Install it first:\n" +
        "    macOS:  brew install tmux\n" +
        "    Linux:  apt install tmux  (or your distro's equivalent)",
    );
    process.exit(1);
  }
  if (!pathContains(targets.binDir)) {
    console.error(
      `warning: ${targets.binDir} is not on PATH.\n` +
        "  Add it to your shell rc and restart the shell:\n" +
        `    export PATH="${targets.binDir}:$PATH"`,
    );
  }
}

function reapOrphans(
  currentEntries: SourceEntry[],
  manifestPath: string | undefined,
  log: (msg: string) => void,
  canonicalRoot: string,
): number {
  const previous = readManifest(manifestPath);
  const currentTargets = new Set(currentEntries.map((e) => e.target));
  // Resolved once per reap pass (not per-record) so the per-record backstop
  // doesn't re-spawn `git symbolic-ref` N times. Falls open to undefined when
  // canonical is not a git repo — `removeIfManagedSymlink` then skips the
  // backstop entirely and falls through to today's existing reap behavior.
  const defaultBranch = resolveDefaultBranch(canonicalRoot) ?? undefined;
  let removed = 0;
  for (const record of previous.symlinks) {
    if (currentTargets.has(record.target)) continue;
    if (removeIfManagedSymlink(record.target, record.source, { canonicalRoot, defaultBranch, log })) {
      log(`  - ${path.basename(record.target)}  (orphan removed)`);
      removed++;
    }
  }
  return removed;
}

function mergeManifest(
  entries: SourceEntry[],
  flowSource: string,
  installRoot: string,
): Manifest {
  const records: SymlinkRecord[] = entries.map((e) => entryToRecord(e, flowSource, installRoot));
  return { version: 1, symlinks: records };
}

function bucketFor(result: LinkResult): keyof Pick<SetupSummary, "created" | "updated" | "skipped" | "blocked"> {
  switch (result) {
    case "created":
      return "created";
    case "updated":
      return "updated";
    case "exists":
      return "skipped";
    case "blocked":
      return "blocked";
  }
}

function logResult(entry: SourceEntry, result: LinkResult, log: (msg: string) => void): void {
  const label = `${entry.kind}/${entry.displayName}`;
  switch (result) {
    case "created":
      log(`  + ${label}`);
      break;
    case "updated":
      log(`  ~ ${label}  (relinked)`);
      break;
    case "exists":
      // Quiet on idempotent runs — chatty output drowns the real signal.
      break;
    case "blocked":
      log(`  ! ${label}  (blocked — non-symlink at target; use --force to replace)`);
      break;
  }
}

function printSummary(s: SetupSummary, log: (msg: string) => void): void {
  const parts = [
    s.created ? `${s.created} created` : null,
    s.updated ? `${s.updated} updated` : null,
    s.skipped ? `${s.skipped} skipped` : null,
    s.removed ? `${s.removed} removed` : null,
    s.blocked ? `${s.blocked} blocked` : null,
  ].filter(Boolean);
  log(parts.length ? `      ${parts.join(", ")}` : "      no changes");
}

function commandOnPath(cmd: string): boolean {
  const result = Bun.spawnSync(["sh", "-c", `command -v ${cmd}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0;
}

function pathContains(dir: string): boolean {
  const p = process.env.PATH ?? "";
  const real = (() => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return dir;
    }
  })();
  for (const segment of p.split(":")) {
    if (segment === dir || segment === real) return true;
    try {
      if (fs.realpathSync(segment) === real) return true;
    } catch {
      // ignore non-existent PATH segments
    }
  }
  return false;
}
