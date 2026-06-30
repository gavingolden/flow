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
  // The 4th arg is the seed (send-keys delivery); the 5th is the deps object
  // carrying the injected `consumed` state-file-poll predicate.
  createWindowVerified: vi.fn<
    (
      name: string,
      cwd: string,
      command: string[],
      seed?: string,
      deps?: { consumed?: () => boolean; onProgress?: (ms: number) => void },
    ) => {
      status: "started" | "launched-not-confirmed" | "failed";
      stderr: string;
    }
  >(() => ({ status: "started", stderr: "" })),
  respawnWindowVerified: vi.fn<
    (
      name: string,
      cwd: string,
      command: string[],
      seed?: string,
      deps?: { consumed?: () => boolean; onProgress?: (ms: number) => void },
    ) => {
      status: "started" | "launched-not-confirmed" | "failed";
      stderr: string;
    }
  >(() => ({ status: "started", stderr: "" })),
  FLOW_SESSION: "flow",
}));
vi.mock("./tmux", () => tmuxMock);

import { runEpicCli } from "./epic";
import { deriveWorktreePath } from "./new";
import { writeState } from "./state";
import { writeEpicRunState } from "./epic-run-state";

let logs!: string[];
let errors!: string[];
let stateDir!: string;
let repoDir!: string;
let epicsDir!: string;
let semDir!: string;

