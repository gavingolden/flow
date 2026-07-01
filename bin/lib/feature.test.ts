import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs's readSync so the multi-slug --resume preview's confirm() is
// drivable from tests. Everything else (real mkdtempSync / writeState reads /
// existsSync) passes through via `...actual`. The real fs.readSync property
// isn't reconfigurable, so vi.spyOn fails — vi.mock at module scope is the
// only seam (mirrors done.test.ts).
const readSyncMock = vi.hoisted(() =>
  vi.fn<(fd: number, buf: Buffer, ...rest: unknown[]) => number>(() => 0),
);
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readSync: readSyncMock };
});

// Mock tmux primitives so the resume happy/refusal paths don't shell out.
// The mocks are toggled per-test via the exported handles below.
const tmuxMock = vi.hoisted(() => ({
  windowExists: vi.fn<(name: string) => boolean>(() => false),
  isPaneAlive: vi.fn<(name: string) => boolean>(() => false),
  // feature.ts now launches windows through the liveness-verified wrappers, so the
  // mock drives those (not the bare createWindow/respawnWindow). They default
  // to ok so the happy paths still pass without per-test setup. The 5th arg is
  // the deps object carrying the injected `consumed` state-file-poll predicate.
  createWindowVerified: vi.fn<
    (
      name: string,
      cwd: string,
      command: string[],
      seed: string,
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
      seed: string,
      deps?: { consumed?: () => boolean; onProgress?: (ms: number) => void },
    ) => {
      status: "started" | "launched-not-confirmed" | "failed";
      stderr: string;
    }
  >(() => ({ status: "started", stderr: "" })),
  FLOW_SESSION: "flow",
}));
vi.mock("./tmux", () => tmuxMock);

import { runNew, runFeatureCli, deriveWorktreePath } from "./feature";
import { writeState } from "./state";

let stateDir!: string;
let repoDir!: string;
let semDir!: string;
let errors!: string[];
let logs!: string[];

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-new-"));
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-new-repo-"));
  // Redirect the host-wide launch semaphore off the real ~/.flow so the whole
  // suite's launches stay hermetic (feature.ts honors this env override).
  semDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-new-sem-"));
  process.env.FLOW_LAUNCH_SEM_DIR = semDir;
  // Redirect the flow-scoped --settings file off the real ~/.flow too, so any
  // test that omits `command` (and so builds the real argv) writes to a temp.
  process.env.FLOW_LAUNCH_SETTINGS_PATH = path.join(
    semDir,
    "launch-settings.json",
  );
  delete process.env.FLOW_LAUNCH_CONCURRENCY;
  errors = [];
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  tmuxMock.windowExists.mockReset().mockReturnValue(false);
  tmuxMock.isPaneAlive.mockReset().mockReturnValue(false);
  tmuxMock.createWindowVerified
    .mockReset()
    .mockReturnValue({ status: "started", stderr: "" });
  tmuxMock.respawnWindowVerified
    .mockReset()
    .mockReturnValue({ status: "started", stderr: "" });
  readSyncMock.mockReset().mockReturnValue(0);
});

function declinePrompt(): void {
  readSyncMock.mockImplementation((_fd, buf) => {
    const bytes = Buffer.from("n\n");
    bytes.copy(buf as Buffer);
    return bytes.length;
  });
}

function acceptPrompt(): void {
  readSyncMock.mockImplementation((_fd, buf) => {
    const bytes = Buffer.from("y\n");
    bytes.copy(buf as Buffer);
    return bytes.length;
  });
}

// runFresh probes windowExists twice now: the up-front "already exists" guard
// (false = proceed) and the pre-persist Mode-2 re-check (true = window still
// present). Default both for a happy fresh launch. Resume tests are unaffected
// (runResume calls windowExists once) and keep the beforeEach default.
function freshWindowOk(): void {
  tmuxMock.windowExists
    .mockReset()
    .mockReturnValueOnce(false)
    .mockReturnValue(true);
}

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(semDir, { recursive: true, force: true });
  delete process.env.FLOW_LAUNCH_SEM_DIR;
  delete process.env.FLOW_LAUNCH_SETTINGS_PATH;
  delete process.env.FLOW_LAUNCH_CONCURRENCY;
  vi.restoreAllMocks();
});

function seedState(slug: string, repo = repoDir): void {
  writeState(
    {
      slug,
      phase: "verifying",
      repo,
      updatedAt: new Date().toISOString(),
    },
    stateDir,
  );
}

