/**
 * `flow install` and `flow install --upgrade`: globally install flow's skills,
 * agents, and helper binaries via symlinks under ~/.claude/ and ~/.local/bin/.
 *
 * Manifest at ~/.flow/installed.json records every symlink so --upgrade can
 * reap orphans deterministically. Real files at install targets are never
 * touched without --force, preserving user-authored content with the same
 * name.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CLAUDE_SETTINGS_PATH,
  FLOW_MANIFEST,
  resolveFlowSource,
  SETUP_LOCK_PATH,
} from "./paths";
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
import { readFlowVersion } from "./pkg-version";
import { invalidateUpdateCheckCache } from "./update-check";
import { dim, green, red } from "./color";
import { confirmStdin } from "./confirm";
import { moduleForArtifactName, moduleIds } from "./modules";
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
   * `command -v <cmd>` probe seam for preflight's tmux-on-PATH check.
   * Test-only override (mirrors the `tmuxOnPath` seam `feature.ts`/`epic.ts`
   * thread through `resolveLauncherBackend`). Defaults to a real
   * `command -v` shell-out.
   */
  commandOnPath?: (cmd: string) => boolean;
};

export type SetupSummary = {
  created: number;
  updated: number;
  skipped: number;
  blocked: number;
  removed: number;
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
  const installRoot = options.installRoot ?? resolveFlowSource();
  const targets = options.targets ?? DEFAULT_TARGETS;
  const log = options.quiet
    ? () => undefined
    : (msg: string) => console.log(msg);

  if (!options.skipPreflight) preflight(targets, options);

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
  // (printOutcome) rather than logged inline.
  let ff: FastForwardResult | undefined;
  if (options.upgrade && options.pullCanonicalFirst !== false) {
    ff = fastForwardCanonical({ canonicalRoot: installRoot });
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

async function runUnderLock(
  flowSource: string,
  installRoot: string,
  targets: InstallTargets,
  log: (msg: string) => void,
  options: SetupOptions,
  missingRuntimeDeps: string[],
  ff: FastForwardResult | undefined,
): Promise<SetupSummary> {
  const { entries, persistIds } = await resolveEntriesForRun(
    options,
    flowSource,
    installRoot,
    targets,
    log,
  );
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
        "  i launcher: defaulting to plain — opt into tmux with `flow config launcher tmux`",
      ),
    );
  }
  const summary: SetupSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    blocked: 0,
    removed: 0,
    validationFailures: [],
    missingRuntimeDeps,
  };

  log(`flow: setup`);
  log(`      source ${flowSource}`);

  for (const entry of entries) {
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
    const result = ensureSymlink(
      entry.target,
      liveSource,
      options.force ?? false,
    );
    logResult(entry, result, log);
    summary[bucketFor(result)]++;
  }

  // Reap on EVERY run, not just --upgrade: a module-selection narrowing
  // (re-running `flow install` with a smaller `--modules` list, or declining
  // a previously-accepted module at the interactive Q&A) must prune the
  // now-deselected symlinks even without --upgrade — "deselecting a module
  // prunes its previously-linked artifacts" per docs/target-architecture.md,
  // not "deselecting AND upgrading". Safe unconditionally: reapOrphans only
  // ever removes a flow-managed symlink no longer present in `entries`; it
  // never touches a non-symlink (user-authored) file at the same target.
  summary.removed = reapOrphans(
    entries,
    options.manifestPath,
    log,
    installRoot,
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
    installRoot,
    ff,
    entries,
    manifestTargetPath,
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
 * Resolves which `SourceEntry[]` this run links, and (when the resolution
 * expressed real user intent) which module-id list to persist.
 *
 * `--all` bypasses module resolution entirely and calls `discoverAll`
 * directly — not `discoverSelected(moduleIds())` — so its byte-parity with
 * today's unconditional install holds by construction, independent of the
 * registry/resolver. It still persists the full id list so a later
 * `--upgrade` run with no flag keeps installing everything (verified
 * set-equal to `discoverAll` by `modules.test.ts`).
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
): Promise<{ entries: SourceEntry[]; persistIds: string[] | undefined }> {
  if (options.all) {
    return {
      entries: discoverAll(flowSource, installRoot, targets),
      persistIds: moduleIds(),
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
 * Removes `target` iff it is a symlink whose resolved target lives under one
 * of `flowRoots` (flow-owned by construction). Returns true if removed. A
 * symlink pointing outside the flow tree — a user's own — is preserved; a
 * non-symlink is left to the `readlinkSync` failure path.
 */
function removeIfFlowOwnedSymlink(
  target: string,
  flowRoots: string[],
): boolean {
  let link: string;
  try {
    link = fs.readlinkSync(target);
  } catch {
    return false; // not a symlink / unreadable
  }
  const raw = path.resolve(path.dirname(target), link);
  let resolved = raw;
  try {
    resolved = fs.realpathSync(raw);
  } catch {
    // Dangling link — keep `raw` for the ownership check below.
  }
  const owned = flowRoots.some(
    (root) => isPathUnder(resolved, root) || isPathUnder(raw, root),
  );
  if (!owned) return false;
  try {
    fs.unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

/** True when `child` is `parent` itself or nested beneath it. */
function isPathUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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
  switch (result) {
    case "created":
      log(dim(`  + ${label}`));
      break;
    case "updated":
      log(dim(`  ~ ${label}  (relinked)`));
      break;
    case "exists":
      // Quiet on idempotent runs — chatty output drowns the real signal.
      break;
    case "blocked":
      log(
        red(
          `  ! ${label}  (blocked — non-symlink at target; use --force to replace)`,
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
  installRoot: string,
  ff: FastForwardResult | undefined,
  entries: SourceEntry[],
  manifestPath: string,
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
  // idempotent run keeps to the one-line outcome above (Story 6).
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

function printModuleBreakdown(
  entries: SourceEntry[],
  log: (msg: string) => void,
): void {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const moduleId = moduleForArtifactName(e.displayName);
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
