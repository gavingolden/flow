import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSetupArgs, runSetupCli } from "./setup-args";

describe("parseSetupArgs", () => {
  it("returns all-false defaults for an empty arg list", () => {
    expect(parseSetupArgs([])).toEqual({
      upgrade: false,
      force: false,
      noCompletions: false,
      noHooks: false,
      pullCanonical: true,
      repairSettings: false,
      installDeps: false,
    });
  });

  it("recognizes --upgrade", () => {
    expect(parseSetupArgs(["--upgrade"])).toEqual({
      upgrade: true,
      force: false,
      noCompletions: false,
      noHooks: false,
      pullCanonical: true,
      repairSettings: false,
      installDeps: false,
    });
  });

  it("recognizes --force", () => {
    expect(parseSetupArgs(["--force"])).toEqual({
      upgrade: false,
      force: true,
      noCompletions: false,
      noHooks: false,
      pullCanonical: true,
      repairSettings: false,
      installDeps: false,
    });
  });

  it("recognizes --no-completions", () => {
    expect(parseSetupArgs(["--no-completions"])).toEqual({
      upgrade: false,
      force: false,
      noCompletions: true,
      noHooks: false,
      pullCanonical: true,
      repairSettings: false,
      installDeps: false,
    });
  });

  it("recognizes --no-hooks", () => {
    expect(parseSetupArgs(["--no-hooks"])).toEqual({
      upgrade: false,
      force: false,
      noCompletions: false,
      noHooks: true,
      pullCanonical: true,
      repairSettings: false,
      installDeps: false,
    });
  });

  it("recognizes --no-pull-canonical (defaults to true; flag flips it false)", () => {
    expect(parseSetupArgs(["--no-pull-canonical"])).toEqual({
      upgrade: false,
      force: false,
      noCompletions: false,
      noHooks: false,
      pullCanonical: false,
      repairSettings: false,
      installDeps: false,
    });
  });

  it("recognizes --upgrade --no-pull-canonical together", () => {
    expect(parseSetupArgs(["--upgrade", "--no-pull-canonical"])).toEqual({
      upgrade: true,
      force: false,
      noCompletions: false,
      noHooks: false,
      pullCanonical: false,
      repairSettings: false,
      installDeps: false,
    });
  });

  it("recognizes --repair-settings", () => {
    expect(parseSetupArgs(["--repair-settings"])).toEqual({
      upgrade: false,
      force: false,
      noCompletions: false,
      noHooks: false,
      pullCanonical: true,
      repairSettings: true,
      installDeps: false,
    });
  });

  it("recognizes --install-deps", () => {
    expect(parseSetupArgs(["--install-deps"])).toEqual({
      upgrade: false,
      force: false,
      noCompletions: false,
      noHooks: false,
      pullCanonical: true,
      repairSettings: false,
      installDeps: true,
    });
  });

  it("errors when --source is followed by --repair-settings instead of a path", () => {
    const result = parseSetupArgs(["--source", "--repair-settings"]);
    expect(result).toEqual({
      error: "flow setup: --source requires a path argument",
    });
  });

  it("rejects --no-pull-canonical as a value after --source", () => {
    // Symmetric guard to --no-completions / --no-hooks: a boolean flag must
    // not silently capture as a path value.
    const result = parseSetupArgs(["--source", "--no-pull-canonical"]);
    expect(result).toEqual({
      error: "flow setup: --source requires a path argument",
    });
  });

  it("captures the path argument after --source", () => {
    expect(parseSetupArgs(["--source", "/abs/path"])).toEqual({
      upgrade: false,
      force: false,
      noCompletions: false,
      noHooks: false,
      pullCanonical: true,
      repairSettings: false,
      installDeps: false,
      flowSource: "/abs/path",
    });
  });

  it("combines all flags in any order", () => {
    expect(
      parseSetupArgs([
        "--upgrade",
        "--force",
        "--no-completions",
        "--no-hooks",
        "--no-pull-canonical",
        "--source",
        "/x",
      ]),
    ).toEqual({
      upgrade: true,
      force: true,
      noCompletions: true,
      noHooks: true,
      pullCanonical: false,
      repairSettings: false,
      installDeps: false,
      flowSource: "/x",
    });
    expect(
      parseSetupArgs([
        "--source",
        "/x",
        "--force",
        "--upgrade",
        "--no-completions",
        "--no-hooks",
        "--no-pull-canonical",
      ]),
    ).toEqual({
      upgrade: true,
      force: true,
      noCompletions: true,
      noHooks: true,
      pullCanonical: false,
      repairSettings: false,
      installDeps: false,
      flowSource: "/x",
    });
  });

  it("errors when --source is the last token (no value)", () => {
    const result = parseSetupArgs(["--source"]);
    expect(result).toEqual({
      error: "flow setup: --source requires a path argument",
    });
  });

  it("errors when --source is followed by another flag instead of a path", () => {
    const result = parseSetupArgs(["--source", "--upgrade"]);
    expect(result).toEqual({
      error: "flow setup: --source requires a path argument",
    });
  });

  it("errors when --source is followed by --no-completions instead of a path", () => {
    const result = parseSetupArgs(["--source", "--no-completions"]);
    expect(result).toEqual({
      error: "flow setup: --source requires a path argument",
    });
  });

  it("errors when --source is followed by --no-hooks instead of a path", () => {
    const result = parseSetupArgs(["--source", "--no-hooks"]);
    expect(result).toEqual({
      error: "flow setup: --source requires a path argument",
    });
  });

  it("errors on an unknown flag", () => {
    const result = parseSetupArgs(["--bogus"]);
    expect(result).toEqual({
      error: "flow setup: unknown option '--bogus'",
    });
  });

  it("errors on an unknown flag even after valid flags", () => {
    const result = parseSetupArgs(["--upgrade", "--mystery"]);
    expect(result).toEqual({
      error: "flow setup: unknown option '--mystery'",
    });
  });

  it("still rejects a genuinely unknown flag alongside --install-deps", () => {
    // The new flag must not widen the unknown-flag rejection path.
    const result = parseSetupArgs(["--install-deps", "--bogus"]);
    expect(result).toEqual({
      error: "flow setup: unknown option '--bogus'",
    });
  });

  it("rejects --no-hooks combined with --repair-settings (mutually exclusive)", () => {
    // --no-hooks opts out of touching settings.json; --repair-settings is a
    // settings.json recovery mode. The combination is silently a no-op on
    // the repair branch, so reject at the parser layer.
    const result = parseSetupArgs(["--no-hooks", "--repair-settings"]);
    expect(result).toEqual({
      error: "flow setup: --no-hooks and --repair-settings are mutually exclusive",
    });
  });

  it("rejects --repair-settings followed by --no-hooks (order-independent)", () => {
    const result = parseSetupArgs(["--repair-settings", "--no-hooks"]);
    expect(result).toEqual({
      error: "flow setup: --no-hooks and --repair-settings are mutually exclusive",
    });
  });
});

