/**
 * Tests for `flow setup`. Each test stands up a fake flow-source tree and
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
import { readManifest } from "./manifest";
import { LockTimeoutError } from "./lock";
import { removeIfManagedSymlink } from "./symlink";
import { countStopHook } from "./settings-merge";
import { discoverHelpers, discoverValidators } from "./sources";

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
  } = {},
) {
  const { flowSourceOverride, installRootOverride, ...rest } = opts;
  // installRoot defaults to flowSource so the existing test fixtures
  // (which only override flowSource) keep recording fixture-rooted paths
  // in the manifest. Tests that exercise the worktree → install-root
  // divergence pass `flowSourceOverride` to drive flowSource away from
  // the canonical install-root fixture.
  return runSetup({
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

describe("flow setup", () => {
  it("creates symlinks for every skill, agent, and helper from a fresh state", () => {
    const summary = setup();

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

  it("strips the .ts extension when symlinking helpers", () => {
    setup();
    const t = targets();
    expect(fs.existsSync(path.join(t.binDir, "flow-helper"))).toBe(true);
    expect(fs.existsSync(path.join(t.binDir, "flow-helper.ts"))).toBe(false);
  });

  it("excludes test files from helper discovery", () => {
    setup();
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
  });

  it("discovers the two schema validators via the discoverValidators allowlist", () => {
    // Regression guard: discoverValidators ships exactly the two validators
    // named in the VALIDATOR_MODULES allowlist — pr-review-result-schema and
    // agent-finding-schema — sourced from bin/lib/ with a `flow-` install
    // target prefix. It must NOT pick up coder-schema (not on the allowlist)
    // or any `*-schema.test.ts` file. Run against the real repo's bin/lib/
    // rather than the synthetic fixture so this test fires if a future
    // refactor regresses the allowlist or the naming.
    const repoRoot = path.resolve(__dirname, "..", "..");
    const validators = discoverValidators(repoRoot);
    expect(validators).toHaveLength(2);
    const names = validators.map((v) => path.basename(v.target)).sort();
    expect(names).toEqual([
      "flow-agent-finding-schema",
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

  it("writes a manifest recording every symlink it created", () => {
    setup();
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

  it("is idempotent: a second run produces only 'exists' results", () => {
    setup();
    const second = setup();
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
  });

  it("blocks non-symlink files at the target without --force", () => {
    const t = targets();
    fs.mkdirSync(t.skillsDir, { recursive: true });
    // Pretend the user has authored their own 'alpha' skill at the target.
    fs.writeFileSync(path.join(t.skillsDir, "alpha"), "user content");
    const summary = setup();
    expect(summary.blocked).toBeGreaterThan(0);
    // Real file untouched.
    expect(fs.readFileSync(path.join(t.skillsDir, "alpha"), "utf8")).toBe(
      "user content",
    );
  });

  it("--force replaces a non-symlink file at the target", () => {
    const t = targets();
    fs.mkdirSync(t.binDir, { recursive: true });
    fs.writeFileSync(path.join(t.binDir, "flow-helper"), "old content");
    const summary = setup({ force: true });
    expect(summary.blocked).toBe(0);
    expect(
      fs.lstatSync(path.join(t.binDir, "flow-helper")).isSymbolicLink(),
    ).toBe(true);
  });

  it("--upgrade reaps orphan symlinks recorded in a previous manifest", () => {
    // First install — alpha + beta exist.
    setup();
    const t = targets();

    // Drop alpha from the source tree.
    fs.rmSync(path.join(flowSource, "skills", "pipeline", "alpha"), {
      recursive: true,
    });

    // Re-run with --upgrade.
    const summary = setup({ upgrade: true });
    expect(summary.removed).toBe(1);
    expect(fs.existsSync(path.join(t.skillsDir, "alpha"))).toBe(false);
    expect(fs.existsSync(path.join(t.skillsDir, "beta"))).toBe(true);
  });

  it("acquires the setup lock and releases it on success", () => {
    setup();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("times out instead of stomping when another live process holds the setup lock", () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(process.pid));
    expect(() => setup({ lockTimeoutMs: 200 })).toThrow(LockTimeoutError);
    fs.unlinkSync(lockPath);
  });

  it("reclaims a stale setup lock left by a dead process", () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(pickDeadPid()));
    const summary = setup({ lockTimeoutMs: 1000 });
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

    it("symlinks completion scripts into ~/.flow/completions/", () => {
      setup();
      const completionsDir = targets().completionsDir;
      expect(
        fs.lstatSync(path.join(completionsDir, "flow.bash")).isSymbolicLink(),
      ).toBe(true);
      expect(
        fs.lstatSync(path.join(completionsDir, "flow.zsh")).isSymbolicLink(),
      ).toBe(true);
    });

    it("records completion symlinks in the manifest with kind 'completion'", () => {
      setup();
      const manifest = readManifest(manifestPath);
      const completionEntries = manifest.symlinks.filter(
        (s) => s.kind === "completion",
      );
      expect(
        completionEntries.map((s) => path.basename(s.target)).sort(),
      ).toEqual(["flow.bash", "flow.zsh"]);
    });

    it("inserts the managed block into ~/.zshrc when it exists", () => {
      seedRc(".zshrc", "alias ll='ls -la'\n");
      setup();
      const after = fs.readFileSync(rcPath(".zshrc"), "utf8");
      expect(after).toContain("# managed by flow completions");
      expect(after).toContain("flow.zsh");
      expect(after).toContain("# end flow completions");
      // Original content preserved.
      expect(after).toContain("alias ll='ls -la'");
    });

    it("inserts the managed block into ~/.bashrc when it exists", () => {
      seedRc(".bashrc", "export EDITOR=vim\n");
      setup();
      const after = fs.readFileSync(rcPath(".bashrc"), "utf8");
      expect(after).toContain("# managed by flow completions");
      expect(after).toContain("flow.bash");
    });

    it("inserts the managed block into ~/.bash_profile when it exists", () => {
      seedRc(".bash_profile", "# bash login config\n");
      setup();
      const after = fs.readFileSync(rcPath(".bash_profile"), "utf8");
      expect(after).toContain("# managed by flow completions");
      expect(after).toContain("flow.bash");
    });

    it("does not create rc files that don't already exist", () => {
      setup();
      expect(fs.existsSync(rcPath(".zshrc"))).toBe(false);
      expect(fs.existsSync(rcPath(".bashrc"))).toBe(false);
      expect(fs.existsSync(rcPath(".bash_profile"))).toBe(false);
    });

    it("is idempotent: a second run leaves rc files byte-identical to the first", () => {
      seedRc(".zshrc", "alias ll='ls -la'\n");
      setup();
      const afterFirst = fs.readFileSync(rcPath(".zshrc"), "utf8");
      setup();
      const afterSecond = fs.readFileSync(rcPath(".zshrc"), "utf8");
      expect(afterSecond).toBe(afterFirst);
    });

    it("--no-completions on a fresh run does not edit any rc file", () => {
      seedRc(".zshrc", "alias ll='ls -la'\n");
      const before = fs.readFileSync(rcPath(".zshrc"), "utf8");
      setup({ noCompletions: true });
      const after = fs.readFileSync(rcPath(".zshrc"), "utf8");
      expect(after).toBe(before);
    });

    it("--no-completions on a system that already has the block removes it cleanly", () => {
      const original = "alias ll='ls -la'\nexport EDITOR=vim\n";
      seedRc(".zshrc", original);
      setup();
      // Block is present after first run.
      expect(fs.readFileSync(rcPath(".zshrc"), "utf8")).toContain(
        "# managed by flow completions",
      );
      // Run again with --no-completions; rc returns to pre-install state.
      setup({ noCompletions: true });
      expect(fs.readFileSync(rcPath(".zshrc"), "utf8")).toBe(original);
    });

    it("--upgrade reaps an orphaned completion symlink when source is gone", () => {
      setup();
      const completionsDir = targets().completionsDir;
      // Remove the bash script from the source — its target should be reaped.
      fs.rmSync(path.join(flowSource, "completions", "flow.bash"));
      const summary = setup({ upgrade: true });
      expect(summary.removed).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(path.join(completionsDir, "flow.bash"))).toBe(false);
      // Zsh script still installed.
      expect(fs.existsSync(path.join(completionsDir, "flow.zsh"))).toBe(true);
    });
  });

  it("--upgrade refuses to delete an unmanaged symlink (points outside flow source)", () => {
    setup();
    const t = targets();

    // Manually replace alpha with a symlink to /tmp (not under flow source).
    const userTarget = fs.mkdtempSync(path.join(os.tmpdir(), "user-"));
    fs.unlinkSync(path.join(t.skillsDir, "alpha"));
    fs.symlinkSync(userTarget, path.join(t.skillsDir, "alpha"));

    // Drop alpha from the source so it would otherwise be an orphan.
    fs.rmSync(path.join(flowSource, "skills", "pipeline", "alpha"), {
      recursive: true,
    });

    const summary = setup({ upgrade: true });
    expect(summary.removed).toBe(0); // refused — replacement still resolves
    expect(fs.existsSync(path.join(t.skillsDir, "alpha"))).toBe(true);

    fs.rmSync(userTarget, { recursive: true, force: true });
  });

  it("--upgrade reaps a dangling user-replaced symlink at our managed target", () => {
    // Documents the relaxed-reaper's deliberate aggressive behavior: when an
    // on-disk symlink at a target we recorded in the manifest no longer
    // resolves to *anything* on disk, it gets reaped — regardless of whether
    // the dangling pointer was something we wrote or something the user
    // replaced ours with. The user-replacement-still-resolves case is
    // preserved by the test above.
    setup();
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

    const summary = setup({ upgrade: true });
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

    it("registers the Stop hook entry on a fresh setup", () => {
      setup();
      expect(countFlowStopEntries()).toBe(1);
    });

    it("preserves user-authored Stop hook entries when registering", () => {
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
      setup();
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

    it("is idempotent: re-running setup does not duplicate the entry", () => {
      setup();
      setup();
      setup();
      expect(countFlowStopEntries()).toBe(1);
    });

    it("--no-hooks skips the merge entirely", () => {
      setup({ noHooks: true });
      expect(fs.existsSync(settingsPath())).toBe(false);
    });

    it("--no-hooks does not flag a pre-existing malformed settings.json as a validation failure", () => {
      // Regression: when the user passes --no-hooks, flow never touched
      // settings.json this run. A malformed file there is a pre-existing
      // condition, not a flow-induced regression — it must not block exit.
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
      fs.writeFileSync(settingsPath(), "{not valid json");
      const summary = setup({ noHooks: true });
      expect(summary.validationFailures).toEqual([]);
      // Malformed content survives — flow opted out of touching it.
      expect(fs.readFileSync(settingsPath(), "utf8")).toBe("{not valid json");
    });

    describe("--repair-settings recovery", () => {
      it("repairs a malformed regular settings.json and registers the hook", () => {
        // End-to-end: seed a malformed file, run setup with repairSettings,
        // assert the file is now valid JSON with the hook installed and a
        // timestamped backup landed next to the realpath target.
        const settingsP = settingsPath();
        fs.mkdirSync(path.dirname(settingsP), { recursive: true });
        const seed = '{"theme":"dar';
        fs.writeFileSync(settingsP, seed);

        const summary = setup({ repairSettings: true });
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

      it("emits the `repaired; backup at` log line on a regular file", () => {
        const settingsP = settingsPath();
        fs.mkdirSync(path.dirname(settingsP), { recursive: true });
        fs.writeFileSync(settingsP, '{"theme":"dar');

        const logSpy = vi
          .spyOn(console, "log")
          .mockImplementation(() => undefined);
        try {
          runSetup({
            repairSettings: true,
            flowSource,
            installRoot: flowSource,
            targets: targets(),
            skipPreflight: true,
            manifestPath,
            lockPath,
            homeDir,
            settingsPath: settingsP,
          });
          const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
          expect(allLogs).toMatch(/repaired; backup at/);
        } finally {
          logSpy.mockRestore();
        }
      });

      it("repairs a malformed file behind a symlink and preserves the symlink", () => {
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
            const summary = runSetup({
              repairSettings: true,
              flowSource,
              installRoot: flowSource,
              targets: targets(),
              skipPreflight: true,
              manifestPath,
              lockPath,
              homeDir,
              settingsPath: settingsP,
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

  it("flags a validation failure when a settings.json is corrupted between runs", () => {
    // Integration counterpart to the validateJsonFiles unit tests: setup
    // runs once cleanly, then the file is corrupted on disk, then the next
    // setup run must surface the validation failure in the summary. (The
    // ensureStopHook safe-bailout preserves the malformed content; the
    // validator then catches it.)
    setup();
    // First run produced a clean settings.json — corrupt it.
    fs.writeFileSync(settingsPath(), "{not valid json");
    const summary = setup();
    expect(summary.validationFailures).toContain(settingsPath());
  });

  it("all JSON files written by setup round-trip through JSON.parse", () => {
    // Catches any future regression that writes malformed JSON through any
    // of bin/'s writers. Walks both ~/.claude and ~/.flow under the fake
    // homeDir; the fixture writes settings.json (under .claude) and
    // installed.json (under .flow), and both must parse cleanly.
    setup();

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
    it("records install-root paths in the manifest when flowSource diverges from installRoot", () => {
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

      setup({ flowSourceOverride: worktree });

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

    it("symlinks still point at the worktree's content during the in-flight session", () => {
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

      setup({ flowSourceOverride: worktree });

      const t = targets();
      // realpath on both sides — ensureSymlink writes realpath'd targets, and
      // /var → /private/var canonicalization on macOS would otherwise yield a
      // string mismatch.
      expect(fs.realpathSync(path.join(t.skillsDir, "epsilon"))).toBe(
        fs.realpathSync(path.join(worktree, "skills", "pipeline", "epsilon")),
      );
    });

    it("the production CLI path keeps installRoot canonical and the wrapper anchored when --source overrides flowSource", () => {
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
      const code = runSetupCli(["--source", worktree], {
        targets: targets(),
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: settingsPath(),
        quiet: true,
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

    it("reaps dangling symlinks left behind when a prior --source <worktree> worktree is gone", () => {
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
      setup({ flowSourceOverride: worktree, upgrade: true });
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
      const summary = setup({ upgrade: true });

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
  });

  describe("canonical-tree-presence backstop (PR #115 race)", () => {
    it("preserves the symlink when the recorded source is in origin/<default>'s tree but absent from the working tree", () => {
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
      setup({ upgrade: true });

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
        const summary = setup({ upgrade: true });
        // Symlink survives.
        expect(fs.lstatSync(linkBefore).isSymbolicLink()).toBe(true);
        expect(summary.removed).toBe(0);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("falls through to the legacy reap when the recorded source is in NEITHER origin/<default> nor the working tree", () => {
      // Symmetric to PR #79: the recorded source is genuinely orphaned
      // (origin/main has no record of it), so the backstop must NOT fire
      // and the legacy dangling-reap must reap it.
      buildFakeFlowSourceWithGit(
        flowSource,
        /* skillsInTree */ ["alpha", "beta"],
      );

      // Install once.
      setup({ upgrade: true });
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

      const summary = setup({ upgrade: true });
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

    it("e2e --upgrade fast-forwards canonical and the freshly-merged skill survives the reap", () => {
      // Mirrors the PR #115 race: the supervisor's `flow setup --upgrade`
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
        const summary = setup({ upgrade: true });
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

    it("--no-pull-canonical opts out of the fast-forward (no `git fetch` recorded)", () => {
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
        runSetup({
          upgrade: true,
          pullCanonicalFirst: false,
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
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe("runtime-dependency resolution check", () => {
    it("sets summary.missingRuntimeDeps and logs the remediation when a runtime dep is absent", () => {
      // Drop the resolved node_modules entry for one declared dep.
      fs.rmSync(path.join(flowSource, "node_modules", "picomatch"), {
        recursive: true,
        force: true,
      });
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      try {
        const summary = runSetup({
          flowSource,
          installRoot: flowSource,
          targets: targets(),
          skipPreflight: true,
          manifestPath,
          lockPath,
          homeDir,
          settingsPath: settingsPath(),
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

    it("leaves summary.missingRuntimeDeps empty and emits no dep error when all deps resolve", () => {
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      try {
        const summary = setup();
        expect(summary.missingRuntimeDeps).toEqual([]);
        const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(allLogs).not.toMatch(/missing runtime dependencies/);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("checks installRoot, not flowSource (Story 5): worktree missing the dep, canonical has it", () => {
      // flowSource (the --source worktree) lacks the dep; installRoot
      // (canonical) has it. The check must read installRoot and pass.
      const worktree = path.join(scratch, "worktree");
      buildFakeFlowSource(worktree);
      fs.rmSync(path.join(worktree, "node_modules", "picomatch"), {
        recursive: true,
        force: true,
      });
      const summary = setup({ flowSourceOverride: worktree });
      expect(summary.missingRuntimeDeps).toEqual([]);
    });

    it("installDeps:true invokes the injected installRunner and clears the missing list on success", () => {
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
      const summary = setup({ installDeps: true, installRunner });
      expect(ran).toBe(1);
      expect(summary.missingRuntimeDeps).toEqual([]);
    });

    it("installDeps:true with a failing installRunner keeps the dep missing, logs the failure, and exits 1", () => {
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
        const summary = runSetup({
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
      const code = runSetupCli(["--install-deps"], {
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
      });
      expect(code).toBe(1);
    });
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
