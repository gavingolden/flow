/**
 * Tests for `flow install`. Each test stands up a fake flow-source tree and
 * a fake install-target tree in tmpdir, runs setup against them, and
 * asserts the resulting symlinks + manifest. Real ~/.claude/ is never
 * touched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { runSetup, validateJsonFiles } from "./setup";
import { runSetupCli } from "./setup-args";
import { readManifest, writeManifest } from "./manifest";
import type { FlowRootInfo } from "./worktree-source";
import { LockTimeoutError } from "./lock";
import { removeIfManagedSymlink } from "./symlink";
import { countStopHook } from "./settings-merge";
import { resolveFlowSource } from "./paths";
import { moduleIds } from "./modules";
import {
  discoverAgents,
  discoverAll,
  discoverHelpers,
  discoverSelected,
  discoverValidators,
  effectiveLinkSource,
  rebaseOntoInstallRoot,
} from "./sources";

let scratch!: string;
let flowSource!: string;
let homeDir!: string;
let manifestPath!: string;
let lockPath!: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-setup-"));
  flowSource = path.join(scratch, "flow-src");
  homeDir = path.join(scratch, "home");
  manifestPath = path.join(homeDir, ".flow", "installed.json");
  lockPath = path.join(homeDir, ".flow", "setup.lock");
  buildFakeFlowSource(flowSource);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function targets() {
  return {
    skillsDir: path.join(homeDir, ".claude", "skills"),
    agentsDir: path.join(homeDir, ".claude", "agents"),
    binDir: path.join(homeDir, ".local", "bin"),
    completionsDir: path.join(homeDir, ".flow", "completions"),
  };
}

function settingsPath(): string {
  return path.join(homeDir, ".claude", "settings.json");
}

function setup(
  opts: {
    upgrade?: boolean;
    force?: boolean;
    lockTimeoutMs?: number;
    noCompletions?: boolean;
    noHooks?: boolean;
    repairSettings?: boolean;
    flowSourceOverride?: string;
    installRootOverride?: string;
    installDeps?: boolean;
    installRunner?: (root: string) => { ok: boolean; stderr?: string };
    cachePath?: string;
    modules?: string[];
    all?: boolean;
    confirm?: (prompt: string) => boolean;
    isTTY?: boolean;
    configPath?: string;
  } = {},
) {
  const { flowSourceOverride, installRootOverride, ...rest } = opts;
  // installRoot defaults to flowSource so the existing test fixtures
  // (which only override flowSource) keep recording fixture-rooted paths
  // in the manifest. Tests that exercise the worktree → install-root
  // divergence pass `flowSourceOverride` to drive flowSource away from
  // the canonical install-root fixture.
  return runSetup({
    // Default the update-check cache into the tmpdir home so the ~19
    // upgrade:true invocations invalidate a fixture-local cache instead of
    // the developer's / CI runner's real ~/.flow/update-check.json. Placed
    // before ...rest so an explicit opts.cachePath (arriving via ...rest)
    // still overrides it.
    cachePath: path.join(homeDir, ".flow", "update-check.json"),
    // Every test in this file builds `flowSource` from `buildFakeFlowSource`
    // (fictional names like "alpha"/"beta" that don't appear in the real
    // module registry), so `all: true` — bypassing module resolution
    // entirely via `discoverAll` — is what preserves this whole file's
    // pre-module-registry unconditional-install behavior. `isTTY: false` +
    // a fixture-local `configPath` are the accompanying safety net: even
    // under `all: true` the resolved selection is persisted, and without
    // these overrides that write (and, on a hypothetical future code path,
    // a `confirm()` read) would land on the real ~/.flow/config.json / a
    // real stdin prompt. Module-selection behavior itself is exercised in
    // the dedicated "module selection" describe block below via direct
    // `runSetup` calls against the real flow-source tree.
    all: true,
    isTTY: false,
    configPath: path.join(homeDir, ".flow", "config.json"),
    ...rest,
    flowSource: flowSourceOverride ?? flowSource,
    installRoot: installRootOverride ?? flowSource,
    targets: targets(),
    skipPreflight: true,
    manifestPath,
    lockPath,
    homeDir,
    settingsPath: settingsPath(),
    quiet: true,
  });
}

describe("flow install", () => {
  it("creates symlinks for every skill, agent, and helper from a fresh state", async () => {
    const summary = await setup();

    expect(summary.created).toBeGreaterThan(0);
    expect(summary.blocked).toBe(0);

    const t = targets();
    expect(fs.lstatSync(path.join(t.skillsDir, "alpha")).isSymbolicLink()).toBe(
      true,
    );
    expect(fs.lstatSync(path.join(t.skillsDir, "beta")).isSymbolicLink()).toBe(
      true,
    );
    expect(
      fs.lstatSync(path.join(t.agentsDir, "reviewer.md")).isSymbolicLink(),
    ).toBe(true);
    expect(
      fs.lstatSync(path.join(t.binDir, "flow-helper")).isSymbolicLink(),
    ).toBe(true);
    expect(fs.lstatSync(path.join(t.binDir, "flow")).isSymbolicLink()).toBe(
      true,
    );
  });

  it("strips the .ts extension when symlinking helpers", async () => {
    await setup();
    const t = targets();
    expect(fs.existsSync(path.join(t.binDir, "flow-helper"))).toBe(true);
    expect(fs.existsSync(path.join(t.binDir, "flow-helper.ts"))).toBe(false);
  });

  it("excludes test files from helper discovery", async () => {
    await setup();
    const t = targets();
    expect(fs.existsSync(path.join(t.binDir, "flow-helper.test"))).toBe(false);
  });

  it("discovers flow-annotate-pr and flow-fetch-intent-comments helpers", () => {
    // Regression guard: discoverHelpers should auto-pick up every *.ts file
    // under bin/ (excluding tests + the flow wrapper). Run against the real
    // repo's bin/ directory rather than the synthetic fixture so this test
    // fires if a future refactor breaks discovery for the new helpers.
    const repoRoot = path.resolve(__dirname, "..", "..");
    const helpers = discoverHelpers(repoRoot);
    const names = helpers.map((h) => h.displayName);
    expect(names).toContain("flow-annotate-pr");
    expect(names).toContain("flow-fetch-intent-comments");
    // Maintainer-only: flow-release exists under bin/ but must never ship to a
    // user's PATH (tree-mutating + tag-creating). Other helpers stay present.
    expect(names).not.toContain("flow-release");
    expect(names).toContain("flow-new-worktree");
  });

  it("discovers the flow-verify and flow-fix-applier agent definitions", () => {
    // Regression guard: discoverAgents ships every agents/*.md file as a
    // kind: "agent" SourceEntry symlinked into ~/.claude/agents. Run against
    // the real repo's agents/ directory (not the synthetic fixture) so this
    // fires if a future refactor breaks discovery for the two low-effort
    // agent definitions that pin the mechanical fan-outs.
    const repoRoot = path.resolve(__dirname, "..", "..");
    const agents = discoverAgents(repoRoot);
    const names = agents.map((a) => a.displayName);
    expect(names).toContain("flow-verify.md");
    expect(names).toContain("flow-fix-applier.md");
    for (const a of agents) {
      expect(a.kind).toBe("agent");
    }
  });

  it("discovers the four schema validators via the discoverValidators allowlist", () => {
    // Regression guard: discoverValidators ships exactly the four validators
    // named in the VALIDATOR_MODULES allowlist — pr-review-result-schema,
    // agent-finding-schema, fix-applier-schema, and epic-manifest-schema —
    // sourced from bin/lib/ with a `flow-` install target prefix. It must NOT
    // pick up coder-schema (not on the allowlist) or any `*-schema.test.ts`
    // file. Run against the real repo's bin/lib/ rather than the synthetic
    // fixture so this test fires if a future refactor regresses the allowlist
    // or the naming.
    const repoRoot = path.resolve(__dirname, "..", "..");
    const validators = discoverValidators(repoRoot);
    expect(validators).toHaveLength(4);
    const names = validators.map((v) => path.basename(v.target)).sort();
    expect(names).toEqual([
      "flow-agent-finding-schema",
      "flow-epic-manifest-schema",
      "flow-fix-applier-schema",
      "flow-pr-review-result-schema",
    ]);
    for (const entry of validators) {
      expect(entry.kind).toBe("bin");
      expect(entry.source.includes(path.join("bin", "lib"))).toBe(true);
    }
    expect(names).not.toContain("flow-coder-schema");
    expect(names.some((n) => n.endsWith(".test"))).toBe(false);
  });

  it("discoverValidators drops an allowlisted module whose file is physically absent", () => {
    // The repo-root test above only exercises the all-files-present case, so
    // the `.filter(existsSync)` call is never observed dropping anything — a
    // refactor deleting that filter would still pass. This points
    // discoverValidators at a fixture bin/lib/ containing only ONE of the two
    // allowlisted modules and asserts the filter drops the absent one.
    fs.rmSync(path.join(flowSource, "bin", "lib", "agent-finding-schema.ts"));
    const validators = discoverValidators(flowSource, targets());
    expect(validators).toHaveLength(1);
    expect(path.basename(validators[0].target)).toBe(
      "flow-pr-review-result-schema",
    );
  });

  it("discoverValidators returns [] when bin/lib is absent", () => {
    // Covers the `if (!existsDir(libDir)) return []` early-return branch —
    // otherwise unasserted, since every fixture builds bin/lib/.
    fs.rmSync(path.join(flowSource, "bin", "lib"), { recursive: true });
    expect(discoverValidators(flowSource, targets())).toEqual([]);
  });

  it("writes a manifest recording every symlink it created", async () => {
    await setup();
    const manifest = readManifest(manifestPath);
    const targets_ = manifest.symlinks.map((s) => path.basename(s.target));
    expect(targets_).toContain("alpha");
    expect(targets_).toContain("reviewer.md");
    expect(targets_).toContain("flow-helper");
    expect(targets_).toContain("flow");
    // End-to-end integration of discoverValidators through runSetup: the two
    // allowlisted validators flow into the manifest as `flow-`-prefixed bin
    // entries, and the non-allowlisted bin/lib/ module does not. This is the
    // automated counterpart to the PR's manual `grep ~/.flow/installed.json`
    // Test Step — it asserts the validators actually resolve on PATH.
    expect(targets_).toContain("flow-pr-review-result-schema");
    expect(targets_).toContain("flow-agent-finding-schema");
    expect(targets_).not.toContain("flow-foo-schema");
  });

  it("is idempotent: a second run produces only 'exists' results", async () => {
    await setup();
    const second = await setup();
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
  });

  it("blocks non-symlink files at the target without --force", async () => {
    const t = targets();
    fs.mkdirSync(t.skillsDir, { recursive: true });
    // Pretend the user has authored their own 'alpha' skill at the target.
    fs.writeFileSync(path.join(t.skillsDir, "alpha"), "user content");
    const summary = await setup();
    expect(summary.blocked).toBeGreaterThan(0);
    // Real file untouched.
    expect(fs.readFileSync(path.join(t.skillsDir, "alpha"), "utf8")).toBe(
      "user content",
    );
  });

  it("--force replaces a non-symlink file at the target", async () => {
    const t = targets();
    fs.mkdirSync(t.binDir, { recursive: true });
    fs.writeFileSync(path.join(t.binDir, "flow-helper"), "old content");
    const summary = await setup({ force: true });
    expect(summary.blocked).toBe(0);
    expect(
      fs.lstatSync(path.join(t.binDir, "flow-helper")).isSymbolicLink(),
    ).toBe(true);
  });

  it("--upgrade reaps orphan symlinks recorded in a previous manifest", async () => {
    // First install — alpha + beta exist.
    await setup();
    const t = targets();

    // Drop alpha from the source tree.
    fs.rmSync(path.join(flowSource, "skills", "pipeline", "alpha"), {
      recursive: true,
    });

    // Re-run with --upgrade.
    const summary = await setup({ upgrade: true });
    expect(summary.removed).toBe(1);
    expect(fs.existsSync(path.join(t.skillsDir, "alpha"))).toBe(false);
    expect(fs.existsSync(path.join(t.skillsDir, "beta"))).toBe(true);
  });

  it("acquires the setup lock and releases it on success", async () => {
    await setup();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("times out instead of stomping when another live process holds the setup lock", async () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(process.pid));
    await expect(setup({ lockTimeoutMs: 200 })).rejects.toThrow(
      LockTimeoutError,
    );
    fs.unlinkSync(lockPath);
  });

  it("reclaims a stale setup lock left by a dead process", async () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(pickDeadPid()));
    const summary = await setup({ lockTimeoutMs: 1000 });
    expect(summary.created).toBeGreaterThan(0);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  describe("shell rc-file completions", () => {
    function rcPath(name: string): string {
      return path.join(homeDir, name);
    }

    function seedRc(name: string, contents: string): void {
      fs.mkdirSync(homeDir, { recursive: true });
      fs.writeFileSync(rcPath(name), contents);
    }

    it("symlinks completion scripts into ~/.flow/completions/", async () => {
      await setup();
      const completionsDir = targets().completionsDir;
      expect(
        fs.lstatSync(path.join(completionsDir, "flow.bash")).isSymbolicLink(),
      ).toBe(true);
      expect(
        fs.lstatSync(path.join(completionsDir, "flow.zsh")).isSymbolicLink(),
      ).toBe(true);
    });

    it("records completion symlinks in the manifest with kind 'completion'", async () => {
      await setup();
      const manifest = readManifest(manifestPath);
      const completionEntries = manifest.symlinks.filter(
        (s) => s.kind === "completion",
      );
      expect(
        completionEntries.map((s) => path.basename(s.target)).sort(),
      ).toEqual(["flow.bash", "flow.zsh"]);
    });

    it("inserts the managed block into ~/.zshrc when it exists", async () => {
      seedRc(".zshrc", "alias ll='ls -la'\n");
      await setup();
      const after = fs.readFileSync(rcPath(".zshrc"), "utf8");
      expect(after).toContain("# managed by flow completions");
      expect(after).toContain("flow.zsh");
      expect(after).toContain("# end flow completions");
      // Original content preserved.
      expect(after).toContain("alias ll='ls -la'");
    });

    it("inserts the managed block into ~/.bashrc when it exists", async () => {
      seedRc(".bashrc", "export EDITOR=vim\n");
      await setup();
      const after = fs.readFileSync(rcPath(".bashrc"), "utf8");
      expect(after).toContain("# managed by flow completions");
      expect(after).toContain("flow.bash");
    });

    it("inserts the managed block into ~/.bash_profile when it exists", async () => {
      seedRc(".bash_profile", "# bash login config\n");
      await setup();
      const after = fs.readFileSync(rcPath(".bash_profile"), "utf8");
      expect(after).toContain("# managed by flow completions");
      expect(after).toContain("flow.bash");
    });

    it("does not create rc files that don't already exist", async () => {
      await setup();
      expect(fs.existsSync(rcPath(".zshrc"))).toBe(false);
      expect(fs.existsSync(rcPath(".bashrc"))).toBe(false);
      expect(fs.existsSync(rcPath(".bash_profile"))).toBe(false);
    });

    it("is idempotent: a second run leaves rc files byte-identical to the first", async () => {
      seedRc(".zshrc", "alias ll='ls -la'\n");
      await setup();
      const afterFirst = fs.readFileSync(rcPath(".zshrc"), "utf8");
      await setup();
      const afterSecond = fs.readFileSync(rcPath(".zshrc"), "utf8");
      expect(afterSecond).toBe(afterFirst);
    });

    it("--no-completions on a fresh run does not edit any rc file", async () => {
      seedRc(".zshrc", "alias ll='ls -la'\n");
      const before = fs.readFileSync(rcPath(".zshrc"), "utf8");
      await setup({ noCompletions: true });
      const after = fs.readFileSync(rcPath(".zshrc"), "utf8");
      expect(after).toBe(before);
    });

    it("--no-completions on a system that already has the block removes it cleanly", async () => {
      const original = "alias ll='ls -la'\nexport EDITOR=vim\n";
      seedRc(".zshrc", original);
      await setup();
      // Block is present after first run.
      expect(fs.readFileSync(rcPath(".zshrc"), "utf8")).toContain(
        "# managed by flow completions",
      );
      // Run again with --no-completions; rc returns to pre-install state.
      await setup({ noCompletions: true });
      expect(fs.readFileSync(rcPath(".zshrc"), "utf8")).toBe(original);
    });

    it("--upgrade reaps an orphaned completion symlink when source is gone", async () => {
      await setup();
      const completionsDir = targets().completionsDir;
      // Remove the bash script from the source — its target should be reaped.
      fs.rmSync(path.join(flowSource, "completions", "flow.bash"));
      const summary = await setup({ upgrade: true });
      expect(summary.removed).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(path.join(completionsDir, "flow.bash"))).toBe(false);
      // Zsh script still installed.
      expect(fs.existsSync(path.join(completionsDir, "flow.zsh"))).toBe(true);
    });
  });

  it("--upgrade refuses to delete an unmanaged symlink (points outside flow source)", async () => {
    await setup();
    const t = targets();

    // Manually replace alpha with a symlink to /tmp (not under flow source).
    const userTarget = fs.mkdtempSync(path.join(os.tmpdir(), "user-"));
    fs.unlinkSync(path.join(t.skillsDir, "alpha"));
    fs.symlinkSync(userTarget, path.join(t.skillsDir, "alpha"));

    // Drop alpha from the source so it would otherwise be an orphan.
    fs.rmSync(path.join(flowSource, "skills", "pipeline", "alpha"), {
      recursive: true,
    });

    const summary = await setup({ upgrade: true });
    expect(summary.removed).toBe(0); // refused — replacement still resolves
    expect(fs.existsSync(path.join(t.skillsDir, "alpha"))).toBe(true);

    fs.rmSync(userTarget, { recursive: true, force: true });
  });

  it("--upgrade reaps a dangling user-replaced symlink at our managed target", async () => {
    // Documents the relaxed-reaper's deliberate aggressive behavior: when an
    // on-disk symlink at a target we recorded in the manifest no longer
    // resolves to *anything* on disk, it gets reaped — regardless of whether
    // the dangling pointer was something we wrote or something the user
    // replaced ours with. The user-replacement-still-resolves case is
    // preserved by the test above.
    await setup();
    const t = targets();

    // User replaces our `alpha` symlink with their own pointing somewhere else.
    const userTarget = fs.mkdtempSync(path.join(os.tmpdir(), "user-"));
    fs.unlinkSync(path.join(t.skillsDir, "alpha"));
    fs.symlinkSync(userTarget, path.join(t.skillsDir, "alpha"));

    // Drop alpha from the source so it qualifies as an orphan in the manifest.
    fs.rmSync(path.join(flowSource, "skills", "pipeline", "alpha"), {
      recursive: true,
    });
    // And remove the user's replacement target so the symlink is dangling.
    fs.rmSync(userTarget, { recursive: true, force: true });

    const summary = await setup({ upgrade: true });
    expect(summary.removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(t.skillsDir, "alpha"))).toBe(false);
  });

  describe("Stop hook merge into Claude Code settings.json", () => {
    function readSettings(): unknown {
      return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    }

    function countFlowStopEntries(): number {
      const settings = readSettings() as {
        hooks?: { Stop?: Array<{ hooks?: Array<{ command?: string }> }> };
      };
      let n = 0;
      for (const matcher of settings.hooks?.Stop ?? []) {
        for (const h of matcher.hooks ?? []) {
          if (h.command === "flow-stop-guard") n++;
        }
      }
      return n;
    }

    function countFlowSessionStartEntries(): number {
      const settings = readSettings() as {
        hooks?: {
          SessionStart?: Array<{
            matcher?: string;
            hooks?: Array<{ command?: string }>;
          }>;
        };
      };
      let n = 0;
      for (const matcher of settings.hooks?.SessionStart ?? []) {
        for (const h of matcher.hooks ?? []) {
          if (h.command === "flow-session-start-hook") n++;
        }
      }
      return n;
    }

    it("registers the Stop hook entry on a fresh setup", async () => {
      await setup();
      expect(countFlowStopEntries()).toBe(1);
    });

    it("registers the SessionStart:clear hook on a fresh setup, absent under --no-hooks", async () => {
      await setup();
      expect(countFlowSessionStartEntries()).toBe(1);
      const settings = readSettings() as {
        hooks?: { SessionStart?: Array<{ matcher?: string }> };
      };
      expect(settings.hooks?.SessionStart?.[0]?.matcher).toBe("clear");

      // --no-hooks never touches settings.json (asserted here fresh: the
      // afterEach tears the whole home dir down, so a separate run has no file).
      fs.rmSync(settingsPath(), { force: true });
      await setup({ noHooks: true });
      expect(fs.existsSync(settingsPath())).toBe(false);
    });

    it("preserves user-authored Stop hook entries when registering", async () => {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
      fs.writeFileSync(
        settingsPath(),
        JSON.stringify({
          theme: "dark",
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: "command", command: "/usr/local/bin/user-tool.sh" },
                ],
              },
            ],
          },
        }),
      );
      await setup();
      const got = readSettings() as {
        theme: string;
        hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
      };
      expect(got.theme).toBe("dark");
      expect(got.hooks.Stop).toHaveLength(2);
      expect(got.hooks.Stop[0].hooks[0].command).toBe(
        "/usr/local/bin/user-tool.sh",
      );
      expect(got.hooks.Stop[1].hooks[0].command).toBe("flow-stop-guard");
    });

    it("is idempotent: re-running setup does not duplicate the entry", async () => {
      await setup();
      await setup();
      await setup();
      expect(countFlowStopEntries()).toBe(1);
    });

    it("--no-hooks skips the merge entirely", async () => {
      await setup({ noHooks: true });
      expect(fs.existsSync(settingsPath())).toBe(false);
    });

    it("--no-hooks does not flag a pre-existing malformed settings.json as a validation failure", async () => {
      // Regression: when the user passes --no-hooks, flow never touched
      // settings.json this run. A malformed file there is a pre-existing
      // condition, not a flow-induced regression — it must not block exit.
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
      fs.writeFileSync(settingsPath(), "{not valid json");
      const summary = await setup({ noHooks: true });
      expect(summary.validationFailures).toEqual([]);
      // Malformed content survives — flow opted out of touching it.
      expect(fs.readFileSync(settingsPath(), "utf8")).toBe("{not valid json");
    });

    describe("--repair-settings recovery", () => {
      it("repairs a malformed regular settings.json and registers the hook", async () => {
        // End-to-end: seed a malformed file, run setup with repairSettings,
        // assert the file is now valid JSON with the hook installed and a
        // timestamped backup landed next to the realpath target.
        const settingsP = settingsPath();
        fs.mkdirSync(path.dirname(settingsP), { recursive: true });
        const seed = '{"theme":"dar';
        fs.writeFileSync(settingsP, seed);

        const summary = await setup({ repairSettings: true });
        expect(summary.validationFailures).toEqual([]);

        // File now parses cleanly and contains exactly one flow Stop hook.
        const parsed = JSON.parse(fs.readFileSync(settingsP, "utf8"));
        expect(parsed).toBeDefined();
        expect(countStopHook(settingsP, "flow-stop-guard")).toBe(1);

        // Backup file landed next to the realpath target.
        const dir = path.dirname(fs.realpathSync(settingsP));
        const backups = fs
          .readdirSync(dir)
          .filter((f) => f.startsWith("settings.json.flow-backup-"));
        expect(backups).toHaveLength(1);
        // The backup preserves the original (malformed) seed verbatim.
        expect(fs.readFileSync(path.join(dir, backups[0]), "utf8")).toBe(seed);
      });

      it("emits the `repaired; backup at` log line on a regular file", async () => {
        const settingsP = settingsPath();
        fs.mkdirSync(path.dirname(settingsP), { recursive: true });
        fs.writeFileSync(settingsP, '{"theme":"dar');

        const logSpy = vi
          .spyOn(console, "log")
          .mockImplementation(() => undefined);
        try {
          await runSetup({
            repairSettings: true,
            flowSource,
            installRoot: flowSource,
            targets: targets(),
            skipPreflight: true,
            manifestPath,
            lockPath,
            homeDir,
            settingsPath: settingsP,
            all: true,
            isTTY: false,
            configPath: path.join(homeDir, ".flow", "config.json"),
          });
          const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
          expect(allLogs).toMatch(/repaired; backup at/);
        } finally {
          logSpy.mockRestore();
        }
      });

      it("repairs a malformed file behind a symlink and preserves the symlink", async () => {
        // Dotfiles-style layout: settings.json is a symlink. The repair
        // must target the realpath (so the symlink survives) and log the
        // `(followed symlink to ...)` line.
        //
        // The realDir lives UNDER `homeDir` so the containment guard
        // accepts the symlink target (a real dotfiles setup would have the
        // managed target somewhere like `~/.dotfiles/...`, also under home).
        // The negative-path symlink-escape test lives in settings-merge.test.ts
        // — exercising it from this layer would just duplicate coverage.
        const settingsP = settingsPath();
        fs.mkdirSync(homeDir, { recursive: true });
        const realDir = fs.mkdtempSync(path.join(homeDir, ".dotfiles-"));
        try {
          const target = path.join(realDir, "real-settings.json");
          const seed = '{"theme":"dar';
          fs.writeFileSync(target, seed);
          fs.mkdirSync(path.dirname(settingsP), { recursive: true });
          fs.symlinkSync(target, settingsP);

          const logSpy = vi
            .spyOn(console, "log")
            .mockImplementation(() => undefined);
          try {
            const summary = await runSetup({
              repairSettings: true,
              flowSource,
              installRoot: flowSource,
              targets: targets(),
              skipPreflight: true,
              manifestPath,
              lockPath,
              homeDir,
              settingsPath: settingsP,
              all: true,
              isTTY: false,
              configPath: path.join(homeDir, ".flow", "config.json"),
            });
            expect(summary.validationFailures).toEqual([]);
            // Symlink survives the rewrite.
            expect(fs.lstatSync(settingsP).isSymbolicLink()).toBe(true);
            // Target file now parses and carries the hook.
            const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
            expect(parsed).toBeDefined();
            expect(countStopHook(settingsP, "flow-stop-guard")).toBe(1);
            const allLogs = logSpy.mock.calls
              .map((c) => String(c[0]))
              .join("\n");
            expect(allLogs).toMatch(/followed symlink to/);
          } finally {
            logSpy.mockRestore();
          }
        } finally {
          fs.rmSync(realDir, { recursive: true, force: true });
        }
      });
    });
  });

  describe("validateJsonFiles (pure helper)", () => {
    let helperDir!: string;

    beforeEach(() => {
      helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-validate-"));
    });

    afterEach(() => {
      fs.rmSync(helperDir, { recursive: true, force: true });
    });

    it("returns empty for parseable files", () => {
      const a = path.join(helperDir, "a.json");
      const b = path.join(helperDir, "b.json");
      fs.writeFileSync(a, '{"k":1}');
      fs.writeFileSync(b, "[]");
      const result = validateJsonFiles([a, b]);
      expect(result.failures).toEqual([]);
      expect(result.errors.size).toBe(0);
    });

    it("returns the path and error for a malformed file", () => {
      const bad = path.join(helperDir, "bad.json");
      fs.writeFileSync(bad, "{not valid json");
      const result = validateJsonFiles([bad]);
      expect(result.failures).toEqual([bad]);
      expect(result.errors.get(bad)).toMatch(/JSON|Unexpected|Unterminated/);
    });

    it("returns empty for missing files (skip-missing semantics)", () => {
      const missing = path.join(helperDir, "does-not-exist.json");
      const result = validateJsonFiles([missing]);
      expect(result.failures).toEqual([]);
      expect(result.errors.size).toBe(0);
    });

    it("returns only the malformed path when given a mix of good, bad, and missing", () => {
      const good = path.join(helperDir, "good.json");
      const bad = path.join(helperDir, "bad.json");
      const missing = path.join(helperDir, "missing.json");
      fs.writeFileSync(good, "{}");
      fs.writeFileSync(bad, "{nope");
      const result = validateJsonFiles([good, bad, missing]);
      expect(result.failures).toEqual([bad]);
      expect(result.errors.size).toBe(1);
      expect(result.errors.get(bad)).toBeDefined();
    });
  });

  it("flags a validation failure when a settings.json is corrupted between runs", async () => {
    // Integration counterpart to the validateJsonFiles unit tests: setup
    // runs once cleanly, then the file is corrupted on disk, then the next
    // setup run must surface the validation failure in the summary. (The
    // ensureStopHook safe-bailout preserves the malformed content; the
    // validator then catches it.)
    await setup();
    // First run produced a clean settings.json — corrupt it.
    fs.writeFileSync(settingsPath(), "{not valid json");
    const summary = await setup();
    expect(summary.validationFailures).toContain(settingsPath());
  });

  it("all JSON files written by setup round-trip through JSON.parse", async () => {
    // Catches any future regression that writes malformed JSON through any
    // of bin/'s writers. Walks both ~/.claude and ~/.flow under the fake
    // homeDir; the fixture writes settings.json (under .claude) and
    // installed.json (under .flow), and both must parse cleanly.
    await setup();

    const roots = [path.join(homeDir, ".claude"), path.join(homeDir, ".flow")];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      const entries = fs.readdirSync(root, {
        withFileTypes: true,
        recursive: true,
      });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(".json")) continue;
        const parentPath =
          (entry as { parentPath?: string; path?: string }).parentPath ??
          (entry as { path?: string }).path ??
          root;
        const fullPath = path.join(parentPath, entry.name);
        const content = fs.readFileSync(fullPath, "utf8");
        expect(
          () => JSON.parse(content),
          `expected ${fullPath} to be valid JSON`,
        ).not.toThrow();
      }
    }
  });

  describe("--source <worktree> recording + cleanup", () => {
    it("records install-root paths in the manifest when flowSource diverges from installRoot", async () => {
      // Build a fake worktree alongside the install-root fixture, with one
      // extra skill that only exists in the worktree.
      const worktree = path.join(scratch, "worktree");
      buildFakeFlowSource(worktree);
      fs.mkdirSync(path.join(worktree, "skills", "pipeline", "epsilon"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(worktree, "skills", "pipeline", "epsilon", "SKILL.md"),
        "# epsilon\n",
      );

      await setup({ flowSourceOverride: worktree });

      const manifest = readManifest(manifestPath);
      // Every recorded source path must live under the install-root fixture,
      // never under the worktree — even for the new `epsilon` skill that
      // only physically exists in the worktree.
      for (const record of manifest.symlinks) {
        expect(record.source.startsWith(flowSource)).toBe(true);
        expect(record.source.startsWith(worktree)).toBe(false);
      }
      // Spot-check that epsilon got recorded under install-root.
      const epsilon = manifest.symlinks.find(
        (s) => path.basename(s.target) === "epsilon",
      );
      expect(epsilon?.source).toBe(
        path.join(flowSource, "skills", "pipeline", "epsilon"),
      );
    });

    it("symlinks still point at the worktree's content during the in-flight session", async () => {
      // The recording change must not break step-5.5's purpose: in-flight
      // worktree files have to be reachable through the install target.
      const worktree = path.join(scratch, "worktree");
      buildFakeFlowSource(worktree);
      fs.mkdirSync(path.join(worktree, "skills", "pipeline", "epsilon"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(worktree, "skills", "pipeline", "epsilon", "SKILL.md"),
        "# epsilon\n",
      );

      await setup({ flowSourceOverride: worktree });

      const t = targets();
      // realpath on both sides — ensureSymlink writes realpath'd targets, and
      // /var → /private/var canonicalization on macOS would otherwise yield a
      // string mismatch.
      expect(fs.realpathSync(path.join(t.skillsDir, "epsilon"))).toBe(
        fs.realpathSync(path.join(worktree, "skills", "pipeline", "epsilon")),
      );
    });

    it("the production CLI path keeps installRoot canonical and the wrapper anchored when --source overrides flowSource", async () => {
      // Regression: prior to the fix, runSetup's `installRoot` fell back
      // through `resolveFlowSource()` whenever the CLI didn't pass it
      // explicitly. Running from inside a worktree (or after a previous
      // `--source` poisoned `~/.local/bin/flow`) collapsed `installRoot`
      // onto the worktree, so `canonicalizeRecordedSource` short-circuited
      // and the manifest stamped worktree-rooted paths. The wrapper itself
      // was also anchored to `flowSource`, dangling on worktree removal.
      //
      // This test drives setup through `runSetupCli` (the production path)
      // with a fake `<homeDir>/.flow/config.json` controlling
      // `resolveFlowSource()`'s output. `installRoot` must be captured at
      // the CLI seam — not re-derived after the override applies — and the
      // wrapper symlink must resolve to the install-root fixture, not the
      // worktree.
      const worktree = path.join(scratch, "worktree");
      buildFakeFlowSource(worktree);
      fs.mkdirSync(path.join(worktree, "skills", "pipeline", "epsilon"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(worktree, "skills", "pipeline", "epsilon", "SKILL.md"),
        "# epsilon\n",
      );

      // Stand up `~/.flow/config.json` in the fake home so the production
      // `resolveFlowSource(homeDir)` returns the install-root fixture.
      fs.mkdirSync(path.join(homeDir, ".flow"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".flow", "config.json"),
        JSON.stringify({ source: flowSource }),
      );

      // Drive via `runSetupCli`. Crucially we pass NO `installRoot` —
      // the CLI seam must compute it from `resolveFlowSource(homeDir)`.
      const code = await runSetupCli(["--source", worktree], {
        targets: targets(),
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
        quiet: true,
        all: true,
        isTTY: false,
        configPath: path.join(homeDir, ".flow", "config.json"),
      });
      expect(code).toBe(0);

      // Manifest records install-root paths only.
      const manifest = readManifest(manifestPath);
      for (const record of manifest.symlinks) {
        expect(record.source.startsWith(flowSource)).toBe(true);
        expect(record.source.startsWith(worktree)).toBe(false);
      }

      // The wrapper symlink at ~/.local/bin/flow resolves to the
      // install-root fixture's bin/flow — not the worktree's.
      const t = targets();
      const wrapperLink = path.join(t.binDir, "flow");
      expect(fs.realpathSync(wrapperLink)).toBe(
        fs.realpathSync(path.join(flowSource, "bin", "flow")),
      );

      // Sanity: in-flight content (epsilon) still resolves to the worktree
      // — the fix must not break step 5.5's purpose.
      expect(fs.realpathSync(path.join(t.skillsDir, "epsilon"))).toBe(
        fs.realpathSync(path.join(worktree, "skills", "pipeline", "epsilon")),
      );
    });

    it("reaps dangling symlinks left behind when a prior --source <worktree> worktree is gone", async () => {
      // (a) Build a worktree with one helper that doesn't exist in the
      // install-root fixture — the realistic "PR adds a new skill/helper"
      // scenario.
      const worktree = path.join(scratch, "worktree");
      buildFakeFlowSource(worktree);
      fs.writeFileSync(
        path.join(worktree, "bin", "flow-pipeline-only.ts"),
        "#!/usr/bin/env bun\n// only in worktree\n",
      );

      // (b) Simulate the supervisor's step-5.5: setup --upgrade --source $WORKTREE.
      await setup({ flowSourceOverride: worktree, upgrade: true });
      const t = targets();
      // The new helper symlink exists and resolves to the worktree file.
      const link = path.join(t.binDir, "flow-pipeline-only");
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(link)).toBe(
        fs.realpathSync(path.join(worktree, "bin", "flow-pipeline-only.ts")),
      );
      // And the manifest recorded the install-root path (not the worktree path).
      const manifestBefore = readManifest(manifestPath);
      const recordBefore = manifestBefore.symlinks.find(
        (s) => path.basename(s.target) === "flow-pipeline-only",
      );
      expect(recordBefore?.source).toBe(
        path.join(flowSource, "bin", "flow-pipeline-only.ts"),
      );

      // (c) Simulate `flow-remove-worktree` — the worktree directory is gone.
      fs.rmSync(worktree, { recursive: true, force: true });

      // (d) Re-run setup --upgrade from the install-root fixture (no --source).
      // The install-root has no `flow-pipeline-only.ts` (the PR was never
      // merged), so the manifest's stale entry is an orphan and the on-disk
      // symlink is dangling.
      const summary = await setup({ upgrade: true });

      // (e) The orphan got reaped despite the dangling pointer landing
      // outside flowSource (the worktree path) — that's the relaxed-reaper fix.
      expect(summary.removed).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(link)).toBe(false);
      const manifestAfter = readManifest(manifestPath);
      expect(
        manifestAfter.symlinks.some(
          (s) => path.basename(s.target) === "flow-pipeline-only",
        ),
      ).toBe(false);
    });

    it("points live symlinks for content present in canonical at the install-root, not the worktree (Story 1)", async () => {
      // A shared helper + skill exist in BOTH the worktree and the
      // install-root fixture (buildFakeFlowSource builds identical trees).
      // Their live symlinks must resolve under installRoot so they survive
      // the worktree's post-merge removal — no re-pointing churn onto the
      // worktree.
      const worktree = path.join(scratch, "worktree");
      buildFakeFlowSource(worktree);

      await setup({ flowSourceOverride: worktree, upgrade: true });

      const t = targets();
      // realpath both sides — /var → /private/var on macOS would otherwise
      // yield a spurious string mismatch.
      expect(fs.realpathSync(path.join(t.binDir, "flow-helper"))).toBe(
        fs.realpathSync(path.join(flowSource, "bin", "flow-helper.ts")),
      );
      expect(fs.realpathSync(path.join(t.skillsDir, "alpha"))).toBe(
        fs.realpathSync(path.join(flowSource, "skills", "pipeline", "alpha")),
      );
      // Neither link resolves into the worktree.
      expect(
        fs
          .realpathSync(path.join(t.binDir, "flow-helper"))
          .startsWith(worktree),
      ).toBe(false);
    });

    it("keeps a genuinely worktree-only helper pointed at the worktree so it is usable during the pipeline (Story 2)", async () => {
      const worktree = path.join(scratch, "worktree");
      buildFakeFlowSource(worktree);
      fs.writeFileSync(
        path.join(worktree, "bin", "flow-pipeline-only.ts"),
        "#!/usr/bin/env bun\n// only in worktree\n",
      );

      await setup({ flowSourceOverride: worktree, upgrade: true });

      const t = targets();
      const link = path.join(t.binDir, "flow-pipeline-only");
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(link)).toBe(
        fs.realpathSync(path.join(worktree, "bin", "flow-pipeline-only.ts")),
      );
    });

    it("keeps the flow wrapper anchored to install-root under a --source install (Story 3)", async () => {
      const worktree = path.join(scratch, "worktree");
      buildFakeFlowSource(worktree);

      await setup({ flowSourceOverride: worktree, upgrade: true });

      const t = targets();
      expect(fs.realpathSync(path.join(t.binDir, "flow"))).toBe(
        fs.realpathSync(path.join(flowSource, "bin", "flow")),
      );
    });

    it("re-links an existing helper to canonical while reaping a never-merged worktree-only helper after removal (Story 5)", async () => {
      // A worktree that adds a new-only helper on top of the shared tree.
      const worktree = path.join(scratch, "worktree");
      buildFakeFlowSource(worktree);
      fs.writeFileSync(
        path.join(worktree, "bin", "flow-pipeline-only.ts"),
        "#!/usr/bin/env bun\n// only in worktree\n",
      );

      // Step 5.5: --source upgrade. Shared helper points at canonical; the
      // new-only helper points at the worktree.
      await setup({ flowSourceOverride: worktree, upgrade: true });
      const t = targets();
      expect(fs.realpathSync(path.join(t.binDir, "flow-helper"))).toBe(
        fs.realpathSync(path.join(flowSource, "bin", "flow-helper.ts")),
      );

      // flow-remove-worktree: the worktree is gone.
      fs.rmSync(worktree, { recursive: true, force: true });

      // Post-merge canonical upgrade (no --source).
      const summary = await setup({ upgrade: true });

      // The never-merged worktree-only helper is reaped (dangling branch)...
      expect(summary.removed).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(path.join(t.binDir, "flow-pipeline-only"))).toBe(
        false,
      );
      // ...while the shared helper is re-linked to canonical, not reaped.
      expect(
        fs.lstatSync(path.join(t.binDir, "flow-helper")).isSymbolicLink(),
      ).toBe(true);
      expect(fs.realpathSync(path.join(t.binDir, "flow-helper"))).toBe(
        fs.realpathSync(path.join(flowSource, "bin", "flow-helper.ts")),
      );
    });
  });

  describe("canonical-tree-presence backstop (PR #115 race)", () => {
    it("preserves the symlink when the recorded source is in origin/<default>'s tree but absent from the working tree", async () => {
      // Mid-pipeline scenario: a previous --upgrade run installed a symlink
      // pointing at a skill, but the working tree's copy of that skill has
      // been removed by the user before the next reap pass. The backstop
      // must defer the dangling-reap because origin/<default> still has it.
      buildFakeFlowSourceWithGit(
        flowSource,
        /* skillsInTree */ ["alpha", "beta"],
      );

      // Stand up the symlink + manifest entry as if a prior run had installed
      // both alpha and beta.
      const t = targets();
      await setup({ upgrade: true });

      // Now: the user (or the supervisor's race) deletes alpha from the
      // working tree, but it still lives in origin/main's tree.
      fs.rmSync(path.join(flowSource, "skills", "pipeline", "alpha"), {
        recursive: true,
      });

      const linkBefore = path.join(t.skillsDir, "alpha");
      expect(
        fs.existsSync(linkBefore) || fs.lstatSync(linkBefore).isSymbolicLink(),
      ).toBe(true);

      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      try {
        // Re-run with --upgrade. The reap pass would normally fire on the
        // dangling pointer; the backstop should defer because origin/main
        // still contains skills/pipeline/alpha.
        const summary = await setup({ upgrade: true });
        // Symlink survives.
        expect(fs.lstatSync(linkBefore).isSymbolicLink()).toBe(true);
        expect(summary.removed).toBe(0);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("falls through to the legacy reap when the recorded source is in NEITHER origin/<default> nor the working tree", async () => {
      // Symmetric to PR #79: the recorded source is genuinely orphaned
      // (origin/main has no record of it), so the backstop must NOT fire
      // and the legacy dangling-reap must reap it.
      buildFakeFlowSourceWithGit(
        flowSource,
        /* skillsInTree */ ["alpha", "beta"],
      );

      // Install once.
      await setup({ upgrade: true });
      const t = targets();

      // Inject a stale manifest entry for a skill that never existed in
      // origin/main and isn't in the working tree either.
      const manifest = readManifest(manifestPath);
      const orphan = path.join(t.skillsDir, "ghost");
      const orphanSource = path.join(flowSource, "skills", "pipeline", "ghost");
      // Create a dangling symlink at the target.
      fs.symlinkSync(orphanSource, orphan);
      manifest.symlinks.push({
        target: orphan,
        source: orphanSource,
        kind: "skill",
      });
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const summary = await setup({ upgrade: true });
      // Legacy reap fires on ghost.
      expect(summary.removed).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(orphan)).toBe(false);
    });

    it("falls through to the legacy reap when canonicalRoot is not a git repo (no .git directory)", () => {
      // Direct unit test of removeIfManagedSymlink's fail-open path. The
      // canonicalRoot has no .git, so the spawn for `git ls-tree` fails,
      // and the backstop returns false — the legacy reap path fires.
      const t = targets();
      const targetPath = path.join(t.skillsDir, "ghost");
      const sourceDir = path.join(flowSource, "skills", "pipeline", "ghost");
      fs.mkdirSync(t.skillsDir, { recursive: true });
      // Create a dangling symlink (target points at a non-existent source).
      fs.symlinkSync(sourceDir, targetPath);

      // flowSource has no .git — the backstop's spawn fails, fall-through.
      const removed = removeIfManagedSymlink(targetPath, sourceDir, {
        canonicalRoot: flowSource,
        defaultBranch: "main",
      });
      expect(removed).toBe(true);
      expect(fs.existsSync(targetPath)).toBe(false);
    });

    it("e2e --upgrade fast-forwards canonical and the freshly-merged skill survives the reap", async () => {
      // Mirrors the PR #115 race: the supervisor's `flow install --upgrade`
      // (post-merge sweep) advances canonical, then reap runs against the
      // post-merge tree and does NOT consider the new skill orphaned.
      buildFakeFlowSourceWithGit(
        flowSource,
        /* skillsInTree */ ["alpha", "beta"],
      );

      // Simulate the new skill landing on origin/main but not yet merged
      // into the working tree — that's the race window.
      addSkillToOriginMain(flowSource, "epsilon");

      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      try {
        const summary = await setup({ upgrade: true });
        // The fast-forward should have advanced canonical, pulling epsilon
        // into the working tree.
        const epsilonDir = path.join(
          flowSource,
          "skills",
          "pipeline",
          "epsilon",
        );
        expect(fs.existsSync(epsilonDir)).toBe(true);
        // The reap pass must not have fired on the freshly-merged skill.
        expect(summary.removed).toBe(0);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("--no-pull-canonical opts out of the fast-forward (no `git fetch` recorded)", async () => {
      // Direct opt-out check: when the caller passes pullCanonicalFirst:
      // false, the FF call must not run — no fetch, no merge, the canonical
      // line is silent.
      buildFakeFlowSourceWithGit(
        flowSource,
        /* skillsInTree */ ["alpha", "beta"],
      );

      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      try {
        await runSetup({
          upgrade: true,
          pullCanonicalFirst: false,
          // Fixture-local cache so this upgrade:true call doesn't touch the
          // real ~/.flow/update-check.json.
          cachePath: path.join(homeDir, ".flow", "update-check.json"),
          all: true,
          isTTY: false,
          configPath: path.join(homeDir, ".flow", "config.json"),
          flowSource,
          installRoot: flowSource,
          targets: targets(),
          skipPreflight: true,
          manifestPath,
          lockPath,
          homeDir,
          settingsPath: settingsPath(),
          // quiet: false intentionally so the canonical line would surface
        });
        const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(allLogs).not.toMatch(/canonical: (fast-forwarded|skipped)/);
        // No content was fetched/compared, so the headline must NOT claim
        // up-to-date — that would over-claim a check that never ran.
        expect(allLogs).not.toMatch(/already up to date/);
        expect(allLogs).toMatch(/content not checked/);
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe("runtime-dependency resolution check", () => {
    it("sets summary.missingRuntimeDeps and logs the remediation when a runtime dep is absent", async () => {
      // Drop the resolved node_modules entry for one declared dep.
      fs.rmSync(path.join(flowSource, "node_modules", "picomatch"), {
        recursive: true,
        force: true,
      });
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      try {
        const summary = await runSetup({
          flowSource,
          installRoot: flowSource,
          targets: targets(),
          skipPreflight: true,
          manifestPath,
          lockPath,
          homeDir,
          settingsPath: settingsPath(),
          all: true,
          isTTY: false,
          configPath: path.join(homeDir, ".flow", "config.json"),
          // quiet: false so the remediation line surfaces
        });
        expect(summary.missingRuntimeDeps).toEqual(["picomatch"]);
        const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(allLogs).toMatch(/missing runtime dependencies: picomatch/);
        expect(allLogs).toMatch(/npm install/);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("leaves summary.missingRuntimeDeps empty and emits no dep error when all deps resolve", async () => {
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      try {
        const summary = await setup();
        expect(summary.missingRuntimeDeps).toEqual([]);
        const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(allLogs).not.toMatch(/missing runtime dependencies/);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("checks installRoot, not flowSource (Story 5): worktree missing the dep, canonical has it", async () => {
      // flowSource (the --source worktree) lacks the dep; installRoot
      // (canonical) has it. The check must read installRoot and pass.
      const worktree = path.join(scratch, "worktree");
      buildFakeFlowSource(worktree);
      fs.rmSync(path.join(worktree, "node_modules", "picomatch"), {
        recursive: true,
        force: true,
      });
      const summary = await setup({ flowSourceOverride: worktree });
      expect(summary.missingRuntimeDeps).toEqual([]);
    });

    it("installDeps:true invokes the injected installRunner and clears the missing list on success", async () => {
      fs.rmSync(path.join(flowSource, "node_modules", "picomatch"), {
        recursive: true,
        force: true,
      });
      let ran = 0;
      const installRunner = (root: string): { ok: boolean } => {
        ran++;
        // Simulate a successful install by materializing the missing module.
        const dir = path.join(root, "node_modules", "picomatch");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify({ name: "picomatch" }),
        );
        return { ok: true };
      };
      const summary = await setup({ installDeps: true, installRunner });
      expect(ran).toBe(1);
      expect(summary.missingRuntimeDeps).toEqual([]);
    });

    it("installDeps:true with a failing installRunner keeps the dep missing, logs the failure, and exits 1", async () => {
      // The operationally important branch: a real `npm install` failure
      // (offline, registry 503, lockfile conflict) lands here. A failed
      // install must NOT silently turn into a green exit — the re-check
      // leaves missingRuntimeDeps populated and the CLI seam exits 1.
      fs.rmSync(path.join(flowSource, "node_modules", "picomatch"), {
        recursive: true,
        force: true,
      });
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      try {
        const installRunner = (): { ok: boolean; stderr: string } => ({
          ok: false,
          stderr: "boom",
        });
        // Summary seam: the failed install does not clear the missing list.
        const summary = await runSetup({
          flowSource,
          installRoot: flowSource,
          targets: targets(),
          skipPreflight: true,
          manifestPath,
          lockPath,
          homeDir,
          settingsPath: settingsPath(),
          installDeps: true,
          installRunner,
          all: true,
          isTTY: false,
          configPath: path.join(homeDir, ".flow", "config.json"),
          // quiet: false so the failure line surfaces
        });
        expect(summary.missingRuntimeDeps).toEqual(["picomatch"]);
        const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(allLogs).toMatch(/install-deps failed at .*: boom/);
        expect(allLogs).toMatch(/missing runtime dependencies: picomatch/);
      } finally {
        logSpy.mockRestore();
      }

      // Exit-code seam: the same still-missing dep drives runSetupCli to 1.
      const code = await runSetupCli(["--install-deps"], {
        flowSource,
        installRoot: flowSource,
        targets: targets(),
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
        installRunner: () => ({ ok: false, stderr: "boom" }),
        quiet: true,
        all: true,
        isTTY: false,
        configPath: path.join(homeDir, ".flow", "config.json"),
      });
      expect(code).toBe(1);
    });
  });

  describe("version-stamped outcome headline (Stories 1-4, 6)", () => {
    // Capture stdout (quiet:false) so we can assert the composed headline.
    async function setupLogged(
      opts: Parameters<typeof setup>[0] = {},
    ): Promise<{
      summary: Awaited<ReturnType<typeof runSetup>>;
      logs: string[];
    }> {
      const logs: string[] = [];
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation((...args: unknown[]) => {
          logs.push(args.map(String).join(" "));
        });
      try {
        const { flowSourceOverride, installRootOverride, ...rest } = opts;
        const summary = await runSetup({
          // Same fixture-local defaults as setup(): keep upgrade:true callers
          // off the real ~/.flow/update-check.json, and keep every call in
          // this describe block off the real ~/.flow/config.json / a real
          // stdin confirm() prompt (see setup()'s comment for the full
          // rationale).
          cachePath: path.join(homeDir, ".flow", "update-check.json"),
          all: true,
          isTTY: false,
          configPath: path.join(homeDir, ".flow", "config.json"),
          ...rest,
          flowSource: flowSourceOverride ?? flowSource,
          installRoot: installRootOverride ?? flowSource,
          targets: targets(),
          skipPreflight: true,
          manifestPath,
          lockPath,
          homeDir,
          settingsPath: settingsPath(),
          // quiet:false so the outcome headline surfaces
        });
        return { summary, logs };
      } finally {
        logSpy.mockRestore();
      }
    }

    function pinVersion(root: string, version: string): void {
      const pkgPath = path.join(root, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      pkg.version = version;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg));
    }

    /**
     * Pins the version and commits + pushes it so the canonical working tree
     * stays clean (a dirty tree would make the fast-forward skip). Keeps
     * origin and canonical in sync at the bumped version.
     */
    function pinVersionCommitted(root: string, version: string): void {
      pinVersion(root, version);
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      };
      for (const args of [
        ["add", "-A"],
        ["commit", "-m", `bump ${version}`],
        ["push", "origin", "main"],
      ]) {
        spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
      }
    }

    it("Story 1: ahead → version + commit count + before→after SHA", async () => {
      buildFakeFlowSourceWithGit(flowSource, ["alpha", "beta"]);
      pinVersionCommitted(flowSource, "0.0.1");
      addSkillToOriginMain(flowSource, "epsilon");

      const { logs } = await setupLogged({ upgrade: true });
      const joined = logs.join("\n");
      expect(joined).toMatch(/flow updated: v0\.0\.1, 1 commit/);
      // Before→after SHAs are short hex tokens joined by an arrow.
      expect(joined).toMatch(/flow updated:.*[0-9a-f]{7,}.* → .*[0-9a-f]{7,}/);
      // No false "up to date" / "no changes" wording.
      expect(joined).not.toMatch(/up to date/);
      expect(joined).not.toMatch(/no changes/);
    });

    it("Story 4: ahead → changed-list names the changed skill", async () => {
      buildFakeFlowSourceWithGit(flowSource, ["alpha", "beta"]);
      addSkillToOriginMain(flowSource, "epsilon");

      const { logs } = await setupLogged({ upgrade: true });
      const joined = logs.join("\n");
      expect(joined).toMatch(/changed: .*epsilon/);
    });

    it("Story 2: up-to-date → 'already up to date at v<ver>', no list, no throw", async () => {
      buildFakeFlowSourceWithGit(flowSource, ["alpha", "beta"]);
      pinVersionCommitted(flowSource, "0.0.1");
      // No addSkillToOriginMain → canonical is already at origin/main.

      const { logs } = await setupLogged({ upgrade: true });
      const joined = logs.join("\n");
      expect(joined).toMatch(/flow already up to date at v0\.0\.1/);
      expect(joined).not.toMatch(/changed:/);
      expect(joined).not.toMatch(/no changes/);
    });

    it("Story 3: skipped(dirty) → prominent 'NOT refreshed', no false up-to-date", async () => {
      buildFakeFlowSourceWithGit(flowSource, ["alpha", "beta"]);
      // Make the canonical tree dirty so the fast-forward skips.
      fs.writeFileSync(path.join(flowSource, "DIRTY.txt"), "uncommitted\n");

      const { logs } = await setupLogged({ upgrade: true });
      const joined = logs.join("\n");
      expect(joined).toMatch(/NOT refreshed \(dirty\)/);
      expect(joined).not.toMatch(/up to date/);
    });

    it("Story 3: skipped(non-default-branch) → quieter informational caveat", async () => {
      buildFakeFlowSourceWithGit(flowSource, ["alpha", "beta"]);
      // Check out a feature branch so HEAD != default.
      spawnSync("git", ["-C", flowSource, "checkout", "-b", "feature/x"], {
        encoding: "utf8",
      });

      const { logs } = await setupLogged({ upgrade: true });
      const joined = logs.join("\n");
      expect(joined).toMatch(/not refreshed \(on a non-default branch\)/);
      expect(joined).not.toMatch(/NOT refreshed/);
      expect(joined).not.toMatch(/up to date/);
    });

    it("first install (non-upgrade) → 'flow installed v<ver>'", async () => {
      pinVersion(flowSource, "0.0.1");
      const { logs } = await setupLogged();
      expect(logs.join("\n")).toMatch(/flow installed v0\.0\.1/);
    });

    it("Story 6: idempotent zero-churn upgrade emits ≤3 substantive lines plus warnings", async () => {
      buildFakeFlowSourceWithGit(flowSource, ["alpha", "beta"]);
      // First install wires everything; the second --upgrade has no churn.
      await setupLogged({ upgrade: true });
      const { logs } = await setupLogged({ upgrade: true });
      // Drop the start-of-run banner (flow: setup / source ...) — count the
      // outcome + any churn/warning lines.
      const substantive = logs.filter(
        (l) => !/^flow: setup$/.test(l) && !/^ {6}source /.test(l),
      );
      const warnings = substantive.filter((l) => /\s!\s/.test(l));
      const nonWarning = substantive.filter((l) => !/\s!\s/.test(l));
      // Budget raised from 2 to 3 to 4: the grouped by-module summary line
      // (`by module: core N`) is a third always-on line, additive to the
      // up-to-date headline + the "N skipped" symlink-accounting line — it
      // fires regardless of churn. It reports `core` (not 0) even for this
      // fixture's otherwise-fictional artifact names: `buildFakeFlowSource`
      // deliberately names its two `bin/lib/` fixtures after two real
      // `VALIDATOR_MODULES` allowlist entries (pr-review-result-schema.ts /
      // agent-finding-schema.ts) to exercise the allowlist-filter behavior,
      // and those two names are also real `core` validator rows. That same
      // collision is what pushes the budget to 4: those two linked records
      // give `resolveModuleActivity` a non-empty relevant-record manifest,
      // so it reports every OTHER (genuinely fictional, thus never-linked)
      // module as inactive via the doctor summary's fourth always-on line
      // (`inactive modules: ...`) — see setup.ts's `printInactiveModules`.
      expect(nonWarning.length).toBeLessThanOrEqual(4);
      // The outcome line is the up-to-date headline (no symlink churn).
      expect(nonWarning.join("\n")).toMatch(/already up to date/);
      expect(nonWarning.join("\n")).toMatch(/by module: core \d+/);
      expect(nonWarning.join("\n")).toMatch(/inactive modules:/);
      void warnings;
    });
  });
});

describe("preflight tmux-on-PATH warning (hard-fail-to-warning flip)", () => {
  it("installs cleanly with no error when no launcher is recorded and tmux is absent", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const summary = await runSetup({
        flowSource,
        installRoot: flowSource,
        targets: targets(),
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
        cachePath: path.join(homeDir, ".flow", "update-check.json"),
        all: true,
        isTTY: false,
        configPath: path.join(homeDir, ".flow", "config.json"),
        // No recorded launcher config: preflight's tmux check only fires
        // when the recorded launcher is "tmux" — the exact regression this
        // spec pins is a hard exit(1) firing regardless of that recording.
        commandOnPath: () => false,
        quiet: true,
      });
      expect(summary.blocked).toBe(0);
      const allErrors = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(allErrors).not.toMatch(/tmux/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("warns (never exits) when the recorded launcher is tmux and tmux is absent", async () => {
    const configPath = path.join(homeDir, ".flow", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ launcher: "tmux" }));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const summary = await runSetup({
        flowSource,
        installRoot: flowSource,
        targets: targets(),
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
        cachePath: path.join(homeDir, ".flow", "update-check.json"),
        all: true,
        isTTY: false,
        configPath,
        commandOnPath: () => false,
        quiet: true,
      });
      expect(summary.blocked).toBe(0);
      const allErrors = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(allErrors).toMatch(/warning: your recorded launcher is tmux/);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("rebaseOntoInstallRoot / effectiveLinkSource", () => {
  const worktree = "/repo/flow-slug";
  const canonical = "/repo/flow";

  it("is identity when flowSource === installRoot", () => {
    const p = "/repo/flow/bin/flow-helper.ts";
    expect(rebaseOntoInstallRoot(p, canonical, canonical)).toBe(p);
  });

  it("rebases a worktree-rooted path onto installRoot when they diverge", () => {
    expect(
      rebaseOntoInstallRoot(
        "/repo/flow-slug/bin/flow-helper.ts",
        worktree,
        canonical,
      ),
    ).toBe("/repo/flow/bin/flow-helper.ts");
  });

  it("is identity when the source escapes flowSource (the ..-guard)", () => {
    // The wrapper's source is already installRoot-rooted, so relative()
    // escapes with a leading `..`; rebasing must not double-join.
    const wrapper = "/repo/flow/bin/flow";
    expect(rebaseOntoInstallRoot(wrapper, worktree, canonical)).toBe(wrapper);
  });

  it("effectiveLinkSource falls back to the worktree path when no canonical file exists", () => {
    // /repo/flow/bin/flow-newonly.ts does not exist on disk, so the live
    // link stays worktree-pointed.
    const wtOnly = "/repo/flow-slug/bin/flow-newonly.ts";
    expect(effectiveLinkSource(wtOnly, worktree, canonical)).toBe(wtOnly);
  });

  it("effectiveLinkSource prefers the canonical path when it exists on disk", () => {
    // Build a real canonical file so existsSync returns true.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-els-"));
    try {
      const canon = path.join(root, "flow");
      const wt = path.join(root, "flow-slug");
      fs.mkdirSync(path.join(canon, "bin"), { recursive: true });
      fs.writeFileSync(path.join(canon, "bin", "flow-helper.ts"), "// x\n");
      const wtSource = path.join(wt, "bin", "flow-helper.ts");
      expect(effectiveLinkSource(wtSource, wt, canon)).toBe(
        path.join(canon, "bin", "flow-helper.ts"),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- Fixture builders ---

function buildFakeFlowSource(root: string): void {
  // skills/{pipeline,universal,stacks}/<skill>/SKILL.md
  for (const [tier, names] of [
    ["pipeline", ["alpha", "beta"]],
    ["universal", ["gamma"]],
    ["stacks", ["delta"]],
  ] as const) {
    for (const name of names) {
      const dir = path.join(root, "skills", tier, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${name}\n`);
    }
  }

  // agents/<file>.md
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "reviewer.md"), "# reviewer\n");

  // bin/flow-helper.ts + bin/flow-helper.test.ts + bin/flow
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "flow-helper.ts"),
    "#!/usr/bin/env bun\n// helper\n",
  );
  fs.writeFileSync(path.join(binDir, "flow-helper.test.ts"), "// test\n");
  fs.writeFileSync(
    path.join(binDir, "flow"),
    "#!/usr/bin/env bun\n// wrapper\n",
  );

  // bin/lib/ — the two allowlisted schema validators plus a non-allowlisted
  // schema module. discoverValidators must ship exactly the two on the
  // VALIDATOR_MODULES allowlist; foo-schema.ts proves the allowlist filters.
  const libDir = path.join(binDir, "lib");
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(
    path.join(libDir, "pr-review-result-schema.ts"),
    "#!/usr/bin/env bun\n// validator\n",
  );
  fs.writeFileSync(
    path.join(libDir, "agent-finding-schema.ts"),
    "#!/usr/bin/env bun\n// validator\n",
  );
  fs.writeFileSync(
    path.join(libDir, "foo-schema.ts"),
    "// library-only, not allowlisted\n",
  );

  // completions/flow.bash + completions/flow.zsh
  const completionsDir = path.join(root, "completions");
  fs.mkdirSync(completionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(completionsDir, "flow.bash"),
    "# fake bash completion\n",
  );
  fs.writeFileSync(
    path.join(completionsDir, "flow.zsh"),
    "#compdef flow\n# fake\n",
  );

  // package.json declaring two runtime deps, plus a node_modules tree that
  // resolves both — so the dep-resolution check passes for the default
  // fixture and only the tests that deliberately drop a dep see `missing`.
  writeFakePackageJson(root, { picomatch: "^4.0.0", execa: "^9.0.0" });
  stubNodeModule(root, "picomatch");
  stubNodeModule(root, "execa");
}

/** Write a package.json with the given runtime `dependencies` map. */
function writeFakePackageJson(
  root: string,
  deps: Record<string, string>,
): void {
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fake-flow", dependencies: deps }),
  );
}

/** Create node_modules/<name>/package.json so the dep resolves on disk. */
function stubNodeModule(root: string, name: string): void {
  const dir = path.join(root, "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }));
}

/**
 * Like `buildFakeFlowSource`, but wraps the result in a real git repo with a
 * synthetic `origin/<defaultBranch>` ref pointing at a tree containing the
 * named skills. Used by the canonical-tree-presence backstop tests; the
 * `<root>/.git` directory has to be real so `git ls-tree -r origin/main` can
 * walk it. Network-free — there's no actual `origin` remote, just the local
 * remote-tracking ref.
 */
function buildFakeFlowSourceWithGit(
  root: string,
  skillsInTree: string[],
): void {
  buildFakeFlowSource(root);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const run = (cwd: string, args: string[]) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    }
    return r.stdout;
  };
  // Bare origin sibling; the canonical checkout pushes to it.
  const originDir = path.join(
    path.dirname(root),
    `${path.basename(root)}.origin.git`,
  );
  fs.mkdirSync(originDir, { recursive: true });
  spawnSync("git", ["init", "--bare", "-b", "main", originDir], { env });

  run(root, ["init", "-b", "main"]);
  run(root, ["remote", "add", "origin", originDir]);
  run(root, ["add", "."]);
  run(root, ["commit", "-m", "init"]);
  run(root, ["push", "origin", "main"]);
  // Populate refs/remotes/origin/* explicitly so the fixture genuinely
  // mirrors a freshly-cloned repo. The backstop probe in symlink.ts
  // (`git ls-tree -r origin/main`) and the symbolic-ref below both need
  // refs/remotes/origin/main to exist; not relying on a `git push`
  // remote-tracking-ref side-effect keeps the fixture deterministic.
  run(root, ["fetch", "origin"]);
  // Set up origin/HEAD so resolveDefaultBranch's symbolic-ref probe works
  // (mirrors a freshly-cloned repo).
  run(root, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  void skillsInTree;
}

/**
 * Adds a new skill on `origin/main` (synthetic remote-tracking ref) without
 * touching the working tree. The fast-forward path fetches origin/main and
 * merges --ff-only — the skill should land in the working tree post-merge.
 *
 * Implementation: build a commit on a detached HEAD, point origin/main at
 * the new commit, then leave HEAD on the old commit so the working tree
 * lags. The fast-forward then has work to do.
 */
function addSkillToOriginMain(root: string, name: string): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const run = (cwd: string, args: string[]) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    }
    return r.stdout;
  };
  // Build the new commit on a sibling clone so the canonical checkout's HEAD
  // and working tree don't move. Pushing back to the bare origin then leaves
  // origin/main ahead of canonical/main — the FF path has work to do.
  const stagingDir = path.join(
    path.dirname(root),
    `${path.basename(root)}.staging`,
  );
  fs.rmSync(stagingDir, { recursive: true, force: true });
  const originDir = path.join(
    path.dirname(root),
    `${path.basename(root)}.origin.git`,
  );
  spawnSync("git", ["clone", "-b", "main", originDir, stagingDir], { env });
  run(stagingDir, ["config", "user.email", "test@example.com"]);
  run(stagingDir, ["config", "user.name", "test"]);
  const skillDir = path.join(stagingDir, "skills", "pipeline", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${name}\n`);
  run(stagingDir, ["add", "."]);
  run(stagingDir, ["commit", "-m", `add ${name}`]);
  run(stagingDir, ["push", "origin", "main"]);
  fs.rmSync(stagingDir, { recursive: true, force: true });
}

/**
 * Returns a PID guaranteed not to be live on this host. Tries a small set of
 * high-numbered candidates and uses the first one process.kill(0) reports as
 * ESRCH. Mirrors the same helper in lock.test.ts — duplicated rather than
 * shared because pulling in a test-utils module just for this one helper
 * isn't worth the extra import surface.
 */
function pickDeadPid(): number {
  for (const candidate of [999999, 998123, 987654]) {
    try {
      process.kill(candidate, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("could not find a dead PID for the test");
}

describe("update-check cache invalidation on --upgrade", () => {
  function seedCache(): string {
    const cachePath = path.join(homeDir, ".flow", "update-check.json");
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ lastCheckedMs: 123, behind: 7 }),
    );
    return cachePath;
  }

  it("removes the cache file on --upgrade so the next check re-fetches", async () => {
    const cachePath = seedCache();
    await setup({ upgrade: true, cachePath });
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it("completes without throwing when no cache file is present", async () => {
    const cachePath = path.join(homeDir, ".flow", "update-check.json");
    expect(fs.existsSync(cachePath)).toBe(false);
    const summary = await setup({ upgrade: true, cachePath });
    expect(summary.created).toBeGreaterThan(0);
  });

  it("leaves the cache file untouched on a plain (non-upgrade) setup", async () => {
    const cachePath = seedCache();
    const before = fs.readFileSync(cachePath, "utf8");
    await setup({ cachePath });
    expect(fs.existsSync(cachePath)).toBe(true);
    expect(fs.readFileSync(cachePath, "utf8")).toBe(before);
  });
});

describe("module selection (--modules / --all / --core-only / TTY Q&A / prune)", () => {
  // Structural tests (a)-(d) below use the file's usual fictional fixture
  // (buildFakeFlowSource's "alpha"/"beta"/… names) because they only assert
  // on confirm()-call counts and config.json persistence — not on which
  // specific module owns which artifact. The name-matching tests (e)-(g)
  // need REAL registry names, so they point `flowSource` at the actual flow
  // checkout via `resolveFlowSource()` (read-only discovery; nothing under
  // that tree is ever written) while keeping every WRITE target (symlink
  // targets, manifest, config) inside this file's usual tmpdir fixture.
  //
  // `installRoot` for the real-registry tests is a plain non-git tmp dir
  // (not the real checkout) so `reapOrphans`'s git backstop
  // (`resolveDefaultBranch`) fails open locally ("not a git repository")
  // instead of ever reaching its `git remote show origin` network fallback.
  function configPath(): string {
    return path.join(homeDir, ".flow", "config.json");
  }

  function readConfig(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  }

  it("(a) TTY with no recorded config prompts once per optional module and persists the resolved selection", async () => {
    const asked: string[] = [];
    const confirm = (prompt: string): boolean => {
      asked.push(prompt);
      return prompt.startsWith("Install research");
    };
    await setup({ all: false, isTTY: true, confirm, configPath: configPath() });
    // Every optional (non-core) module once, plus the one launcher question.
    expect(asked.length).toBe(7);
    expect(
      asked.filter((p) => p.includes("Use tmux as your pipeline launcher?")),
    ).toHaveLength(1);
    const written = readConfig();
    expect(new Set(written.modules as string[])).toEqual(
      new Set(["core", "research"]),
    );
    // The launcher answer (declined) is persisted alongside modules.
    expect(written.launcher).toBe("plain");
  });

  it("(b) a recorded config selection re-links without invoking confirm", async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ modules: ["core", "copilot"] }),
    );
    const confirm = vi.fn((prompt: string) =>
      prompt.includes("Use tmux as your pipeline launcher?"),
    );
    await setup({ all: false, isTTY: true, confirm, configPath: configPath() });
    // Only the launcher question fires — never a module re-ask.
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(confirm.mock.calls[0]![0])).toContain(
      "Use tmux as your pipeline launcher?",
    );
    // Not re-persisted: the recorded module ids are untouched (still exactly
    // what was seeded, modulo formatting — read back as the same ids).
    expect(new Set(readConfig().modules as string[])).toEqual(
      new Set(["core", "copilot"]),
    );
    expect(readConfig().launcher).toBe("tmux");
  });

  it("(c) a non-TTY run with nothing recorded defaults to core, emits the one-line notice, and does not persist", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runSetup({
        flowSource,
        installRoot: flowSource,
        targets: targets(),
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
        isTTY: false,
        configPath: configPath(),
        // quiet:false so the notice surfaces
      });
      const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(allLogs).toMatch(/module selection: defaulting to core only/);
    } finally {
      logSpy.mockRestore();
    }
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it("launcher: a recorded config value never re-asks and is left untouched", async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ modules: ["core"], launcher: "tmux" }),
    );
    const confirm = vi.fn(() => false);
    await setup({ all: false, isTTY: true, confirm, configPath: configPath() });
    expect(confirm).not.toHaveBeenCalled();
    expect(readConfig().launcher).toBe("tmux");
  });

  it("launcher: --upgrade with nothing recorded never asks and persists nothing", async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ modules: ["core"] }));
    const confirm = vi.fn(() => true);
    await setup({
      all: false,
      upgrade: true,
      isTTY: true,
      confirm,
      configPath: configPath(),
      cachePath: path.join(homeDir, ".flow", "update-check.json"),
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(readConfig().launcher).toBeUndefined();
  });

  it("launcher: non-TTY with nothing recorded defaults to plain, notices, persists nothing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runSetup({
        flowSource,
        installRoot: flowSource,
        targets: targets(),
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
        isTTY: false,
        configPath: configPath(),
      });
      const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(allLogs).toMatch(/launcher: defaulting to plain/);
    } finally {
      logSpy.mockRestore();
    }
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it("(d) --upgrade honors a recorded selection with zero confirm calls", async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ modules: ["core"] }));
    const confirm = vi.fn(() => true);
    await setup({
      all: false,
      upgrade: true,
      isTTY: true,
      confirm,
      configPath: configPath(),
      cachePath: path.join(homeDir, ".flow", "update-check.json"),
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  describe("real-registry name matching", () => {
    // flowSource === installRoot (both the real flow checkout) — the
    // "identity" case `rebaseOntoInstallRoot`/`effectiveLinkSource` special-
    // case, so the manifest's recorded source exactly matches the live
    // symlink target and the prune test's equality check in
    // `removeIfManagedSymlink` isn't defeated by a synthetic install-root
    // divergence. `resolveDefaultBranch`'s `git symbolic-ref
    // refs/remotes/origin/HEAD` probe (inside `reapOrphans`) resolves
    // locally against this checkout's own `.git` — no network call, same
    // read-only-discovery safety as `completion.test.ts` /
    // `model-routing-table.test.ts`'s live-repo assertions. Every WRITE
    // target (symlinks, manifest, config) still lives in this file's usual
    // tmpdir fixture (`targets()` / `manifestPath` / `configPath()`); only
    // discovery reads from the real checkout.
    const realFlowSource = resolveFlowSource();

    it("(e) --modules core,research links only those modules' artifacts", async () => {
      const summary = await runSetup({
        flowSource: realFlowSource,
        installRoot: realFlowSource,
        targets: targets(),
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
        modules: ["core", "research"],
        isTTY: false,
        configPath: configPath(),
        quiet: true,
      });
      expect(summary.blocked).toBe(0);
      const t = targets();
      // core: present.
      expect(fs.existsSync(path.join(t.skillsDir, "flow-coder"))).toBe(true);
      // research: present (skill + a helper).
      expect(fs.existsSync(path.join(t.skillsDir, "flow-research"))).toBe(true);
      expect(fs.existsSync(path.join(t.binDir, "flow-delegate"))).toBe(true);
      // never-selected stack/copilot modules: absent.
      expect(fs.existsSync(path.join(t.skillsDir, "flow-svelte"))).toBe(false);
      expect(
        fs.existsSync(path.join(t.skillsDir, "flow-tailwind-shadcn")),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(t.skillsDir, "flow-supabase-project")),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(t.skillsDir, "flow-cloudflare-pages")),
      ).toBe(false);
      expect(fs.existsSync(path.join(t.binDir, "flow-request-copilot"))).toBe(
        false,
      );
    });

    it("(f) narrowing a prior --all install to --modules core prunes non-core symlinks while a planted non-flow file survives", async () => {
      await runSetup({
        flowSource: realFlowSource,
        installRoot: realFlowSource,
        targets: targets(),
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
        all: true,
        isTTY: false,
        configPath: configPath(),
        quiet: true,
      });
      const t = targets();
      expect(fs.existsSync(path.join(t.skillsDir, "flow-svelte"))).toBe(true);

      // A user-authored file living alongside the managed per-skill symlinks
      // — never recorded in any manifest, so the reap pass must leave it be.
      const plantedFile = path.join(t.skillsDir, "my-notes.txt");
      fs.writeFileSync(plantedFile, "not a flow artifact\n");

      const summary = await runSetup({
        flowSource: realFlowSource,
        installRoot: realFlowSource,
        targets: t,
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
        modules: ["core"],
        isTTY: false,
        configPath: configPath(),
        quiet: true,
      });

      expect(summary.removed).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(t.skillsDir, "flow-svelte"))).toBe(false);
      expect(fs.existsSync(path.join(t.skillsDir, "flow-coder"))).toBe(true);
      expect(fs.existsSync(plantedFile)).toBe(true);
      expect(fs.readFileSync(plantedFile, "utf8")).toBe(
        "not a flow artifact\n",
      );
    });

    it("(g) discoverSelected(every module id) set-equals discoverAll for target + source, byte-for-byte (the --all-equivalence precondition)", async () => {
      const all = discoverAll(realFlowSource, realFlowSource);
      const selected = await discoverSelected(
        realFlowSource,
        realFlowSource,
        moduleIds(),
      );
      const key = (e: { target: string; source: string }) =>
        `${e.target} ${e.source}`;
      expect(new Set(selected.map(key))).toEqual(new Set(all.map(key)));
      expect(selected.length).toBe(all.length);
    });

    it("(h) --all persists the full module-id list to config.json, and a subsequent bare --upgrade replays it rather than narrowing", async () => {
      await runSetup({
        flowSource: realFlowSource,
        installRoot: realFlowSource,
        targets: targets(),
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
        all: true,
        isTTY: false,
        configPath: configPath(),
        quiet: true,
      });
      expect(new Set(readConfig().modules as string[])).toEqual(
        new Set(moduleIds()),
      );

      const t = targets();
      await runSetup({
        flowSource: realFlowSource,
        installRoot: realFlowSource,
        targets: t,
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
        upgrade: true,
        isTTY: false,
        configPath: configPath(),
        quiet: true,
        cachePath: path.join(homeDir, ".flow", "update-check.json"),
      });
      expect(fs.existsSync(path.join(t.skillsDir, "flow-svelte"))).toBe(true);
    });

    it("(i) --modules core prints the inactive-modules doctor line naming every deselected optional", async () => {
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      try {
        await runSetup({
          flowSource: realFlowSource,
          installRoot: realFlowSource,
          targets: targets(),
          skipPreflight: true,
          manifestPath,
          lockPath,
          homeDir,
          settingsPath: settingsPath(),
          modules: ["core"],
          isTTY: false,
          configPath: configPath(),
        });
        const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(allLogs).toMatch(/inactive modules:/);
        expect(allLogs).toMatch(/research \(deselected\)/);
        expect(allLogs).toMatch(/copilot \(deselected\)/);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("(j) a full --all install prints no inactive-modules line — every module is fully linked", async () => {
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      try {
        await runSetup({
          flowSource: realFlowSource,
          installRoot: realFlowSource,
          targets: targets(),
          skipPreflight: true,
          manifestPath,
          lockPath,
          homeDir,
          settingsPath: settingsPath(),
          all: true,
          isTTY: false,
          configPath: configPath(),
        });
        const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(allLogs).not.toMatch(/inactive modules:/);
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe("source-tree-aware module registry (PR #445 regression)", () => {
    // Reproduces the exact silent-no-op scenario `resolveArtifactSetForSource`
    // fixes: a --source (worktree) tree adds a brand-new artifact file AND
    // registers it in a new bin/lib/modules.ts row, while the canonical
    // installRoot fixture is stale — it has neither the file nor the row.
    // Before the fix, `discoverSelected` resolved the module registry from
    // the compiled-in (canonical-derived) registry unconditionally, so the
    // new agent was silently never linked even though it physically exists
    // in the worktree passed via `--source`.
    it("picks up a new-file-plus-new-registry-row addition from a --source tree the compiled registry doesn't know about yet", async () => {
      const worktree = path.join(scratch, "worktree-with-new-agent");
      const canonicalRoot = path.join(scratch, "stale-canonical");
      buildFakeFlowSource(worktree);
      buildFakeFlowSource(canonicalRoot);

      // The new artifact: an agent file that exists ONLY in the worktree.
      fs.writeFileSync(
        path.join(worktree, "agents", "new-agent.md"),
        "# new-agent\n",
      );

      // The new registry row: the worktree's OWN bin/lib/modules.ts, unknown
      // to the compiled-in (canonical-derived) registry this test process
      // was built from. Mirrors buildFakeFlowSource's existing rows so the
      // pre-existing fixture artifacts stay linked too, plus the new agent.
      fs.mkdirSync(path.join(worktree, "bin", "lib"), { recursive: true });
      fs.writeFileSync(
        path.join(worktree, "bin", "lib", "modules.ts"),
        `
        export function resolveArtifactSet(selectedIds) {
          return {
            skills: ["alpha", "beta", "gamma", "delta"],
            agents: ["reviewer.md", "new-agent.md"],
            helpers: ["flow-helper"],
            validators: ["pr-review-result-schema", "agent-finding-schema"],
          };
        }
        `,
      );

      const t = targets();
      const summary = await runSetup({
        flowSource: worktree,
        installRoot: canonicalRoot,
        targets: t,
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
        modules: ["core"],
        isTTY: false,
        configPath: path.join(homeDir, ".flow", "config.json"),
        cachePath: path.join(homeDir, ".flow", "update-check.json"),
        quiet: true,
      });

      expect(summary.created).toBeGreaterThan(0);
      expect(
        fs.lstatSync(path.join(t.agentsDir, "new-agent.md")).isSymbolicLink(),
      ).toBe(true);

      const manifest = readManifest(manifestPath);
      expect(
        manifest.symlinks.some(
          (s) => s.target === path.join(t.agentsDir, "new-agent.md"),
        ),
      ).toBe(true);
    });

    it("logs a '! module registry:' warning and falls back to the compiled-in registry when the --source tree's modules.ts is malformed", async () => {
      const worktree = path.join(scratch, "worktree-with-malformed-registry");
      const canonicalRoot = path.join(scratch, "stale-canonical-2");
      buildFakeFlowSource(worktree);
      buildFakeFlowSource(canonicalRoot);

      // Malformed on purpose: throws instead of exporting resolveArtifactSet,
      // so resolveArtifactSetForSource's catch path fires and threads its
      // warning through discoverSelected's onWarning callback.
      fs.mkdirSync(path.join(worktree, "bin", "lib"), { recursive: true });
      fs.writeFileSync(
        path.join(worktree, "bin", "lib", "modules.ts"),
        `throw new Error("boom");`,
      );

      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      try {
        const t = targets();
        const summary = await runSetup({
          flowSource: worktree,
          installRoot: canonicalRoot,
          targets: t,
          skipPreflight: true,
          manifestPath,
          lockPath,
          homeDir,
          settingsPath: settingsPath(),
          modules: ["core"],
          isTTY: false,
          configPath: path.join(homeDir, ".flow", "config.json"),
          cachePath: path.join(homeDir, ".flow", "update-check.json"),
          quiet: false,
        });

        // Fell back to the compiled-in registry rather than erroring out.
        expect(summary.created).toBeGreaterThan(0);

        const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(allLogs).toMatch(/! module registry:/);
        expect(allLogs).toMatch(/boom/);
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});

describe("skills-home retarget + migration (Story 1)", () => {
  // A new-style skills target that differs from the pre-retarget
  // `<home>/.claude/skills` location, so the migration sweep engages.
  function newStyleTargets() {
    return {
      skillsDir: path.join(
        homeDir,
        ".flow",
        "claude-home",
        ".claude",
        "skills",
      ),
      agentsDir: path.join(homeDir, ".claude", "agents"),
      binDir: path.join(homeDir, ".local", "bin"),
      completionsDir: path.join(homeDir, ".flow", "completions"),
    };
  }

  function oldSkillsDir() {
    return path.join(homeDir, ".claude", "skills");
  }

  function runRetargeted(extra: Record<string, unknown> = {}) {
    return runSetup({
      flowSource,
      installRoot: flowSource,
      targets: newStyleTargets(),
      skipPreflight: true,
      manifestPath,
      lockPath,
      homeDir,
      settingsPath: settingsPath(),
      all: true,
      isTTY: false,
      configPath: path.join(homeDir, ".flow", "config.json"),
      quiet: true,
      cachePath: path.join(homeDir, ".flow", "update-check.json"),
      ...extra,
    });
  }

  it("links selected skills under the new claude-home target", async () => {
    await runRetargeted();
    const skillsDir = newStyleTargets().skillsDir;
    expect(fs.lstatSync(path.join(skillsDir, "alpha")).isSymbolicLink()).toBe(
      true,
    );
    expect(fs.lstatSync(path.join(skillsDir, "gamma")).isSymbolicLink()).toBe(
      true,
    );
  });

  it("reaps a manifest-recorded old-location symlink and preserves a non-flow file", async () => {
    // Seed a pre-retarget install: an old-location symlink into the flow tree
    // plus a manifest record claiming it, and a real (non-flow) file alongside.
    const old = oldSkillsDir();
    fs.mkdirSync(old, { recursive: true });
    const oldLink = path.join(old, "alpha");
    fs.symlinkSync(
      path.join(flowSource, "skills", "pipeline", "alpha"),
      oldLink,
    );
    const userFile = path.join(old, "my-own-skill");
    fs.mkdirSync(userFile, { recursive: true });
    fs.writeFileSync(path.join(userFile, "SKILL.md"), "# mine\n");
    writeManifest(
      {
        version: 1,
        symlinks: [
          {
            source: path.join(flowSource, "skills", "pipeline", "alpha"),
            target: oldLink,
            kind: "skill",
          },
        ],
      },
      manifestPath,
    );

    await runRetargeted({ upgrade: true });

    expect(fs.existsSync(oldLink)).toBe(false); // reaped
    expect(fs.existsSync(path.join(userFile, "SKILL.md"))).toBe(true); // untouched
    expect(
      fs
        .lstatSync(path.join(newStyleTargets().skillsDir, "alpha"))
        .isSymbolicLink(),
    ).toBe(true); // relinked at the new home
  });

  it("drift-sweeps a flow-owned old-location symlink with no manifest record, leaving a foreign symlink", async () => {
    // No manifest record at all (a pre-manifest / drifted install). The sweep
    // must still remove a flow-owned symlink at the old location while leaving
    // a user's own symlink (target outside the flow tree) intact.
    const old = oldSkillsDir();
    fs.mkdirSync(old, { recursive: true });
    const flowOwned = path.join(old, "beta");
    fs.symlinkSync(
      path.join(flowSource, "skills", "pipeline", "beta"),
      flowOwned,
    );
    const externalTarget = path.join(scratch, "external-skill");
    fs.mkdirSync(externalTarget, { recursive: true });
    const foreign = path.join(old, "not-flow");
    fs.symlinkSync(externalTarget, foreign);

    await runRetargeted();

    expect(fs.existsSync(flowOwned)).toBe(false); // swept (flow-owned)
    expect(fs.lstatSync(foreign).isSymbolicLink()).toBe(true); // foreign preserved
  });

  it("drift-sweeps a DANGLING flow-owned old-location symlink, preserving a dangling foreign symlink", async () => {
    // Exercises the `realpathSync(raw)` throws → `isPathUnder(raw, root)`
    // fallback branch: the old-location link points into the flow tree but its
    // target was since removed (a renamed/deleted skill), so realpath fails and
    // ownership must be decided lexically off `raw`. The sweep must still remove
    // it, while a dangling symlink whose target lies OUTSIDE the flow tree (a
    // user's own, its target also gone) is preserved.
    const old = oldSkillsDir();
    fs.mkdirSync(old, { recursive: true });
    const flowOwned = path.join(old, "beta");
    fs.symlinkSync(
      path.join(flowSource, "skills", "pipeline", "beta"),
      flowOwned,
    );
    // Remove the source so the flow-owned link dangles → realpathSync throws.
    fs.rmSync(path.join(flowSource, "skills", "pipeline", "beta"), {
      recursive: true,
      force: true,
    });
    // A foreign symlink whose target (outside the flow tree) never existed —
    // dangling too, so realpathSync throws and the raw clause must NOT own it.
    const foreign = path.join(old, "not-flow");
    fs.symlinkSync(path.join(scratch, "external-gone"), foreign);

    await runRetargeted();

    expect(fs.existsSync(flowOwned)).toBe(false); // swept via the raw fallback
    expect(fs.lstatSync(foreign).isSymbolicLink()).toBe(true); // foreign preserved
  });
});

describe("gh#435 non-interactive --upgrade breadth preservation (Story 4)", () => {
  const realFlowSource = resolveFlowSource();

  function cfgPath() {
    return path.join(homeDir, ".flow", "config.json");
  }

  it("a non-TTY --upgrade with a populated manifest and nothing recorded preserves breadth, not core-only, and does not persist", async () => {
    const t = targets();
    // First install the full set so a populated manifest exists on disk.
    await runSetup({
      flowSource: realFlowSource,
      installRoot: realFlowSource,
      targets: t,
      skipPreflight: true,
      manifestPath,
      lockPath,
      homeDir,
      settingsPath: settingsPath(),
      all: true,
      isTTY: false,
      configPath: cfgPath(),
      quiet: true,
      cachePath: path.join(homeDir, ".flow", "update-check.json"),
    });
    // Clear the recorded selection --all persisted, so the next run has a
    // populated manifest but nothing recorded — the gh#435 scenario.
    fs.rmSync(cfgPath(), { force: true });
    expect(fs.existsSync(path.join(t.skillsDir, "flow-svelte"))).toBe(true);

    const summary = await runSetup({
      flowSource: realFlowSource,
      installRoot: realFlowSource,
      targets: t,
      skipPreflight: true,
      manifestPath,
      lockPath,
      homeDir,
      settingsPath: settingsPath(),
      upgrade: true,
      isTTY: false,
      configPath: cfgPath(),
      quiet: true,
      cachePath: path.join(homeDir, ".flow", "update-check.json"),
    });

    // Breadth preserved — flow-svelte (a non-core stack skill) is still linked,
    // NOT reaped down to core.
    expect(fs.existsSync(path.join(t.skillsDir, "flow-svelte"))).toBe(true);
    expect(fs.existsSync(path.join(t.skillsDir, "flow-pipeline"))).toBe(true);
    expect(summary.blocked).toBe(0);
    // Not persisted — the manifest-derived selection re-derives each run.
    expect(fs.existsSync(cfgPath())).toBe(false);
  });

  it("a non-TTY install with an empty manifest and nothing recorded stays core-only", async () => {
    const t = targets();
    const summary = await runSetup({
      flowSource: realFlowSource,
      installRoot: realFlowSource,
      targets: t,
      skipPreflight: true,
      manifestPath,
      lockPath,
      homeDir,
      settingsPath: settingsPath(),
      isTTY: false,
      configPath: cfgPath(),
      quiet: true,
      cachePath: path.join(homeDir, ".flow", "update-check.json"),
    });
    // core skill present, non-core stack skill absent.
    expect(fs.existsSync(path.join(t.skillsDir, "flow-pipeline"))).toBe(true);
    expect(fs.existsSync(path.join(t.skillsDir, "flow-svelte"))).toBe(false);
    expect(summary.blocked).toBe(0);
  });
});

describe("gh#435 registry-unknown pass-through in discoverSelected (Story 4)", () => {
  function buildSkillsTree(
    root: string,
    spec: { tier: string; name: string; withSkillMd?: boolean }[],
  ) {
    for (const s of spec) {
      const dir = path.join(root, "skills", s.tier, s.name);
      fs.mkdirSync(dir, { recursive: true });
      if (s.withSkillMd !== false) {
        fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${s.name}\n`);
      }
    }
  }

  function skillNames(entries: { kind: string; displayName: string }[]) {
    return entries.filter((e) => e.kind === "skill").map((e) => e.displayName);
  }

  it("passes through a registry-unknown skill under core-only while filtering a deselected known skill", async () => {
    const src = path.join(scratch, "unknown-passthrough");
    buildSkillsTree(src, [
      { tier: "stacks", name: "flow-svelte" }, // registry-known (stack-svelte)
      { tier: "pipeline", name: "my-worktree-skill" }, // registry-unknown
    ]);
    const names = skillNames(
      await discoverSelected(src, src, ["core"], targets()),
    );
    expect(names).toContain("my-worktree-skill"); // passed through
    expect(names).not.toContain("flow-svelte"); // deselected known — filtered
  });

  it("links a deselected known skill once its module is selected", async () => {
    const src = path.join(scratch, "known-selected");
    buildSkillsTree(src, [{ tier: "stacks", name: "flow-svelte" }]);
    const names = skillNames(
      await discoverSelected(src, src, ["core", "stack-svelte"], targets()),
    );
    expect(names).toContain("flow-svelte");
  });

  it("never links a stray skills/ directory with no SKILL.md, any selection (validity bound)", async () => {
    const src = path.join(scratch, "stray-dir");
    buildSkillsTree(src, [
      { tier: "pipeline", name: "real-skill" },
      { tier: "pipeline", name: "stray-scratch", withSkillMd: false },
    ]);
    for (const sel of [["core"], moduleIds()]) {
      const names = skillNames(
        await discoverSelected(src, src, sel, targets()),
      );
      expect(names).toContain("real-skill"); // valid unknown → passed through
      expect(names).not.toContain("stray-scratch"); // no SKILL.md → never discovered
    }
  });
});

describe("worktree install root", () => {
  function addWorktree(canonicalRoot: string, worktreeDir: string): void {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const r = spawnSync(
      "git",
      ["-C", canonicalRoot, "worktree", "add", "-b", "sibling", worktreeDir],
      { env, encoding: "utf8" },
    );
    if (r.status !== 0) {
      throw new Error(`git worktree add failed: ${r.stderr}`);
    }
  }

  it("repoints a worktree-rooted install to the canonical sibling checkout", async () => {
    const canonicalRoot = path.join(scratch, "flow-canonical");
    buildFakeFlowSourceWithGit(canonicalRoot, ["alpha", "beta"]);
    const worktreeDir = path.join(scratch, "flow-worktree");
    addWorktree(canonicalRoot, worktreeDir);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runSetup({
        cachePath: path.join(homeDir, ".flow", "update-check.json"),
        all: true,
        isTTY: false,
        configPath: path.join(homeDir, ".flow", "config.json"),
        flowSource: worktreeDir,
        installRoot: worktreeDir,
        targets: targets(),
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
      });
      const manifest = readManifest(manifestPath);
      expect(manifest.symlinks.length).toBeGreaterThan(0);
      // Recorded sources are realpath'd (inspectFlowRoot resolves symlinks,
      // e.g. macOS's /var -> /private/var), so compare against the
      // canonical root's realpath rather than the raw fixture path.
      const realCanonicalRoot = fs.realpathSync(canonicalRoot);
      const realWorktreeDir = fs.realpathSync(worktreeDir);
      for (const record of manifest.symlinks) {
        expect(record.source.startsWith(realCanonicalRoot)).toBe(true);
        expect(record.source.startsWith(realWorktreeDir)).toBe(false);
      }
      const wrapper = path.join(targets().binDir, "flow");
      expect(fs.realpathSync(wrapper)).toBe(
        fs.realpathSync(path.join(canonicalRoot, "bin", "flow")),
      );
      const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(allLogs).toMatch(
        /is a git worktree — recording and linking against canonical/,
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("warn-only when the guard can't derive a canonical root: install still completes", async () => {
    const inspectRoot = (): FlowRootInfo => ({
      isWorktree: true,
      canonicalRoot: null,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const summary = await runSetup({
        cachePath: path.join(homeDir, ".flow", "update-check.json"),
        all: true,
        isTTY: false,
        configPath: path.join(homeDir, ".flow", "config.json"),
        flowSource,
        installRoot: flowSource,
        targets: targets(),
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
        inspectRoot,
      });
      expect(summary.blocked).toBe(0);
      expect(summary.created).toBeGreaterThan(0);
      const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(allLogs).toMatch(
        /is a git worktree and no canonical checkout was derived/,
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("skips the repoint (warn-only) when an explicit source is already configured", async () => {
    fs.mkdirSync(path.join(homeDir, ".flow"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".flow", "config.json"),
      JSON.stringify({ source: flowSource }),
    );
    const canonicalRoot = path.join(scratch, "flow-canonical-unused");
    buildFakeFlowSource(canonicalRoot);
    const inspectRoot = (): FlowRootInfo => ({
      isWorktree: true,
      canonicalRoot,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runSetup({
        cachePath: path.join(homeDir, ".flow", "update-check.json"),
        all: true,
        isTTY: false,
        configPath: path.join(homeDir, ".flow", "config.json"),
        flowSource,
        installRoot: flowSource,
        targets: targets(),
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
        inspectRoot,
      });
      const manifest = readManifest(manifestPath);
      // No repoint: every recorded source stays under the configured
      // (worktree) flowSource, never the injected canonicalRoot.
      for (const record of manifest.symlinks) {
        expect(record.source.startsWith(flowSource)).toBe(true);
        expect(record.source.startsWith(canonicalRoot)).toBe(false);
      }
      const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(allLogs).toMatch(
        /is a git worktree and no canonical checkout was derived/,
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("names a worktree-only artifact exactly once in the install summary", async () => {
    // Calls runSetup directly (not the `setup()` helper, which hardcodes
    // `quiet: true`) so the summary line is actually observable via
    // console.log — same reason the sibling `--no-pull-canonical` spec above
    // bypasses the helper.
    const worktree = path.join(scratch, "worktree-with-extra-skill");
    buildFakeFlowSource(worktree);
    fs.mkdirSync(path.join(worktree, "skills", "pipeline", "epsilon"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(worktree, "skills", "pipeline", "epsilon", "SKILL.md"),
      "# epsilon\n",
    );

    const runSetupArgs = (flowSourceOverride: string) => ({
      cachePath: path.join(homeDir, ".flow", "update-check.json"),
      all: true,
      isTTY: false,
      configPath: path.join(homeDir, ".flow", "config.json"),
      flowSource: flowSourceOverride,
      installRoot: flowSource,
      targets: targets(),
      skipPreflight: true,
      manifestPath,
      lockPath,
      homeDir,
      settingsPath: settingsPath(),
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runSetup(runSetupArgs(worktree));
      const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      const matches = allLogs.match(
        /artifact\(s\) linked from the worktree source \(no canonical counterpart yet\)/g,
      );
      expect(matches?.length ?? 0).toBe(1);
      expect(allLogs).toMatch(/epsilon/);
    } finally {
      logSpy.mockRestore();
    }

    // Companion: no worktree-only artifact -> no such line.
    const logSpy2 = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    try {
      await runSetup(runSetupArgs(flowSource));
      const allLogs2 = logSpy2.mock.calls.map((c) => String(c[0])).join("\n");
      expect(allLogs2).not.toMatch(/linked from the worktree source/);
    } finally {
      logSpy2.mockRestore();
    }
  });

  it("suppresses the canonical fast-forward when the repoint happened, but not otherwise", async () => {
    // Repointed --upgrade run: fastForwardCanonical must not run against the
    // worktree, and the generic skipped-reason line names repointed-source.
    const canonicalRoot = path.join(scratch, "flow-canonical-ff");
    buildFakeFlowSourceWithGit(canonicalRoot, ["alpha", "beta"]);
    const worktreeDir = path.join(scratch, "flow-worktree-ff");
    addWorktree(canonicalRoot, worktreeDir);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runSetup({
        upgrade: true,
        cachePath: path.join(homeDir, ".flow", "update-check.json"),
        all: true,
        isTTY: false,
        configPath: path.join(homeDir, ".flow", "config.json"),
        flowSource: worktreeDir,
        installRoot: worktreeDir,
        targets: targets(),
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
      });
      const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(allLogs).toMatch(/content not refreshed \(repointed-source\)/);
    } finally {
      logSpy.mockRestore();
    }

    // Non-repointed canonical --upgrade run: the suppression must be scoped
    // to the repoint — a normal canonical upgrade never emits that reason.
    const logSpy2 = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    try {
      await runSetup({
        upgrade: true,
        cachePath: path.join(homeDir, ".flow", "update-check.json"),
        all: true,
        isTTY: false,
        configPath: path.join(homeDir, ".flow", "config.json"),
        flowSource: canonicalRoot,
        installRoot: canonicalRoot,
        targets: targets(),
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
      });
      const allLogs2 = logSpy2.mock.calls.map((c) => String(c[0])).join("\n");
      expect(allLogs2).not.toMatch(/repointed-source/);
    } finally {
      logSpy2.mockRestore();
    }
  });
});