describe("runSetupCli", () => {
  let scratch!: string;
  let flowSource!: string;
  let homeDir!: string;
  let manifestPath!: string;
  let lockPath!: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-cli-"));
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

  function cli(args: string[]) {
    return runSetupCli(args, {
      flowSource,
      targets: targets(),
      skipPreflight: true,
      manifestPath,
      lockPath,
      homeDir,
      settingsPath: path.join(homeDir, ".claude", "settings.json"),
      quiet: true,
    });
  }

  it("returns exit code 0 when no targets are blocked", () => {
    expect(cli([])).toBe(0);
  });

  it("returns exit code 1 when at least one target is blocked", () => {
    const t = targets();
    fs.mkdirSync(t.skillsDir, { recursive: true });
    fs.writeFileSync(path.join(t.skillsDir, "alpha"), "user content");
    expect(cli([])).toBe(1);
  });

  it("returns exit code 1 when validationFailures > 0 (malformed JSON at a validated path)", () => {
    // Plant a malformed settings.json at the path the validator scans. The
    // ensureStopHook safe-bailout will refuse to overwrite it (preserving
    // user data), then end-of-run validation flips the exit code.
    const settingsP = path.join(homeDir, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsP), { recursive: true });
    fs.writeFileSync(settingsP, "{not valid json");
    expect(cli([])).toBe(1);
    // Malformed content survives — the safe-bailout never stomped it.
    expect(fs.readFileSync(settingsP, "utf8")).toBe("{not valid json");
  });

  it("returns exit code 1 when summary.missingRuntimeDeps > 0 (declared dep not in node_modules)", () => {
    // installRoot's package.json declares a runtime dep that has no
    // node_modules/<name>/package.json — the dep-resolution check populates
    // summary.missingRuntimeDeps and the CLI flips the exit code.
    fs.writeFileSync(
      path.join(flowSource, "package.json"),
      JSON.stringify({ dependencies: { picomatch: "^4.0.0" } }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const code = runSetupCli([], {
        flowSource,
        installRoot: flowSource,
        targets: targets(),
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: path.join(homeDir, ".claude", "settings.json"),
      });
      expect(code).toBe(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("returns exit code 2 on a parser error and prints to stderr", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = runSetupCli(["--bogus"]);
    expect(code).toBe(2);
    expect(errSpy).toHaveBeenCalledWith("flow setup: unknown option '--bogus'");
    expect(errSpy).toHaveBeenCalledWith(
      "usage: flow setup [--upgrade] [--force] [--source <path>] [--no-completions] [--no-hooks] [--no-pull-canonical] [--repair-settings] [--install-deps]",
    );
    errSpy.mockRestore();
  });

  it("prints help and returns 0 for --help / -h, before parseSetupArgs runs", () => {
    // Regression: parseSetupArgs(["--help"]) returns an unknown-option error.
    // The CLI shim must intercept --help/-h before delegating to the parser.
    for (const flag of ["--help", "-h"]) {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const code = runSetupCli([flag]);
      expect(code).toBe(0);
      expect(log).toHaveBeenCalled();
      expect(log.mock.calls[0][0]).toMatch(/^flow setup — install skills/);
      expect(err).not.toHaveBeenCalled();
      log.mockRestore();
      err.mockRestore();
    }
  });

  it("forwards --source to runSetup as flowSource", () => {
    // Move flow-src under a fresh location and target it via --source.
    // On macOS, /tmp is a symlink to /private/tmp, so compare via realpath
    // — runSetup uses the path as given, but `scratch` may resolve to a
    // different prefix than the symlink content reports.
    const altSource = path.join(scratch, "alt-src");
    buildFakeFlowSource(altSource);
    const code = runSetupCli(["--source", altSource], {
      // omit flowSource here — runSetupCli should derive it from --source
      targets: targets(),
      skipPreflight: true,
      manifestPath,
      lockPath,
      homeDir,
      quiet: true,
    });
    expect(code).toBe(0);
    const t = targets();
    const linkRealpath = fs.realpathSync(path.join(t.skillsDir, "alpha"));
    const altRealpath = fs.realpathSync(altSource);
    expect(linkRealpath.startsWith(altRealpath)).toBe(true);
  });

  it("vitest.setup.ts's global net redirects process.env.HOME under os.tmpdir()", () => {
    // Replaces a manual "temporarily console.log(process.env.HOME) and revert"
    // step from the PR Test Steps. If vitest.config.ts ever drops setupFiles,
    // or vitest.setup.ts's beforeAll ever fails to flip HOME, this assertion
    // catches it without a human edit-and-revert.
    const home = process.env.HOME;
    expect(home).toBeDefined();
    const tmpReal = fs.realpathSync(os.tmpdir());
    const homeReal = fs.realpathSync(home as string);
    expect(homeReal.startsWith(tmpReal)).toBe(true);
    expect(path.basename(home as string)).toMatch(/^flow-vitest-home-/);
  });

  it("plumbs pullCanonicalFirst=false through to runSetup when --no-pull-canonical is passed", () => {
    // The fake flow-source fixture is not a git repo, so the default
    // upgrade path would log `canonical: skipped (not-a-git-repo)` via
    // runSetup's fast-forward best-effort branch. With --no-pull-canonical
    // the CLI must skip that branch entirely, so the line must not appear.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const code = runSetupCli(["--upgrade", "--no-pull-canonical"], {
        flowSource,
        installRoot: flowSource,
        targets: targets(),
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: path.join(homeDir, ".claude", "settings.json"),
        // quiet: false so the canonical line would surface if plumbing broke
      });
      expect(code).toBe(0);
      const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(allLogs).not.toMatch(/canonical:/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs canonical: skipped on --upgrade alone (default pullCanonical=true) when fixture is not a git repo", () => {
    // Symmetric counterpart to the assertion above: confirms the default
    // path actually fires the FF probe (and falls through to skipped/
    // not-a-git-repo on the fake fixture).
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const code = runSetupCli(["--upgrade"], {
        flowSource,
        installRoot: flowSource,
        targets: targets(),
        skipPreflight: true,
        manifestPath,
        lockPath,
        homeDir,
        settingsPath: path.join(homeDir, ".claude", "settings.json"),
      });
      expect(code).toBe(0);
      const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(allLogs).toMatch(/canonical: skipped \(not-a-git-repo\)/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("writes the completions rc-block inside the sandboxed homeDir, not the real $HOME", () => {
    // Regression for the leak that stamped a stale `/var/folders/.../flow-cli-…`
    // path into a real ~/.zshrc. If `cli()` ever drops `homeDir`, the block
    // lands in the real home and this assertion fails — because the sandboxed
    // .zshrc gets nothing.
    fs.mkdirSync(homeDir, { recursive: true });
    const sandboxedZshrc = path.join(homeDir, ".zshrc");
    fs.writeFileSync(sandboxedZshrc, "");

    expect(cli([])).toBe(0);

    const expectedSourceLine = path.join(targets().completionsDir, "flow.zsh");
    const after = fs.readFileSync(sandboxedZshrc, "utf8");
    expect(after).toContain("# managed by flow completions");
    expect(after).toContain(expectedSourceLine);
  });
});

function buildFakeFlowSource(root: string): void {
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
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "reviewer.md"), "# reviewer\n");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "flow-helper.ts"), "#!/usr/bin/env bun\n// helper\n");
  fs.writeFileSync(path.join(binDir, "flow-helper.test.ts"), "// test\n");
  fs.writeFileSync(path.join(binDir, "flow"), "#!/usr/bin/env bun\n// wrapper\n");
}
