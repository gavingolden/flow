/**
 * `flow install` and `flow install --upgrade`: globally install flow's skills,
 * agents, and helper binaries via symlinks under ~/.claude/ and ~/.local/bin/.
 *
 * Manifest at ~/.flow/installed.json records every symlink so --upgrade can
 * reap orphans deterministically. Real files at install targets are never
 * touched without --force, preserving user-authored content with the same
 * name.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CLAUDE_SETTINGS_PATH,
  configuredFlowSource,
  FLOW_MANIFEST,
  resolveFlowSource,
  SETUP_LOCK_PATH,
} from "./paths";
import { inspectFlowRoot, type FlowRootInfo } from "./worktree-source";
import { isFlowOwnedSymlink } from "./flow-owned-symlink";
import {
  readManifest,
  writeManifest,
  type Manifest,
  type SymlinkRecord,
} from "./manifest";
import {
  DEFAULT_TARGETS,
  discoverAll,
  discoverSelected,
  effectiveLinkSource,
  entryToRecord,
  type InstallTargets,
  type SourceEntry,
} from "./sources";
import {
  ensureSymlink,
  removeIfManagedSymlink,
  type LinkResult,
} from "./symlink";
import {
  ensurePluginRoot,
  removePluginRoot,
  scanPluginRoots,
} from "./plugin-root";
import { moduleIdFromPluginRootName, pluginRootName } from "./plugin-manifest";
import { withFileLock } from "./lock";
import { applyShellRcCompletions } from "./setup-rc";
import {
  ensureSessionStartHook,
  ensureStopHook,
  repairSettings,
} from "./settings-merge";
import {
  changedInstallPaths,
  fastForwardCanonical,
  resolveDefaultBranch,
  type FastForwardResult,
} from "./git";
import { findMissingRuntimeDeps, formatMissingDepsError } from "./setup-deps";
import {
  checkInstallDrift,
  formatDriftNotice,
  type InstallDriftResult,
} from "./install-drift";
import {
  checkClaudeRunnable,
  formatClaudeCheckWarning,
  type ClaudeProbeRunner,
} from "./setup-claude-check";
import { readFlowVersion } from "./pkg-version";
import { invalidateUpdateCheckCache } from "./update-check";
import { dim, green, red } from "./color";
import { confirmStdin } from "./confirm";
import { moduleForArtifactName, moduleIds, type ModuleId } from "./modules";
import {
  collectModuleConfigWarnings,
  deriveSelectionFromManifest,
  readConfigFileAt,
  readModuleSelection,
  resolveModuleSelection,
  writeModuleSelection,
  type ReadConfigFile,
} from "./modules-config";
import { inactiveOptionalModules, type ModuleActivity } from "./module-status";
import {
  collectLauncherConfigWarnings,
  readLauncherConfig,
  resolveLauncherSelection,
  writeLauncherConfig,
} from "./launcher-config";
import { listStates, TERMINAL_PHASE_SET } from "./state";

const STOP_HOOK_COMMAND = "flow-stop-guard";
const SESSION_START_HOOK_COMMAND = "flow-session-start-hook";

/** Default `installRunner`: run `npm install` at `root` via Bun.spawnSync. */
function npmInstall(root: string): { ok: boolean; stderr?: string } {
  const result = Bun.spawnSync(["npm", "install"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0
    ? { ok: true }
    : { ok: false, stderr: result.stderr.toString() };
}

/** Default `reexecAfterFastForward`: re-runs the current process (same
 * argv) via `spawnSync` — see the call site in `runSetup` for why. */
function reexecUnderFreshCode(): number | undefined {
  const result = spawnSync(process.argv[0], process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, FLOW_INSTALL_REEXEC: "1" },
  });
  if (result.error || result.status === null || result.status === undefined) {
    return undefined;
  }
  return result.status;
}