describe("runNew --resume", () => {
  it("rejects an empty name", () => {
    const code = runNew("", { resume: true, stateDir });
    expect(code).toBe(1);
    expect(errors[0]).toMatch(/<name> is required/);
  });

  it("rejects whitespace-only names", () => {
    const code = runNew("   ", { resume: true, stateDir });
    expect(code).toBe(1);
    expect(errors[0]).toMatch(/<name> is required/);
  });

  it("rejects names that are not already valid slugs", () => {
    // Resume takes a slug, not a description: 'CSV Export' wouldn't round-trip.
    const code = runNew("CSV Export", { resume: true, stateDir });
    expect(code).toBe(1);
    expect(errors[0]).toMatch(/not a valid pipeline name/);
  });

  it("refuses when no state file exists for the slug", () => {
    const code = runNew("ghost", { resume: true, stateDir });
    expect(code).toBe(1);
    expect(errors[0]).toMatch(/no pipeline state for 'ghost'/);
    expect(errors[1]).toMatch(/run `flow feature create <description>`/);
  });

  it("does not write state on a refusal path", () => {
    runNew("ghost", { resume: true, stateDir });
    expect(fs.existsSync(path.join(stateDir, "ghost.json"))).toBe(false);
  });

  it("refuses when the recorded repo path no longer exists", () => {
    const goneRepo = fs.mkdtempSync(path.join(os.tmpdir(), "flow-gone-"));
    fs.rmSync(goneRepo, { recursive: true, force: true });
    seedState("zombie", goneRepo);
    const code = runNew("zombie", { resume: true, stateDir });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/no longer exists/);
    expect(errors.join("\n")).toContain(goneRepo);
  });

  it("refuses when the pane is still alive (live supervisor)", () => {
    seedState("alive-one");
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(true);
    const code = runNew("alive-one", { resume: true, stateDir });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/is still running/);
    expect(errors.join("\n")).toMatch(/flow attach alive-one/);
    expect(tmuxMock.respawnWindowVerified).not.toHaveBeenCalled();
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
  });

  it("respawns the existing window when state exists and pane is dead", () => {
    seedState("crashed");
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);
    const settingsPath = path.join(stateDir, "launch-settings.json");
    const code = runNew("crashed", {
      resume: true,
      stateDir,
      launchSettingsPath: settingsPath,
    });
    expect(code).toBe(0);
    expect(tmuxMock.respawnWindowVerified).toHaveBeenCalledTimes(1);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
    const [, cwd, command, seed] =
      tmuxMock.respawnWindowVerified.mock.calls[0]!;
    expect(cwd).toBe(repoDir);
    // The argv carries NO positional seed — just the claude flags + --settings.
    // The seed is delivered via send-keys (the 4th arg below).
    expect(command).toEqual([
      "env",
      "FLOW_PIPELINE=1",
      "claude",
      "--add-dir",
      deriveWorktreePath(repoDir, "crashed"),
      "--settings",
      settingsPath,
    ]);
    // Contract: the resume seed prefix is what the supervisor parses to detect
    // resume mode. SKILL.md hard-codes the literal string; if this assertion
    // ever fails, update both ends in lockstep. Delivered via send-keys (4th arg).
    expect(seed).toBe(
      "[pipeline-slug: crashed]\nUse the /flow-pipeline skill in --resume mode for: crashed",
    );
    expect(logs[0]).toBe("flow:crashed");
    // Cross-verb voice: the second line uses the stable `flow feature resume:` prose
    // voice. Non-TTY (vitest) → no ANSI on either line.
    expect(logs[1]).toBe(
      "flow feature resume: resumed — attach with `flow attach crashed`",
    );
  });

  it("recreates the window when tmux has lost it (no window, dead pane)", () => {
    seedState("tmux-bounced");
    tmuxMock.windowExists.mockReturnValue(false);
    const code = runNew("tmux-bounced", { resume: true, stateDir });
    expect(code).toBe(0);
    expect(tmuxMock.createWindowVerified).toHaveBeenCalledTimes(1);
    expect(tmuxMock.respawnWindowVerified).not.toHaveBeenCalled();
  });

  it("does not rewrite state.json on entry (the supervisor's first transition does)", () => {
    seedState("preserve");
    tmuxMock.windowExists.mockReturnValue(true);
    const before = fs.readFileSync(
      path.join(stateDir, "preserve.json"),
      "utf8",
    );
    runNew("preserve", { resume: true, stateDir });
    const after = fs.readFileSync(path.join(stateDir, "preserve.json"), "utf8");
    expect(after).toBe(before);
  });

  it("surfaces the tmux failure when the verified respawn returns non-ok", () => {
    seedState("respawn-fail");
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.respawnWindowVerified.mockReturnValue({
      status: "failed",
      stderr: "can't find session: flow",
    });
    const code = runNew("respawn-fail", {
      resume: true,
      stateDir,
      retrySleepMs: 0,
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/claude exited immediately after launch/);
    expect(errors.join("\n")).toContain("can't find session: flow");
  });

  it("wires a resume consumed predicate that gates on updatedAt advancing past the baseline", () => {
    // On resume the phase is already past `starting`, so consumption is keyed on
    // `updatedAt` moving off the pre-respawn value, not on a phase change.
    const baseline = new Date(Date.now() - 10_000).toISOString();
    writeState(
      {
        slug: "resumed",
        phase: "verifying",
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
    const code = runNew("resumed", { resume: true, stateDir });
    expect(code).toBe(0);
    expect(consumedFn).toBeDefined();
    // updatedAt still equals the baseline → not yet consumed.
    expect(consumedFn!()).toBe(false);
    // The resumed supervisor bumps updatedAt → the predicate flips true.
    writeState(
      {
        slug: "resumed",
        phase: "verifying",
        repo: repoDir,
        updatedAt: new Date().toISOString(),
      },
      stateDir,
    );
    expect(consumedFn!()).toBe(true);
  });

  it("resume consumed predicate ignores a STALE seedIngestedAt marker and requires a fresh re-stamp", () => {
    // Regression: the seed-ingested hook stamps `seedIngestedAt` on the ORIGINAL
    // fresh launch, and runResume never clears it (writeState is not called on
    // the resume path). A bare `seedIngestedAt != null` check would short-circuit
    // consumed() true on the first probe off the stale marker — skipping the
    // resume-seed send-keys (the double-submit guard) and latching a false-success
    // resume that never delivered the seed. consumed() must require the marker to
    // DIFFER from the captured pre-resume value (a fresh re-stamp by the resumed
    // session), so a stale marker alone does not confirm.
    const baseline = new Date(Date.now() - 10_000).toISOString();
    const staleMarker = new Date(Date.now() - 9_000).toISOString();
    writeState(
      {
        slug: "stale-marker",
        phase: "verifying",
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
    const code = runNew("stale-marker", { resume: true, stateDir });
    expect(code).toBe(0);
    expect(consumedFn).toBeDefined();
    // Stale marker unchanged + updatedAt unchanged → NOT consumed (the bug would
    // return true here off the stale marker).
    expect(consumedFn!()).toBe(false);
    // The resumed session's hook RE-STAMPS the marker with a new timestamp → flips.
    writeState(
      {
        slug: "stale-marker",
        phase: "verifying",
        repo: repoDir,
        updatedAt: baseline,
        seedIngestedAt: new Date().toISOString(),
      },
      stateDir,
    );
    expect(consumedFn!()).toBe(true);
  });

  it("resume launcher timeout leaves state byte-unchanged and never deletes it (symmetry)", () => {
    // A respawn that never consumes returns ok:false → exit 1, but runResume must
    // NOT kill the window (mocked launcher) and must NOT rewrite or delete state:
    // the window pre-existed the resume.
    seedState("resume-timeout");
    const before = fs.readFileSync(
      path.join(stateDir, "resume-timeout.json"),
      "utf8",
    );
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);
    tmuxMock.respawnWindowVerified.mockReturnValue({
      status: "failed",
      stderr:
        "tmux window respawned but claude died before the seed was confirmed consumed (pane not alive)",
    });
    const code = runNew("resume-timeout", {
      resume: true,
      stateDir,
      retrySleepMs: 0,
    });
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(stateDir, "resume-timeout.json"))).toBe(
      true,
    );
    const after = fs.readFileSync(
      path.join(stateDir, "resume-timeout.json"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("BLOCKING regression: resume captures the updatedAt baseline ONCE before the retry loop (Task 4), and the non-destructive timeout makes that safe", () => {
    // Story 5 / Task 4: the resume `consumed()` predicate now compares against the
    // ORIGINAL pre-resume baseline captured ONCE before `launchWithRetry`, not a
    // per-attempt re-read. Paired with Task 3's non-destructive timeout (a
    // live-but-slow resume is `launched-not-confirmed`, never respawn-killed),
    // this fixes the working-session-killed bug. ACCEPTED rare trade-off: a
    // dead-then-retried resume whose first attempt bumped `updatedAt` reads
    // "consumed" on the next attempt — that only means the supervisor DID start
    // at some point, and resume-over-it is the user's intent. So attempt 1 reads
    // false (updatedAt == baseline) and attempt 2 reads TRUE (the once-captured
    // baseline; attempt 1's bump is now past it).
    const baseline = new Date(Date.now() - 10_000).toISOString();
    writeState(
      {
        slug: "resumed",
        phase: "verifying",
        repo: repoDir,
        updatedAt: baseline,
      },
      stateDir,
    );
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);
    const consumedAtLaunch: boolean[] = [];
    tmuxMock.respawnWindowVerified
      .mockReset()
      .mockImplementationOnce((_name, _cwd, _command, _seed, deps) => {
        consumedAtLaunch.push(deps!.consumed!());
        // The resumed supervisor bumps updatedAt (advances) then the pane dies.
        writeState(
          {
            slug: "resumed",
            phase: "verifying",
            repo: repoDir,
            updatedAt: new Date().toISOString(),
          },
          stateDir,
        );
        return {
          status: "failed",
          stderr:
            "tmux window respawned but claude died before the seed was confirmed consumed (pane not alive)",
        };
      })
      .mockImplementationOnce((_name, _cwd, _command, _seed, deps) => {
        consumedAtLaunch.push(deps!.consumed!());
        return { status: "started", stderr: "" };
      });
    const code = runNew("resumed", { resume: true, stateDir, retrySleepMs: 0 });
    expect(code).toBe(0);
    expect(tmuxMock.respawnWindowVerified).toHaveBeenCalledTimes(2);
    // Once-captured baseline: attempt 1 false, attempt 2 true (the accepted
    // rare false-success the non-destructive timeout makes harmless).
    expect(consumedAtLaunch).toEqual([false, true]);
  });
});

describe("runFeatureCli --resume (multi-slug)", () => {
  it("resumes each slug sequentially with the per-slug resume seed and exits 0", () => {
    seedState("x");
    seedState("y");
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);

    const code = runFeatureCli(["resume", "x", "y", "--yes"], { stateDir });

    expect(code).toBe(0);
    expect(tmuxMock.respawnWindowVerified).toHaveBeenCalledTimes(2);
    // The seed is the 4th arg (send-keys delivery), no longer the argv tail.
    const launched = tmuxMock.respawnWindowVerified.mock.calls.map(
      ([name, , , seed]) => ({ name, prompt: seed }),
    );
    expect(launched).toContainEqual({
      name: "x",
      prompt:
        "[pipeline-slug: x]\nUse the /flow-pipeline skill in --resume mode for: x",
    });
    expect(launched).toContainEqual({
      name: "y",
      prompt:
        "[pipeline-slug: y]\nUse the /flow-pipeline skill in --resume mode for: y",
    });
  });

  it("is sequential and fail-soft — a live-pane slug is skipped, the rest resume, exit 1", () => {
    seedState("x");
    seedState("alive");
    seedState("y");
    // `alive` has a live pane; x and y are crashed (dead pane). windowExists is
    // true for all three; only `alive` reports a live pane.
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockImplementation((name: string) => name === "alive");

    const code = runFeatureCli(["resume", "x", "alive", "y", "--yes"], {
      stateDir,
    });

    expect(code).toBe(1);
    const resumed = tmuxMock.respawnWindowVerified.mock.calls.map(
      ([name]) => name,
    );
    expect(resumed).toContain("x");
    expect(resumed).toContain("y");
    expect(resumed).not.toContain("alive");
    expect(errors.join("\n")).toMatch(/'alive' is still running/);
  });

  it("previews + confirms once for >=2 slugs — a declined prompt launches nothing", () => {
    seedState("x");
    seedState("y");
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    declinePrompt();

    const code = runFeatureCli(["resume", "x", "y"], { stateDir });

    expect(code).toBe(0);
    expect(tmuxMock.respawnWindowVerified).not.toHaveBeenCalled();
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/will resume 2 pipeline\(s\)/);
    expect(logs.join("\n")).toMatch(/aborted — nothing resumed/);
    stdoutWrite.mockRestore();
  });

  it("previews + confirms once for >=2 slugs — accepting launches all", () => {
    seedState("x");
    seedState("y");
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    acceptPrompt();

    const code = runFeatureCli(["resume", "x", "y"], { stateDir });

    expect(code).toBe(0);
    expect(tmuxMock.respawnWindowVerified).toHaveBeenCalledTimes(2);
    stdoutWrite.mockRestore();
  });

  it("dedupes a repeated slug — `--resume x x` resumes `x` once via the single-slug path", () => {
    seedState("x");
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const code = runFeatureCli(["resume", "x", "x"], { stateDir });

    expect(code).toBe(0);
    // dedup at feature.ts:91-92 collapses the repeat to length 1, so it routes
    // through the single-slug short-circuit: one respawn, no >=2 preview,
    // and the confirm prompt (readSync) is never consulted.
    expect(tmuxMock.respawnWindowVerified).toHaveBeenCalledTimes(1);
    expect(tmuxMock.respawnWindowVerified.mock.calls[0]![0]).toBe("x");
    expect(readSyncMock).not.toHaveBeenCalled();
    expect(logs.join("\n")).not.toMatch(/will resume/);
    stdoutWrite.mockRestore();
  });

  it("--yes bypasses the preview entirely (readSync is never consulted)", () => {
    seedState("x");
    seedState("y");
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);

    const code = runFeatureCli(["resume", "x", "y", "--yes"], { stateDir });

    expect(code).toBe(0);
    expect(readSyncMock).not.toHaveBeenCalled();
    expect(logs.join("\n")).not.toMatch(/will resume/);
  });
});

