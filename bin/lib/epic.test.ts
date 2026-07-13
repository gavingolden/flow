/**
 * Tests for `flow epic`. F5 rewires `create` from a resolve-and-print stub to
 * a window-spawn (mirroring `flow feature create`): it opens a tmux window running the
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

// Mock ./models-config so the reader functions' `read` parameter defaults to
// a no-config stub instead of defaultReadConfigFile: the host's real
// ~/.flow/config.json (e.g. models.default: "opus") must never leak into
// tests that omit options.readConfig. Tests that DO pass readConfig still
// exercise the real logic through the explicit argument.
vi.mock("./models-config", async () => {
  const actual =
    await vi.importActual<typeof import("./models-config")>("./models-config");
  type ReadConfigFile = typeof actual.defaultReadConfigFile;
  const noConfig: ReadConfigFile = () => undefined;
  return {
    ...actual,
    readPhaseModel: (phase: string, read: ReadConfigFile = noConfig) =>
      actual.readPhaseModel(phase, read),
    readDefaultModel: (read: ReadConfigFile = noConfig) =>
      actual.readDefaultModel(read),
    collectModelConfigWarnings: (read: ReadConfigFile = noConfig) =>
      actual.collectModelConfigWarnings(read),
  };
});

import { runEpicCli, parseRunArgs } from "./epic";
import { deriveWorktreePath } from "./feature";
import { writeState } from "./state";
import {
  writeEpicRunState,
  readEpicRunState,
  type EpicRunState,
} from "./epic-run-state";

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
      // Pin: this asserts an exact-length argv with no --model. Without an
      // explicit empty override, this leaks the developer machine's real
      // ~/.flow/config.json models.default into the launch command.
      readConfig: () => ({}),
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
      // Pin: this asserts an exact argv with no --model. See the readConfig
      // comment in the "spawns a window" test above.
      readConfig: () => ({}),
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

  it("degrades to a dim warning and still launches when the settings write throws", () => {
    // Force ensureLaunchSettings to throw: point launchSettingsPath under a
    // regular file so mkdirSync(dirname) hits ENOTDIR. buildLaunchCommand's
    // best-effort try/catch must swallow it, warn on stderr, and still return
    // the argv carrying --settings (the lazy reaper backstops orphan cleanup).
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const blocker = path.join(stateDir, "not-a-dir");
    fs.writeFileSync(blocker, "");
    const settingsPath = path.join(blocker, "launch-settings.json");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = runEpicCli(["create", "design the thing"], {
      stateDir,
      cwd: repoDir,
      launchSettingsPath: settingsPath,
      // Pin: this asserts an exact argv with no --model. See the readConfig
      // comment in the "spawns a window" test above.
      readConfig: () => ({}),
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
    // The degradation warning was emitted, and no settings file was written.
    const warned = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(warned).toContain("could not write launch settings");
    expect(fs.existsSync(settingsPath)).toBe(false);
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
        // Pin: this asserts an exact argv with no --model. See the
        // readConfig comment in the "spawns a window" test above.
        readConfig: () => ({}),
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
      // Pin: this asserts no --model in the argv. See the readConfig
      // comment in the "spawns a window" test above.
      readConfig: () => ({}),
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

  // --- --model-planning (shared modelPlanning field, Task 4) --------------

  it.each(["opus", "fable"] as const)(
    "--model-planning %s persists modelPlanning and does NOT reach the launch argv",
    (alias) => {
      spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
      freshWindowOk();
      const code = runEpicCli(
        ["create", "--model-planning", alias, "design the thing"],
        {
          stateDir,
          cwd: repoDir,
          // Pin: this asserts no --model in the argv. See the readConfig
          // comment in the "spawns a window" test above.
          readConfig: () => ({}),
        },
      );
      expect(code).toBe(0);
      const raw = JSON.parse(
        fs.readFileSync(path.join(stateDir, "design-thing.json"), "utf8"),
      );
      expect(raw.modelPlanning).toBe(alias);
      const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
      // Per-phase override is NOT threaded into the session launch argv.
      expect(command).not.toContain("--model-planning");
      expect(command).not.toContain("--model");
    },
  );

  it("--model-planning with an invalid value returns exit 2 and writes no state", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runEpicCli(
      ["create", "--model-planning", "gpt4", "design the thing"],
      { stateDir, cwd: repoDir },
    );
    expect(code).toBe(2);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/opus, haiku, sonnet, fable/);
  });

  it("--model-planning strips the flag + value from the slug", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runEpicCli(
      ["create", "--model-planning", "fable", "design the thing"],
      { stateDir, cwd: repoDir },
    );
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(stateDir, "design-thing.json"))).toBe(true);
  });

  // --- config models.default at epic-create launch (Task 3) ---------------

  it("threads config models.default into the epic launch argv when no --model, and persists it", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runEpicCli(["create", "design the thing"], {
      stateDir,
      cwd: repoDir,
      readConfig: () => ({ models: { default: "sonnet" } }),
    });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(command[command.indexOf("--model") + 1]).toBe("sonnet");
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "design-thing.json"), "utf8"),
    );
    expect(raw.model).toBe("sonnet");
  });

  it("--model wins over config models.default at epic create", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runEpicCli(["create", "--model", "opus", "design the thing"], {
      stateDir,
      cwd: repoDir,
      readConfig: () => ({ models: { default: "sonnet" } }),
    });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(command[command.indexOf("--model") + 1]).toBe("opus");
  });

  it("warns and falls back when config models.default is present-but-invalid at epic create", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runEpicCli(["create", "design the thing"], {
      stateDir,
      cwd: repoDir,
      readConfig: () => ({ models: { default: "gpt4" } }),
    });
    expect(code).toBe(0);
    expect(errors.join("\n")).toMatch(
      /models\.default.*not a valid model alias/,
    );
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(command).not.toContain("--model");
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
    // `updatedAt` moving off the pre-respawn baseline, mirroring feature.ts runResume.
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

describe("runEpicCli run/status/ls/bind/launch", () => {
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

  /** Spawn stub for launchFeature: `flow feature create` prints the minted slug. */
  const okSpawn = (mintedSlug = "launched-slug") =>
    vi.fn((_command: string, _args: string[]) => ({
      status: 0,
      stdout: `flow:${mintedSlug}\n`,
      stderr: "",
    }));

  const seedRunState = (
    slug: string,
    manifestPath: string,
    overrides: Partial<EpicRunState> = {},
  ): EpicRunState => ({
    epicSlug: slug,
    repo: fs.realpathSync(repoDir),
    manifestPath,
    manifestSha: "sha",
    maxParallel: 3,
    createdAt: "2026-06-28T00:00:00Z",
    updatedAt: "2026-06-28T00:00:00Z",
    features: {},
    ...overrides,
  });

  // ── run: the playbook launcher ────────────────────────────────────────────

  it("run: manifest missing → non-zero + 'manifest not found'", () => {
    gitInit();
    const code = runEpicCli(["run", "ghost"], { cwd: repoDir, epicsDir });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/manifest not found/);
  });

  it("run: invalid DAG (cycle) → refuses non-zero and spawns no window", () => {
    gitInit();
    writeManifest("cyclic", [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ]);
    const code = runEpicCli(["run", "cyclic"], { cwd: repoDir, epicsDir });
    expect(code).toBe(2);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/DAG|cycle/i);
  });

  it("run: opens exactly one verified /epic-run playbook window (two-line seed, no run.json pre-seed)", () => {
    gitInit();
    writeManifest("spawn-epic", [{ id: "a" }]);
    freshWindowOk();
    const code = runEpicCli(["run", "spawn-epic"], { cwd: repoDir, epicsDir });
    expect(code).toBe(0);
    expect(logs[0]).toBe("flow:spawn-epic");
    expect(tmuxMock.createWindowVerified).toHaveBeenCalledTimes(1);
    expect(tmuxMock.respawnWindowVerified).not.toHaveBeenCalled();
    // Default never-consumed predicate: no `consumed` deps arg is passed.
    const [, , , seed, deps] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(seed).toContain("Use the /epic-run skill for: spawn-epic");
    expect(seed).toContain(".flow/epics/spawn-epic");
    // The loop-era seed lines are gone.
    expect(seed).not.toContain("AUTO_REDIRECT");
    expect(seed).not.toContain("MODEL_JUDGE");
    expect(deps).toBeUndefined();
    // No run.json is pre-seeded by the launcher (the playbook writes it via bind/launch).
    expect(readEpicRunState("spawn-epic", epicsDir)).toBeNull();
  });

  it("run: refuses (exit 2) when a window already exists for the slug", () => {
    gitInit();
    writeManifest("dup-epic", [{ id: "a" }]);
    tmuxMock.windowExists.mockReturnValue(true);
    const code = runEpicCli(["run", "dup-epic"], { cwd: repoDir, epicsDir });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/already exists/);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
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

  it.each([
    ["--once"],
    ["--json"],
    ["--no-judgment"],
    ["--no-auto-redirect"],
    ["--max-parallel"],
    ["--model-judge"],
  ])("run: removed loop-era flag %s exits 2 (unknown option)", (flag) => {
    gitInit();
    writeManifest("removed-flags", [{ id: "a" }]);
    const code = runEpicCli(["run", "removed-flags", flag], {
      cwd: repoDir,
      epicsDir,
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/unknown option/);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
  });

  it("run --model (parity): threads --model into the supervisor launch argv", () => {
    gitInit();
    writeManifest("run-model-epic", [{ id: "a" }]);
    freshWindowOk();
    const code = runEpicCli(["run", "run-model-epic", "--model", "fable"], {
      cwd: repoDir,
      epicsDir,
    });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(command[command.indexOf("--model") + 1]).toBe("fable");
  });

  it("run (default, no --model): threads config models.default into the launch argv", () => {
    gitInit();
    writeManifest("run-default-epic", [{ id: "a" }]);
    freshWindowOk();
    const code = runEpicCli(["run", "run-default-epic"], {
      cwd: repoDir,
      epicsDir,
      readConfig: () => ({ models: { default: "sonnet" } }),
    });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(command[command.indexOf("--model") + 1]).toBe("sonnet");
  });

  it("run --model wins over config models.default", () => {
    gitInit();
    writeManifest("run-model-wins-epic", [{ id: "a" }]);
    freshWindowOk();
    const code = runEpicCli(
      ["run", "run-model-wins-epic", "--model", "fable"],
      {
        cwd: repoDir,
        epicsDir,
        readConfig: () => ({ models: { default: "sonnet" } }),
      },
    );
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(command[command.indexOf("--model") + 1]).toBe("fable");
  });

  it("run --effort xhigh threads --effort into the supervisor launch argv", () => {
    gitInit();
    writeManifest("run-effort-epic", [{ id: "a" }]);
    freshWindowOk();
    const code = runEpicCli(["run", "run-effort-epic", "--effort", "xhigh"], {
      cwd: repoDir,
      epicsDir,
    });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(command[command.indexOf("--effort") + 1]).toBe("xhigh");
  });

  describe("parseRunArgs", () => {
    it("parses a bare slug", () => {
      const parsed = parseRunArgs(["my-epic"]);
      expect(parsed.error).toBeUndefined();
      expect(parsed.slug).toBe("my-epic");
      expect(parsed.model).toBeUndefined();
    });

    it("parses --model", () => {
      const parsed = parseRunArgs(["my-epic", "--model", "opus"]);
      expect(parsed.error).toBeUndefined();
      expect(parsed.model).toBe("opus");
    });

    it("rejects a missing --model value", () => {
      const parsed = parseRunArgs(["my-epic", "--model"]);
      expect(parsed.error).toMatch(/--model requires a value/);
    });

    it("rejects an invalid --model value", () => {
      const parsed = parseRunArgs(["my-epic", "--model", "gpt4"]);
      expect(parsed.error).toMatch(/invalid --model value/);
    });

    it("parses --effort", () => {
      const parsed = parseRunArgs(["my-epic", "--effort", "xhigh"]);
      expect(parsed.error).toBeUndefined();
      expect(parsed.effort).toBe("xhigh");
    });

    it("rejects a missing --effort value", () => {
      const parsed = parseRunArgs(["my-epic", "--effort"]);
      expect(parsed.error).toMatch(/--effort requires a value/);
    });

    it("rejects an invalid --effort value", () => {
      const parsed = parseRunArgs(["my-epic", "--effort", "bogus"]);
      expect(parsed.error).toMatch(/invalid --effort value/);
    });

    it("rejects a removed loop-era flag as an unknown option", () => {
      expect(parseRunArgs(["my-epic", "--once"]).error).toMatch(
        /unknown option/,
      );
      expect(parseRunArgs(["my-epic", "--model-judge", "haiku"]).error).toMatch(
        /unknown option/,
      );
    });
  });

  // ── status ────────────────────────────────────────────────────────────────

  it("status: renders a board with feature rows + summary and exits 0", () => {
    const manifestPath = writeManifest("watch", [
      { id: "schema" },
      { id: "backend", dependsOn: ["schema"] },
    ]);
    writeEpicRunState(
      seedRunState("watch", manifestPath, {
        features: {
          schema: {
            slug: "watch-schema",
            launchedAt: "2026-06-28T00:00:00Z",
            pr: 12,
          },
        },
      }),
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

  it("status --json: emits exactly one JSON object with the hypothesis source note", () => {
    const manifestPath = writeManifest("json-status", [
      { id: "schema" },
      { id: "backend", dependsOn: ["schema"] },
    ]);
    writeEpicRunState(
      seedRunState("json-status", manifestPath, {
        features: {
          schema: {
            slug: "json-schema",
            launchedAt: "2026-06-28T00:00:00Z",
            pr: 7,
          },
        },
      }),
      epicsDir,
    );
    const code = runEpicCli(["status", "json-status", "--json"], {
      epicsDir,
      readFeatureState: (slug) =>
        slug === "json-schema"
          ? { slug, phase: "merged", repo: repoDir, updatedAt: "x", pr: 7 }
          : null,
    });
    expect(code).toBe(0);
    // Exactly one jq-parseable JSON object on stdout (no human render mixed in).
    expect(logs.length).toBe(1);
    const payload = JSON.parse(logs[0]!);
    expect(payload.epicSlug).toBe("json-status");
    expect(payload.event.kind).toBeDefined();
    expect(payload.epicStatus).toBeDefined();
    expect(payload.summary.total).toBe(2);
    expect(Array.isArray(payload.board)).toBe(true);
    // The source field frames run.json as a possibly-stale cache to verify.
    expect(typeof payload.source).toBe("string");
    expect(payload.source).toMatch(/cache|stale|hint/i);
    expect(payload.source).toMatch(/GitHub|git/);
  });

  it("status --json: renders all-unlaunched when a manifest exists but no run.json", () => {
    gitInit();
    writeManifest("ephem-json", [{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    const code = runEpicCli(["status", "ephem-json", "--json"], {
      cwd: repoDir,
      epicsDir,
      readFeatureState: () => null,
      readMaxParallel: () => 3,
    });
    expect(code).toBe(0);
    const payload = JSON.parse(logs[0]!);
    const byId = Object.fromEntries(
      payload.board.map((r: { id: string; status: string }) => [
        r.id,
        r.status,
      ]),
    );
    expect(byId.a).toBe("ready");
    expect(byId.b).toBe("blocked");
  });

  it("status: no run-state and no committed manifest → 'no epic found', non-zero", () => {
    gitInit();
    const code = runEpicCli(["status", "nope"], { cwd: repoDir, epicsDir });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/no epic found/);
  });

  it("status: ephemeral — committed manifest but no run-state yet renders the board, exit 0", () => {
    gitInit();
    writeManifest("fresh", [{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    const code = runEpicCli(["status", "fresh"], {
      cwd: repoDir,
      epicsDir,
      readFeatureState: () => null,
      readMaxParallel: () => 3,
    });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toMatch(/a\s+ready/);
    expect(out).toMatch(/b\s+blocked/);
  });

  it("status: runtime state present but its manifest is unreadable → exit 2", () => {
    writeEpicRunState(
      seedRunState(
        "broken",
        path.join(repoDir, ".flow", "epics", "broken", "manifest.json"),
      ),
      epicsDir,
    );
    const code = runEpicCli(["status", "broken"], { epicsDir });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/unreadable/);
  });

  // ── ls ──────────────────────────────────────────────────────────────────

  it("ls: lists every epic with per-state counts + status and exits 0", () => {
    const alphaManifest = writeManifest("alpha", [{ id: "a" }]);
    const betaManifest = writeManifest("beta", [
      { id: "b" },
      { id: "c", dependsOn: ["b"] },
    ]);
    writeEpicRunState(
      seedRunState("alpha", alphaManifest, {
        features: { a: { slug: "alpha-a", launchedAt: "x" } },
      }),
      epicsDir,
    );
    writeEpicRunState(
      seedRunState("beta", betaManifest, {
        features: { b: { slug: "beta-b", launchedAt: "x" } },
      }),
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

  // ── bind ──────────────────────────────────────────────────────────────────

  it("bind: adopts an unbound feature, init-ing run.json on missing", () => {
    gitInit();
    writeManifest("bind-adopt", [{ id: "feat-a" }]);
    writeState(
      {
        slug: "real-slug",
        phase: "implementing",
        repo: repoDir,
        updatedAt: "x",
      },
      stateDir,
    );
    const code = runEpicCli(["bind", "bind-adopt", "feat-a", "real-slug"], {
      cwd: repoDir,
      epicsDir,
      stateDir,
    });
    expect(code).toBe(0);
    const rs = readEpicRunState("bind-adopt", epicsDir);
    expect(rs?.features["feat-a"]?.slug).toBe("real-slug");
    expect(rs?.features["feat-a"]?.launchedAt).toBeDefined();
  });

  it("bind: refuses a DIFFERING existing binding without --force (exit 2, writes nothing)", () => {
    gitInit();
    const manifestPath = writeManifest("bind-refuse", [{ id: "feat-a" }]);
    writeEpicRunState(
      seedRunState("bind-refuse", manifestPath, {
        features: { "feat-a": { slug: "old-slug", launchedAt: "x" } },
      }),
      epicsDir,
    );
    writeState(
      {
        slug: "new-slug",
        phase: "implementing",
        repo: repoDir,
        updatedAt: "x",
      },
      stateDir,
    );
    const code = runEpicCli(["bind", "bind-refuse", "feat-a", "new-slug"], {
      cwd: repoDir,
      epicsDir,
      stateDir,
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/already bound/);
    // Unchanged on disk.
    expect(
      readEpicRunState("bind-refuse", epicsDir)?.features["feat-a"]?.slug,
    ).toBe("old-slug");
  });

  it("bind --force: repoints the slug and appends the old slug to priorSlugs", () => {
    gitInit();
    const manifestPath = writeManifest("bind-force", [{ id: "feat-a" }]);
    writeEpicRunState(
      seedRunState("bind-force", manifestPath, {
        features: { "feat-a": { slug: "old-slug", launchedAt: "x" } },
      }),
      epicsDir,
    );
    const code = runEpicCli(
      ["bind", "bind-force", "feat-a", "new-slug", "--force"],
      { cwd: repoDir, epicsDir, stateDir },
    );
    expect(code).toBe(0);
    const rec = readEpicRunState("bind-force", epicsDir)?.features["feat-a"];
    expect(rec?.slug).toBe("new-slug");
    expect(rec?.priorSlugs).toEqual(["old-slug"]);
  });

  it.each<[string, string[]]>([
    ["missing", []],
    ["empty", [""]],
  ])(
    "bind: rejects a %s --external value (exit 2, writes nothing)",
    (_label, extraArg) => {
      // An empty ref (a shell var that expanded empty) must NOT write a
      // `{ external: "" }` record — that fails the run-state guard on read and
      // collapses the whole run.json to "missing", losing every binding.
      gitInit();
      writeManifest("bind-empty-ext", [{ id: "feat-a" }]);
      const code = runEpicCli(
        ["bind", "bind-empty-ext", "feat-a", "--external", ...extraArg],
        { cwd: repoDir, epicsDir, stateDir },
      );
      expect(code).toBe(2);
      expect(errors.join("\n")).toMatch(/--external requires a non-empty/);
      // Nothing written.
      expect(readEpicRunState("bind-empty-ext", epicsDir)).toBeNull();
    },
  );

  it("bind --force: carries pr + lastStatus forward onto the rebound record", () => {
    // A rebind must not blank the board's PR/PHASE columns — the audit fields
    // survive the repoint.
    gitInit();
    const manifestPath = writeManifest("bind-carry", [{ id: "feat-a" }]);
    writeEpicRunState(
      seedRunState("bind-carry", manifestPath, {
        features: {
          "feat-a": {
            slug: "old-slug",
            launchedAt: "x",
            pr: 77,
            lastStatus: "reviewing",
          },
        },
      }),
      epicsDir,
    );
    const code = runEpicCli(
      ["bind", "bind-carry", "feat-a", "new-slug", "--force"],
      { cwd: repoDir, epicsDir, stateDir },
    );
    expect(code).toBe(0);
    const rec = readEpicRunState("bind-carry", epicsDir)?.features["feat-a"];
    expect(rec?.slug).toBe("new-slug");
    expect(rec?.pr).toBe(77);
    expect(rec?.lastStatus).toBe("reviewing");
  });

  it("bind: refuses a target slug with no pipeline state unless --force (typo guard)", () => {
    gitInit();
    writeManifest("bind-typo", [{ id: "feat-a" }]);
    // No writeState for 'ghost-slug' → typo guard fires.
    const refused = runEpicCli(["bind", "bind-typo", "feat-a", "ghost-slug"], {
      cwd: repoDir,
      epicsDir,
      stateDir,
    });
    expect(refused).toBe(2);
    expect(errors.join("\n")).toMatch(/no pipeline state/);
    // --force overrides the guard (a legitimately cleaned-up pipeline).
    const forced = runEpicCli(
      ["bind", "bind-typo", "feat-a", "ghost-slug", "--force"],
      { cwd: repoDir, epicsDir, stateDir },
    );
    expect(forced).toBe(0);
    expect(
      readEpicRunState("bind-typo", epicsDir)?.features["feat-a"]?.slug,
    ).toBe("ghost-slug");
  });

  it("bind --external: records a completed out-of-band feature (external ref, no slug)", () => {
    gitInit();
    writeManifest("bind-ext", [{ id: "feat-b" }]);
    const code = runEpicCli(
      ["bind", "bind-ext", "feat-b", "--external", "PR #123"],
      { cwd: repoDir, epicsDir, stateDir },
    );
    expect(code).toBe(0);
    const rec = readEpicRunState("bind-ext", epicsDir)?.features["feat-b"];
    expect(rec?.external).toBe("PR #123");
    expect(rec?.completedAt).toBeDefined();
    expect(rec?.slug).toBeUndefined();
  });

  it("bind --external on a slug-bound record: refuses without --force; --force moves slug to priorSlugs and drops it", () => {
    gitInit();
    const manifestPath = writeManifest("bind-ext-force", [{ id: "feat-b" }]);
    writeEpicRunState(
      seedRunState("bind-ext-force", manifestPath, {
        features: { "feat-b": { slug: "live-slug", launchedAt: "x" } },
      }),
      epicsDir,
    );
    const refused = runEpicCli(
      ["bind", "bind-ext-force", "feat-b", "--external", "PR #9"],
      { cwd: repoDir, epicsDir, stateDir },
    );
    expect(refused).toBe(2);

    const forced = runEpicCli(
      ["bind", "bind-ext-force", "feat-b", "--external", "PR #9", "--force"],
      { cwd: repoDir, epicsDir, stateDir },
    );
    expect(forced).toBe(0);
    const rec = readEpicRunState("bind-ext-force", epicsDir)?.features[
      "feat-b"
    ];
    expect(rec?.external).toBe("PR #9");
    expect(rec?.slug).toBeUndefined();
    expect(rec?.priorSlugs).toEqual(["live-slug"]);
  });

  it("bind: rejects a feature-id not in the manifest (exit 2)", () => {
    gitInit();
    writeManifest("bind-miss", [{ id: "feat-a" }]);
    const code = runEpicCli(["bind", "bind-miss", "ghost-feat", "some-slug"], {
      cwd: repoDir,
      epicsDir,
      stateDir,
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/not in the manifest/);
  });

  it("bind: slug positional and --external are mutually exclusive (exit 2)", () => {
    gitInit();
    writeManifest("bind-mutex", [{ id: "feat-a" }]);
    const code = runEpicCli(
      ["bind", "bind-mutex", "feat-a", "a-slug", "--external", "PR #1"],
      { cwd: repoDir, epicsDir, stateDir },
    );
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/mutually exclusive/);
  });

  // ── launch ──────────────────────────────────────────────────────────────

  it("launch: on success records the minted slug binding before exiting 0", () => {
    gitInit();
    writeManifest("launch-ok", [{ id: "feat-c" }]);
    const spawn = okSpawn("feat-c-minted");
    const code = runEpicCli(["launch", "launch-ok", "feat-c"], {
      cwd: repoDir,
      epicsDir,
      spawn,
    });
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(logs[0]).toBe("flow:feat-c-minted");
    const rec = readEpicRunState("launch-ok", epicsDir)?.features["feat-c"];
    expect(rec?.slug).toBe("feat-c-minted");
    expect(rec?.launchedAt).toBeDefined();
  });

  it("launch: on flow-feature-create failure writes NO record and exits non-zero", () => {
    gitInit();
    writeManifest("launch-fail", [{ id: "feat-c" }]);
    const failSpawn = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "window 'flow:feat-c' already exists",
    }));
    const code = runEpicCli(["launch", "launch-fail", "feat-c"], {
      cwd: repoDir,
      epicsDir,
      spawn: failSpawn,
    });
    expect(code).toBe(2);
    // Nothing recorded — the binding is only written once the pipeline exists.
    expect(
      readEpicRunState("launch-fail", epicsDir)?.features["feat-c"],
    ).toBeUndefined();
  });

  it("launch: refuses an already-bound feature without --force (exit 2)", () => {
    gitInit();
    const manifestPath = writeManifest("launch-bound", [{ id: "feat-c" }]);
    writeEpicRunState(
      seedRunState("launch-bound", manifestPath, {
        features: { "feat-c": { slug: "already", launchedAt: "x" } },
      }),
      epicsDir,
    );
    const spawn = okSpawn();
    const code = runEpicCli(["launch", "launch-bound", "feat-c"], {
      cwd: repoDir,
      epicsDir,
      spawn,
    });
    expect(code).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/already bound/);
  });

  it("launch --force: relaunches an already-bound feature and appends the old slug to priorSlugs", () => {
    gitInit();
    const manifestPath = writeManifest("launch-relaunch", [{ id: "feat-c" }]);
    writeEpicRunState(
      seedRunState("launch-relaunch", manifestPath, {
        features: { "feat-c": { slug: "stale-slug", launchedAt: "x" } },
      }),
      epicsDir,
    );
    const spawn = okSpawn("relaunched-slug");
    const code = runEpicCli(
      ["launch", "launch-relaunch", "feat-c", "--force"],
      {
        cwd: repoDir,
        epicsDir,
        spawn,
      },
    );
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    const rec = readEpicRunState("launch-relaunch", epicsDir)?.features[
      "feat-c"
    ];
    expect(rec?.slug).toBe("relaunched-slug");
    expect(rec?.priorSlugs).toEqual(["stale-slug"]);
  });

  // ── launch: --model / --effort per-launch overrides ───────────────────

  it("launch --effort low threads through to the spawned flow feature create argv", () => {
    gitInit();
    writeManifest("launch-effort", [{ id: "feat-c" }]);
    const spawn = okSpawn("feat-c-minted");
    const code = runEpicCli(
      ["launch", "launch-effort", "feat-c", "--effort", "low"],
      { cwd: repoDir, epicsDir, spawn },
    );
    expect(code).toBe(0);
    const args = spawn.mock.calls[0]![1] as string[];
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
  });

  it("launch --model opus appends --model to the spawned argv", () => {
    gitInit();
    writeManifest("launch-model", [{ id: "feat-c" }]);
    const spawn = okSpawn("feat-c-minted");
    const code = runEpicCli(
      ["launch", "launch-model", "feat-c", "--model", "opus"],
      { cwd: repoDir, epicsDir, spawn },
    );
    expect(code).toBe(0);
    const args = spawn.mock.calls[0]![1] as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
  });

  it("launch --effort bogus: invalid value exits 2, spawn not called, no run.json record", () => {
    gitInit();
    writeManifest("launch-bad-effort", [{ id: "feat-c" }]);
    const spawn = okSpawn();
    const code = runEpicCli(
      ["launch", "launch-bad-effort", "feat-c", "--effort", "bogus"],
      { cwd: repoDir, epicsDir, spawn },
    );
    expect(code).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/invalid --effort value/);
    expect(
      readEpicRunState("launch-bad-effort", epicsDir)?.features["feat-c"],
    ).toBeUndefined();
  });

  it("launch --model gpt4: invalid value exits 2, spawn not called, no run.json record", () => {
    gitInit();
    writeManifest("launch-bad-model", [{ id: "feat-c" }]);
    const spawn = okSpawn();
    const code = runEpicCli(
      ["launch", "launch-bad-model", "feat-c", "--model", "gpt4"],
      { cwd: repoDir, epicsDir, spawn },
    );
    expect(code).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/invalid --model value/);
    expect(
      readEpicRunState("launch-bad-model", epicsDir)?.features["feat-c"],
    ).toBeUndefined();
  });

  it("launch --model (missing value): exits 2, spawn not called", () => {
    gitInit();
    writeManifest("launch-missing-model", [{ id: "feat-c" }]);
    const spawn = okSpawn();
    const code = runEpicCli(
      ["launch", "launch-missing-model", "feat-c", "--model"],
      { cwd: repoDir, epicsDir, spawn },
    );
    expect(code).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("launch: a positional after a value flag still resolves the trailing positional correctly", () => {
    gitInit();
    writeManifest("launch-posn", [{ id: "feat-c" }]);
    const spawn = okSpawn("feat-c-minted");
    const code = runEpicCli(
      ["launch", "launch-posn", "--model", "opus", "feat-c"],
      { cwd: repoDir, epicsDir, spawn },
    );
    expect(code).toBe(0);
    const rec = readEpicRunState("launch-posn", epicsDir)?.features["feat-c"];
    expect(rec?.slug).toBe("feat-c-minted");
  });

  it("launch: a flag value colliding with a positional still resolves both positionals (index-based stripping)", () => {
    gitInit();
    // The epic slug itself is 'opus' — the same literal string as the
    // --model value — so a value-based (string-match) strip would wrongly
    // remove the epic-slug positional too.
    writeManifest("opus", [{ id: "low" }]);
    const spawn = okSpawn("low-minted");
    const code = runEpicCli(["launch", "opus", "low", "--model", "opus"], {
      cwd: repoDir,
      epicsDir,
      spawn,
    });
    expect(code).toBe(0);
    const args = spawn.mock.calls[0]![1] as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    const rec = readEpicRunState("opus", epicsDir)?.features["low"];
    expect(rec?.slug).toBe("low-minted");
  });

  it("launch: '--model --effort low' errors '--model requires a value' (not 'invalid --model value')", () => {
    gitInit();
    writeManifest("launch-model-then-effort", [{ id: "feat-c" }]);
    const spawn = okSpawn();
    const code = runEpicCli(
      [
        "launch",
        "launch-model-then-effort",
        "feat-c",
        "--model",
        "--effort",
        "low",
      ],
      { cwd: repoDir, epicsDir, spawn },
    );
    expect(code).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/--model requires a value/);
    expect(errors.join("\n")).not.toMatch(/invalid --model value/);
  });

  it("launch with overrides: committed manifest.json is byte-identical after launch", () => {
    gitInit();
    const manifestPath = writeManifest("launch-manifest-untouched", [
      { id: "feat-c" },
    ]);
    const before = fs.readFileSync(manifestPath, "utf8");
    const spawn = okSpawn("feat-c-minted");
    const code = runEpicCli(
      [
        "launch",
        "launch-manifest-untouched",
        "feat-c",
        "--model",
        "opus",
        "--effort",
        "high",
      ],
      { cwd: repoDir, epicsDir, spawn },
    );
    expect(code).toBe(0);
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
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

describe("runEpicCli done", () => {
  const seedRun = (slug: string) =>
    writeEpicRunState(
      {
        epicSlug: slug,
        repo: "/tmp/repo",
        manifestPath: "/tmp/repo/.flow/epics/" + slug + "/manifest.json",
        manifestSha: "abc",
        maxParallel: 3,
        createdAt: "2026-06-28T12:00:00Z",
        updatedAt: "2026-06-28T12:00:00Z",
        features: {},
      },
      epicsDir,
    );

  it("--help returns 0 with no fs side effect", () => {
    const before = fs.readdirSync(epicsDir);
    expect(runEpicCli(["done", "--help"], { stateDir, epicsDir })).toBe(0);
    expect(fs.readdirSync(epicsDir)).toEqual(before);
  });

  it("missing slug exits 2", () => {
    expect(runEpicCli(["done"], { stateDir, epicsDir })).toBe(2);
    expect(errors.join("\n")).toContain("flow epic done:");
  });

  it("nonexistent dir exits 1 without throwing", () => {
    expect(runEpicCli(["done", "ghost"], { stateDir, epicsDir })).toBe(1);
    expect(errors.join("\n")).toMatch(/no run-state/);
  });

  it("done <slug> --yes removes the dir and exits 0", () => {
    seedRun("finished");
    expect(
      runEpicCli(["done", "finished", "--yes"], { stateDir, epicsDir }),
    ).toBe(0);
    expect(fs.existsSync(path.join(epicsDir, "finished"))).toBe(false);
    expect(logs.join("\n")).toMatch(/removed:/);
  });

  it("done <slug> -y removes the dir and exits 0 without the confirm seam", () => {
    seedRun("short-flag");
    const confirm = vi.fn(() => true);
    expect(
      runEpicCli(["done", "short-flag", "-y"], { stateDir, epicsDir, confirm }),
    ).toBe(0);
    expect(fs.existsSync(path.join(epicsDir, "short-flag"))).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("rejects a traversal slug ('..') without deleting and exits 2", () => {
    expect(runEpicCli(["done", "..", "--yes"], { stateDir, epicsDir })).toBe(2);
    expect(errors.join("\n")).toMatch(/invalid slug/);
    // The guard must fire BEFORE path.join(epicsDir, '..') + rmSync, which
    // would otherwise recursively delete epicsDir's parent (all of ~/.flow).
    expect(fs.existsSync(epicsDir)).toBe(true);
  });

  it("declined confirm leaves the dir and exits 0", () => {
    seedRun("keepme");
    expect(
      runEpicCli(["done", "keepme"], {
        stateDir,
        epicsDir,
        confirm: () => false,
      }),
    ).toBe(0);
    expect(fs.existsSync(path.join(epicsDir, "keepme"))).toBe(true);
    expect(logs.join("\n")).toMatch(/aborted/);
  });

  it("accepted confirm removes the dir", () => {
    seedRun("killme");
    expect(
      runEpicCli(["done", "killme"], {
        stateDir,
        epicsDir,
        confirm: () => true,
      }),
    ).toBe(0);
    expect(fs.existsSync(path.join(epicsDir, "killme"))).toBe(false);
  });

  it("cross-pointer hint fires when a pipeline-state file exists", () => {
    seedRun("hinted");
    writeState(
      { slug: "hinted", phase: "epic-approved", repo: "", updatedAt: "" },
      stateDir,
    );
    expect(
      runEpicCli(["done", "hinted", "--yes"], { stateDir, epicsDir }),
    ).toBe(0);
    expect(logs.join("\n")).toMatch(/flow done hinted/);
  });

  it("cross-pointer hint fires when a tmux window exists", () => {
    seedRun("winhint");
    tmuxMock.windowExists.mockReturnValue(true);
    expect(
      runEpicCli(["done", "winhint", "--yes"], { stateDir, epicsDir }),
    ).toBe(0);
    expect(logs.join("\n")).toMatch(/flow done winhint/);
  });

  it("no hint when neither window nor state exists", () => {
    seedRun("silent");
    expect(
      runEpicCli(["done", "silent", "--yes"], { stateDir, epicsDir }),
    ).toBe(0);
    expect(logs.join("\n")).not.toMatch(/flow done/);
  });
});