export type SetupOptions = {
  upgrade?: boolean;
  force?: boolean;
  /** Override the flow source root (default: derived from this module's path). */
  flowSource?: string;
  /**
   * Override the canonical install root recorded in the manifest. Distinct
   * from `flowSource`: when `flow install --source <worktree>` is used,
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
  /**
   * Update-check cache path override (test-only; default:
   * ~/.flow/update-check.json). On `--upgrade`, this file is invalidated so
   * the next `flow ls` / `flow version` re-fetches staleness rather than
   * replaying the pre-upgrade notice from the 24h throttle cache.
   */
  cachePath?: string;
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
   * `flow install --upgrade --no-pull-canonical`.
   */
  pullCanonicalFirst?: boolean;
  /**
   * Injectable seam that re-runs the installer under freshly fast-forwarded
   * code (see the call site in `runSetup` for why this exists). Returns the
   * re-exec'd child's numeric exit status, or `undefined` when the spawn
   * itself failed (the caller then falls through rather than exiting).
   * Defaults to a real re-exec via `spawnSync`; tests inject a stub so no
   * test spawns a real subprocess or calls the real `process.exit`.
   */
  reexecAfterFastForward?: (ff: FastForwardResult) => number | undefined;
  /**
   * If true, when the Stop-hook merge encounters malformed JSON at
   * `settingsPath`, back the file up to a timestamped sibling and rewrite
   * with a minimal valid file containing just the Stop hook. Off by default
   * — the safe-bailout never stomps user data without explicit opt-in.
   */
  repairSettings?: boolean;
  /**
   * If true, when a declared runtime dependency fails to resolve from
   * `installRoot`, run an install there and re-check before reporting. Off by
   * default — the default is to report the missing package and exit non-zero.
   */
  installDeps?: boolean;
  /**
   * Injectable installer used when `installDeps` is true. Defaults to running
   * `npm install` at the given root via Bun.spawnSync; tests stub it to avoid
   * shelling out.
   */
  installRunner?: (root: string) => { ok: boolean; stderr?: string };
  /**
   * Injectable worktree/canonical-root inspector, used by the install-root
   * worktree guard. Defaults to `inspectFlowRoot` (`./worktree-source.ts`);
   * tests stub it to exercise the guard's branches without a real git
   * worktree fixture.
   */
  inspectRoot?: (dir: string) => FlowRootInfo;
  /**
   * Explicit module selection from `--modules <csv>` / `--core-only`
   * (already resolved to an id list, core folded in, by `setup-args.ts`).
   * Wins over any recorded `~/.flow/config.json` selection — see
   * `resolveModuleSelection` in `modules-config.ts`. `undefined` falls
   * through to the recorded selection, then TTY Q&A, then the non-TTY
   * core-only default.
   */
  modules?: string[];
  /**
   * `--all`: install every module. Bypasses module resolution entirely and
   * links via `discoverAll` directly (not `discoverSelected(moduleIds())`)
   * so byte-parity with today's unconditional install holds by
   * construction. Still persists the full module-id list so a later
   * `--upgrade` run with no flag keeps installing everything.
   */
  all?: boolean;
  /**
   * Confirmation-prompt seam for the first-run per-optional-module Q&A.
   * Defaults to `confirmStdin` (bin/lib/confirm.ts). Test-only override.
   */
  confirm?: (prompt: string) => boolean;
  /**
   * Whether the invoking process has an interactive TTY. Defaults to
   * `process.stdin.isTTY === true`. Test-only override — drives the
   * TTY-Q&A vs non-TTY-core-default branch of module-selection resolution.
   */
  isTTY?: boolean;
  /**
   * Override the `~/.flow/config.json` path read/written for the module
   * selection. Test-only (default: `flowConfigPath()`, via
   * `modules-config.ts`'s own default).
   */
  configPath?: string;
  /**
   * Override the pre-retarget skills location swept for flow-owned symlinks
   * during migration. Test-only (default:
   * `<homeDir ?? os.homedir()>/.claude/skills`). The sweep is a no-op when
   * this resolves to the same directory as `targets.skillsDir` — i.e. when
   * flow is still linking into the old location, there is nothing to migrate.
   */
  oldSkillsDir?: string;
  /**
   * Override the pre-agent-move global agents location swept for
   * flow-owned symlinks during migration. Test-only (default:
   * `<homeDir ?? os.homedir()>/.claude/agents`). Same no-op-when-live-target
   * guard as `oldSkillsDir`, and the same active-session-guard skip — see
   * `sweepOldAgentsLocation`.
   */
  oldAgentsDir?: string;
  /**
   * Override the `~/.flow/state/` directory the active-session guard scans
   * before pruning old-location agent links. Test-only (default:
   * `state.ts`'s own `FLOW_STATE_DIR` default via `listStates()`).
   */
  stateDir?: string;
  /**
   * `command -v <cmd>` probe seam for preflight's tmux-on-PATH check.
   * Test-only override (mirrors the `tmuxOnPath` seam `feature.ts`/`epic.ts`
   * thread through `resolveLauncherBackend`). Defaults to a real
   * `command -v` shell-out.
   */
  commandOnPath?: (cmd: string) => boolean;
  /**
   * `claude --version` probe seam for preflight's claude-runnable check.
   * Test-only override; defaults to the real spawn in setup-claude-check.ts.
   */
  claudeProbe?: ClaudeProbeRunner;
  /**
   * Post-repair residual-drift check, printed as a warn-only notice beside
   * `printInactiveModules`. Defaults to the real `checkInstallDrift`
   * (`./install-drift.ts`). Test-only override — `flow install` already
   * repairs drift before this point, so exercising a "drifted" result here
   * always means stubbing the check, not organically breaking a symlink.
   */
  checkDrift?: () => InstallDriftResult;
};

export type SetupSummary = {
  created: number;
  updated: number;
  skipped: number;
  blocked: number;
  removed: number;
  /** Count of plugin roots (one per selected module) materialized this run. */
  pluginRoots: number;
  /**
   * End-of-run JSON self-validation failures. Each entry is the path of a
   * file that flow wrote (or attempted to write) during this run but which
   * fails to round-trip through `JSON.parse`. Surfaced as `!` summary lines
   * and escalated to a non-zero CLI exit code.
   */
  validationFailures: string[];
  /**
   * Declared runtime dependencies that failed to resolve from `installRoot`
   * (after an optional `--install-deps` attempt). Non-empty drives a non-zero
   * CLI exit, parallel to `validationFailures`.
   */
  missingRuntimeDeps: string[];
};