beforeEach(() => {
  logs = [];
  errors = [];
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-"));
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-repo-"));
  epicsDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-run-"));
  // Redirect the host-wide launch semaphore + the flow-scoped --settings file
  // off the real ~/.flow so the whole suite's launches stay hermetic (epic.ts
  // honors these env overrides).
  semDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-sem-"));
  process.env.FLOW_LAUNCH_SEM_DIR = semDir;
  process.env.FLOW_LAUNCH_SETTINGS_PATH = path.join(
    semDir,
    "launch-settings.json",
  );
  delete process.env.FLOW_LAUNCH_CONCURRENCY;
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
    .mockReturnValue({ status: "started", stderr: "" });
  tmuxMock.respawnWindowVerified
    .mockReset()
    .mockReturnValue({ status: "started", stderr: "" });
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
  fs.rmSync(epicsDir, { recursive: true, force: true });
  fs.rmSync(semDir, { recursive: true, force: true });
  delete process.env.FLOW_LAUNCH_SEM_DIR;
  delete process.env.FLOW_LAUNCH_SETTINGS_PATH;
  delete process.env.FLOW_LAUNCH_CONCURRENCY;
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

    // The seed (delivered via send-keys, the 4th arg — NOT a positional argv)
    // embeds the resolved literal EPIC_DIR (R1) so the spawned window never
    // re-derives the path nor imports bin/lib.
    const [, cwd, command, seed] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(cwd).toBe(fs.realpathSync(repoDir));
    expect(seed).toContain(
      "Use the /epic-create skill for: add a watchlist feature",
    );
    expect(seed).toContain(".flow/epics/add-watchlist-feature");
    // The seed also embeds the resolved product-planning SKILL_DIR (R1) so the
    // supervisor can pass a concrete path to its Task-spawned designer. Assert
    // the path-suffix, not an absolute host path — resolveFlowSource() resolves
    // to the live checkout under vitest.
    expect(seed).toContain("SKILL_DIR:");
    expect(seed).toContain("skills/pipeline/product-planning");
    // The argv carries --add-dir <worktree> + trailing --settings, NO
    // positional seed (length 5).
    expect(command).toHaveLength(5);
    expect(command[0]).toBe("claude");
    expect(command[1]).toBe("--add-dir");
    expect(command[3]).toBe("--settings");
    expect(command.some((a) => a.includes("Use the /epic-create skill"))).toBe(
      false,
    );
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
      status: "failed",
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

  it("writes epic state(phase=starting) BEFORE the verified launch (supervisor needs a file to advance)", () => {
    // Mirrors new.test.ts: the inverted persist gate writes state up front so the
    // /epic-create supervisor has a file to advance past `starting`.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    let phaseAtLaunch: string | null = null;
    tmuxMock.createWindowVerified.mockImplementation((name) => {
      try {
        phaseAtLaunch = JSON.parse(
          fs.readFileSync(path.join(stateDir, `${name}.json`), "utf8"),
        ).phase;
      } catch {
        phaseAtLaunch = null;
      }
      return { status: "started", stderr: "" };
    });
    const code = runEpicCli(["create", "design the thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(0);
    expect(phaseAtLaunch).toBe("starting");
  });

  it("fresh consume-timeout deletes the up-front epic state (no orphan under the inverted gate)", () => {
    // createWindowVerified ok:false (consume timed out) must delete the state
    // file runCreate wrote up front, so no orphaned `phase: starting` survives.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    tmuxMock.createWindowVerified.mockReturnValue({
      status: "failed",
      stderr: "the seed prompt was never consumed (supervisor did not start)",
    });
    const code = runEpicCli(["create", "design the thing"], {
      stateDir,
      cwd: repoDir,
      retrySleepMs: 0,
    });
    expect(code).toBe(2);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("wires a fresh consumed predicate that flips true once the phase advances past starting", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    let consumedFn: (() => boolean) | undefined;
    let launchedSlug: string | undefined;
    tmuxMock.createWindowVerified.mockImplementation(
      (name, _cwd, _command, _seed, deps) => {
        launchedSlug = name;
        consumedFn = deps?.consumed;
        return { status: "started", stderr: "" };
      },
    );
    const code = runEpicCli(["create", "add a watchlist feature"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(0);
    expect(consumedFn).toBeDefined();
    expect(launchedSlug).toBeDefined();
    expect(consumedFn!()).toBe(false);
    writeState(
      {
        slug: launchedSlug!,
        phase: "epic-designing",
        repo: fs.realpathSync(repoDir),
        updatedAt: new Date().toISOString(),
      },
      stateDir,
    );
    expect(consumedFn!()).toBe(true);
  });

  it("MODE 2 (window vanished after verify): a missing window at the pre-persist re-check writes no state and exits non-zero", () => {
    // Mirrors new.test.ts's Mode-2 case: the launcher reports ok (a live, seeded
    // window), but the window vanishes before the state write (racing kill / tmux
    // bounce). The pre-persist windowExists re-check catches it: guard #1 false →
    // proceed; re-check #2 false → vanished. No state, exit 2, the vanished error.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    tmuxMock.createWindowVerified.mockReturnValue({
      status: "started",
      stderr: "",
    });
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

  it("backoff schedule: failed attempts sleep 1s then 2s via the injected sleep spy", () => {
    // The flat short retry is replaced by an increasing 1s → 2s → 4s backoff.
    // With 3 failing attempts there are 2 inter-attempt gaps → [1000, 2000]. The
    // retrySleep seam is injected so the schedule is assertable without sleeping.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    tmuxMock.createWindowVerified.mockReturnValue({
      status: "failed",
      stderr: "transient",
    });
    const sleeps: number[] = [];
    const code = runEpicCli(["create", "design the thing"], {
      stateDir,
      cwd: repoDir,
      retrySleep: (ms) => sleeps.push(ms),
    });
    expect(code).not.toBe(0);
    expect(tmuxMock.createWindowVerified).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("launches claude with --add-dir <derived-worktree> and trailing --settings (bare env, hook written)", () => {
    // LOAD-BEARING: omit `command` so buildLaunchCommand runs the real argv.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const settingsPath = path.join(stateDir, "launch-settings.json");
    const code = runEpicCli(["create", "design the thing"], {
      stateDir,
      cwd: repoDir,
      launchSettingsPath: settingsPath,
    });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(command).toEqual([
      "claude",
      "--add-dir",
      deriveWorktreePath(fs.realpathSync(repoDir), "design-thing"),
      "--settings",
      settingsPath,
    ]);
    // Epic's launch env stays deliberately bare — NO env FLOW_PIPELINE=1 prefix.
    expect(command).not.toContain("FLOW_PIPELINE=1");
    expect(command).not.toContain("env");
    // The flow-scoped settings file was written, registering the seed-ingested hook.
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      "flow-seed-ingested-hook",
    );
  });

  it("marker-aware fresh consumed(): true on seedIngestedAt, falls back to phase past starting", () => {
    // The launch-time seed-ingested marker latches consumed() even before the
    // supervisor advances the phase; absent the marker it falls back to the
    // phase moving off `starting`.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    let consumedFn: (() => boolean) | undefined;
    tmuxMock.createWindowVerified.mockImplementation(
      (_name, _cwd, _command, _seed, deps) => {
        consumedFn = deps?.consumed;
        return { status: "started", stderr: "" };
      },
    );
    const code = runEpicCli(["create", "design the thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(0);
    expect(consumedFn).toBeDefined();
    // Up-front state is `starting`, no marker → not consumed.
    expect(consumedFn!()).toBe(false);
    // Stamp the marker (phase still starting) → consumed via the marker.
    writeState(
      {
        slug: "design-thing",
        phase: "starting",
        repo: fs.realpathSync(repoDir),
        seedIngestedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      stateDir,
    );
    expect(consumedFn!()).toBe(true);
  });
});

describe("runEpicCli create — launch concurrency semaphore", () => {
  it("acquires a slot before the launch and releases it after (success path)", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    let slotsDuringLaunch = -1;
    tmuxMock.createWindowVerified.mockImplementation(() => {
      slotsDuringLaunch = fs
        .readdirSync(semDir)
        .filter((f) => f.startsWith("slot-")).length;
      return { status: "started", stderr: "" };
    });
    const code = runEpicCli(["create", "design the thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(0);
    expect(slotsDuringLaunch).toBe(1); // one slot held during the launch
    // Released after: the finally in withTestSemaphore removes the won slot.
    expect(fs.readdirSync(semDir).filter((f) => f.startsWith("slot-"))).toEqual(
      [],
    );
  });

  it("releases the slot on the failure path too", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    tmuxMock.createWindowVerified.mockReturnValue({
      status: "failed",
      stderr: "dead",
    });
    const code = runEpicCli(["create", "design the thing"], {
      stateDir,
      cwd: repoDir,
      retrySleepMs: 0,
    });
    expect(code).toBe(2);
    expect(fs.readdirSync(semDir).filter((f) => f.startsWith("slot-"))).toEqual(
      [],
    );
  });

  it("honors FLOW_LAUNCH_CONCURRENCY and fails open when the cap is saturated", () => {
    // cap=1 + slot-0 pre-held by THIS (live) pid → no free slot. The acquire
    // times out fast and the launch proceeds holding NO slot (fail-open). That
    // the launch ran with only the pre-held slot present (count 1, not 2) proves
    // BOTH the override (cap=1) AND the fail-open path.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    process.env.FLOW_LAUNCH_CONCURRENCY = "1";
    fs.writeFileSync(path.join(semDir, "slot-0"), String(process.pid));
    let slotsDuringLaunch = -1;
    tmuxMock.createWindowVerified.mockImplementation(() => {
      slotsDuringLaunch = fs
        .readdirSync(semDir)
        .filter((f) => f.startsWith("slot-")).length;
      return { status: "started", stderr: "" };
    });
    const code = runEpicCli(["create", "design the thing"], {
      stateDir,
      cwd: repoDir,
      launchSemTimeoutMs: 30,
    });
    expect(code).toBe(0); // fail-open: launch ran despite the saturated cap
    expect(slotsDuringLaunch).toBe(1); // only the pre-held slot — held none
    fs.rmSync(path.join(semDir, "slot-0"), { force: true });
  });
});

describe("runEpicCli create — --effort / --model flags", () => {
  it("--effort high threads --effort before the prompt and persists effort", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runEpicCli(
      ["create", "--effort", "high", "design the thing"],
      {
        stateDir,
        cwd: repoDir,
      },
    );
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    // NO positional seed (delivered via send-keys); --effort sits after --add-dir,
    // then the trailing --settings (real argv uses process.env.FLOW_LAUNCH_SETTINGS_PATH).
    expect(command).toEqual([
      "claude",
      "--add-dir",
      deriveWorktreePath(fs.realpathSync(repoDir), "design-thing"),
      "--effort",
      "high",
      "--settings",
      path.join(semDir, "launch-settings.json"),
    ]);
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "design-thing.json"), "utf8"),
    );
    expect(raw.effort).toBe("high");
  });

  it.each(["opus", "fable"] as const)(
    "--model %s threads --model before the prompt and persists model",
    (alias) => {
      spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
      freshWindowOk();
      const code = runEpicCli(
        ["create", "--model", alias, "design the thing"],
        {
          stateDir,
          cwd: repoDir,
        },
      );
      expect(code).toBe(0);
      const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
      // NO positional seed (delivered via send-keys); --model sits after --add-dir,
      // then the trailing --settings.
      expect(command).toEqual([
        "claude",
        "--add-dir",
        deriveWorktreePath(fs.realpathSync(repoDir), "design-thing"),
        "--model",
        alias,
        "--settings",
        path.join(semDir, "launch-settings.json"),
      ]);
      const raw = JSON.parse(
        fs.readFileSync(path.join(stateDir, "design-thing.json"), "utf8"),
      );
      expect(raw.model).toBe(alias);
    },
  );

  it("--model opus --effort high orders --model before --effort before the prompt", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runEpicCli(
      ["create", "--model", "opus", "--effort", "high", "design the thing"],
      { stateDir, cwd: repoDir },
    );
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    // Deterministic order: --model before --effort, both after --add-dir, then
    // the trailing --settings; NO positional seed (delivered via send-keys).
    expect(command).toEqual([
      "claude",
      "--add-dir",
      deriveWorktreePath(fs.realpathSync(repoDir), "design-thing"),
      "--model",
      "opus",
      "--effort",
      "high",
      "--settings",
      path.join(semDir, "launch-settings.json"),
    ]);
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "design-thing.json"), "utf8"),
    );
    expect(raw.model).toBe("opus");
    expect(raw.effort).toBe("high");
  });

  it("without --effort/--model omits both from the argv and the state keys", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runEpicCli(["create", "design the thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(command).not.toContain("--effort");
    expect(command).not.toContain("--model");
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "design-thing.json"), "utf8"),
    );
    expect(raw).not.toHaveProperty("effort");
    expect(raw).not.toHaveProperty("model");
  });

  it("--effort with an invalid value returns exit 2 and writes no state", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runEpicCli(
      ["create", "--effort", "bogus", "design the thing"],
      {
        stateDir,
        cwd: repoDir,
      },
    );
    expect(code).toBe(2);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/low, medium, high, xhigh, max/);
  });

  it("--model with an invalid value returns exit 2 and writes no state", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runEpicCli(["create", "--model", "gpt4", "design the thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(2);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/opus, haiku, sonnet, fable/);
  });

  it("--model with a missing value returns exit 2 and writes no state", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runEpicCli(["create", "--model"], { stateDir, cwd: repoDir });
    expect(code).toBe(2);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
  });

  it("--effort followed by another flag returns exit 2 and writes no state", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runEpicCli(
      ["create", "--effort", "--model", "design the thing"],
      {
        stateDir,
        cwd: repoDir,
      },
    );
    expect(code).toBe(2);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
  });

  it("--model followed by another flag returns exit 2 and writes no state", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runEpicCli(
      ["create", "--model", "--effort", "design the thing"],
      {
        stateDir,
        cwd: repoDir,
      },
    );
    expect(code).toBe(2);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
  });

  it("strips the flag + value tokens from the prompt/slug", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runEpicCli(
      ["create", "--model", "opus", "--effort", "high", "design the thing"],
      { stateDir, cwd: repoDir },
    );
    expect(code).toBe(0);
    // Slug excludes the flag/value tokens: prompt was "design the thing".
    expect(fs.existsSync(path.join(stateDir, "design-thing.json"))).toBe(true);
    // The seed is delivered via send-keys (the 4th arg), NOT a positional argv.
    const [, , , seed] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(seed).toContain("Use the /epic-create skill for: design the thing");
    expect(seed).not.toContain("--model");
    expect(seed).not.toContain("--effort");
  });

  it("--resume re-applies the saved effort + model into the respawn argv", () => {
    writeState(
      {
        slug: "saved-flags-epic",
        phase: "epic-designing",
        repo: repoDir,
        effort: "max",
        model: "opus",
        updatedAt: new Date().toISOString(),
      },
      stateDir,
    );
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);
    const code = runEpicCli(["create", "--resume", "saved-flags-epic"], {
      stateDir,
    });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.respawnWindowVerified.mock.calls[0]!;
    // NO positional seed (delivered via send-keys); saved --model/--effort
    // re-applied after --add-dir in deterministic order, then trailing --settings.
    expect(command).toEqual([
      "claude",
      "--add-dir",
      deriveWorktreePath(repoDir, "saved-flags-epic"),
      "--model",
      "opus",
      "--effort",
      "max",
      "--settings",
      path.join(semDir, "launch-settings.json"),
    ]);
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
    // The resume seed is the 4th arg (send-keys delivery), not the argv tail.
    const [, cwd, command, seed] =
      tmuxMock.respawnWindowVerified.mock.calls[0]!;
    expect(cwd).toBe(repoDir);
    expect(seed).toContain(
      "Use the /epic-create skill in --resume mode for: crashed-epic",
    );
    expect(seed).toContain(".flow/epics/crashed-epic");
    // The resume seed carries the same resolved SKILL_DIR as the create seed.
    expect(seed).toContain("SKILL_DIR:");
    expect(seed).toContain("skills/pipeline/product-planning");
    // The argv carries NO positional seed (claude + --add-dir <worktree> +
    // trailing --settings, length 5).
    expect(command).toHaveLength(5);
    expect(command[3]).toBe("--settings");
    expect(command.some((a) => a.includes("Use the /epic-create skill"))).toBe(
      false,
    );
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

  it("wires a resume consumed predicate that gates on updatedAt advancing from epic-designing", () => {
    // On resume the phase is already `epic-designing`, so consumption keys on
    // `updatedAt` moving off the pre-respawn baseline, mirroring new.ts runResume.
    const baseline = new Date(Date.now() - 10_000).toISOString();
    writeState(
      {
        slug: "resumed-epic",
        phase: "epic-designing",
        repo: repoDir,
        updatedAt: baseline,
      },
      stateDir,
    );
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);
    let consumedFn: (() => boolean) | undefined;
    tmuxMock.respawnWindowVerified.mockImplementation(
      (_name, _cwd, _command, _seed, deps) => {
        consumedFn = deps?.consumed;
        return { status: "started", stderr: "" };
      },
    );
    const code = runEpicCli(["create", "--resume", "resumed-epic"], {
      stateDir,
    });
    expect(code).toBe(0);
    expect(consumedFn).toBeDefined();
    expect(consumedFn!()).toBe(false);
    writeState(
      {
        slug: "resumed-epic",
        phase: "epic-designing",
        repo: repoDir,
        updatedAt: new Date().toISOString(),
      },
      stateDir,
    );
    expect(consumedFn!()).toBe(true);
  });

  it("resume consumed predicate ignores a STALE seedIngestedAt marker and requires a fresh re-stamp", () => {
    // The seed-ingested hook stamps `seedIngestedAt` on the ORIGINAL fresh
    // launch, and runEpicResume never clears it. A bare `seedIngestedAt != null`
    // check would short-circuit consumed() true on the first probe off the stale
    // marker — skipping the resume-seed send-keys and latching a false-success
    // resume. consumed() must require the marker to DIFFER from the captured
    // pre-resume value (a fresh re-stamp by the resumed session).
    const baseline = new Date(Date.now() - 10_000).toISOString();
    const staleMarker = new Date(Date.now() - 9_000).toISOString();
    writeState(
      {
        slug: "stale-marker-epic",
        phase: "epic-designing",
        repo: repoDir,
        updatedAt: baseline,
        seedIngestedAt: staleMarker,
      },
      stateDir,
    );
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);
    let consumedFn: (() => boolean) | undefined;
    tmuxMock.respawnWindowVerified.mockImplementation(
      (_name, _cwd, _command, _seed, deps) => {
        consumedFn = deps?.consumed;
        return { status: "started", stderr: "" };
      },
    );
    const code = runEpicCli(["create", "--resume", "stale-marker-epic"], {
      stateDir,
    });
    expect(code).toBe(0);
    expect(consumedFn).toBeDefined();
    // Stale marker unchanged + updatedAt unchanged → NOT consumed.
    expect(consumedFn!()).toBe(false);
    // The resumed session's hook RE-STAMPS the marker with a new timestamp → flips.
    writeState(
      {
        slug: "stale-marker-epic",
        phase: "epic-designing",
        repo: repoDir,
        updatedAt: baseline,
        seedIngestedAt: new Date().toISOString(),
      },
      stateDir,
    );
    expect(consumedFn!()).toBe(true);
  });

  it("resume launcher timeout leaves epic state byte-unchanged and never deletes it (symmetry)", () => {
    seedEpicState("resume-timeout-epic");
    const before = fs.readFileSync(
      path.join(stateDir, "resume-timeout-epic.json"),
      "utf8",
    );
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);
    tmuxMock.respawnWindowVerified.mockReturnValue({
      status: "failed",
      stderr: "the seed prompt was never consumed (supervisor did not start)",
    });
    const code = runEpicCli(["create", "--resume", "resume-timeout-epic"], {
      stateDir,
      retrySleepMs: 0,
    });
    expect(code).toBe(2);
    expect(fs.existsSync(path.join(stateDir, "resume-timeout-epic.json"))).toBe(
      true,
    );
    const after = fs.readFileSync(
      path.join(stateDir, "resume-timeout-epic.json"),
      "utf8",
    );
    expect(after).toBe(before);
  });
});

