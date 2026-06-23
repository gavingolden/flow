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
  // new.ts now launches windows through the liveness-verified wrappers, so the
  // mock drives those (not the bare createWindow/respawnWindow). They default
  // to ok so the happy paths still pass without per-test setup.
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

import { runNew, runNewCli, deriveWorktreePath } from "./new";
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
  tmuxMock.createWindowVerified
    .mockReset()
    .mockReturnValue({ ok: true, stderr: "" });
  tmuxMock.respawnWindowVerified
    .mockReset()
    .mockReturnValue({ ok: true, stderr: "" });
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
    expect(tmuxMock.respawnWindowVerified).not.toHaveBeenCalled();
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
  });

  it("respawns the existing window when state exists and pane is dead", () => {
    seedState("crashed");
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);
    const code = runNew("crashed", { resume: true, stateDir });
    expect(code).toBe(0);
    expect(tmuxMock.respawnWindowVerified).toHaveBeenCalledTimes(1);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
    const [, cwd, command] = tmuxMock.respawnWindowVerified.mock.calls[0]!;
    expect(cwd).toBe(repoDir);
    // Contract: the prompt prefix is what the supervisor parses to detect
    // resume mode. SKILL.md hard-codes the literal string; if this assertion
    // ever fails, update both ends in lockstep.
    expect(command).toEqual([
      "claude",
      "--add-dir",
      deriveWorktreePath(repoDir, "crashed"),
      "Use the /flow-pipeline skill in --resume mode for: crashed",
    ]);
    expect(logs[0]).toBe("flow:crashed");
    // Cross-verb voice: the second line uses the stable `flow new:` prose
    // voice. Non-TTY (vitest) → no ANSI on either line.
    expect(logs[1]).toBe(
      "flow new: resumed — attach with `flow attach crashed`",
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
      ok: false,
      stderr: "can't find session: flow",
    });
    const code = runNew("respawn-fail", { resume: true, stateDir });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/claude exited immediately after launch/);
    expect(errors.join("\n")).toContain("can't find session: flow");
  });
});