export async function runSetup(
  options: SetupOptions = {},
): Promise<SetupSummary> {
  const flowSource = options.flowSource ?? resolveFlowSource();
  let installRoot = options.installRoot ?? resolveFlowSource();
  const targets = options.targets ?? DEFAULT_TARGETS;
  const log = options.quiet
    ? () => undefined
    : (msg: string) => console.log(msg);

  if (!options.skipPreflight) preflight(targets, options);

  // Install-root worktree guard: an install rooted in a git worktree (rather
  // than the canonical checkout) records manifest entries and symlink
  // targets that dangle the moment that worktree is removed (e.g. on PR
  // merge). Repoint to the derived canonical root when one is available and
  // no explicit `source` is already configured; otherwise warn-only — never
  // throws, never changes the exit code (inspectFlowRoot itself fails open).
  let repointedInstallRoot = false;
  const rootInfo = (options.inspectRoot ?? inspectFlowRoot)(installRoot);
  if (rootInfo.isWorktree) {
    if (
      rootInfo.canonicalRoot &&
      configuredFlowSource(options.homeDir) === null
    ) {
      log(
        `! install root ${installRoot} is a git worktree — recording and linking against canonical ${rootInfo.canonicalRoot} instead (a worktree-rooted install dangles every global symlink when the worktree is removed)`,
      );
      installRoot = rootInfo.canonicalRoot;
      repointedInstallRoot = true;
    } else {
      log(
        `! install root ${installRoot} is a git worktree and no canonical checkout was derived — every symlink written now will dangle when this worktree is removed; re-run 'flow install --upgrade' from the canonical checkout afterwards`,
      );
    }
  }

  // Preflight-like timing so a broken node_modules surfaces fast — but
  // reported through the summary (set inside runUnderLock), never via
  // process.exit. Check installRoot, NOT flowSource: a `--source <worktree>`
  // run points flowSource at the worktree while helpers resolve their imports
  // from the canonical installRoot, so that is the tree whose deps must
  // resolve. With --install-deps, attempt the install and re-check.
  let missingRuntimeDeps = findMissingRuntimeDeps(installRoot).missing;
  if (missingRuntimeDeps.length > 0 && options.installDeps) {
    const install = (options.installRunner ?? npmInstall)(installRoot);
    if (!install.ok) {
      log(
        `  ! install-deps failed at ${installRoot}: ${install.stderr ?? "no detail"}`,
      );
    }
    missingRuntimeDeps = findMissingRuntimeDeps(installRoot).missing;
  }
  if (missingRuntimeDeps.length > 0) {
    log(`  ${formatMissingDepsError(missingRuntimeDeps, installRoot)}`);
  }

  // Outside the lock so two parallel pipelines don't serialize on a network
  // round-trip. Best-effort — captured and reported in the outcome headline
  // (printOutcome) rather than logged inline. Suppressed when the guard
  // above already repointed installRoot this run: the freshly repointed
  // canonical tree doesn't need (and shouldn't race) a fetch/merge in the
  // same breath as the repoint.
  let ff: FastForwardResult | undefined;
  if (repointedInstallRoot) {
    ff = { status: "skipped", reason: "repointed-source" };
  } else if (options.upgrade && options.pullCanonicalFirst !== false) {
    ff = fastForwardCanonical({ canonicalRoot: installRoot });
  }

  // Bun resolves every `bin/lib/*` import at module load — BEFORE this point
  // — so an `ahead` fast-forward just rewrote the content on disk out from
  // under the code already loaded into THIS process. Re-exec (before the
  // lock, before any symlink/manifest write below) so the run that actually
  // mutates the filesystem does so under the fresh post-merge code, never
  // the stale pre-merge code. FLOW_INSTALL_REEXEC=1 in the child's env
  // bounds this to exactly one hop; a failed spawn falls through unchanged.
  if (ff?.status === "ahead" && process.env.FLOW_INSTALL_REEXEC !== "1") {
    const exitStatus = (options.reexecAfterFastForward ?? reexecUnderFreshCode)(
      ff,
    );
    if (exitStatus !== undefined) {
      process.exit(exitStatus);
    }
  }

  // Serialize symlink + manifest writes against any concurrent `flow install`
  // invocation. Without the lock, two parallel pipelines that both run
  // `flow install --upgrade` can race on the same skill/agent symlink.
  return withFileLock(
    options.lockPath ?? SETUP_LOCK_PATH,
    () =>
      runUnderLock(
        flowSource,
        installRoot,
        targets,
        log,
        options,
        missingRuntimeDeps,
        ff,
      ),
    { timeoutMs: options.lockTimeoutMs },
  );
}

/** Version string recorded in each materialized plugin.json. Falls back to
 * "0.0.0" (never throws) on any read failure — a plugin root must still
 * materialize even when the version can't be determined. */
function resolveInstallVersion(installRoot: string): string {
  try {
    return readFlowVersion(installRoot);
  } catch {
    return "0.0.0";
  }
}

