import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decide,
  parseArgs,
  run,
  TERMINAL_PHASE_SET,
  type DecisionResult,
  type Inputs,
} from "./flow-epic-resume-decide";
import { writeState, type PipelineState, TERMINAL_PHASES } from "./lib/state";
import {
  type GhRunner,
  type GitRunner,
  type PrInfo,
  type WorktreeInfo,
} from "./lib/resume-probes";

// ---------------------------------------------------------------------------
// makeInputs(): default Inputs that lands at the design-review checkpoint
// (phase epic-design-pending-review, worktree present, PR open). Each test
// overrides the field(s) it cares about.
// ---------------------------------------------------------------------------

const PRESENT_WORKTREE: WorktreeInfo = { kind: "present", path: "/tmp/wt" };
const OPEN_PR: PrInfo = {
  kind: "found",
  state: "OPEN",
  number: 100,
  url: "https://x/y/pull/100",
};

function baseState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    slug: "test",
    phase: "epic-design-pending-review",
    repo: "/tmp/repo",
    worktree: "/tmp/wt",
    updatedAt: "2026-06-24T12:00:00Z",
    ...overrides,
  };
}

function makeInputs(overrides: Partial<Inputs> = {}): Inputs {
  return {
    slug: "test",
    state: baseState(),
    worktree: PRESENT_WORKTREE,
    pr: OPEN_PR,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. decide() — per-epic-phase coverage
// ---------------------------------------------------------------------------

describe("decide() — terminal phases (parity with TERMINAL_PHASES)", () => {
  it("returns terminal when phase is 'epic-approved'", () => {
    const r = decide(
      makeInputs({ state: baseState({ phase: "epic-approved" }) }),
    );
    expect(r.epicResumeAt).toBe("terminal");
    expect(r.reason).toContain("epic-approved");
  });

  it("returns terminal when phase is 'cancelled' (epic cancel path)", () => {
    const r = decide(makeInputs({ state: baseState({ phase: "cancelled" }) }));
    expect(r.epicResumeAt).toBe("terminal");
    expect(r.reason).toContain("cancelled");
  });

  it("returns terminal when phase is 'needs-human' (canonical-set parity)", () => {
    const r = decide(
      makeInputs({ state: baseState({ phase: "needs-human" }) }),
    );
    expect(r.epicResumeAt).toBe("terminal");
    expect(r.reason).toContain("needs-human");
  });

  it("does NOT replay approval — an epic-approved resume is terminal, never re-checkpoint", () => {
    const r = decide(
      makeInputs({ state: baseState({ phase: "epic-approved" }), pr: OPEN_PR }),
    );
    expect(r.epicResumeAt).toBe("terminal");
    expect(r.epicResumeAt).not.toBe("checkpoint");
  });
});

describe("decide() — pre-tree escalations", () => {
  it("escalates with pr-closed-without-merge when PR state is CLOSED", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "epic-pr-open" }),
        pr: {
          kind: "found",
          state: "CLOSED",
          number: 100,
          url: "https://x/y/pull/100",
        },
      }),
    );
    expect(r.epicResumeAt).toBe("escalate");
    expect(r.reason).toBe("pr-closed-without-merge");
    expect(r.context.prState).toBe("CLOSED");
  });

  it("escalates with worktree-missing-on-resume when path is set but dir is gone", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "epic-validating" }),
        worktree: { kind: "missing-on-disk", path: "/tmp/gone" },
        pr: { kind: "none" },
      }),
    );
    expect(r.epicResumeAt).toBe("escalate");
    expect(r.reason).toBe("worktree-missing-on-resume");
  });
});

describe("decide() — worktree-absent", () => {
  it("resumes at 'worktree' when the worktree is not yet created", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "starting", worktree: undefined }),
        worktree: { kind: "absent-from-state" },
        pr: { kind: "none" },
      }),
    );
    expect(r.epicResumeAt).toBe("worktree");
  });
});

