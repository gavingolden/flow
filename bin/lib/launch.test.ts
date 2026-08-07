import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELP_TOP } from "./help";
import { buildInteractiveLaunchArgv, runLaunchCli } from "./launch";
import { FLOW_CLAUDE_HOME, resolveFlowSource } from "./paths";
import { ensurePluginRoot } from "./plugin-root";

const HOME = "/home/dev/.flow/claude-home";

let originalPath: string | undefined;

beforeEach(() => {
  originalPath = process.env.PATH;
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

describe("buildInteractiveLaunchArgv", () => {
  it("is exactly `claude --add-dir <claude-home>` — no --settings, no FLOW_PIPELINE=1, no --plugin-dir (no materialized roots)", () => {
    expect(buildInteractiveLaunchArgv(HOME)).toEqual([
      "claude",
      "--add-dir",
      HOME,
    ]);
  });

  it("defaults to FLOW_CLAUDE_HOME when no home is passed", () => {
    // pluginRootsScan pinned to () => [] — FLOW_CLAUDE_HOME derives from
    // paths.ts's import-time `HOME = os.homedir()`, which vitest.setup.ts
    // explicitly does NOT sandbox, so an unpinned scan would read the
    // developer's real ~/.flow/claude-home/.claude/skills and go red the
    // moment `flow install` has materialized any plugin root there.
    expect(buildInteractiveLaunchArgv(undefined, () => [])).toEqual([
      "claude",
      "--add-dir",
      FLOW_CLAUDE_HOME,
    ]);
  });

  it("carries one --plugin-dir pair per materialized root under <claudeHome>/.claude/skills", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-launch-"));
    try {
      const claudeHome = path.join(scratch, "claude-home");
      const skillsDir = path.join(claudeHome, ".claude", "skills");
      const root = path.join(skillsDir, "flow-module-copilot");
      ensurePluginRoot({
        root,
        moduleId: "copilot",
        flowSource: resolveFlowSource(),
        version: "1.0.0",
        includeSkills: false,
        force: false,
      });
      expect(buildInteractiveLaunchArgv(claudeHome)).toEqual([
        "claude",
        "--add-dir",
        claudeHome,
        "--plugin-dir",
        root,
      ]);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("runLaunchCli", () => {
  it("on a TTY spawns `claude --add-dir <home>` and returns the child exit code", () => {
    const spawned: string[][] = [];
    const code = runLaunchCli({
      isTTY: true,
      claudeHome: HOME,
      existsDir: () => true,
      spawn: (argv) => {
        spawned.push(argv);
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(spawned).toEqual([["claude", "--add-dir", HOME]]);
  });

  it("propagates the child's non-zero exit code", () => {
    const code = runLaunchCli({
      isTTY: true,
      claudeHome: HOME,
      existsDir: () => true,
      spawn: () => 42,
    });
    expect(code).toBe(42);
  });

  it("off a TTY prints top help, returns 0, and never spawns", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const spawn = vi.fn(() => 0);
    const code = runLaunchCli({ isTTY: false, claudeHome: HOME, spawn });
    expect(code).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(HELP_TOP);
    log.mockRestore();
  });

  it("when the skills home is missing, emits a dim notice naming `flow install` and still launches", () => {
    const logs: string[] = [];
    const spawned: string[][] = [];
    const code = runLaunchCli({
      isTTY: true,
      claudeHome: HOME,
      existsDir: () => false,
      log: (s) => logs.push(s),
      spawn: (argv) => {
        spawned.push(argv);
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("flow install");
    expect(logs.join("\n")).toContain(HOME);
    expect(spawned).toEqual([["claude", "--add-dir", HOME]]); // launch still proceeds
  });

  it("with no materialized roots, the argv is unchanged from today and PATH is not mutated", () => {
    process.env.PATH = "/usr/bin:/bin";
    const spawned: string[][] = [];
    runLaunchCli({
      isTTY: true,
      claudeHome: HOME,
      existsDir: () => true,
      spawn: (argv) => {
        spawned.push(argv);
        return 0;
      },
    });
    expect(spawned).toEqual([["claude", "--add-dir", HOME]]);
    expect(process.env.PATH).toBe("/usr/bin:/bin");
  });

  it("with two materialized roots, the argv carries exactly two --plugin-dir pairs in scan order, and PATH is prefixed with both bin dirs", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-launch-"));
    try {
      const claudeHome = path.join(scratch, "claude-home");
      const skillsDir = path.join(claudeHome, ".claude", "skills");
      const rootA = path.join(skillsDir, "flow-module-copilot");
      const rootB = path.join(skillsDir, "flow-module-research");
      for (const [root, moduleId] of [
        [rootA, "copilot"],
        [rootB, "research"],
      ] as const) {
        ensurePluginRoot({
          root,
          moduleId,
          flowSource: resolveFlowSource(),
          version: "1.0.0",
          includeSkills: false,
          force: false,
        });
      }
      process.env.PATH = "/usr/bin:/bin";
      const spawned: string[][] = [];
      runLaunchCli({
        isTTY: true,
        claudeHome,
        existsDir: () => true,
        spawn: (argv) => {
          spawned.push(argv);
          return 0;
        },
      });
      expect(spawned).toEqual([
        [
          "claude",
          "--add-dir",
          claudeHome,
          "--plugin-dir",
          rootA,
          "--plugin-dir",
          rootB,
        ],
      ]);
      expect(process.env.PATH).toBe(
        `${path.join(rootA, "bin")}:${path.join(rootB, "bin")}:/usr/bin:/bin`,
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("does not double-prepend the plugin PATH prefix when it is already leading", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-launch-"));
    try {
      const claudeHome = path.join(scratch, "claude-home");
      const skillsDir = path.join(claudeHome, ".claude", "skills");
      const root = path.join(skillsDir, "flow-module-copilot");
      ensurePluginRoot({
        root,
        moduleId: "copilot",
        flowSource: resolveFlowSource(),
        version: "1.0.0",
        includeSkills: false,
        force: false,
      });
      const prefix = path.join(root, "bin");
      process.env.PATH = `${prefix}:/usr/bin:/bin`;
      runLaunchCli({
        isTTY: true,
        claudeHome,
        existsDir: () => true,
        spawn: () => 0,
      });
      expect(process.env.PATH).toBe(`${prefix}:/usr/bin:/bin`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("a root whose bin/ does not exist contributes a --plugin-dir entry but no PATH segment", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-launch-"));
    try {
      const claudeHome = path.join(scratch, "claude-home");
      const skillsDir = path.join(claudeHome, ".claude", "skills");
      const root = path.join(skillsDir, "flow-module-stack-svelte");
      ensurePluginRoot({
        root,
        moduleId: "stack-svelte",
        flowSource: resolveFlowSource(),
        version: "1.0.0",
        includeSkills: false,
        force: false,
      });
      expect(fs.existsSync(path.join(root, "bin"))).toBe(false);
      process.env.PATH = "/usr/bin:/bin";
      const spawned: string[][] = [];
      runLaunchCli({
        isTTY: true,
        claudeHome,
        existsDir: () => true,
        spawn: (argv) => {
          spawned.push(argv);
          return 0;
        },
      });
      expect(spawned).toEqual([
        ["claude", "--add-dir", claudeHome, "--plugin-dir", root],
      ]);
      expect(process.env.PATH).toBe("/usr/bin:/bin");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