describe("runNew (fresh)", () => {
  it("rejects an empty description", () => {
    const code = runNew("", { stateDir });
    expect(code).toBe(1);
    expect(errors[0]).toMatch(/description is required/);
  });

  it("falls back to a deterministic task-<hash8> slug for purely-punctuation input", () => {
    // Item 15: aggressive slugify never returns "" — when stop-word filtering
    // (or in this case, dashing of pure punctuation) leaves nothing, slugify
    // returns task-<sha256[0..8]>(input). `flow feature create` should accept that slug
    // rather than refuse with the old "produces an empty slug" error, so
    // any input the user types is always actionable.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runNew("---", { stateDir, cwd: repoDir, command: ["true"] });
    expect(code).toBe(0);
    const files = fs.readdirSync(stateDir);
    const matched = files.find((f) => /^task-[0-9a-f]{8}\.json$/.test(f));
    expect(
      matched,
      `expected a task-<hash8>.json in ${files.join(",")}`,
    ).toBeDefined();
  });

  it("emits the stable 'flow feature create:' voice and a raw contract first line on a fresh start", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runNew("CSV export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
    });
    expect(code).toBe(0);
    // First line is the machine-read contract token — no ANSI, exact shape.
    expect(logs[0]).toBe("flow:csv-export");
    expect(logs[1]).toBe(
      "flow feature create: created — attach with `flow attach csv-export`",
    );
  });

  it("does not persist autoMerge by default (absent ≡ true)", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runNew("CSV export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
    });
    expect(code).toBe(0);
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "csv-export.json"), "utf8"),
    );
    expect(raw).not.toHaveProperty("autoMerge");
  });

  it("persists autoMerge: false when noAutoMerge: true is passed", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runNew("CSV export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
      noAutoMerge: true,
    });
    expect(code).toBe(0);
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "csv-export.json"), "utf8"),
    );
    expect(raw.autoMerge).toBe(false);
  });

  it("does not persist waitForCopilot by default (absent ≡ false / auto-detect ON)", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runNew("CSV export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
    });
    expect(code).toBe(0);
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "csv-export.json"), "utf8"),
    );
    expect(raw).not.toHaveProperty("waitForCopilot");
  });

  it("persists waitForCopilot: true when waitForCopilot option is true", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runNew("CSV export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
      waitForCopilot: true,
    });
    expect(code).toBe(0);
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "csv-export.json"), "utf8"),
    );
    expect(raw.waitForCopilot).toBe(true);
  });

  it("launches claude with --add-dir <derived-worktree> and --settings, NO positional seed", () => {
    // LOAD-BEARING: omit `command` so buildLaunchCommand runs — passing
    // `command: ["true"]` would short-circuit the argv under test (issue #317).
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const settingsPath = path.join(stateDir, "launch-settings.json");
    const code = runNew("CSV export", {
      stateDir,
      cwd: repoDir,
      launchSettingsPath: settingsPath,
    });
    expect(code).toBe(0);
    const [, , command, seed] = tmuxMock.createWindowVerified.mock.calls[0]!;
    // runFresh resolves the repo via `git rev-parse --show-toplevel`, which
    // returns the canonical realpath (macOS /var → /private/var), so derive
    // the expected worktree from the resolved path, not the raw temp dir. The
    // argv carries NO positional seed — just the flags + --settings.
    expect(command).toEqual([
      "env",
      "FLOW_PIPELINE=1",
      "claude",
      "--add-dir",
      deriveWorktreePath(fs.realpathSync(repoDir), "csv-export"),
      "--settings",
      settingsPath,
    ]);
    // No element of the argv is the seed text (it is send-keys-only now).
    expect(
      command.some((a) => a.includes("Use the /flow-pipeline skill")),
    ).toBe(false);
    // The 4th arg is the seed delivered via send-keys.
    expect(seed).toBe(
      "[pipeline-slug: csv-export]\nUse the /flow-pipeline skill for: CSV export",
    );
    // The supervisor marker lets leaf skills detect they run inside the pipeline.
    expect(command).toContain("FLOW_PIPELINE=1");
    // The flow-scoped settings file was written (registers the hook) and never
    // touches the global ~/.claude/settings.json.
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.hooks).toHaveProperty("UserPromptSubmit");
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      "flow-seed-ingested-hook",
    );
  });

  it("fresh launched-not-confirmed: exit 0, keeps the up-front state, prints the still-starting message", () => {
    // The pane is alive but the supervisor hasn't confirmed the seed in the short
    // budget. Non-destructive: state is KEPT (the reaper backstops it), exit 0,
    // and the distinct message goes to stderr while stdout line 1 stays flow:slug.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    tmuxMock.createWindowVerified.mockReturnValue({
      status: "launched-not-confirmed",
      stderr: "",
    });
    const code = runNew("CSV export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
      retrySleepMs: 0,
    });
    expect(code).toBe(0);
    expect(logs[0]).toBe("flow:csv-export");
    expect(fs.existsSync(path.join(stateDir, "csv-export.json"))).toBe(true);
    expect(errors.join("\n")).toContain(
      "launched; supervisor still starting — attach to verify",
    );
  });

  it("backoff schedule: failed attempts sleep 1s then 2s via the injected sleep spy", () => {
    // Task 2: the flat 150ms retry is replaced by an increasing 1s→2s→4s backoff.
    // With 3 failing attempts there are 2 inter-attempt gaps → [1000, 2000]. The
    // retrySleep seam (not retrySleepMs:0) is injected so the schedule is
    // assertable without real sleeping.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    tmuxMock.createWindowVerified.mockReturnValue({
      status: "failed",
      stderr: "transient",
    });
    const sleeps: number[] = [];
    const code = runNew("CSV export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
      retrySleep: (ms) => sleeps.push(ms),
    });
    expect(code).not.toBe(0);
    expect(tmuxMock.createWindowVerified).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("marker-aware fresh consumed(): true on seedIngestedAt+alive, falls back to phase past starting", () => {
    // Task 7: the launch-time seed-ingested marker latches consumed() even before
    // the supervisor advances the phase; absent the marker it falls back to the
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
    runNew("CSV export", { stateDir, cwd: repoDir, command: ["true"] });
    expect(consumedFn).toBeDefined();
    // Up-front state is `starting`, no marker → not consumed.
    expect(consumedFn!()).toBe(false);
    // Stamp the marker (phase still starting) → consumed via the marker.
    writeState(
      {
        slug: "csv-export",
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

describe("runFresh — launch concurrency semaphore (Task 8)", () => {
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
    const code = runNew("CSV export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
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
    const code = runNew("CSV export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
      retrySleepMs: 0,
    });
    expect(code).not.toBe(0);
    expect(fs.readdirSync(semDir).filter((f) => f.startsWith("slot-"))).toEqual(
      [],
    );
  });

  it("honors FLOW_LAUNCH_CONCURRENCY and fails open when the cap is saturated", () => {
    // cap=1 + slot-0 pre-held by THIS (live) pid → no free slot. The acquire
    // times out fast and the launch proceeds holding NO slot (fail-open). That
    // the launch ran with only the pre-held slot present (count 1, not 2) proves
    // BOTH the override (cap=1, not the default 4) AND the fail-open path.
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
    const code = runNew("CSV export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
      launchSemTimeoutMs: 30,
    });
    expect(code).toBe(0); // fail-open: launch ran despite the saturated cap
    expect(slotsDuringLaunch).toBe(1); // only the pre-held slot — held none
    fs.rmSync(path.join(semDir, "slot-0"), { force: true });
  });
});

describe("deriveWorktreePath", () => {
  it("mirrors flow-new-worktree's <repo-parent>/<repoName>-<slug> rule for a slash-free slug", () => {
    expect(deriveWorktreePath("/Users/me/code/flow", "csv-export")).toBe(
      "/Users/me/code/flow-csv-export",
    );
  });

  it("collapses slashes via toDirSuffix parity (defensive — slugs are slash-free)", () => {
    // slugify never emits slashes, but the derivation reuses toDirSuffix so it
    // cannot drift from flow-new-worktree.ts if that invariant ever changes.
    expect(deriveWorktreePath("/a/b/repo", "feature/foo")).toBe(
      "/a/b/repo-feature-foo",
    );
  });
});

describe("runFeatureCli (mini-dispatcher)", () => {
  it("with no subcommand prints a usage error and exits 2", () => {
    const code = runFeatureCli([], { stateDir });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(
      /a subcommand is required \(create\|resume\)/,
    );
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("with an unknown subcommand prints an error and exits 2", () => {
    const code = runFeatureCli(["bogus"], { stateDir });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/unknown feature subcommand: bogus/);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });
});

describe("runFeatureCli (--help / -h short-circuit)", () => {
  // Regression for the catastrophic bug: `flow feature create --help` previously
  // slugified `--help` to `help`, spawned a tmux window, and wrote
  // ~/.flow/state/help.json. The CLI shim must intercept the flag before
  // any side-effect.

  for (const flag of ["--help", "-h"]) {
    it(`exits 0 and writes no state file when args is ['${flag}']`, () => {
      const code = runFeatureCli([flag], { stateDir });
      expect(code).toBe(0);
      expect(fs.readdirSync(stateDir)).toEqual([]);
    });

    it(`prints help to stdout (not stderr) for '${flag}'`, () => {
      runFeatureCli([flag], { stateDir });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.join("\n")).toMatch(
        /^flow feature — start or resume a pipeline/,
      );
    });

    it(`does not invoke tmux for '${flag}'`, () => {
      runFeatureCli([flag], { stateDir });
      expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
      expect(tmuxMock.respawnWindowVerified).not.toHaveBeenCalled();
      expect(tmuxMock.windowExists).not.toHaveBeenCalled();
    });
  }

  it("short-circuits even when --help follows --no-auto-merge", () => {
    const code = runFeatureCli(["create", "--no-auto-merge", "--help"], {
      stateDir,
    });
    expect(code).toBe(0);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
  });

  it("short-circuits even when --help follows --resume", () => {
    // --resume normally requires a single <name>; with --help present the
    // shim must print help instead of erroring on missing <name>.
    const code = runFeatureCli(["resume", "--help"], { stateDir });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
  });

  it("runFeatureCli --wait-for-copilot writes waitForCopilot: true and excludes the flag from the slug", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runFeatureCli(
      ["create", "--wait-for-copilot", "do", "thing"],
      {
        stateDir,
        cwd: repoDir,
        command: ["true"],
      },
    );
    expect(code).toBe(0);
    // Slug must not include "wait-for-copilot" tokens; description was "do thing".
    expect(fs.existsSync(path.join(stateDir, "do-thing.json"))).toBe(true);
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "do-thing.json"), "utf8"),
    );
    expect(raw.waitForCopilot).toBe(true);
  });

  it("runFeatureCli --research writes forceResearch: true and excludes the flag from the slug", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runFeatureCli(["create", "--research", "do", "thing"], {
      stateDir,
      cwd: repoDir,
      command: ["true"],
    });
    expect(code).toBe(0);
    // Slug must not include the "research" token; description was "do thing".
    expect(fs.existsSync(path.join(stateDir, "do-thing.json"))).toBe(true);
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "do-thing.json"), "utf8"),
    );
    expect(raw.forceResearch).toBe(true);
  });

  it("runFeatureCli without --research leaves forceResearch absent (absent ≡ not forced)", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runFeatureCli(["create", "do", "thing"], {
      stateDir,
      cwd: repoDir,
      command: ["true"],
    });
    expect(code).toBe(0);
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "do-thing.json"), "utf8"),
    );
    expect(raw).not.toHaveProperty("forceResearch");
  });

  it.each(["auto", "always", "never"] as const)(
    "runFeatureCli --copilot-review %s persists copilotReview and excludes the flag+value from the slug",
    (value) => {
      spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
      freshWindowOk();
      const code = runFeatureCli(
        ["create", "--copilot-review", value, "do", "thing"],
        {
          stateDir,
          cwd: repoDir,
          command: ["true"],
        },
      );
      expect(code).toBe(0);
      // Slug must not include the flag or its value token; description was "do thing".
      expect(fs.existsSync(path.join(stateDir, "do-thing.json"))).toBe(true);
      const raw = JSON.parse(
        fs.readFileSync(path.join(stateDir, "do-thing.json"), "utf8"),
      );
      expect(raw.copilotReview).toBe(value);
    },
  );

  it("runFeatureCli --copilot-review with an invalid value returns non-zero and writes no state", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runFeatureCli(
      ["create", "--copilot-review", "sometimes", "do", "thing"],
      {
        stateDir,
        cwd: repoDir,
        command: ["true"],
      },
    );
    expect(code).toBe(1);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(errors.join("\n")).toMatch(/auto, always, never/);
  });

  it("runFeatureCli --copilot-review with a missing value returns non-zero and writes no state", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runFeatureCli(["create", "--copilot-review"], {
      stateDir,
      cwd: repoDir,
      command: ["true"],
    });
    expect(code).toBe(1);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("runFeatureCli without --copilot-review leaves the field undefined (absent ≡ auto)", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runFeatureCli(["create", "do", "thing"], {
      stateDir,
      cwd: repoDir,
      command: ["true"],
    });
    expect(code).toBe(0);
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "do-thing.json"), "utf8"),
    );
    expect(raw).not.toHaveProperty("copilotReview");
  });

  it("runFeatureCli --effort high launches claude with --effort then --settings, no positional seed, persists effort", () => {
    // LOAD-BEARING: omit `command` so buildLaunchCommand runs — passing
    // `command: ["true"]` would short-circuit the argv under test.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const settingsPath = path.join(stateDir, "launch-settings.json");
    const code = runFeatureCli(["create", "--effort", "high", "do", "thing"], {
      stateDir,
      cwd: repoDir,
      launchSettingsPath: settingsPath,
    });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(command).toEqual([
      "env",
      "FLOW_PIPELINE=1",
      "claude",
      "--add-dir",
      deriveWorktreePath(fs.realpathSync(repoDir), "do-thing"),
      "--effort",
      "high",
      "--settings",
      settingsPath,
    ]);
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "do-thing.json"), "utf8"),
    );
    expect(raw.effort).toBe("high");
  });

  it("runFeatureCli without --effort omits --effort from the launch argv and the effort key from state", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const settingsPath = path.join(stateDir, "launch-settings.json");
    const code = runFeatureCli(["create", "do", "thing"], {
      stateDir,
      cwd: repoDir,
      launchSettingsPath: settingsPath,
    });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(command).toEqual([
      "env",
      "FLOW_PIPELINE=1",
      "claude",
      "--add-dir",
      deriveWorktreePath(fs.realpathSync(repoDir), "do-thing"),
      "--settings",
      settingsPath,
    ]);
    expect(command).not.toContain("--effort");
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "do-thing.json"), "utf8"),
    );
    expect(raw).not.toHaveProperty("effort");
  });

  it("runFeatureCli --effort with an invalid value returns non-zero and triggers no side-effect", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runFeatureCli(["create", "--effort", "bogus", "do", "thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(1);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/low, medium, high, xhigh, max/);
  });

  it("runFeatureCli --effort with a missing value returns non-zero and triggers no side-effect", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runFeatureCli(["create", "--effort"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(1);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
  });

  it("runFeatureCli --effort followed by another flag returns non-zero and triggers no side-effect", () => {
    // Pins the `value.startsWith("--")` half of the missing-value guard: a
    // following flag must not be consumed as the effort value.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runFeatureCli(
      ["create", "--effort", "--no-auto-merge", "do", "thing"],
      {
        stateDir,
        cwd: repoDir,
      },
    );
    expect(code).toBe(1);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
  });

  it("runFeatureCli --effort high strips the flag and its value token from the slug", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runFeatureCli(["create", "--effort", "high", "do", "thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(0);
    // Slug must not include the flag or its value token; description was "do thing".
    expect(fs.existsSync(path.join(stateDir, "do-thing.json"))).toBe(true);
  });

  it("runNew --resume re-applies the saved effort into the respawn argv", () => {
    // LOAD-BEARING: omit `command` so buildLaunchCommand runs.
    writeState(
      {
        slug: "saved-effort",
        phase: "verifying",
        repo: repoDir,
        effort: "max",
        updatedAt: new Date().toISOString(),
      },
      stateDir,
    );
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);
    const settingsPath = path.join(stateDir, "launch-settings.json");
    const code = runNew("saved-effort", {
      resume: true,
      stateDir,
      launchSettingsPath: settingsPath,
    });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.respawnWindowVerified.mock.calls[0]!;
    expect(command).toEqual([
      "env",
      "FLOW_PIPELINE=1",
      "claude",
      "--add-dir",
      deriveWorktreePath(repoDir, "saved-effort"),
      "--effort",
      "max",
      "--settings",
      settingsPath,
    ]);
  });

  it.each(["opus", "fable"] as const)(
    "runFeatureCli --model %s launches claude with --model before the prompt and persists model",
    (alias) => {
      // LOAD-BEARING: omit `command` so buildLaunchCommand runs.
      spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
      freshWindowOk();
      const code = runFeatureCli(["create", "--model", alias, "do", "thing"], {
        stateDir,
        cwd: repoDir,
      });
      expect(code).toBe(0);
      const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
      // NO positional seed (delivered via send-keys); --model sits between
      // --add-dir and the trailing --settings.
      expect(command).toEqual([
        "env",
        "FLOW_PIPELINE=1",
        "claude",
        "--add-dir",
        deriveWorktreePath(fs.realpathSync(repoDir), "do-thing"),
        "--model",
        alias,
        "--settings",
        path.join(semDir, "launch-settings.json"),
      ]);
      const raw = JSON.parse(
        fs.readFileSync(path.join(stateDir, "do-thing.json"), "utf8"),
      );
      expect(raw.model).toBe(alias);
    },
  );

  it("runFeatureCli --model opus --effort high orders --model before --effort before the prompt", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runFeatureCli(
      ["create", "--model", "opus", "--effort", "high", "do", "thing"],
      {
        stateDir,
        cwd: repoDir,
      },
    );
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    // Deterministic order: --model before --effort, both before --settings.
    expect(command).toEqual([
      "env",
      "FLOW_PIPELINE=1",
      "claude",
      "--add-dir",
      deriveWorktreePath(fs.realpathSync(repoDir), "do-thing"),
      "--model",
      "opus",
      "--effort",
      "high",
      "--settings",
      path.join(semDir, "launch-settings.json"),
    ]);
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "do-thing.json"), "utf8"),
    );
    expect(raw.model).toBe("opus");
    expect(raw.effort).toBe("high");
  });

  it("runFeatureCli without --model omits --model from the launch argv and the model key from state", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runFeatureCli(["create", "do", "thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(command).not.toContain("--model");
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "do-thing.json"), "utf8"),
    );
    expect(raw).not.toHaveProperty("model");
  });

  it("runFeatureCli --model with an invalid value returns non-zero and triggers no side-effect", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runFeatureCli(["create", "--model", "gpt4", "do", "thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(1);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/opus, haiku, sonnet, fable/);
  });

  it("runFeatureCli --model with a missing value returns non-zero and triggers no side-effect", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runFeatureCli(["create", "--model"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(1);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
  });

  it("runFeatureCli --model followed by another flag returns non-zero and triggers no side-effect", () => {
    // Pins the `value.startsWith("--")` half of the missing-value guard: a
    // following flag must not be consumed as the model value.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runFeatureCli(
      ["create", "--model", "--no-auto-merge", "do", "thing"],
      {
        stateDir,
        cwd: repoDir,
      },
    );
    expect(code).toBe(1);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
  });

  it("runFeatureCli --model opus strips the flag and its value token from the slug", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runFeatureCli(["create", "--model", "opus", "do", "thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(stateDir, "do-thing.json"))).toBe(true);
  });

  it("runNew --resume re-applies the saved model into the respawn argv", () => {
    // LOAD-BEARING: omit `command` so buildLaunchCommand runs.
    writeState(
      {
        slug: "saved-model",
        phase: "verifying",
        repo: repoDir,
        model: "opus",
        updatedAt: new Date().toISOString(),
      },
      stateDir,
    );
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);
    const code = runNew("saved-model", { resume: true, stateDir });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.respawnWindowVerified.mock.calls[0]!;
    // NO positional seed (delivered via send-keys); the saved --model is
    // re-applied between --add-dir and the trailing --settings.
    expect(command).toEqual([
      "env",
      "FLOW_PIPELINE=1",
      "claude",
      "--add-dir",
      deriveWorktreePath(repoDir, "saved-model"),
      "--model",
      "opus",
      "--settings",
      path.join(semDir, "launch-settings.json"),
    ]);
  });

  it("runNew --resume prefers the recorded worktree path over the derived one for --add-dir", () => {
    // When state.worktree is set (the common post-step-2 case), the resume
    // argv must pre-authorize the ACTUAL worktree — covering the auto-suffix
    // divergence case where the derived bare-slug path is wrong.
    const recordedWorktree = path.join(
      path.dirname(repoDir),
      `${path.basename(repoDir)}-suffixed-slug-2`,
    );
    writeState(
      {
        slug: "suffixed-slug",
        phase: "verifying",
        repo: repoDir,
        worktree: recordedWorktree,
        updatedAt: new Date().toISOString(),
      },
      stateDir,
    );
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);
    const settingsPath = path.join(stateDir, "launch-settings.json");
    const code = runNew("suffixed-slug", {
      resume: true,
      stateDir,
      launchSettingsPath: settingsPath,
    });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.respawnWindowVerified.mock.calls[0]!;
    expect(command).toEqual([
      "env",
      "FLOW_PIPELINE=1",
      "claude",
      "--add-dir",
      recordedWorktree,
      "--settings",
      settingsPath,
    ]);
    // Falls back to the derived bare-slug path only when no worktree recorded.
    expect(command).not.toContain(deriveWorktreePath(repoDir, "suffixed-slug"));
  });

  it("treats -h after `--` as part of the description, not a help flag", () => {
    // Regression for the over-eager argsContainHelp scan: a description body
    // that happens to contain `-h` (e.g. `flow feature create -- fix the -h crash`)
    // must not be intercepted as `flow feature create --help`. Pipeline runs, slug
    // derives from the words after `--`.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const code = runFeatureCli(["create", "--", "fix", "the", "-h", "crash"], {
      stateDir,
      cwd: repoDir,
      command: ["true"],
    });
    expect(code).toBe(0);
    // Slug derives from the description after `--`; exact form depends on
    // slugify's stop-word rules, but a state file must exist (the regression
    // bug suppressed pipeline creation entirely).
    const files = fs.readdirSync(stateDir);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith(".json")).toBe(true);
    // Sanity-check no help text leaked to logs (would indicate intercept).
    expect(logs.join("\n")).not.toMatch(
      /^flow feature — start or resume a pipeline/m,
    );
  });
});