describe("decide() — design / validate / checkpoint", () => {
  it("resumes at 'design' when phase is 'starting' (worktree present)", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "starting" }),
        pr: { kind: "none" },
      }),
    );
    expect(r.epicResumeAt).toBe("design");
  });

  it("resumes at 'design' when phase is 'epic-designing'", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "epic-designing" }),
        pr: { kind: "none" },
      }),
    );
    expect(r.epicResumeAt).toBe("design");
  });

  it("resumes at 'validate' when phase is 'epic-validating'", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "epic-validating" }),
        pr: { kind: "none" },
      }),
    );
    expect(r.epicResumeAt).toBe("validate");
  });

  it("resumes at 'checkpoint' when phase is 'epic-design-pending-review' (worktree + PR)", () => {
    const r = decide(makeInputs());
    expect(r.epicResumeAt).toBe("checkpoint");
    expect(r.context.pr).toBe(100);
    expect(r.context.prState).toBe("OPEN");
  });

  it("re-renders the checkpoint WITHOUT re-designing — never re-runs the designer at epic-design-pending-review", () => {
    const r = decide(makeInputs());
    expect(r.epicResumeAt).toBe("checkpoint");
    expect(r.epicResumeAt).not.toBe("design");
  });
});

describe("decide() — epic-pr-open idempotent readback precedence (load-bearing)", () => {
  it("resumes at 'read-back-pr' (NOT 'open-pr') when phase is 'epic-pr-open' AND a branch PR already exists", () => {
    // The load-bearing precedence: a crash mid-PR-open with the PR already
    // created must read it back, never fire a second `gh pr create`.
    const r = decide(
      makeInputs({ state: baseState({ phase: "epic-pr-open" }), pr: OPEN_PR }),
    );
    expect(r.epicResumeAt).toBe("read-back-pr");
    expect(r.epicResumeAt).not.toBe("open-pr");
    expect(r.context.pr).toBe(100);
  });

  it("resumes at 'open-pr' when phase is 'epic-pr-open' AND no PR exists yet", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "epic-pr-open" }),
        pr: { kind: "none" },
      }),
    );
    expect(r.epicResumeAt).toBe("open-pr");
  });
});

// ---------------------------------------------------------------------------
// 2. Canonical phase-set parity (anti-drift guard)
// ---------------------------------------------------------------------------

describe("canonical phase-set parity", () => {
  it("TERMINAL_PHASE_SET equals the canonical lib/state TERMINAL_PHASES (no drift)", () => {
    // Mirrors flow-resume-decide's guard: the terminal short-circuit must
    // source from the canonical set so a future TERMINAL_PHASES change (e.g.
    // a new epic terminal phase) can't silently desync this reader.
    expect([...TERMINAL_PHASE_SET].sort()).toEqual([...TERMINAL_PHASES].sort());
  });

  it("includes epic-approved (the epic approve-terminal) in the terminal set", () => {
    expect(TERMINAL_PHASE_SET.has("epic-approved")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. parseArgs
// ---------------------------------------------------------------------------

describe(parseArgs, () => {
  it("treats empty argv as 'slug omitted' (auto-resolve path)", () => {
    expect(parseArgs([])).toEqual({});
  });

  it("rejects an unknown flag in the slug position", () => {
    expect(parseArgs(["--bogus"])).toEqual({ error: "unknown flag: --bogus" });
  });

  it("accepts a single slug positional", () => {
    expect(parseArgs(["my-epic"])).toEqual({ slug: "my-epic" });
  });
});

// ---------------------------------------------------------------------------
// 4. run() integration — tmpdir state + stubbed gh/git
// ---------------------------------------------------------------------------

let stateDir!: string;
let worktreeRoot!: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-resume-state-"));
  worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-resume-wt-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(worktreeRoot, { recursive: true, force: true });
});

function seedState(slug: string, overrides: Partial<PipelineState> = {}): void {
  writeState(
    {
      slug,
      phase: "epic-designing",
      repo: "/tmp/repo",
      worktree: worktreeRoot,
      updatedAt: "2026-06-24T12:00:00Z",
      ...overrides,
    },
    stateDir,
  );
}

function initWorktree(): void {
  spawnSync("git", ["init", "-b", "main"], { cwd: worktreeRoot });
  spawnSync("git", ["config", "user.email", "test@example.com"], {
    cwd: worktreeRoot,
  });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: worktreeRoot });
  spawnSync("git", ["commit", "--allow-empty", "-m", "feat: initial"], {
    cwd: worktreeRoot,
  });
}

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    writes.push(s.toString());
    return true;
  });
  return { writes, restore: () => spy.mockRestore() };
}

