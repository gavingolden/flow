import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock tmux primitives so the resume happy/refusal paths don't shell out.
// The mocks are toggled per-test via the exported handles below.
const tmuxMock = vi.hoisted(() => ({
  windowExists: vi.fn<(name: string) => boolean>(() => false),
  isPaneAlive: vi.fn<(name: string) => boolean>(() => false),
  createWindow: vi.fn<(name: string, cwd: string, command: string[]) => { ok: boolean; stderr: string }>(() => ({ ok: true, stderr: "" })),
  respawnWindow: vi.fn<(name: string, cwd: string, command: string[]) => { ok: boolean; stderr: string }>(() => ({ ok: true, stderr: "" })),
  FLOW_SESSION: "flow",
}));
vi.mock("./tmux", () => tmuxMock);

import { runNew, runNewCli } from "./new";
import { writeState } from "./state";

let stateDir!: string;
let repoDir!: string;
let errors!: string[];
let logs!: string[];

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-new-"));
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-new-repo-"));
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
  tmuxMock.createWindow.mockReset().mockReturnValue({ ok: true, stderr: "" });
  tmuxMock.respawnWindow.mockReset().mockReturnValue({ ok: true, stderr: "" });
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
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
    expect(errors[1]).toMatch(/run `flow new <description>`/);
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
    expect(tmuxMock.respawnWindow).not.toHaveBeenCalled();
    expect(tmuxMock.createWindow).not.toHaveBeenCalled();
  });

  it("respawns the existing window when state exists and pane is dead", () => {
    seedState("crashed");
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);
    const code = runNew("crashed", { resume: true, stateDir });
    expect(code).toBe(0);
    expect(tmuxMock.respawnWindow).toHaveBeenCalledTimes(1);
    expect(tmuxMock.createWindow).not.toHaveBeenCalled();
    const [, cwd, command] = tmuxMock.respawnWindow.mock.calls[0]!;
    expect(cwd).toBe(repoDir);
    // Contract: the prompt prefix is what the supervisor parses to detect
    // resume mode. SKILL.md hard-codes the literal string; if this assertion
    // ever fails, update both ends in lockstep.
    expect(command).toEqual([
      "claude",
      "Use the /flow-pipeline skill in --resume mode for: crashed",
    ]);
    expect(logs[0]).toBe("flow:crashed");
  });

  it("recreates the window when tmux has lost it (no window, dead pane)", () => {
    seedState("tmux-bounced");
    tmuxMock.windowExists.mockReturnValue(false);
    const code = runNew("tmux-bounced", { resume: true, stateDir });
    expect(code).toBe(0);
    expect(tmuxMock.createWindow).toHaveBeenCalledTimes(1);
    expect(tmuxMock.respawnWindow).not.toHaveBeenCalled();
  });

  it("does not rewrite state.json on entry (the supervisor's first transition does)", () => {
    seedState("preserve");
    tmuxMock.windowExists.mockReturnValue(true);
    const before = fs.readFileSync(path.join(stateDir, "preserve.json"), "utf8");
    runNew("preserve", { resume: true, stateDir });
    const after = fs.readFileSync(path.join(stateDir, "preserve.json"), "utf8");
    expect(after).toBe(before);
  });

  it("surfaces the tmux failure when respawn returns non-ok", () => {
    seedState("respawn-fail");
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.respawnWindow.mockReturnValue({
      ok: false,
      stderr: "can't find session: flow",
    });
    const code = runNew("respawn-fail", { resume: true, stateDir });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/tmux failed to respawn/);
    expect(errors.join("\n")).toContain("can't find session: flow");
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
    // returns task-<sha256[0..8]>(input). `flow new` should accept that slug
    // rather than refuse with the old "produces an empty slug" error, so
    // any input the user types is always actionable.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNew("---", { stateDir, cwd: repoDir, command: ["true"] });
    expect(code).toBe(0);
    const files = fs.readdirSync(stateDir);
    const matched = files.find((f) => /^task-[0-9a-f]{8}\.json$/.test(f));
    expect(matched, `expected a task-<hash8>.json in ${files.join(",")}`).toBeDefined();
  });

  it("does not persist autoMerge by default (absent ≡ true)", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNew("CSV export", { stateDir, cwd: repoDir, command: ["true"] });
    expect(code).toBe(0);
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, "csv-export.json"), "utf8"));
    expect(raw).not.toHaveProperty("autoMerge");
  });

  it("persists autoMerge: false when noAutoMerge: true is passed", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNew("CSV export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
      noAutoMerge: true,
    });
    expect(code).toBe(0);
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, "csv-export.json"), "utf8"));
    expect(raw.autoMerge).toBe(false);
  });

  it("does not persist waitForCopilot by default (absent ≡ false / auto-detect ON)", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNew("CSV export", { stateDir, cwd: repoDir, command: ["true"] });
    expect(code).toBe(0);
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, "csv-export.json"), "utf8"));
    expect(raw).not.toHaveProperty("waitForCopilot");
  });

  it("persists waitForCopilot: true when waitForCopilot option is true", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNew("CSV export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
      waitForCopilot: true,
    });
    expect(code).toBe(0);
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, "csv-export.json"), "utf8"));
    expect(raw.waitForCopilot).toBe(true);
  });
});