async function runUnderLock(
  flowSource: string,
  installRoot: string,
  targets: InstallTargets,
  log: (msg: string) => void,
  options: SetupOptions,
  missingRuntimeDeps: string[],
  ff: FastForwardResult | undefined,
): Promise<SetupSummary> {
  const { entries, persistIds, selectedIds } = await resolveEntriesForRun(
    options,
    flowSource,
    installRoot,
    targets,
    log,
  );
  const pluginVersion = resolveInstallVersion(installRoot);
  if (persistIds) {
    writeModuleSelection(persistIds, { configPath: options.configPath });
  }

  // Launcher backend Q&A (default-off). A recorded config value or an
  // `--upgrade` run never re-asks; a non-TTY run with nothing recorded
  // defaults to plain with a one-line notice and persists nothing.
  const readCfg: ReadConfigFile | undefined = options.configPath
    ? () => readConfigFileAt(options.configPath!)
    : undefined;
  for (const w of collectLauncherConfigWarnings(readCfg)) {
    log(dim(`  ! launcher config: ${w}`));
  }
  const launcher = resolveLauncherSelection({
    isTTY: options.upgrade
      ? false
      : (options.isTTY ?? process.stdin.isTTY === true),
    confirm: options.confirm ?? confirmStdin,
    read: readCfg,
  });
  if (launcher.shouldPersist) {
    writeLauncherConfig(launcher.id, { configPath: options.configPath });
  }
  if (launcher.source === "default" && !options.upgrade) {
    log(
      dim(
        "  i launcher: defaulting to plain — opt into tmux with `flow config launcher set tmux`",
      ),
    );
  }
  const summary: SetupSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    blocked: 0,
    removed: 0,
    pluginRoots: 0,
    validationFailures: [],
    missingRuntimeDeps,
  };

  log(`flow: setup`);
  log(`      source ${flowSource}`);

  const worktreeOnlyNames: string[] = [];
  // Plugin-root entries process FIRST (a stable partition, not a mutation of
  // `entries` itself — downstream `reapOrphans`/manifest writes still see
  // the original order). Skill/agent targets now nest INSIDE their owning
  // module's root (<root>/skills/<name>, <root>/agents/<name>), so
  // `ensureSymlink`'s own `mkdirSync(dirname, {recursive:true})` would
  // otherwise create the root directory ownerless (no `.claude-plugin/
  // plugin.json` yet) ahead of `ensurePluginRoot` ever seeing it —
  // `isFlowOwnedPluginRoot` would then read that ownerless directory as
  // foreign and permanently "blocked" the root's own materialization.
  const orderedEntries = [
    ...entries.filter((e) => e.kind === "plugin"),
    ...entries.filter((e) => e.kind !== "plugin"),
  ];
  for (const entry of orderedEntries) {
    if (entry.kind === "plugin") {
      // `ensureSymlink` is NOT reusable here: it calls
      // `fs.realpathSync(source)` and returns "blocked" for ANY existing
      // directory at the target without --force, so a root flow
      // re-materializes every run would be permanently "blocked" from the
      // second install onward. `ensurePluginRoot` re-derives the root's
      // content (plugin.json fresh from `flowSource`) on every call
      // instead — but its bin/ symlinks ARE such a "live vs canonical
      // source" pointer, so `installRoot` is threaded through the same way
      // the symlink branch below routes `entry.source` via
      // `effectiveLinkSource`, keeping a `--source <worktree>` install from
      // leaving plugin-root bin/ links dangling once the worktree is
      // removed on merge.
      const moduleId = moduleIdFromPluginRootName(entry.displayName);
      if (!moduleId) continue; // defensive: discoverPluginRoots only ever emits known ids
      const result = ensurePluginRoot({
        root: entry.target,
        moduleId,
        flowSource,
        installRoot,
        version: pluginVersion,
        includeSkills: true,
        force: options.force ?? false,
      });
      logResult(entry, result, log);
      summary[bucketFor(result)]++;
      summary.pluginRoots++;
      continue;
    }
    // Point the live symlink at the canonical (installRoot) path for any
    // content that exists there, so a `--source <worktree>` install doesn't
    // leave global links dangling when the worktree is removed on merge.
    // A genuinely worktree-only new file has no canonical counterpart yet, so
    // it stays worktree-pointed (usable during the pipeline). The manifest
    // record (entry.source → entryToRecord) is unchanged: it always records
    // canonical, even for the not-yet-existing worktree-only case.
    const liveSource = effectiveLinkSource(
      entry.source,
      flowSource,
      installRoot,
    );
    if (
      flowSource !== installRoot &&
      liveSource.startsWith(flowSource) &&
      liveSource === entry.source
    ) {
      worktreeOnlyNames.push(entry.displayName);
    }
    const result = ensureSymlink(
      entry.target,
      liveSource,
      options.force ?? false,
    );
    logResult(entry, result, log);
    summary[bucketFor(result)]++;
  }
  if (worktreeOnlyNames.length > 0) {
    log(
      `! ${worktreeOnlyNames.length} artifact(s) linked from the worktree source (no canonical counterpart yet): ${worktreeOnlyNames.join(", ")} — re-run 'flow install --upgrade' after merge`,
    );
  }

  // Reap on EVERY run, not just --upgrade: a module-selection narrowing
  // (re-running `flow install` with a smaller `--modules` list, or declining
  // a previously-accepted module at the interactive Q&A) must prune the
  // now-deselected symlinks even without --upgrade — "deselecting a module
  // prunes its previously-linked artifacts" per docs/target-architecture.md,
  // not "deselecting AND upgrading". Safe unconditionally: reapOrphans only
  // ever removes a flow-managed symlink (or plugin root) no longer present
  // in `entries`; it never touches a non-symlink (user-authored) file at the
  // same target.
  summary.removed = reapOrphans(
    entries,
    options.manifestPath,
    log,
    installRoot,
    targets.skillsDir,
    selectedIds,
  );
  // Migration backstop for the ~/.claude/skills → ~/.flow/claude-home retarget:
  // reapOrphans only removes MANIFEST-recorded old-location links. A drifted or
  // pre-manifest install would strand its old-location symlinks forever, so
  // sweep the old location directly for any flow-owned symlink (target resolves
  // inside the flow source tree) — never a user file or a foreign symlink.
  const oldSkillsDir =
    options.oldSkillsDir ??
    path.join(options.homeDir ?? os.homedir(), ".claude", "skills");
  summary.removed += sweepOldSkillsLocation(
    oldSkillsDir,
    targets,
    flowSource,
    installRoot,
    log,
  );
  // Migration backstop for the agent-move (Task 4, agent-invocation-name
  // `confirmed` branch): agents now route into their owning module's plugin
  // root instead of the flat global `~/.claude/agents/`, so sweep the old
  // location the same way `oldSkillsDir` is swept above. ACTIVE-SESSION
  // GUARD: skip pruning this run when any recorded pipeline is mid-flight
  // (a non-terminal phase) — see `sweepOldAgentsLocation`'s doc comment.
  const oldAgentsDir =
    options.oldAgentsDir ??
    path.join(options.homeDir ?? os.homedir(), ".claude", "agents");
  // `os.homedir()` read LAZILY here (call-time, not import-time) — safe
  // under `vitest.setup.ts`'s global $HOME sandbox net, unlike
  // `state.ts`'s own `FLOW_STATE_DIR` default, which freezes the REAL
  // home at import time (documented gap, PR #86 followup). Passing an
  // explicit `stateDir` derived from `options.homeDir` here, rather than
  // relying on `listStates`'s own default, keeps every test in this suite
  // off the developer's/CI runner's real `~/.flow/state/`.
  const stateDir =
    options.stateDir ??
    path.join(options.homeDir ?? os.homedir(), ".flow", "state");
  const activeSessionPhases = listStates(stateDir)
    .map((s) => s.phase)
    .filter((phase) => !TERMINAL_PHASE_SET.has(phase));
  if (activeSessionPhases.length > 0) {
    // Scoped wording: this guard only withholds the UNGUARDED-elsewhere
    // sweepOldAgentsLocation sweep below. `reapOrphans` above (manifest-
    // recorded old-agent-location removals) and `sweepOldSkillsLocation`
    // above already ran unconditionally by this point regardless of any
    // active session, so "old locations preserved" would be false in the
    // common case where those two already pruned something.
    console.error(
      "flow install: active sessions detected; non-manifest old-agent-location sweep skipped until next install",
    );
  } else {
    summary.removed += sweepOldAgentsLocation(
      oldAgentsDir,
      targets,
      flowSource,
      installRoot,
      log,
    );
  }
  if (options.upgrade) {
    // Invalidate the update-check throttle cache so the next `flow ls` /
    // `flow version` re-fetches staleness instead of replaying the
    // pre-upgrade "N commits behind" notice for up to 24h. Unconditional on
    // upgrade (not gated on ff.status) — the cache can be stale even when
    // this fast-forward was a no-op. Best-effort: never fails the upgrade.
    invalidateUpdateCheckCache(options.cachePath);
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

  const settingsPath = options.settingsPath ?? CLAUDE_SETTINGS_PATH;
  if (!options.noHooks) {
    const result = ensureStopHook(settingsPath, STOP_HOOK_COMMAND, {
      homeDir: options.homeDir,
    });
    if (result.changed) {
      log(
        `  + hooks/Stop:${STOP_HOOK_COMMAND}  (registered in ${settingsPath})`,
      );
    } else if (result.reason === "malformed-json" && options.repairSettings) {
      const repair = repairSettings(settingsPath, STOP_HOOK_COMMAND, {
        homeDir: options.homeDir,
      });
      if (repair.changed) {
        log(
          `  ~ hooks/Stop:${STOP_HOOK_COMMAND}  (repaired; backup at ${repair.backupPath})`,
        );
        if (repair.resolvedPath && repair.resolvedPath !== settingsPath) {
          log(`      (followed symlink to ${repair.resolvedPath})`);
        }
      } else {
        log(
          `  ! hooks/Stop:${STOP_HOOK_COMMAND}  (repair-failed: ${repair.error ?? repair.reason ?? "no detail"})`,
        );
      }
    } else if (result.reason) {
      log(
        `  ! hooks/Stop:${STOP_HOOK_COMMAND}  (${result.reason}: ${result.error ?? "no detail"})`,
      );
      if (result.reason === "malformed-json") {
        log(
          `      → run "flow install --repair-settings" to back up and rewrite the file`,
        );
      }
      // unsafe-symlink-target intentionally gets no repair hint — repair
      // would just chase the same escaping symlink. The user needs to
      // inspect the symlink themselves and decide whether it's a planted
      // attack or a legitimate dotfiles target outside ~/.
    }

    // SessionStart:clear auto-resume hook — same gate + settingsPath as the
    // Stop hook. Runs AFTER the Stop block so that if a malformed file was
    // repaired above (--repair-settings), this rides the now-valid file. A
    // malformed-json outcome here is a duplicate of the Stop hook's own
    // report + repair hint, so it's not re-logged.
    const ssResult = ensureSessionStartHook(
      settingsPath,
      SESSION_START_HOOK_COMMAND,
      { homeDir: options.homeDir },
    );
    if (ssResult.changed) {
      log(
        `  + hooks/SessionStart:${SESSION_START_HOOK_COMMAND}  (registered in ${settingsPath})`,
      );
    } else if (ssResult.reason && ssResult.reason !== "malformed-json") {
      log(
        `  ! hooks/SessionStart:${SESSION_START_HOOK_COMMAND}  (${ssResult.reason}: ${ssResult.error ?? "no detail"})`,
      );
    }
  }

  // Write the manifest as the union of "what we just installed" + entries
  // that still exist from a prior run that we didn't reap (they remain valid
  // claims). On a fresh install the union is just the new entries.
  const manifest = mergeManifest(entries, flowSource, installRoot);
  const manifestTargetPath = options.manifestPath ?? FLOW_MANIFEST;
  writeManifest(manifest, manifestTargetPath);

  // End-of-run JSON self-validation: re-parse every JSON file this run wrote
  // (or attempted to write). Catches any future regression in any of flow's
  // JSON writers at install time; skips files that don't exist on disk
  // (e.g. a --no-hooks run never touches settings.json).
  //
  // Gate settingsPath on `!options.noHooks` — when the user opted out via
  // --no-hooks, flow never touched settings.json this run, so a malformed
  // file there is not a flow-induced regression and must not block exit.
  const validationTargets = [manifestTargetPath];
  if (!options.noHooks) validationTargets.push(settingsPath);
  const validation = validateJsonFiles(validationTargets);
  for (const p of validation.failures) {
    summary.validationFailures.push(p);
    log(
      red(
        `  ! ${p}  (validation-failed: ${validation.errors.get(p) ?? "no detail"})`,
      ),
    );
  }

  printOutcome(
    summary,
    log,
    options,
    flowSource,
    installRoot,
    ff,
    entries,
    manifestTargetPath,
    targets,
  );
  return summary;
}

