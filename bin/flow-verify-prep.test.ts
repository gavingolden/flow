import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./flow-verify-prep";
import { readState, writeState } from "./lib/state";

let stateDir!: string;
let worktree!: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-verify-prep-state-"));
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), "flow-verify-prep-wt-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(worktree, { recursive: true, force: true });
  logSpy.mockRestore();
});

function seedState(slug: string, extra: Record<string, unknown> = {}): void {
  writeState(
    {
      slug,
      phase: "installing-skills",
      repo: "/tmp/repo",
      updatedAt: "2026-01-01T00:00:00Z",
      ...extra,
    },
    stateDir,
  );
}

function lastJson(): Record<string, unknown> {
  const calls = logSpy.mock.calls;
  return JSON.parse(String(calls[calls.length - 1]?.[0]));
}

describe(parseArgs, () => {
  it("parses --worktree and --skill-dir", () => {
    expect(parseArgs(["--worktree", "/a", "--skill-dir", "/b"])).toEqual({
      worktree: "/a",
      skillDir: "/b",
    });
  });

  it("parses with neither flag", () => {
    expect(parseArgs([])).toEqual({ worktree: undefined, skillDir: undefined });
  });

  it("errors on an unknown flag", () => {
    expect(parseArgs(["--bogus"])).toEqual({ error: "unknown flag: --bogus" });
  });

  it("errors when --worktree has no value", () => {
    expect(parseArgs(["--worktree"])).toEqual({
      error: "--worktree requires a value",
    });
  });

  it("treats --pr 0 as 'no PR' rather than an error", () => {
    // Regression: Step 6 runs before a PR exists (evals/verify-loop-isolation
    // passes --pr "0" / "$PR" empty). `pr` stays undefined so the downstream
    // `expectPr: parsed.pr ?? null` disables the pr-mismatch guard instead of
    // escalating with a "positive integer" error.
    expect(parseArgs(["--pr", "0"])).toEqual({
      worktree: undefined,
      skillDir: undefined,
      pr: undefined,
    });
  });

  it("treats --pr '' as 'no PR' rather than an error", () => {
    expect(parseArgs(["--pr", ""])).toEqual({
      worktree: undefined,
      skillDir: undefined,
      pr: undefined,
    });
  });

  it("still rejects a non-numeric --pr value", () => {
    expect(parseArgs(["--pr", "abc"])).toEqual({
      error: "--pr must be a positive integer, got 'abc'",
    });
  });

  it("still rejects a negative --pr value", () => {
    expect(parseArgs(["--pr", "-1"])).toEqual({
      error: "--pr must be a positive integer, got '-1'",
    });
  });

  it("still rejects a non-integer --pr value", () => {
    expect(parseArgs(["--pr", "1.5"])).toEqual({
      error: "--pr must be a positive integer, got '1.5'",
    });
  });

  it("still parses a valid positive --pr value", () => {
    expect(parseArgs(["--pr", "42"])).toEqual({
      worktree: undefined,
      skillDir: undefined,
      pr: 42,
    });
  });

  it("errors when --pr has no value", () => {
    expect(parseArgs(["--pr"])).toEqual({
      error: "--pr requires a value",
    });
  });
});

