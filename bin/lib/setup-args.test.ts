import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSetupArgs, runSetupCli } from "./setup-args";

describe("parseSetupArgs", () => {
  it("returns all-false defaults for an empty arg list", () => {
    expect(parseSetupArgs([])).toEqual({ upgrade: false, force: false, noCompletions: false });
  });

  it("recognizes --upgrade", () => {
    expect(parseSetupArgs(["--upgrade"])).toEqual({
      upgrade: true,
      force: false,
      noCompletions: false,
    });
  });

  it("recognizes --force", () => {
    expect(parseSetupArgs(["--force"])).toEqual({
      upgrade: false,
      force: true,
      noCompletions: false,
    });
  });

  it("recognizes --no-completions", () => {
    expect(parseSetupArgs(["--no-completions"])).toEqual({
      upgrade: false,
      force: false,
      noCompletions: true,
    });
  });

  it("captures the path argument after --source", () => {
    expect(parseSetupArgs(["--source", "/abs/path"])).toEqual({
      upgrade: false,
      force: false,
      noCompletions: false,
      flowSource: "/abs/path",
    });
  });

  it("combines all flags in any order", () => {
    expect(
      parseSetupArgs(["--upgrade", "--force", "--no-completions", "--source", "/x"]),
    ).toEqual({
      upgrade: true,
      force: true,
      noCompletions: true,
      flowSource: "/x",
    });
    expect(
      parseSetupArgs(["--source", "/x", "--force", "--upgrade", "--no-completions"]),
    ).toEqual({
      upgrade: true,
      force: true,
      noCompletions: true,
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

  it("returns exit code 2 on a parser error and prints to stderr", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = runSetupCli(["--bogus"]);
    expect(code).toBe(2);
    expect(errSpy).toHaveBeenCalledWith("flow setup: unknown option '--bogus'");
    expect(errSpy).toHaveBeenCalledWith(
      "usage: flow setup [--upgrade] [--force] [--source <path>] [--no-completions]",
    );
    errSpy.mockRestore();
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
      quiet: true,
    });
    expect(code).toBe(0);
    const t = targets();
    const linkRealpath = fs.realpathSync(path.join(t.skillsDir, "alpha"));
    const altRealpath = fs.realpathSync(altSource);
    expect(linkRealpath.startsWith(altRealpath)).toBe(true);
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
