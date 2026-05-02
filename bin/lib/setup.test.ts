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
  } = {},
) {
  return runSetup({
    ...opts,
    flowSource,
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
    expect(summary.removed).toBe(0); // refused — not pointing at flow source
    expect(fs.existsSync(path.join(t.skillsDir, "alpha"))).toBe(true);

    fs.rmSync(userTarget, { recursive: true, force: true });
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