/**
 * The `~/.flow/config.json` module-selection reader seam, resolved once
 * from `options.configPath` (test fixtures) or the real config path
 * (production). Shared by `resolveEntriesForRun` and `printOutcome`'s
 * doctor-summary read so both resolve the SAME fixture-scoped file rather
 * than one of them silently falling through to the real `~/.flow`.
 */
function configReaderFor(options: SetupOptions): ReadConfigFile | undefined {
  return options.configPath
    ? () => readConfigFileAt(options.configPath!)
    : undefined;
}

/**
 * Resolves which `SourceEntry[]` this run links, which module-id list to
 * persist (when the resolution expressed real user intent), and which
 * module ids were actually selected (`selectedIds` — always populated,
 * unlike `persistIds`, which is `undefined` whenever `shouldPersist` is
 * false: a recorded-config run, a manifest-derived run, and the non-TTY
 * default all resolve a real selection without persisting it). Callers that
 * need "what did this run select" (`runUnderLock`'s OQ-7 orphan scan) must
 * read `selectedIds`, never infer it from `persistIds`.
 *
 * `--all` bypasses module resolution entirely and calls `discoverAll`
 * directly — not `discoverSelected(moduleIds())` — so its SYMLINK-set
 * byte-parity with today's unconditional install holds by construction,
 * independent of the registry/resolver. `discoverAll`'s plugin-root append
 * is additive on top of that and is the ADR's sanctioned first break of the
 * guarantee (see `sources.ts`'s `discoverAll` doc comment). `--all` still
 * persists the full id list so a later `--upgrade` run with no flag keeps
 * installing everything (verified set-equal to `discoverAll` by
 * `modules.test.ts`).
 *
 * A non-TTY run with nothing recorded and no flag defaults to core-only and
 * prints a one-line notice naming how to widen the selection — it does NOT
 * persist, since no user intent was expressed.
 */