describe("run()", () => {
  it("resolves VERIFY_MODEL from state.modelVerify first", () => {
    seedState("s1", { modelVerify: "opus", worktree });
    const exit = run([], {
      resolveSlug: () => "s1",
      stateDir,
      exists: () => false,
      readConfigFile: () => ({ models: { verify: "haiku" } }),
    });
    expect(exit).toBe(0);
    expect(lastJson().verifyModel).toBe("opus");
  });

  it("falls back to config.models.verify when state.modelVerify is absent", () => {
    seedState("s2", { worktree });
    const exit = run([], {
      resolveSlug: () => "s2",
      stateDir,
      exists: () => false,
      readConfigFile: () => ({ models: { verify: "haiku" } }),
    });
    expect(exit).toBe(0);
    expect(lastJson().verifyModel).toBe("haiku");
  });

  it("falls back to sonnet when neither state nor config set a verify model", () => {
    seedState("s3", { worktree });
    const exit = run([], {
      resolveSlug: () => "s3",
      stateDir,
      exists: () => false,
      readConfigFile: () => ({}),
    });
    expect(exit).toBe(0);
    expect(lastJson().verifyModel).toBe("sonnet");
  });

  it("resolves the plugin-qualified VERIFY_SUBAGENT when the agent definition exists", () => {
    seedState("s4", { worktree });
    const exit = run([], {
      resolveSlug: () => "s4",
      stateDir,
      exists: () => true,
      readConfigFile: () => ({}),
    });
    expect(exit).toBe(0);
    expect(lastJson().verifySubagent).toBe("flow-module-core:flow-verify");
  });

  it("falls back to general-purpose with a NOTICE — agent-fallback: line when the agent definition is missing", () => {
    seedState("s5", { worktree });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run([], {
      resolveSlug: () => "s5",
      stateDir,
      exists: () => false,
      readConfigFile: () => ({}),
    });
    expect(exit).toBe(0);
    expect(lastJson().verifySubagent).toBe("general-purpose");
    expect(errSpy.mock.calls.flat().join("\n")).toContain(
      "NOTICE — agent-fallback: flow-verify → general-purpose",
    );
    errSpy.mockRestore();
  });

  it("emits the JSON shape the SKILL.md block consumes", () => {
    seedState("s6", { worktree });
    const exit = run([], {
      resolveSlug: () => "s6",
      stateDir,
      exists: () => true,
      readConfigFile: () => ({}),
    });
    expect(exit).toBe(0);
    const json = lastJson();
    expect(Object.keys(json).sort()).toEqual(
      [
        "artifactPath",
        "instructionsPath",
        "verifyModel",
        "verifySubagent",
      ].sort(),
    );
    expect(json.artifactPath).toBe(
      path.join(worktree, ".flow-tmp", "verify-loop-result.json"),
    );
    expect(json.instructionsPath).toMatch(
      /references\/verify-loop-instructions\.md$/,
    );
  });

  it("uses an explicit --skill-dir over the global-plugin-root default", () => {
    seedState("s7", { worktree });
    const exit = run(["--skill-dir", "/custom/skill-dir"], {
      resolveSlug: () => "s7",
      stateDir,
      exists: () => true,
      readConfigFile: () => ({}),
    });
    expect(exit).toBe(0);
    expect(lastJson().instructionsPath).toBe(
      "/custom/skill-dir/references/verify-loop-instructions.md",
    );
  });

  it("removes a stale artifact from a prior verify cycle", () => {
    seedState("s8", { worktree });
    const flowTmp = path.join(worktree, ".flow-tmp");
    fs.mkdirSync(flowTmp, { recursive: true });
    const artifactPath = path.join(flowTmp, "verify-loop-result.json");
    fs.writeFileSync(artifactPath, '{"stale": true}');
    const exit = run([], {
      resolveSlug: () => "s8",
      stateDir,
      exists: () => true,
      readConfigFile: () => ({}),
    });
    expect(exit).toBe(0);
    expect(fs.existsSync(artifactPath)).toBe(false);
  });

  it("advances state.phase to verifying as a side effect", () => {
    seedState("s9", { worktree });
    const exit = run([], {
      resolveSlug: () => "s9",
      stateDir,
      exists: () => true,
      readConfigFile: () => ({}),
    });
    expect(exit).toBe(0);
    const state = readState("s9", stateDir);
    expect(state?.phase).toBe("verifying");
    expect(state?.phaseLog).toHaveLength(1);
  });

  it("resolves --worktree over state.worktree when both are given", () => {
    seedState("s10", { worktree: "/from-state" });
    const explicitWorktree = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-verify-prep-explicit-"),
    );
    const exit = run(["--worktree", explicitWorktree], {
      resolveSlug: () => "s10",
      stateDir,
      exists: () => true,
      readConfigFile: () => ({}),
    });
    expect(exit).toBe(0);
    expect(lastJson().artifactPath).toBe(
      path.join(explicitWorktree, ".flow-tmp", "verify-loop-result.json"),
    );
    fs.rmSync(explicitWorktree, { recursive: true, force: true });
  });

  it("falls back to state.worktree when --worktree is omitted", () => {
    seedState("s11", { worktree });
    const exit = run([], {
      resolveSlug: () => "s11",
      stateDir,
      exists: () => true,
      readConfigFile: () => ({}),
    });
    expect(exit).toBe(0);
    expect(lastJson().artifactPath).toBe(
      path.join(worktree, ".flow-tmp", "verify-loop-result.json"),
    );
  });

  it("exits 2 when no --worktree given and state.worktree is unset (plain-shell, no ambient slug)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run([], {
      resolveSlug: () => null, // no FLOW_SLUG, no tmux pane — the plain-shell default
      stateDir,
      exists: () => true,
      readConfigFile: () => ({}),
    });
    expect(exit).toBe(2);
    expect(errSpy.mock.calls.flat().join("\n")).toContain("--worktree");
    errSpy.mockRestore();
  });

  it("exits 2 on an unknown flag", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--bogus"], { resolveSlug: () => null, stateDir });
    expect(exit).toBe(2);
    errSpy.mockRestore();
  });
});
