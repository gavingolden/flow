/**
 * Tests for `flow epic`. F5 rewires `create` from a resolve-and-print stub to
 * a window-spawn (mirroring `flow new`): it opens a tmux window running the
 * `/epic-create` supervisor and writes initial epic state. So the `create`
 * specs now mock `./tmux` (like new.test.ts) and assert state + seed prompt;
 * the help / deferred-subcommand / usage specs stay side-effect-free.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock tmux primitives so the create/resume paths don't shell out. Mirrors
// new.test.ts's seam: the verified wrappers default to ok so happy paths pass.
const tmuxMock = vi.hoisted(() => ({
  windowExists: vi.fn<(name: string) => boolean>(() => false),
  isPaneAlive: vi.fn<(name: string) => boolean>(() => false),
  createWindowVerified: vi.fn<
    (
      name: string,
      cwd: string,
      command: string[],
    ) => { ok: boolean; stderr: string }
  >(() => ({ ok: true, stderr: "" })),
  respawnWindowVerified: vi.fn<
    (
      name: string,
      cwd: string,
      command: string[],
    ) => { ok: boolean; stderr: string }
  >(() => ({ ok: true, stderr: "" })),
  FLOW_SESSION: "flow",
}));
vi.mock("./tmux", () => tmuxMock);

import { runEpicCli } from "./epic";
import { writeState } from "./state";

let logs!: string[];
let errors!: string[];
let stateDir!: string;
let repoDir!: string;

beforeEach(() => {
  logs = [];
  errors = [];
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-"));
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-repo-"));
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  tmuxMock.windowExists.mockReset().mockReturnValue(false);
  tmuxMock.isPaneAlive.mockReset().mockReturnValue(false);
  tmuxMock.createWindowVerified
    .mockReset()
    .mockReturnValue({ ok: true, stderr: "" });
  tmuxMock.respawnWindowVerified
    .mockReset()
    .mockReturnValue({ ok: true, stderr: "" });
});

// runCreate probes windowExists twice now: the up-front "already exists" guard
// (false = proceed) and the pre-persist Mode-2 re-check (true = window still
// present). Default both for a happy fresh launch. Resume tests are unaffected
// (runEpicResume calls windowExists once) and keep the beforeEach default.
function freshWindowOk(): void {
  tmuxMock.windowExists
    .mockReset()
    .mockReturnValueOnce(false)
    .mockReturnValue(true);
}

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runEpicCli — verb-level help", () => {
  for (const flag of ["--help", "-h"]) {
    it(`['${flag}'] returns 0, emits help, no minted-slug notice`, () => {
      const code = runEpicCli([flag], { stateDir });
      expect(code).toBe(0);
      expect(logs.length).toBeGreaterThan(0);
      // The verb help must not have spawned a window as a side effect.
      expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
      expect(fs.readdirSync(stateDir)).toEqual([]);
    });
  }
});

describe("runEpicCli create — help short-circuit (no side effect)", () => {
  it("['create','--help'] returns 0, emits the create-specific help, no side effect", () => {
    const code = runEpicCli(["create", "--help"], { stateDir });
    expect(code).toBe(0);
    expect(logs.length).toBeGreaterThan(0);
    const joined = logs.join("\n");
    // Must reach runCreate's create-specific help, NOT the verb-level help.
    // The create help names `flow epic create`; the verb help (printVerbHelp)
    // additionally lists the run/status/ls subcommands, so the absence of
    // `run <id>` discriminates create-help from verb-help.
    expect(joined).toContain("flow epic create");
    expect(joined).not.toContain("run <id>");
    // create --help must NOT spawn a window or write state.
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });
});

describe("runEpicCli create — window spawn (fresh)", () => {
  it("spawns a window + writes epic 'starting' state with the literal EPIC_DIR seed", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runEpicCli(["create", "add a watchlist feature"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(0);
    // First line is the machine-read contract token.
    expect(logs[0]).toBe("flow:add-watchlist-feature");

    // State written at phase 'starting' (the supervisor advances it).
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(stateDir, "add-watchlist-feature.json"),
        "utf8",
      ),
    );
    expect(raw.phase).toBe("starting");
    expect(raw.slug).toBe("add-watchlist-feature");

    // The seed prompt embeds the resolved literal EPIC_DIR (R1) so the
    // spawned window never re-derives the path nor imports bin/lib.
    const [, cwd, command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(cwd).toBe(fs.realpathSync(repoDir));
    const seed = command[command.length - 1];
    expect(seed).toContain(
      "Use the /epic-create skill for: add a watchlist feature",
    );
    expect(seed).toContain(".flow/epics/add-watchlist-feature");
    // --add-dir <worktree> precedes the prompt (claude parses it as an option).
    expect(command).toContain("--add-dir");
    expect(command.indexOf("--add-dir")).toBeLessThan(command.length - 1);
  });

  it("does NOT merge or launch any feature window (no respawn on a fresh create)", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runEpicCli(["create", "design the thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(0);
    expect(tmuxMock.createWindowVerified).toHaveBeenCalledTimes(1);
    expect(tmuxMock.respawnWindowVerified).not.toHaveBeenCalled();
  });

  it("refuses (exit 2, no state) when a window already exists for the slug", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    tmuxMock.windowExists.mockReturnValue(true);
    const code = runEpicCli(["create", "design the thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(2);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(errors.join("\n")).toMatch(/already exists/);
  });

  it("surfaces the tmux failure and writes no state when the verified create returns non-ok", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    tmuxMock.createWindowVerified.mockReturnValue({
      ok: false,
      stderr: "pane not alive after launch",
    });
    const code = runEpicCli(["create", "design the thing"], {
      stateDir,
      cwd: repoDir,
      retrySleepMs: 0,
    });
    expect(code).toBe(2);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(errors.join("\n")).toMatch(/claude exited immediately after launch/);
  });

  it("MODE 2 (window vanished after verify): a missing window at the pre-persist re-check writes no state and exits non-zero", () => {
    // Mirrors new.test.ts's Mode-2 case: the launcher reports ok (a live, seeded
    // window), but the window vanishes before the state write (racing kill / tmux
    // bounce). The pre-persist windowExists re-check catches it: guard #1 false →
    // proceed; re-check #2 false → vanished. No state, exit 2, the vanished error.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    tmuxMock.createWindowVerified.mockReturnValue({ ok: true, stderr: "" });
    tmuxMock.windowExists
      .mockReset()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);
    const code = runEpicCli(["create", "design the thing"], {
      stateDir,
      cwd: repoDir,
      retrySleepMs: 0,
    });
    expect(code).toBe(2);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(errors.join("\n")).toMatch(/vanished after launch/);
  });
});

describe("runEpicCli create --resume", () => {
  function seedEpicState(slug: string, repo = repoDir): void {
    writeState(
      {
        slug,
        phase: "epic-designing",
        repo,
        updatedAt: new Date().toISOString(),
      },
      stateDir,
    );
  }

  it("respawns the existing window with the resume seed + literal EPIC_DIR when present + dead pane", () => {
    seedEpicState("crashed-epic");
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);
    const code = runEpicCli(["create", "--resume", "crashed-epic"], {
      stateDir,
    });
    expect(code).toBe(0);
    expect(tmuxMock.respawnWindowVerified).toHaveBeenCalledTimes(1);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
    const [, cwd, command] = tmuxMock.respawnWindowVerified.mock.calls[0]!;
    expect(cwd).toBe(repoDir);
    const seed = command[command.length - 1];
    expect(seed).toContain(
      "Use the /epic-create skill in --resume mode for: crashed-epic",
    );
    expect(seed).toContain(".flow/epics/crashed-epic");
    expect(logs[0]).toBe("flow:crashed-epic");
  });

  it("recreates the window when tmux has lost it (no window, dead pane)", () => {
    seedEpicState("tmux-bounced-epic");
    tmuxMock.windowExists.mockReturnValue(false);
    const code = runEpicCli(["create", "--resume", "tmux-bounced-epic"], {
      stateDir,
    });
    expect(code).toBe(0);
    expect(tmuxMock.createWindowVerified).toHaveBeenCalledTimes(1);
    expect(tmuxMock.respawnWindowVerified).not.toHaveBeenCalled();
  });

  it("refuses (exit 2) when no state file exists for the slug", () => {
    const code = runEpicCli(["create", "--resume", "ghost-epic"], { stateDir });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/no epic state for 'ghost-epic'/);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
  });

  it("refuses (exit 2) when the pane is still alive (live supervisor)", () => {
    seedEpicState("alive-epic");
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(true);
    const code = runEpicCli(["create", "--resume", "alive-epic"], { stateDir });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/is still running/);
    expect(tmuxMock.respawnWindowVerified).not.toHaveBeenCalled();
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
  });

  it("does not rewrite state.json on entry (the supervisor's first transition does)", () => {
    seedEpicState("preserve-epic");
    tmuxMock.windowExists.mockReturnValue(true);
    const before = fs.readFileSync(
      path.join(stateDir, "preserve-epic.json"),
      "utf8",
    );
    runEpicCli(["create", "--resume", "preserve-epic"], { stateDir });
    const after = fs.readFileSync(
      path.join(stateDir, "preserve-epic.json"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("rejects a slug that is not already a valid slug", () => {
    const code = runEpicCli(["create", "--resume", "Not A Slug"], { stateDir });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/not a valid epic slug/);
  });
});

describe("runEpicCli deferred subcommands", () => {
  it("['run','some-id'] returns 2 and names the orchestrator run phase on stderr", () => {
    const code = runEpicCli(["run", "some-id"], { stateDir });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/run phase/);
  });

  it("['status','some-id'] returns 2 with a deferred message that does NOT name the run phase", () => {
    const code = runEpicCli(["status", "some-id"], { stateDir });
    expect(code).toBe(2);
    const joined = errors.join("\n");
    expect(joined).toContain("deferred");
    expect(joined).not.toMatch(/run phase/);
  });

  it("['ls'] returns 2 with a deferred message that does NOT name the run phase", () => {
    const code = runEpicCli(["ls"], { stateDir });
    expect(code).toBe(2);
    const joined = errors.join("\n");
    expect(joined).toContain("deferred");
    expect(joined).not.toMatch(/run phase/);
  });
});

describe("runEpicCli usage errors", () => {
  it("[] (no subcommand) returns 2 with a usage message on stderr", () => {
    const code = runEpicCli([], { stateDir });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/usage/i);
  });

  it("['frobnicate'] (unknown) returns 2 with an unknown-subcommand message", () => {
    const code = runEpicCli(["frobnicate"], { stateDir });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/unknown epic subcommand/);
  });

  it("['create'] (empty prompt) returns 2 with a usage message on stderr", () => {
    const code = runEpicCli(["create"], { stateDir });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/usage|required/i);
  });
});