async function resolveEntriesForRun(
  options: SetupOptions,
  flowSource: string,
  installRoot: string,
  targets: InstallTargets,
  log: (msg: string) => void,
): Promise<{
  entries: SourceEntry[];
  persistIds: string[] | undefined;
  selectedIds: string[];
}> {
  if (options.all) {
    return {
      entries: discoverAll(flowSource, installRoot, targets),
      persistIds: moduleIds(),
      selectedIds: moduleIds(),
    };
  }

  const read = configReaderFor(options);

  for (const w of collectModuleConfigWarnings(read)) {
    log(dim(`  ! module config: ${w}`));
  }

  // gh#435: when nothing is recorded, derive the existing install's breadth
  // from the manifest so a non-interactive `--upgrade` preserves it instead
  // of collapsing to core. Empty/absent manifest → undefined → the resolver
  // falls through to its TTY / core-default branches unchanged.
  const manifest = readManifest(options.manifestPath);
  const manifestIds =
    manifest.symlinks.length > 0
      ? deriveSelectionFromManifest(manifest)
      : undefined;

  const selection = resolveModuleSelection({
    flagIds: options.modules,
    manifestIds,
    isTTY: options.isTTY ?? process.stdin.isTTY === true,
    confirm: options.confirm ?? confirmStdin,
    read,
  });

  if (selection.source === "manifest") {
    log(
      dim(
        "  i module selection: preserving existing installed breadth (derived from ~/.flow/installed.json) — record a selection with --modules/--all to silence this",
      ),
    );
  } else if (selection.source === "default") {
    log(
      dim(
        "  i module selection: defaulting to core only — pass --modules <csv>, --all, or run `flow install` interactively to select more",
      ),
    );
  }

  return {
    entries: await discoverSelected(
      flowSource,
      installRoot,
      selection.ids,
      targets,
      (msg) => log(dim(`  ! module registry: ${msg}`)),
    ),
    persistIds: selection.shouldPersist ? selection.ids : undefined,
    selectedIds: selection.ids,
  };
}

/**
 * Pure helper: re-parses each given path through `JSON.parse` and reports
 * which paths failed plus the verbatim error messages. Missing files are
 * skipped (returned in neither result field). Separated from the
 * orchestrator so it can be unit-tested in isolation without standing up a
 * full setup fixture.
 */
export function validateJsonFiles(paths: string[]): {
  failures: string[];
  errors: Map<string, string>;
} {
  const failures: string[] = [];
  const errors = new Map<string, string>();
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    try {
      JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(p);
      errors.set(p, msg);
    }
  }
  return { failures, errors };
}

function preflight(targets: InstallTargets, options: SetupOptions): void {
  // tmux is no longer an install prerequisite — the plain launcher is the
  // default backend. Warn (never fail) only when the RECORDED launcher is
  // tmux and tmux is missing, since that recorded preference will degrade at
  // launch time.
  const read: ReadConfigFile | undefined = options.configPath
    ? () => readConfigFileAt(options.configPath!)
    : undefined;
  const hasCommand = options.commandOnPath ?? commandOnPath;
  if (readLauncherConfig(read) === "tmux" && !hasCommand("tmux")) {
    console.error(
      "warning: your recorded launcher is tmux, but tmux is not on PATH.\n" +
        "  pipelines will fall back to the plain launcher. Install tmux:\n" +
        "    macOS:  brew install tmux\n" +
        "    Linux:  apt install tmux  (or your distro's equivalent)",
    );
  }
  if (!pathContains(targets.binDir)) {
    console.error(
      `warning: ${targets.binDir} is not on PATH.\n` +
        "  Add it to your shell rc and restart the shell:\n" +
        `    export PATH="${targets.binDir}:$PATH"`,
    );
  }
  // Claude Code is what every pipeline launch runs; warn (never fail) at
  // install time when `claude --version` won't run, same warn-only pattern
  // as the two checks above.
  const claude = checkClaudeRunnable(options.claudeProbe);
  if (!claude.ok) {
    console.error(formatClaudeCheckWarning(claude.reason ?? "probe-failed"));
  }
}

function reapOrphans(
  currentEntries: SourceEntry[],
  manifestPath: string | undefined,
  log: (msg: string) => void,
  canonicalRoot: string,
  skillsDir: string,
  selectedIds: readonly string[],
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
    if (record.kind === "plugin") {
      if (removePluginRoot(record.target)) {
        log(
          dim(
            `  - ${path.basename(record.target)}  (orphan plugin root removed)`,
          ),
        );
        removed++;
      }
      continue;
    }
    if (
      removeIfManagedSymlink(record.target, record.source, {
        canonicalRoot,
        defaultBranch,
        log,
      })
    ) {
      log(dim(`  - ${path.basename(record.target)}  (orphan removed)`));
      removed++;
    }
  }

  // OQ-7 manifest-independent orphan scan: `scanPluginRoots` finds every
  // flow-owned root ON DISK, independent of what the manifest recorded — a
  // user who checks out a pre-plugin ref and runs `flow install --upgrade`
  // gets a manifest with no "plugin" records at all; checking the new ref
  // back out would otherwise strand those roots unreapable, breaking Story
  // 6's "roll back predictably" acceptance criterion. Prune any found root
  // whose module id is not in the CURRENT SELECTION, whether or not the
  // manifest ever recorded it.
  const currentPluginTargets = new Set(
    selectedIds.map((id) =>
      path.join(skillsDir, pluginRootName(id as ModuleId)),
    ),
  );
  for (const foundRoot of scanPluginRoots(skillsDir)) {
    if (currentPluginTargets.has(foundRoot)) continue;
    if (removePluginRoot(foundRoot)) {
      log(dim(`  - ${path.basename(foundRoot)}  (orphan plugin root removed)`));
      removed++;
    }
  }

  return removed;
}