describe("runEpicCli run/status/ls", () => {
  type FeatureSpec = { id: string; dependsOn?: string[] };

  function gitInit(): void {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
  }

  function writeManifest(slug: string, features: FeatureSpec[]): string {
    const dir = path.join(repoDir, ".flow", "epics", slug);
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        epicId: slug,
        prompt: "p",
        createdAt: "2026-06-28",
        features: features.map((f) => ({
          id: f.id,
          title: f.id.toUpperCase(),
          description: `build ${f.id}`,
          dependsOn: f.dependsOn ?? [],
        })),
      }),
    );
    return manifestPath;
  }

  const okSpawn = () =>
    vi.fn((_command: string, _args: string[]) => ({
      status: 0,
      stdout: "flow:launched-slug\n",
      stderr: "",
    }));

  /** readFeatureState that returns the same phase for any slug. */
  const allPhase = (phase: string) => (slug: string) => ({
    slug,
    phase,
    repo: repoDir,
    updatedAt: "2026-06-28T00:00:00Z",
  });

  it("run: manifest missing → non-zero + 'manifest not found'", () => {
    gitInit();
    const code = runEpicCli(["run", "ghost"], { cwd: repoDir, epicsDir });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/manifest not found/);
  });

  it("run: invalid DAG (cycle) → refuses non-zero and launches nothing", () => {
    gitInit();
    writeManifest("cyclic", [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ]);
    const spawn = okSpawn();
    const code = runEpicCli(["run", "cyclic"], {
      cwd: repoDir,
      epicsDir,
      spawn,
      sleep: vi.fn(),
    });
    expect(code).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/DAG|cycle/i);
  });

  it("run: the watch loop reaches all-merged → exit 0 with 'epic complete'", () => {
    gitInit();
    writeManifest("done-epic", [
      { id: "schema" },
      { id: "backend", dependsOn: ["schema"] },
    ]);
    const spawn = okSpawn();
    const sleep = vi.fn();
    const code = runEpicCli(["run", "done-epic"], {
      cwd: repoDir,
      epicsDir,
      spawn,
      sleep,
      readFeatureState: allPhase("merged"),
      readMaxParallel: () => 3,
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/epic complete: 2\/2/);
    expect(sleep).toHaveBeenCalled(); // it ticked more than once
  });

  it("run: frontier-empty-but-not-all-merged → non-zero 'blocked' naming the feature", () => {
    gitInit();
    writeManifest("stuck", [
      { id: "schema" },
      { id: "backend", dependsOn: ["schema"] },
    ]);
    const code = runEpicCli(["run", "stuck"], {
      cwd: repoDir,
      epicsDir,
      spawn: okSpawn(),
      sleep: vi.fn(),
      readFeatureState: allPhase("gated"),
      readMaxParallel: () => 3,
    });
    expect(code).toBe(1);
    const joined = errors.join("\n");
    expect(joined).toMatch(/blocked/);
    expect(joined).toMatch(/schema/);
  });

  it("run --once: performs exactly one tick (sleep never called) and exits 0", () => {
    gitInit();
    writeManifest("once-epic", [{ id: "schema" }]);
    const spawn = okSpawn();
    const sleep = vi.fn();
    const code = runEpicCli(["run", "once-epic", "--once"], {
      cwd: repoDir,
      epicsDir,
      spawn,
      sleep,
      readFeatureState: () => null,
      readMaxParallel: () => 3,
    });
    expect(code).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1); // launched the single root once
  });

  it("run: --max-parallel caps concurrent launches (third stays ready)", () => {
    gitInit();
    writeManifest("cap", [{ id: "a" }, { id: "b" }, { id: "c" }]);
    const spawn = okSpawn();
    const code = runEpicCli(["run", "cap", "--once", "--max-parallel", "2"], {
      cwd: repoDir,
      epicsDir,
      spawn,
      sleep: vi.fn(),
      readFeatureState: () => null,
    });
    expect(code).toBe(0);
    // The flag overrides the config default: only 2 of 3 independent features
    // launch this tick (the cap arithmetic = maxParallel − running).
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("run: --max-parallel rejects a non-integer / missing value (exit 2)", () => {
    gitInit();
    expect(
      runEpicCli(["run", "cap2", "--max-parallel", "x"], {
        cwd: repoDir,
        epicsDir,
      }),
    ).toBe(2);
    expect(
      runEpicCli(["run", "cap2", "--max-parallel"], {
        cwd: repoDir,
        epicsDir,
      }),
    ).toBe(2);
    expect(errors.join("\n")).toMatch(/--max-parallel/);
  });

  it("run: an unknown -prefixed option exits 2 with a usage message", () => {
    gitInit();
    const code = runEpicCli(["run", "x", "--bogus"], {
      cwd: repoDir,
      epicsDir,
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/unknown option/);
  });

  it("run: a persistently-failing launch bails to blocked (exit 1), never spins forever", () => {
    gitInit();
    writeManifest("stuck-launch", [{ id: "a" }]);
    // spawn always fails (e.g. a window-name collision) → launchFeature ok:false
    // every tick. The feature is never recorded, so it stays in the frontier;
    // without the stall budget the loop would re-fail forever.
    const failSpawn = vi.fn((_command: string, _args: string[]) => ({
      status: 1,
      stdout: "",
      stderr: "window 'flow:a' already exists",
    }));
    const sleep = vi.fn();
    const code = runEpicCli(["run", "stuck-launch"], {
      cwd: repoDir,
      epicsDir,
      spawn: failSpawn,
      sleep,
      readFeatureState: () => null,
      readMaxParallel: () => 3,
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/failed to launch/);
    // Bounded by LAUNCH_STALL_BUDGET (3) — it does NOT retry indefinitely.
    expect(failSpawn).toHaveBeenCalledTimes(3);
  });

  it("status: renders a board with feature rows + summary and exits 0", () => {
    const manifestPath = writeManifest("watch", [
      { id: "schema" },
      { id: "backend", dependsOn: ["schema"] },
    ]);
    writeEpicRunState(
      {
        epicSlug: "watch",
        repo: repoDir,
        manifestPath,
        manifestSha: "sha",
        maxParallel: 3,
        createdAt: "2026-06-28T00:00:00Z",
        updatedAt: "2026-06-28T00:00:00Z",
        features: {
          schema: {
            slug: "watch-schema",
            launchedAt: "2026-06-28T00:00:00Z",
            pr: 12,
          },
        },
      },
      epicsDir,
    );
    const code = runEpicCli(["status", "watch"], {
      epicsDir,
      readFeatureState: (slug) =>
        slug === "watch-schema"
          ? {
              slug,
              phase: "merged",
              repo: repoDir,
              updatedAt: "2026-06-28T00:00:00Z",
              pr: 12,
            }
          : null,
    });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("FEATURE");
    expect(out).toContain("schema");
    expect(out).toContain("backend");
    expect(out).toMatch(/ready:.*running:.*blocked:.*merged:/);
  });

  it("status: no run-state and no committed manifest → 'no epic found', non-zero", () => {
    gitInit();
    const code = runEpicCli(["status", "nope"], { cwd: repoDir, epicsDir });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/no epic found/);
  });

  it("status: ephemeral — committed manifest but no run-state yet renders the board, exit 0", () => {
    gitInit();
    // The normal first-use case: design PR merged, `flow epic run` not yet
    // invoked, so there is a manifest but no run.json — ephemeralRunState serves it.
    writeManifest("fresh", [{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    const code = runEpicCli(["status", "fresh"], {
      cwd: repoDir,
      epicsDir,
      readFeatureState: () => null,
      readMaxParallel: () => 3,
    });
    expect(code).toBe(0);
    const out = logs.join("\n");
    // a is in-degree-0 → ready; b depends on the uncompleted a → blocked.
    expect(out).toMatch(/a\s+ready/);
    expect(out).toMatch(/b\s+blocked/);
  });

  it("status: runtime state present but its manifest is unreadable → exit 2", () => {
    // Run-state exists, but its recorded manifest path resolves to nothing
    // (moved/unmerged) — the non-null-assertion + reconcile branch must not run.
    writeEpicRunState(
      {
        epicSlug: "broken",
        repo: repoDir,
        manifestPath: path.join(
          repoDir,
          ".flow",
          "epics",
          "broken",
          "manifest.json",
        ),
        manifestSha: "sha",
        maxParallel: 3,
        createdAt: "x",
        updatedAt: "x",
        features: {},
      },
      epicsDir,
    );
    const code = runEpicCli(["status", "broken"], { epicsDir });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/unreadable/);
  });

  it("ls: lists every epic with per-state counts + status and exits 0", () => {
    const alphaManifest = writeManifest("alpha", [{ id: "a" }]);
    const betaManifest = writeManifest("beta", [
      { id: "b" },
      { id: "c", dependsOn: ["b"] },
    ]);
    writeEpicRunState(
      {
        epicSlug: "alpha",
        repo: repoDir,
        manifestPath: alphaManifest,
        manifestSha: "s",
        maxParallel: 3,
        createdAt: "x",
        updatedAt: "x",
        features: { a: { slug: "alpha-a", launchedAt: "x" } },
      },
      epicsDir,
    );
    writeEpicRunState(
      {
        epicSlug: "beta",
        repo: repoDir,
        manifestPath: betaManifest,
        manifestSha: "s",
        maxParallel: 3,
        createdAt: "x",
        updatedAt: "x",
        features: { b: { slug: "beta-b", launchedAt: "x" } },
      },
      epicsDir,
    );
    const code = runEpicCli(["ls"], {
      epicsDir,
      readFeatureState: (slug) =>
        slug === "alpha-a"
          ? { slug, phase: "merged", repo: repoDir, updatedAt: "x" }
          : slug === "beta-b"
            ? { slug, phase: "implementing", repo: repoDir, updatedAt: "x" }
            : null,
    });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("EPIC");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
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
