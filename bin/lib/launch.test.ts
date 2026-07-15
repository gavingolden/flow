import { describe, expect, it, vi } from "vitest";
import { HELP_TOP } from "./help";
import { buildInteractiveLaunchArgv, runLaunchCli } from "./launch";
import { FLOW_CLAUDE_HOME } from "./paths";

const HOME = "/home/dev/.flow/claude-home";

describe("buildInteractiveLaunchArgv", () => {
  it("is exactly `claude --add-dir <claude-home>` — no --settings, no FLOW_PIPELINE=1", () => {
    expect(buildInteractiveLaunchArgv(HOME)).toEqual([
      "claude",
      "--add-dir",
      HOME,
    ]);
  });

  it("defaults to FLOW_CLAUDE_HOME when no home is passed", () => {
    expect(buildInteractiveLaunchArgv()).toEqual([
      "claude",
      "--add-dir",
      FLOW_CLAUDE_HOME,
    ]);
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
});