describe("runNewCli (--help / -h short-circuit)", () => {
  // Regression for the catastrophic bug: `flow new --help` previously
  // slugified `--help` to `help`, spawned a tmux window, and wrote
  // ~/.flow/state/help.json. The CLI shim must intercept the flag before
  // any side-effect.

  for (const flag of ["--help", "-h"]) {
    it(`exits 0 and writes no state file when args is ['${flag}']`, () => {
      const code = runNewCli([flag], { stateDir });
      expect(code).toBe(0);
      expect(fs.readdirSync(stateDir)).toEqual([]);
    });

    it(`prints help to stdout (not stderr) for '${flag}'`, () => {
      runNewCli([flag], { stateDir });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.join("\n")).toMatch(/^flow new — start a new pipeline/);
    });

    it(`does not invoke tmux for '${flag}'`, () => {
      runNewCli([flag], { stateDir });
      expect(tmuxMock.createWindow).not.toHaveBeenCalled();
      expect(tmuxMock.respawnWindow).not.toHaveBeenCalled();
      expect(tmuxMock.windowExists).not.toHaveBeenCalled();
    });
  }

  it("short-circuits even when --help follows --no-auto-merge", () => {
    const code = runNewCli(["--no-auto-merge", "--help"], { stateDir });
    expect(code).toBe(0);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindow).not.toHaveBeenCalled();
  });

  it("short-circuits even when --help follows --resume", () => {
    // --resume normally requires a single <name>; with --help present the
    // shim must print help instead of erroring on missing <name>.
    const code = runNewCli(["--resume", "--help"], { stateDir });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
  });

  it("runNewCli --wait-for-copilot writes waitForCopilot: true and excludes the flag from the slug", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNewCli(
      ["--wait-for-copilot", "do", "thing"],
      { stateDir, cwd: repoDir, command: ["true"] },
    );
    expect(code).toBe(0);
    // Slug must not include "wait-for-copilot" tokens; description was "do thing".
    expect(fs.existsSync(path.join(stateDir, "do-thing.json"))).toBe(true);
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, "do-thing.json"), "utf8"));
    expect(raw.waitForCopilot).toBe(true);
  });

  it("treats -h after `--` as part of the description, not a help flag", () => {
    // Regression for the over-eager argsContainHelp scan: a description body
    // that happens to contain `-h` (e.g. `flow new -- fix the -h crash`)
    // must not be intercepted as `flow new --help`. Pipeline runs, slug
    // derives from the words after `--`.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNewCli(
      ["--", "fix", "the", "-h", "crash"],
      { stateDir, cwd: repoDir, command: ["true"] },
    );
    expect(code).toBe(0);
    // Slug derives from the description after `--`; exact form depends on
    // slugify's stop-word rules, but a state file must exist (the regression
    // bug suppressed pipeline creation entirely).
    const files = fs.readdirSync(stateDir);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith(".json")).toBe(true);
    // Sanity-check no help text leaked to logs (would indicate intercept).
    expect(logs.join("\n")).not.toMatch(/^flow new — start a new pipeline/m);
  });
});
