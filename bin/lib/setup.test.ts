/**
 * Tests for `flow setup`. Each test stands up a fake flow-source tree and
 * a fake install-target tree in tmpdir, runs setup against them, and
 * asserts the resulting symlinks + manifest. Real ~/.claude/ is never
 * touched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup";
import { readManifest } from "./manifest";
import { LockTimeoutError } from "./lock";

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

function setup(
  opts: {
    upgrade?: boolean;
    force?: boolean;
    lockTimeoutMs?: number;
    noCompletions?: boolean;
    flowSourceOverride?: string;
  } = {},
) {
  const { flowSourceOverride, ...rest } = opts;
  // installRoot defaults to flowSource so the existing test fixtures
  // (which only override flowSource) keep recording fixture-rooted paths
  // in the manifest. Tests that exercise the worktree → install-root
  // divergence pass `flowSourceOverride` to drive flowSource away from
  // the canonical install-root fixture.
  return runSetup({
    ...rest,
    flowSource: flowSourceOverride ?? flowSource,
    installRoot: flowSource,
    targets: targets(),
    skipPreflight: true,
    manifestPath,
    lockPath,
    homeDir,
    quiet: true,
  });
}

describe("flow setup", () => {
  it("creates symlinks for every skill, agent, and helper from a fresh state", () => {
    const summary = setup();

    expect(summary.created).toBeGreaterThan(0);
    expect(summary.blocked).toBe(0);

    const t = targets();
    expect(fs.lstatSync(path.join(t.skillsDir, "alpha")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(t.skillsDir, "beta")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(t.agentsDir, "reviewer.md")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(t.binDir, "flow-helper")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(t.binDir, "flow")).isSymbolicLink()).toBe(true);
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

  it("writes a manifest recording every symlink it created", () => {
    setup();
    const manifest = readManifest(manifestPath);
    const targets_ = manifest.symlinks.map((s) => path.basename(s.target));
    expect(targets_).toContain("alpha");
    expect(targets_).toContain("reviewer.md");
    expect(targets_).toContain("flow-helper");
    expect(targets_).toContain("flow");
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
    expect(fs.readFileSync(path.join(t.skillsDir, "alpha"), "utf8")).toBe("user content");
  });

  it("--force replaces a non-symlink file at the target", () => {
    const t = targets();
    fs.mkdirSync(t.binDir, { recursive: true });
    fs.writeFileSync(path.join(t.binDir, "flow-helper"), "old content");
    const summary = setup({ force: true });
    expect(summary.blocked).toBe(0);
    expect(fs.lstatSync(path.join(t.binDir, "flow-helper")).isSymbolicLink()).toBe(true);
  });

  it("--upgrade reaps orphan symlinks recorded in a previous manifest", () => {
    // First install — alpha + beta exist.
    setup();
    const t = targets();

    // Drop alpha from the source tree.
    fs.rmSync(path.join(flowSource, "skills", "pipeline", "alpha"), { recursive: true });

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
      expect(fs.lstatSync(path.join(completionsDir, "flow.bash")).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(completionsDir, "flow.zsh")).isSymbolicLink()).toBe(true);
    });

    it("records completion symlinks in the manifest with kind 'completion'", () => {
      setup();
      const manifest = readManifest(manifestPath);
      const completionEntries = manifest.symlinks.filter((s) => s.kind === "completion");
      expect(completionEntries.map((s) => path.basename(s.target)).sort()).toEqual([
        "flow.bash",
        "flow.zsh",
      ]);
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
    fs.rmSync(path.join(flowSource, "skills", "pipeline", "alpha"), { recursive: true });

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
    fs.rmSync(path.join(flowSource, "skills", "pipeline", "alpha"), { recursive: true });
    // And remove the user's replacement target so the symlink is dangling.
    fs.rmSync(userTarget, { recursive: true, force: true });

    const summary = setup({ upgrade: true });
    expect(summary.removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(t.skillsDir, "alpha"))).toBe(false);
  });

  describe("--source <worktree> recording + cleanup", () => {
    it("records install-root paths in the manifest when flowSource diverges from installRoot", () => {
      // Build a fake worktree alongside the install-root fixture, with one
      // extra skill that only exists in the worktree.
      const worktree = path.join(scratch, "worktree");
      buildFakeFlowSource(worktree);
      fs.mkdirSync(path.join(worktree, "skills", "pipeline", "epsilon"), { recursive: true });
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
      const epsilon = manifest.symlinks.find((s) => path.basename(s.target) === "epsilon");
      expect(epsilon?.source).toBe(path.join(flowSource, "skills", "pipeline", "epsilon"));
    });

    it("symlinks still point at the worktree's content during the in-flight session", () => {
      // The recording change must not break step-5.5's purpose: in-flight
      // worktree files have to be reachable through the install target.
      const worktree = path.join(scratch, "worktree");
      buildFakeFlowSource(worktree);
      fs.mkdirSync(path.join(worktree, "skills", "pipeline", "epsilon"), { recursive: true });
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
      expect(recordBefore?.source).toBe(path.join(flowSource, "bin", "flow-pipeline-only.ts"));

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
        manifestAfter.symlinks.some((s) => path.basename(s.target) === "flow-pipeline-only"),
      ).toBe(false);
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
  fs.writeFileSync(path.join(binDir, "flow-helper.ts"), "#!/usr/bin/env bun\n// helper\n");
  fs.writeFileSync(path.join(binDir, "flow-helper.test.ts"), "// test\n");
  fs.writeFileSync(path.join(binDir, "flow"), "#!/usr/bin/env bun\n// wrapper\n");

  // completions/flow.bash + completions/flow.zsh
  const completionsDir = path.join(root, "completions");
  fs.mkdirSync(completionsDir, { recursive: true });
  fs.writeFileSync(path.join(completionsDir, "flow.bash"), "# fake bash completion\n");
  fs.writeFileSync(path.join(completionsDir, "flow.zsh"), "#compdef flow\n# fake\n");
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