describe("runNewCli --resume (multi-slug)", () => {
  it("resumes each slug sequentially with the per-slug resume seed and exits 0", () => {
    seedState("x");
    seedState("y");
    tmuxMock.windowExists.mockReturnValue(true);
    tmuxMock.isPaneAlive.mockReturnValue(false);

    const code = runNewCli(["--resume", "x", "y", "--yes"], { stateDir });

    expect(code).toBe(0);
    expect(tmuxMock.respawnWindowVerified).toHaveBeenCalledTimes(2);
    const launched = tmuxMock.respawnWindowVerified.mock.calls.map(
      ([name, , command]) => ({ name, prompt: command[command.length - 1] }),
    );
    expect(launched).toContainEqual({
      name: "x",
      prompt: "Use the /flow-pipeline skill in --resume mode for: x",
    });
    expect(launched).toContainEqual({
      name: "y",
      prompt: "Use the /flow-pipeline skill in --resume mode for: y",
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

    const code = runNewCli(["--resume", "x", "alive", "y", "--yes"], {
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

    const code = runNewCli(["--resume", "x", "y"], { stateDir });

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

    const code = runNewCli(["--resume", "x", "y"], { stateDir });

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

    const code = runNewCli(["--resume", "x", "x"], { stateDir });

    expect(code).toBe(0);
    // dedup at new.ts:91-92 collapses the repeat to length 1, so it routes
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

    const code = runNewCli(["--resume", "x", "y", "--yes"], { stateDir });

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
    // returns task-<sha256[0..8]>(input). `flow new` should accept that slug
    // rather than refuse with the old "produces an empty slug" error, so
    // any input the user types is always actionable.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNew("---", { stateDir, cwd: repoDir, command: ["true"] });
    expect(code).toBe(0);
    const files = fs.readdirSync(stateDir);
    const matched = files.find((f) => /^task-[0-9a-f]{8}\.json$/.test(f));
    expect(
      matched,
      `expected a task-<hash8>.json in ${files.join(",")}`,
    ).toBeDefined();
  });

  it("emits the stable 'flow new:' voice and a raw contract first line on a fresh start", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNew("CSV export", {
      stateDir,
      cwd: repoDir,
      command: ["true"],
    });
    expect(code).toBe(0);
    // First line is the machine-read contract token — no ANSI, exact shape.
    expect(logs[0]).toBe("flow:csv-export");
    expect(logs[1]).toBe(
      "flow new: created — attach with `flow attach csv-export`",
    );
  });

  it("does not persist autoMerge by default (absent ≡ true)", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
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

  it("launches claude with --add-dir <derived-worktree> before the prompt on a fresh start", () => {
    // LOAD-BEARING: omit `command` so defaultCommand runs — passing
    // `command: ["true"]` would short-circuit the argv under test (issue #317).
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNew("CSV export", { stateDir, cwd: repoDir });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    // runFresh resolves the repo via `git rev-parse --show-toplevel`, which
    // returns the canonical realpath (macOS /var → /private/var), so derive
    // the expected worktree from the resolved path, not the raw temp dir.
    expect(command).toEqual([
      "claude",
      "--add-dir",
      deriveWorktreePath(fs.realpathSync(repoDir), "csv-export"),
      "Use the /flow-pipeline skill for: CSV export",
    ]);
    // The flag pair must precede the prompt so claude parses --add-dir as an
    // option, not as part of the prompt text.
    expect(command.indexOf("--add-dir")).toBeLessThan(command.length - 1);
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
      expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
      expect(tmuxMock.respawnWindowVerified).not.toHaveBeenCalled();
      expect(tmuxMock.windowExists).not.toHaveBeenCalled();
    });
  }

  it("short-circuits even when --help follows --no-auto-merge", () => {
    const code = runNewCli(["--no-auto-merge", "--help"], { stateDir });
    expect(code).toBe(0);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
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
    const code = runNewCli(["--wait-for-copilot", "do", "thing"], {
      stateDir,
      cwd: repoDir,
      command: ["true"],
    });
    expect(code).toBe(0);
    // Slug must not include "wait-for-copilot" tokens; description was "do thing".
    expect(fs.existsSync(path.join(stateDir, "do-thing.json"))).toBe(true);
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "do-thing.json"), "utf8"),
    );
    expect(raw.waitForCopilot).toBe(true);
  });

  it.each(["auto", "always", "never"] as const)(
    "runNewCli --copilot-review %s persists copilotReview and excludes the flag+value from the slug",
    (value) => {
      spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
      const code = runNewCli(["--copilot-review", value, "do", "thing"], {
        stateDir,
        cwd: repoDir,
        command: ["true"],
      });
      expect(code).toBe(0);
      // Slug must not include the flag or its value token; description was "do thing".
      expect(fs.existsSync(path.join(stateDir, "do-thing.json"))).toBe(true);
      const raw = JSON.parse(
        fs.readFileSync(path.join(stateDir, "do-thing.json"), "utf8"),
      );
      expect(raw.copilotReview).toBe(value);
    },
  );

  it("runNewCli --copilot-review with an invalid value returns non-zero and writes no state", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNewCli(["--copilot-review", "sometimes", "do", "thing"], {
      stateDir,
      cwd: repoDir,
      command: ["true"],
    });
    expect(code).toBe(1);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(errors.join("\n")).toMatch(/auto, always, never/);
  });

  it("runNewCli --copilot-review with a missing value returns non-zero and writes no state", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNewCli(["--copilot-review"], {
      stateDir,
      cwd: repoDir,
      command: ["true"],
    });
    expect(code).toBe(1);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("runNewCli without --copilot-review leaves the field undefined (absent ≡ auto)", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNewCli(["do", "thing"], {
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

  it("runNewCli --effort high launches claude with --effort before the prompt and persists effort", () => {
    // LOAD-BEARING: omit `command` so defaultCommand runs — passing
    // `command: ["true"]` would short-circuit the argv under test.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNewCli(["--effort", "high", "do", "thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(command).toEqual([
      "claude",
      "--add-dir",
      deriveWorktreePath(fs.realpathSync(repoDir), "do-thing"),
      "--effort",
      "high",
      "Use the /flow-pipeline skill for: do thing",
    ]);
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "do-thing.json"), "utf8"),
    );
    expect(raw.effort).toBe("high");
  });

  it("runNewCli without --effort omits --effort from the launch argv and the effort key from state", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNewCli(["do", "thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.createWindowVerified.mock.calls[0]!;
    expect(command).toEqual([
      "claude",
      "--add-dir",
      deriveWorktreePath(fs.realpathSync(repoDir), "do-thing"),
      "Use the /flow-pipeline skill for: do thing",
    ]);
    expect(command).not.toContain("--effort");
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "do-thing.json"), "utf8"),
    );
    expect(raw).not.toHaveProperty("effort");
  });

  it("runNewCli --effort with an invalid value returns non-zero and triggers no side-effect", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNewCli(["--effort", "bogus", "do", "thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(1);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/low, medium, high, xhigh, max/);
  });

  it("runNewCli --effort with a missing value returns non-zero and triggers no side-effect", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNewCli(["--effort"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(1);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
  });

  it("runNewCli --effort followed by another flag returns non-zero and triggers no side-effect", () => {
    // Pins the `value.startsWith("--")` half of the missing-value guard: a
    // following flag must not be consumed as the effort value.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNewCli(["--effort", "--no-auto-merge", "do", "thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(1);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(tmuxMock.createWindowVerified).not.toHaveBeenCalled();
  });

  it("runNewCli --effort high strips the flag and its value token from the slug", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNewCli(["--effort", "high", "do", "thing"], {
      stateDir,
      cwd: repoDir,
    });
    expect(code).toBe(0);
    // Slug must not include the flag or its value token; description was "do thing".
    expect(fs.existsSync(path.join(stateDir, "do-thing.json"))).toBe(true);
  });

  it("runNew --resume re-applies the saved effort into the respawn argv", () => {
    // LOAD-BEARING: omit `command` so resumeCommand runs.
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
    const code = runNew("saved-effort", { resume: true, stateDir });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.respawnWindowVerified.mock.calls[0]!;
    expect(command).toEqual([
      "claude",
      "--add-dir",
      deriveWorktreePath(repoDir, "saved-effort"),
      "--effort",
      "max",
      "Use the /flow-pipeline skill in --resume mode for: saved-effort",
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
    const code = runNew("suffixed-slug", { resume: true, stateDir });
    expect(code).toBe(0);
    const [, , command] = tmuxMock.respawnWindowVerified.mock.calls[0]!;
    expect(command).toEqual([
      "claude",
      "--add-dir",
      recordedWorktree,
      "Use the /flow-pipeline skill in --resume mode for: suffixed-slug",
    ]);
    // Falls back to the derived bare-slug path only when no worktree recorded.
    expect(command).not.toContain(deriveWorktreePath(repoDir, "suffixed-slug"));
  });

  it("treats -h after `--` as part of the description, not a help flag", () => {
    // Regression for the over-eager argsContainHelp scan: a description body
    // that happens to contain `-h` (e.g. `flow new -- fix the -h crash`)
    // must not be intercepted as `flow new --help`. Pipeline runs, slug
    // derives from the words after `--`.
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    const code = runNewCli(["--", "fix", "the", "-h", "crash"], {
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
    expect(logs.join("\n")).not.toMatch(/^flow new — start a new pipeline/m);
  });
});

describe("runFresh — verify-before-persist (orphaned-window regression)", () => {
  // Models the intermittent `flow new` bug: tmux's `new-window` returns ok
  // (the shell forked), but the launched `claude` dies immediately so the pane
  // is not alive. createWindowVerified detects this and returns { ok: false }
  // after killing the half-created window; runFresh must then write NO state.
  // Pre-fix, runFresh trusted createWindow's ok and persisted state for the
  // dead window — these tests are RED against that shape and GREEN after the
  // verify-before-persist gate. (Driven via the createWindowVerified mock —
  // no real tmux server, no real claude.)

  it("STORY 1 (immediate-death): runFresh writes no state and exits non-zero when the pane is dead", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    tmuxMock.createWindowVerified.mockReturnValue({
      ok: false,
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
  });

  it("STORY 2 (bounded retry self-heal): a single transient failure retries and succeeds with exactly one state write", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
    // Fail attempt 1, succeed attempt 2. The retry must be BOUNDED — exactly
    // two calls, not an unbounded spin — and persist state exactly once.
    tmuxMock.createWindowVerified
      .mockReturnValueOnce({ ok: false, stderr: "transient" })
      .mockReturnValueOnce({ ok: true, stderr: "" });
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
      ok: false,
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
});