describe("run() integration", () => {
  it("exits 0 with abort JSON when state.json is missing", () => {
    const { writes, restore } = captureStdout();
    const exit = run(["nonexistent-epic"], {
      stateDir,
      gh: vi.fn(),
      git: vi.fn(),
    });
    restore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.epicResumeAt).toBe("abort");
    expect(result.reason).toBe("state-missing-on-resume");
  });

  it("exits 0 with terminal JSON when phase is 'epic-approved' (no gh/git probed)", () => {
    seedState("approved-epic", { phase: "epic-approved" });
    const gh = vi.fn();
    const git = vi.fn();
    const { writes, restore } = captureStdout();
    const exit = run(["approved-epic"], { stateDir, gh, git });
    restore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.epicResumeAt).toBe("terminal");
    // Terminal short-circuits all I/O — the stubs must never be called.
    expect(gh).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
  });

  it("exits 0 with checkpoint JSON at epic-design-pending-review (worktree + open PR)", () => {
    initWorktree();
    seedState("checkpoint-epic", { phase: "epic-design-pending-review" });
    const git: GitRunner = (argv) => {
      if (argv[0] === "rev-parse")
        return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (argv[0] === "branch")
        return { stdout: "epic-feature\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const gh: GhRunner = () => ({
      stdout: JSON.stringify({
        number: 7,
        state: "OPEN",
        url: "https://x/y/pull/7",
      }),
      stderr: "",
      exitCode: 0,
    });
    const { writes, restore } = captureStdout();
    const exit = run(["checkpoint-epic"], { stateDir, gh, git });
    restore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.epicResumeAt).toBe("checkpoint");
    expect(result.context.pr).toBe(7);
  });

  it("exits 0 with read-back-pr at epic-pr-open when a branch PR already exists", () => {
    initWorktree();
    seedState("pr-open-epic", { phase: "epic-pr-open" });
    const git: GitRunner = (argv) => {
      if (argv[0] === "rev-parse")
        return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (argv[0] === "branch")
        return { stdout: "epic-feature\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const gh: GhRunner = () => ({
      stdout: JSON.stringify({
        number: 9,
        state: "OPEN",
        url: "https://x/y/pull/9",
      }),
      stderr: "",
      exitCode: 0,
    });
    const { writes, restore } = captureStdout();
    const exit = run(["pr-open-epic"], { stateDir, gh, git });
    restore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.epicResumeAt).toBe("read-back-pr");
    expect(result.epicResumeAt).not.toBe("open-pr");
  });

  it("exits 0 with open-pr at epic-pr-open when no PR exists for the branch", () => {
    initWorktree();
    seedState("no-pr-epic", { phase: "epic-pr-open" });
    const git: GitRunner = (argv) => {
      if (argv[0] === "rev-parse")
        return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (argv[0] === "branch")
        return { stdout: "epic-feature\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const gh: GhRunner = () => ({
      stdout: "",
      stderr: "no pull requests found",
      exitCode: 1,
    });
    const { writes, restore } = captureStdout();
    const exit = run(["no-pr-epic"], { stateDir, gh, git });
    restore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.epicResumeAt).toBe("open-pr");
  });

  it("exits 2 with usage error on bad CLI args", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--bogus"], { stateDir, gh: vi.fn(), git: vi.fn() });
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });

  it("auto-resolves the slug from $TMUX_PANE when omitted", () => {
    seedState("paneslug-epic", { phase: "epic-approved" });
    const { writes, restore } = captureStdout();
    const exit = run([], {
      stateDir,
      gh: vi.fn(),
      git: vi.fn(),
      resolveSlug: () => "paneslug-epic",
    });
    restore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.epicResumeAt).toBe("terminal");
    expect(result.context.slug).toBe("paneslug-epic");
  });
});