/**
 * One-time migration sweep of the pre-retarget `~/.claude/skills/` location.
 * Removes every direct child that is a flow-owned symlink — one whose target
 * resolves inside the flow source tree (`flowSource` or `installRoot`) — so a
 * drifted or pre-manifest install still migrates out of the old location. Real
 * files and foreign symlinks (targets outside the flow tree) are never touched.
 *
 * No-op when `oldSkillsDir` resolves to the live `targets.skillsDir`: flow is
 * still linking into that directory, so there is nothing to migrate. This guard
 * is what keeps the sweep inert for a consumer who has not retargeted (and for
 * the existing test fixtures, which point `targets.skillsDir` at
 * `<home>/.claude/skills`).
 */
function sweepOldSkillsLocation(
  oldSkillsDir: string,
  targets: InstallTargets,
  flowSource: string,
  installRoot: string,
  log: (msg: string) => void,
): number {
  if (path.resolve(oldSkillsDir) === path.resolve(targets.skillsDir)) return 0;
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(oldSkillsDir, { withFileTypes: true });
  } catch {
    return 0; // old location absent — clean machine or already migrated
  }
  const flowRoots = [path.resolve(flowSource), path.resolve(installRoot)];
  let removed = 0;
  for (const dirent of dirents) {
    if (!dirent.isSymbolicLink()) continue; // never touch a real file
    if (
      removeIfFlowOwnedSymlink(path.join(oldSkillsDir, dirent.name), flowRoots)
    ) {
      log(dim(`  - ${dirent.name}  (migrated out of ~/.claude/skills)`));
      removed++;
    }
  }
  return removed;
}

/**
 * One-time migration sweep of the pre-agent-move global `~/.claude/agents/`
 * location (Task 4, the agent-invocation-name-`confirmed` branch). Removes
 * every direct child that is a flow-owned symlink — same ownership rule as
 * `sweepOldSkillsLocation`'s `removeIfFlowOwnedSymlink` — so a drifted or
 * pre-migration install still cleans up the old location. Real files and
 * foreign symlinks are never touched.
 *
 * NO live-target no-op guard, unlike `sweepOldSkillsLocation`'s: `targets`
 * is threaded through for signature parity and so a future caller can log
 * against it, but `targets.agentsDir` is otherwise DEAD post-retarget —
 * `discoverAgents` (`sources.ts`) never emits a `targets.agentsDir`-rooted
 * target any more (every agent routes into its owning module's plugin
 * root), so there is no live installation this sweep could ever collide
 * with the way skills' home-retarget guard collides. Gating on
 * `oldAgentsDir === targets.agentsDir` the way skills does would make this
 * sweep a permanent no-op under `DEFAULT_TARGETS` (both default to the same
 * `~/.claude/agents` path) — the opposite of Task 4's intent.
 *
 * ACTIVE-SESSION GUARD: when any `~/.flow/state/*.json` carries a phase
 * outside `TERMINAL_PHASE_SET` (`state.ts`), pruning is skipped this run —
 * a live `/flow-pipeline` session may still expect its spawn-site guards
 * (`bin/skill-md-lint.test.ts`'s pinned probe paths) to resolve against the
 * OLD global location until it next re-installs. Old-location links are
 * preserved, not force-migrated, so a resume mid-session degrades to
 * `general-purpose` at worst rather than crashing on a missing file.
 */
function sweepOldAgentsLocation(
  oldAgentsDir: string,
  targets: InstallTargets,
  flowSource: string,
  installRoot: string,
  log: (msg: string) => void,
): number {
  void targets; // signature parity with sweepOldSkillsLocation — see doc comment
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(oldAgentsDir, { withFileTypes: true });
  } catch {
    return 0; // old location absent — clean machine or already migrated
  }
  const flowRoots = [path.resolve(flowSource), path.resolve(installRoot)];
  let removed = 0;
  for (const dirent of dirents) {
    if (!dirent.isSymbolicLink()) continue; // never touch a real file
    if (
      removeIfFlowOwnedSymlink(path.join(oldAgentsDir, dirent.name), flowRoots)
    ) {
      log(dim(`  - ${dirent.name}  (migrated out of ~/.claude/agents)`));
      removed++;
    }
  }
  return removed;
}

/**
 * Removes `target` iff it is a symlink whose resolved target lives under one
 * of `flowRoots` (flow-owned by construction). Returns true if removed. A
 * symlink pointing outside the flow tree — a user's own — is preserved; a
 * non-symlink is left to the `readlinkSync` failure path.
 */
