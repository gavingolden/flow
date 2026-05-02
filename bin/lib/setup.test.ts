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
  };
}

function setup(opts: { upgrade?: boolean; force?: boolean; lockTimeoutMs?: number } = {}) {
  return runSetup({
    ...opts,
    flowSource,
    targets: targets(),
    skipPreflight: true,
    manifestPath,
    lockPath,
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
    fs.writeFileSync(lockPath, "999999");
    const summary = setup({ lockTimeoutMs: 1000 });
    expect(summary.created).toBeGreaterThan(0);
    expect(fs.existsSync(lockPath)).toBe(false);
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
}