describe("runFresh — persist-then-delete-on-failure (orphaned-window regression)", () => {
  // Models the intermittent `flow feature create` bug under the INVERTED persist gate:
  // runFresh now writes state(phase=starting) UP FRONT (the supervisor needs a
  // file to advance), then deletes it on every launch-failure exit. tmux's
  // `new-window` returns ok (the shell forked) but the launched `claude` dies
  // immediately / never advances the state phase, so createWindowVerified returns
  // { ok: false } after killing the half-created window; runFresh must then
  // DELETE the up-front state so NO orphaned `phase=starting` file survives. The
  // no-orphan guarantee that used to come from write-after-verify now comes from
  // delete-on-failure. (Driven via the createWindowVerified mock — no real tmux
  // server, no real claude.)

  it("writes state(phase=starting) BEFORE the verified launch so the supervisor has a file to advance", () => {
    // Pins the inverted ordering: at the instant createWindowVerified is invoked
    // the state file already exists at phase `starting` (pre-fix it was written
    // only AFTER a successful verify, so the supervisor would have nothing to
    // advance and `flow-state-update` would exit non-zero).
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
    const code = runNew("CSV export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
    });
    expect(code).toBe(0);
    expect(phaseAtLaunch).toBe("starting");
  });

  it("wires a fresh consumed predicate that flips true once the phase advances past starting", () => {
    // The injected predicate is the version-independent consumption signal: false
    // while phase === "starting", true once the supervisor advances it.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    let consumedFn: (() => boolean) | undefined;
    tmuxMock.createWindowVerified.mockImplementation(
      (_name, _cwd, _command, _seed, deps) => {
        consumedFn = deps?.consumed;
        return { status: "started", stderr: "" };
      },
    );
    const code = runNew("CSV export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
    });
    expect(code).toBe(0);
    expect(consumedFn).toBeDefined();
    // At launch the up-front state is at `starting` → not yet consumed.
    expect(consumedFn!()).toBe(false);
    // The supervisor advances the phase → the predicate flips true.
    writeState(
      {
        slug: "csv-export",
        phase: "triaging",
        repo: fs.realpathSync(repoDir),
        updatedAt: new Date().toISOString(),
      },
      stateDir,
    );
    expect(consumedFn!()).toBe(true);
  });

  it("fresh launch 'failed' (dead pane) deletes the up-front state (no orphan under the inverted gate)", () => {
    // The launcher wrote nothing itself; runFresh wrote state(starting) up front.
    // A 'failed' launch (dead pane) must DELETE that file so no orphaned
    // `phase=starting` pipeline survives. (An ALIVE-but-slow timeout is
    // 'launched-not-confirmed' and is NON-destructive — covered separately.)
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    tmuxMock.createWindowVerified.mockReturnValue({
      status: "failed",
      stderr:
        "tmux window created but claude died before the seed was confirmed consumed (pane not alive)",
    });
    const code = runNew("csv export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
      retrySleepMs: 0,
    });
    expect(code).not.toBe(0);
    expect(fs.existsSync(path.join(stateDir, "csv-export.json"))).toBe(false);
  });

  it("STORY 1 (immediate-death): runFresh writes no state and exits non-zero when the pane is dead", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    tmuxMock.createWindowVerified.mockReturnValue({
      status: "failed",
      stderr: "pane not alive after launch",
    });
    const code = runNew("csv export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
      retrySleepMs: 0,
    });
    expect(code).not.toBe(0);
    expect(fs.existsSync(path.join(stateDir, "csv-export.json"))).toBe(false);
    expect(errors.join("\n")).toMatch(/claude exited immediately after launch/);
    // Upper bound: a permanent failure stops at exactly WINDOW_CREATE_MAX_ATTEMPTS
    // (3), not 1 (retry silently removed) and not unbounded. STORY 2 only pins
    // the >=2 lower bound; this closes the bounded-not-infinite claim (Test Step
    // #2) so removing or unbounding the retry budget turns this test red.
    expect(tmuxMock.createWindowVerified).toHaveBeenCalledTimes(3);
  });

  it("STORY 2 (bounded retry self-heal): a single transient failure retries and succeeds with exactly one state write", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    // Fail attempt 1, succeed attempt 2. The retry must be BOUNDED — exactly
    // two calls, not an unbounded spin — and persist state exactly once. The
    // successful attempt reaches the pre-persist Mode-2 re-check.
    freshWindowOk();
    tmuxMock.createWindowVerified
      .mockReturnValueOnce({ status: "failed", stderr: "transient" })
      .mockReturnValueOnce({ status: "started", stderr: "" });
    const code = runNew("csv export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
      retrySleepMs: 0,
    });
    expect(code).toBe(0);
    expect(tmuxMock.createWindowVerified).toHaveBeenCalledTimes(2);
    const stateFiles = fs
      .readdirSync(stateDir)
      .filter((f) => f.endsWith(".json"));
    expect(stateFiles).toEqual(["csv-export.json"]);
  });

  it("STORY 3 (repro harness): N>=20 runs against the pane-dead model persist zero orphaned state files", () => {
    // RED against pre-fix code (which trusted createWindow's ok and orphaned a
    // state file every iteration → orphanCount === N); GREEN after the
    // verify-before-persist gate. An orphan := state persisted while the
    // launch never produced a live window (createWindowVerified ok:false,
    // which also kills any half-created window, so no surviving window either).
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    tmuxMock.createWindowVerified.mockReturnValue({
      status: "failed",
      stderr: "pane not alive after launch",
    });
    const N = 20;
    let orphanCount = 0;
    for (let i = 0; i < N; i++) {
      const iterDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `flow-orphan-${i}-`),
      );
      const code = runNew(`pipeline number ${i}`, {
        stateDir: iterDir,
        cwd: repoDir,
        command: ["true"], // fast-exiting injected command
        retrySleepMs: 0, // keep the N-iteration loop fast + deterministic
      });
      expect(code).not.toBe(0);
      const persisted = fs
        .readdirSync(iterDir)
        .filter((f) => f.endsWith(".json"));
      if (persisted.length > 0) orphanCount += 1;
      fs.rmSync(iterDir, { recursive: true, force: true });
    }
    expect(orphanCount).toBe(0);
  });

  it("MODE 1 (seed never consumed): a consumption-verification failure writes no state and exits non-zero", () => {
    // The new failure mode this PR introduces: createWindowVerified confirmed
    // the pane was live but the seed prompt was never consumed (claude idle at an
    // empty input box). runFresh must treat that exactly like the old
    // immediate-death failure — no state, non-zero, the existing error copy.
    // freshWindowOk() is NOT needed: runFresh returns before the Mode-2 re-check.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    tmuxMock.createWindowVerified.mockReturnValue({
      status: "failed",
      stderr: "the seed prompt was never consumed (supervisor did not start)",
    });
    const code = runNew("csv export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
      retrySleepMs: 0,
    });
    expect(code).not.toBe(0);
    expect(fs.existsSync(path.join(stateDir, "csv-export.json"))).toBe(false);
    expect(errors.join("\n")).toMatch(/claude exited immediately after launch/);
  });

  it("MODE 2 (window vanished after verify): a missing window at the pre-persist re-check writes no state and exits non-zero", () => {
    // The launcher reports ok (a live, seeded window), but the window vanishes
    // before the state write (racing kill / tmux bounce). The pre-persist
    // windowExists re-check catches it: guard #1 false → proceed; re-check #2
    // false → vanished. No state, non-zero, the dedicated vanished error.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    tmuxMock.createWindowVerified.mockReturnValue({
      status: "started",
      stderr: "",
    });
    tmuxMock.windowExists
      .mockReset()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);
    const code = runNew("csv export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
      retrySleepMs: 0,
    });
    expect(code).not.toBe(0);
    expect(fs.existsSync(path.join(stateDir, "csv-export.json"))).toBe(false);
    expect(errors.join("\n")).toMatch(/vanished after launch/);
  });

  it("MODE 3 (window-create-then-immediate-exit, bounded self-heal): one transient failure then success writes exactly one state file", () => {
    // The feature.ts-layer framing of the consume-then-die race: the launcher fails
    // once (the window created then claude exited before consuming the seed) then
    // succeeds on retry. Bounded to exactly two launcher calls, exit 0, one state
    // file. The successful attempt reaches the Mode-2 re-check → freshWindowOk().
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    tmuxMock.createWindowVerified
      .mockReturnValueOnce({
        status: "failed",
        stderr: "the seed prompt was never consumed (supervisor did not start)",
      })
      .mockReturnValueOnce({ status: "started", stderr: "" });
    const code = runNew("csv export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
      retrySleepMs: 0,
    });
    expect(code).toBe(0);
    expect(tmuxMock.createWindowVerified).toHaveBeenCalledTimes(2);
    const stateFiles = fs
      .readdirSync(stateDir)
      .filter((f) => f.endsWith(".json"));
    expect(stateFiles).toEqual(["csv-export.json"]);
  });

  it("BLOCKING regression: an attempt that advances the phase then dies must not poison the next retry's consumed()", () => {
    // Within-retry Mode-3 false-success repro (issue #82, feature.ts runFresh): the
    // `consumed` predicate compares phase to the literal `starting`, but the
    // up-front state write fires ONCE and the closure is reused across attempts.
    // So if attempt 1's supervisor advances the phase past `starting` and THEN
    // the pane dies, a single up-front baseline would make attempt 2's
    // consumed() short-circuit true over a brand-new idle window — the seed is
    // skipped and pollUntilConsumed latches immediately, a false-success orphan.
    // The fix re-establishes the `starting` baseline at the START of EACH
    // attempt, so consumed() reads false at every launch until THAT attempt's
    // supervisor advances. Driven entirely through the createWindowVerified seam
    // (no real tmux/claude/fs server) — only the injected predicate + state file.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    freshWindowOk();
    const consumedAtLaunch: boolean[] = [];
    tmuxMock.createWindowVerified
      .mockReset()
      .mockImplementationOnce((name, _cwd, _command, _seed, deps) => {
        // Sample the predicate at launch (still `starting` → false), then model
        // the supervisor advancing the phase, then the pane dying (ok:false).
        consumedAtLaunch.push(deps!.consumed!());
        writeState(
          {
            slug: name,
            phase: "triaging",
            repo: repoDir,
            updatedAt: new Date().toISOString(),
          },
          stateDir,
        );
        return {
          status: "failed",
          stderr:
            "the seed prompt was never consumed (supervisor did not start)",
        };
      })
      .mockImplementationOnce((_name, _cwd, _command, _seed, deps) => {
        // Attempt 2: with the per-attempt baseline reset, consumed() must read
        // false here despite attempt 1 leaving phase=triaging. Pre-fix it read
        // true (stale phase) → the launcher would falsely "succeed" without a
        // genuine attempt-2 consumption.
        consumedAtLaunch.push(deps!.consumed!());
        return { status: "started", stderr: "" };
      });
    const code = runNew("csv export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
      retrySleepMs: 0,
    });
    expect(code).toBe(0);
    expect(tmuxMock.createWindowVerified).toHaveBeenCalledTimes(2);
    // Both attempts saw `starting` at launch — the retry was NOT poisoned by the
    // prior attempt's phase advance.
    expect(consumedAtLaunch).toEqual([false, false]);
  });
});