function removeIfFlowOwnedSymlink(
  target: string,
  flowRoots: string[],
): boolean {
  if (!isFlowOwnedSymlink(target, flowRoots)) return false;
  try {
    fs.unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

function mergeManifest(
  entries: SourceEntry[],
  flowSource: string,
  installRoot: string,
): Manifest {
  const records: SymlinkRecord[] = entries.map((e) =>
    entryToRecord(e, flowSource, installRoot),
  );
  return { version: 1, symlinks: records };
}

function bucketFor(
  result: LinkResult,
): keyof Pick<SetupSummary, "created" | "updated" | "skipped" | "blocked"> {
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

function logResult(
  entry: SourceEntry,
  result: LinkResult,
  log: (msg: string) => void,
): void {
  const label = `${entry.kind}/${entry.displayName}`;
  // A plugin root is a materialized directory, not a symlink — its
  // "updated"/"blocked" wording differs slightly from every other kind's.
  const isPlugin = entry.kind === "plugin";
  switch (result) {
    case "created":
      log(dim(`  + ${label}`));
      break;
    case "updated":
      log(dim(`  ~ ${label}  (${isPlugin ? "re-materialized" : "relinked"})`));
      break;
    case "exists":
      // Quiet on idempotent runs — chatty output drowns the real signal.
      break;
    case "blocked":
      log(
        red(
          `  ! ${label}  (blocked — ${isPlugin ? "existing directory has no flow-written plugin.json" : "non-symlink at target"}; use --force to replace)`,
        ),
      );
      break;
  }
}

/**
 * Composes the version-stamped outcome headline (and, on an `ahead`
 * upgrade, a concise changed-skills/helpers list) under the per-item detail
 * lines. Replaces the bare `no changes` symlink-churn summary: an upgrade
 * whose content advanced reads as updated even with zero relinks. The
 * symlink accounting moves to a dimmed detail line when there is churn.
 */
function printOutcome(
  s: SetupSummary,
  log: (msg: string) => void,
  options: SetupOptions,
  flowSource: string,
  installRoot: string,
  ff: FastForwardResult | undefined,
  entries: SourceEntry[],
  manifestPath: string,
  targets: InstallTargets,
): void {
  const version = (() => {
    try {
      return readFlowVersion(installRoot);
    } catch {
      return undefined;
    }
  })();
  const v = version ? `v${version}` : "(unknown version)";

  if (options.upgrade) {
    if (ff?.status === "ahead") {
      const range =
        ff.beforeSha && ff.afterSha ? `, ${ff.beforeSha} → ${ff.afterSha}` : "";
      log(
        green(
          `flow updated: ${v}, ${ff.advanced} commit${
            ff.advanced === 1 ? "" : "s"
          }${range}`,
        ),
      );
      const changed = changedInstallPaths({
        canonicalRoot: installRoot,
        beforeSha: ff.beforeSha,
        afterSha: ff.afterSha,
      });
      if (changed.length > 0) log(dim(`      changed: ${changed.join(", ")}`));
    } else if (ff?.status === "skipped" && ff.reason === "dirty") {
      log(
        red(
          `flow: content NOT refreshed (dirty) — links re-pointed but content not refreshed`,
        ),
      );
    } else if (ff?.status === "skipped" && ff.reason === "non-default-branch") {
      log(dim(`flow: content not refreshed (on a non-default branch)`));
    } else if (ff?.status === "skipped") {
      log(dim(`flow: content not refreshed (${ff.reason})`));
    } else if (ff?.status === "up-to-date") {
      log(green(`flow already up to date at ${v}`));
    } else {
      // ff === undefined: --no-pull-canonical opted out, so content was never
      // fetched/compared. Don't claim up-to-date — links were re-pointed but
      // no content check happened.
      log(green(`flow install complete at ${v} (content not checked)`));
    }
  } else {
    log(green(`flow installed ${v}`));
  }

  printSummaryLine(s, log);
  printModuleBreakdown(entries, log);
  // Deviation-2 fix: resolve activity from the SAME fixture-scoped
  // manifest/config the rest of this run used (manifestPath / configPath),
  // never the zero-arg real-`~/.flow` default — otherwise a test fixture's
  // `runSetup` call would read the developer's real module state and this
  // line would become non-deterministic under vitest.
  printInactiveModules(
    inactiveOptionalModules({
      readManifest: () => readManifest(manifestPath),
      readSelection: () => readModuleSelection(configReaderFor(options)),
    }),
    log,
  );
  // Post-repair residual-drift check: `flow install` already REPAIRS drift
  // above (the ensureSymlink loop), so a drifted result here means the
  // repair itself missed something — a bug signal, not routine staleness.
  // Warn-only: no exit-code change, no further auto-repair.
  const checkDrift =
    options.checkDrift ??
    (() =>
      checkInstallDrift({ flowSource, installRoot, manifestPath, targets }));
  const driftNotice = formatDriftNotice(checkDrift());
  if (driftNotice) log(dim(`      ${driftNotice}`));
}

function printSummaryLine(s: SetupSummary, log: (msg: string) => void): void {
  const parts = [
    s.created ? `${s.created} created` : null,
    s.updated ? `${s.updated} updated` : null,
    s.skipped ? `${s.skipped} skipped` : null,
    s.removed ? `${s.removed} removed` : null,
    s.blocked ? `${s.blocked} blocked` : null,
  ].filter(Boolean);
  // Only emit the symlink accounting when there was real churn — an
  // idempotent run keeps to the one-line outcome above (Story 6). Plugin
  // roots have already been folded into these SAME created/updated/skipped/
  // blocked buckets (bucketFor is shared) — see printModuleBreakdown for
  // where the plugin-root count itself is surfaced without adding a new
  // always-on line to Story 6's idempotent-run budget.
  if (parts.length) log(dim(`      ${parts.join(", ")}`));
}

/**
 * Groups this run's linked artifacts by owning module and prints one dimmed
 * summary line, e.g. `by module: core 74, stack-svelte 1`. The always-core
 * residue (the `flow` wrapper, shell completions) has no module row —
 * `moduleForArtifactName` returns `undefined` for those and they're
 * excluded from the breakdown, matching how they're excluded from
 * `resolveArtifactSet`'s union.
 */
/**
 * Prints one dimmed doctor-summary line naming every currently-inactive
 * optional module, e.g. `inactive modules: research (deselected), copilot
 * (deselected)`. Prints nothing when `inactive` is empty — a full/`--all`
 * install has no inactive optionals to report.
 */
function printInactiveModules(
  inactive: ModuleActivity[],
  log: (msg: string) => void,
): void {
  if (inactive.length === 0) return;
  const parts = inactive.map((m) => `${m.id} (deselected)`);
  log(dim(`      inactive modules: ${parts.join(", ")}`));
}

/**
 * A plugin root's `displayName` (`flow-module-<id>`) is never a
 * `moduleForArtifactName` hit — that registry only knows skill/agent/
 * helper/validator rows, not synthesized plugin-root names — so it's
 * resolved back to its owning module via `moduleIdFromPluginRootName`
 * instead. This is how the plugin-root count (`SetupSummary.pluginRoots`)
 * surfaces in the printed breakdown without adding a new always-on line to
 * Story 6's idempotent-run budget: it simply adds one to its module's
 * existing tally, the same as any other linked artifact.
 */
function printModuleBreakdown(
  entries: SourceEntry[],
  log: (msg: string) => void,
): void {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const moduleId =
      e.kind === "plugin"
        ? moduleIdFromPluginRootName(e.displayName)
        : moduleForArtifactName(e.displayName);
    if (!moduleId) continue;
    counts.set(moduleId, (counts.get(moduleId) ?? 0) + 1);
  }
  if (counts.size === 0) return;
  const parts = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, n]) => `${id} ${n}`);
  log(dim(`      by module: ${parts.join(", ")}`));
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
