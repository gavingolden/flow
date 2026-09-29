import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTINUE_PHASE_BY_EPIC_STEP,
  decide,
  gatherInputs,
  parseArgs,
  run,
  TERMINAL_PHASE_SET,
  type Deps,
  type DecisionResult,
  type Inputs,
} from "./flow-epic-resume-decide";
import { CONTINUE_PHASE_BY_STEP } from "./flow-resume-decide";
import {
  checkpointConsumedPath,
  checkpointMarkerPath,
} from "./flow-checkpoint";
import { checkpointBodyPath } from "./lib/checkpoint-freshness";
import {
  TERMINAL_EXIT_TRANSITIONS,
  writeState,
  type PipelineState,
  TERMINAL_PHASES,
} from "./lib/state";
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
    checkpointExists: false,
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

  it("returns terminal when phase is 'needs-human' and no worktree is recorded (canonical-set parity)", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "needs-human", worktree: undefined }),
        worktree: { kind: "absent-from-state" },
        pr: { kind: "none" },
      }),
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

function pausedState(...phases: string[]): PipelineState {
  return baseState({
    phase: "needs-human",
    phaseLog: [...phases, "needs-human"].map((phase, i) => ({
      phase,
      at: `t${i}`,
    })),
  });
}

describe("decide() — needs-human awaiting-human pause", () => {
  it("resolves [epic-designing, needs-human] with a live worktree to awaiting-human, continuing at design / epic-designing", () => {
    const r = decide(
      makeInputs({
        state: pausedState("epic-designing"),
        pr: { kind: "none" },
      }),
    );
    expect(r.epicResumeAt).toBe("awaiting-human");
    expect(r.reason).toBe("needs-human-awaiting-human-step");
    expect(r.context.continueAt).toBe("design");
    expect(r.context.continuePhase).toBe("epic-designing");
  });

  it.each([
    ["epic-validating", "validate", "epic-validating"],
    ["epic-plan-review-pending", "validate", "epic-validating"],
    ["epic-design-pending-review", "checkpoint", "epic-design-pending-review"],
    ["starting", "design", "epic-designing"],
  ])(
    "a pause at %s continues at %s by writing %s",
    (paused, continueAt, continuePhase) => {
      const r = decide(
        makeInputs({ state: pausedState(paused), pr: { kind: "none" } }),
      );
      expect(r.epicResumeAt).toBe("awaiting-human");
      expect(r.context.continueAt).toBe(continueAt);
      expect(r.context.continuePhase).toBe(continuePhase);
    },
  );

  it("a pause at epic-pr-open continues at read-back-pr with an open PR and at open-pr without one; both write epic-pr-open", () => {
    const withPr = decide(
      makeInputs({ state: pausedState("epic-pr-open"), pr: OPEN_PR }),
    );
    expect(withPr.context.continueAt).toBe("read-back-pr");
    expect(withPr.context.continuePhase).toBe("epic-pr-open");
    const noPr = decide(
      makeInputs({ state: pausedState("epic-pr-open"), pr: { kind: "none" } }),
    );
    expect(noPr.context.continueAt).toBe("open-pr");
    expect(noPr.context.continuePhase).toBe("epic-pr-open");
  });

  it("leaves continueAt/continuePhase absent when the log has no step before the pause (ask which step)", () => {
    const r = decide(
      makeInputs({
        state: baseState({
          phase: "needs-human",
          phaseLog: [{ phase: "needs-human", at: "t0" }],
        }),
        pr: { kind: "none" },
      }),
    );
    expect(r.epicResumeAt).toBe("awaiting-human");
    expect(r.context.continueAt).toBeUndefined();
    expect(r.context.continuePhase).toBeUndefined();
  });

  it("escalates pr-closed-without-merge when the design PR was closed while paused", () => {
    const r = decide(
      makeInputs({
        state: pausedState("epic-design-pending-review"),
        pr: { kind: "found", state: "CLOSED", number: 5, url: "u" },
      }),
    );
    expect(r.epicResumeAt).toBe("escalate");
    expect(r.reason).toBe("pr-closed-without-merge");
  });

  it("is terminal (pr-merged-while-paused) when the design PR merged while paused", () => {
    const r = decide(
      makeInputs({
        state: pausedState("epic-design-pending-review"),
        pr: { kind: "found", state: "MERGED", number: 5, url: "u" },
      }),
    );
    expect(r.epicResumeAt).toBe("terminal");
    expect(r.reason).toBe("pr-merged-while-paused");
  });

  it("escalates worktree-missing-on-resume when the recorded worktree vanished (surfaced, not dead-ended)", () => {
    const r = decide(
      makeInputs({
        state: pausedState("epic-designing"),
        worktree: { kind: "missing-on-disk", path: "/tmp/gone" },
        pr: { kind: "none" },
      }),
    );
    expect(r.epicResumeAt).toBe("escalate");
    expect(r.reason).toBe("worktree-missing-on-resume");
  });

  it("is terminal when no worktree was ever recorded", () => {
    const r = decide(
      makeInputs({
        state: pausedState("epic-designing"),
        worktree: { kind: "absent-from-state" },
        pr: { kind: "none" },
      }),
    );
    expect(r.epicResumeAt).toBe("terminal");
    expect(r.reason).toContain("needs-human");
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

  it("resumes at 'validate' when phase is 'epic-plan-review-pending' (yielded mid async design review)", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "epic-plan-review-pending" }),
        pr: { kind: "none" },
      }),
    );
    expect(r.epicResumeAt).toBe("validate");
    expect(r.epicResumeAt).not.toBe("design");
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

describe("decide() — checkpointExists (Task 5 parity with flow-resume-decide)", () => {
  it("surfaces checkpointExists: true on a checkpoint decision", () => {
    const r = decide(makeInputs({ checkpointExists: true }));
    expect(r.epicResumeAt).toBe("checkpoint");
    expect(r.context.checkpointExists).toBe(true);
  });

  it("surfaces checkpointExists: false when absent", () => {
    const r = decide(makeInputs({ checkpointExists: false }));
    expect(r.context.checkpointExists).toBe(false);
  });

  it("surfaces checkpointExists: false on a terminal-phase decision (no gh/git probe needed)", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "epic-approved" }),
        checkpointExists: false,
      }),
    );
    expect(r.epicResumeAt).toBe("terminal");
    expect(r.context.checkpointExists).toBe(false);
  });
});

describe("gatherInputs() — needs-human is probed like a live phase", () => {
  it("does not short-circuit needs-human: the worktree probe reads the recorded worktree", () => {
    const git = (() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    })) as unknown as GitRunner;
    const gh = (() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    })) as unknown as GhRunner;
    const inputs = gatherInputs(
      "paused-epic",
      {
        ...pausedState("epic-designing"),
        worktree: path.join(os.tmpdir(), "flow-no-such-epic-wt-9f3a"),
      },
      gh,
      git,
      os.tmpdir(),
    );
    // A nonexistent recorded worktree reports missing-on-disk — proof the
    // probe ran instead of the terminal short-circuit's hard-coded
    // absent-from-state.
    expect(inputs.worktree.kind).toBe("missing-on-disk");
  });
});

describe("gatherInputs() — terminal-phase checkpoint probe", () => {
  // The decide() tests above build Inputs directly, so they never exercise the
  // terminal short-circuit that actually produces `checkpointExists`. These
  // drive gatherInputs itself: the short-circuit used to hard-code `false`,
  // which silently dropped epic-design notes at `epic-approved` — the exact
  // defect the feature-side helper was fixed for.
  let stateDir!: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "epic-resume-cp-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function seedBody(slug: string): void {
    const d = path.join(stateDir, "checkpoints", slug);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "checkpoint.md"), "epic note\n");
  }

  function countingRunners(): {
    gh: GhRunner;
    git: GitRunner;
    calls: () => number;
  } {
    let calls = 0;
    const gh = ((...args: unknown[]) => {
      void args;
      calls += 1;
      return { ok: false, stdout: "", stderr: "" };
    }) as unknown as GhRunner;
    const git = ((...args: unknown[]) => {
      void args;
      calls += 1;
      return { ok: false, stdout: "", stderr: "" };
    }) as unknown as GitRunner;
    return { gh, git, calls: () => calls };
  }

  it("reports checkpointExists: true at a terminal phase when a body exists, with zero gh/git calls", () => {
    seedBody("epic-done");
    const { gh, git, calls } = countingRunners();
    const inputs = gatherInputs(
      "epic-done",
      baseState({ phase: "epic-approved" }),
      gh,
      git,
      stateDir,
    );
    expect(inputs.checkpointExists).toBe(true);
    expect(calls()).toBe(0);
  });

  it("reports checkpointExists: false at a terminal phase when no body exists", () => {
    const { gh, git, calls } = countingRunners();
    const inputs = gatherInputs(
      "epic-none",
      baseState({ phase: "epic-approved" }),
      gh,
      git,
      stateDir,
    );
    expect(inputs.checkpointExists).toBe(false);
    expect(calls()).toBe(0);
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
  it("the feature and epic continue-phase maps together equal TERMINAL_EXIT_TRANSITIONS['needs-human'] exactly (union parity)", () => {
    const union = [
      ...Object.values(CONTINUE_PHASE_BY_STEP),
      ...Object.values(CONTINUE_PHASE_BY_EPIC_STEP),
    ];
    const allowlisted = TERMINAL_EXIT_TRANSITIONS[
      "needs-human"
    ] as readonly string[];
    expect([...new Set(union)].sort()).toEqual([...allowlisted].sort());
  });

  it("no epic continue phase is terminal or a merge phase", () => {
    for (const phase of Object.values(CONTINUE_PHASE_BY_EPIC_STEP)) {
      expect(TERMINAL_PHASES as readonly string[]).not.toContain(phase);
      expect(phase).not.toBe("merging");
    }
  });

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

  it("drives a needs-human epic through the real CLI path: worktree and PR are probed and the verdict is awaiting-human (guards the terminal short-circuit exclusion)", () => {
    initWorktree();
    seedState("paused-cli-epic", {
      phase: "needs-human",
      phaseLog: [
        { phase: "epic-designing", at: "t0" },
        { phase: "needs-human", at: "t1" },
      ],
    });
    const gitCalls: string[][] = [];
    const git: GitRunner = (argv) => {
      gitCalls.push(argv);
      if (argv[0] === "rev-parse")
        return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (argv[0] === "branch")
        return { stdout: "epic-feature\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const gh = vi.fn<GhRunner>(() => ({
      stdout: "",
      stderr: "no pull requests found",
      exitCode: 1,
    }));
    const { writes, restore } = captureStdout();
    const exit = run(["paused-cli-epic"], { stateDir, gh, git });
    restore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.epicResumeAt).toBe("awaiting-human");
    expect(result.context.continueAt).toBe("design");
    expect(result.context.continuePhase).toBe("epic-designing");
    expect(gitCalls.some((a) => a[0] === "rev-parse")).toBe(true);
    expect(gh).toHaveBeenCalled();
  });

  it("exits 2 with usage error on bad CLI args", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--bogus"], { stateDir, gh: vi.fn(), git: vi.fn() });
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });

  it("auto-resolves the slug from $FLOW_SLUG when omitted", () => {
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

describe("run() — one-shot checkpoint retirement", () => {
  const okGit: GitRunner = (argv) => {
    if (argv[0] === "rev-parse")
      return { stdout: "true\n", stderr: "", exitCode: 0 };
    if (argv[0] === "branch")
      return { stdout: "epic-feature\n", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 1 };
  };
  const openPrGh: GhRunner = () => ({
    stdout: JSON.stringify({
      number: 7,
      state: "OPEN",
      url: "https://x/y/pull/7",
    }),
    stderr: "",
    exitCode: 0,
  });

  function armNote(slug: string): { body: string; marker: string } {
    const body = checkpointBodyPath(slug, stateDir);
    const marker = checkpointMarkerPath(slug, stateDir);
    fs.mkdirSync(path.dirname(body), { recursive: true });
    fs.writeFileSync(body, "resume notes\n");
    fs.writeFileSync(marker, `${slug}\n`);
    return { body, marker };
  }

  function decideCli(slug: string, deps: Partial<Deps> = {}): DecisionResult {
    const { writes, restore } = captureStdout();
    const exit = run([slug], { stateDir, gh: openPrGh, git: okGit, ...deps });
    restore();
    expect(exit).toBe(0);
    return JSON.parse(writes.join("")) as DecisionResult;
  }

  it("a non-paused verdict removes the marker, archives the note, and publishes the archived path", () => {
    initWorktree();
    seedState("retire-epic", { phase: "epic-design-pending-review" });
    const { body, marker } = armNote("retire-epic");
    const result = decideCli("retire-epic");
    expect(result.epicResumeAt).toBe("checkpoint");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(body)).toBe(false);
    const archived = checkpointConsumedPath("retire-epic", stateDir);
    expect(fs.readFileSync(archived, "utf8")).toBe("resume notes\n");
    expect(result.context.checkpointPath).toBe(archived);
    expect(result.context.checkpointConsumed).toBe(true);
    expect(result.context.checkpointExists).toBe(true);
  });

  it("a terminal verdict also retires the note (only awaiting-human and abort defer)", () => {
    seedState("retire-terminal", { phase: "epic-approved" });
    const { marker } = armNote("retire-terminal");
    const result = decideCli("retire-terminal");
    expect(result.epicResumeAt).toBe("terminal");
    expect(fs.existsSync(marker)).toBe(false);
    expect(result.context.checkpointPath).toBe(
      checkpointConsumedPath("retire-terminal", stateDir),
    );
  });

  it("keeps the marker and live note at the awaiting-human pause, then retires after the continue-phase write and a second run", () => {
    initWorktree();
    seedState("pause-epic", {
      phase: "needs-human",
      phaseLog: [
        { phase: "epic-designing", at: "t0" },
        { phase: "needs-human", at: "t1" },
      ],
    });
    const { body, marker } = armNote("pause-epic");
    const noPr: GhRunner = () => ({ stdout: "", stderr: "none", exitCode: 1 });

    const paused = decideCli("pause-epic", { gh: noPr });
    expect(paused.epicResumeAt).toBe("awaiting-human");
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.existsSync(body)).toBe(true);
    expect(paused.context.checkpointPath).toBe(body);
    expect(paused.context.checkpointConsumed).toBe(false);

    seedState("pause-epic", { phase: "epic-designing" });
    const resumed = decideCli("pause-epic", { gh: noPr });
    expect(resumed.epicResumeAt).toBe("design");
    expect(fs.existsSync(marker)).toBe(false);
    expect(resumed.context.checkpointPath).toBe(
      checkpointConsumedPath("pause-epic", stateDir),
    );
    expect(resumed.context.checkpointConsumed).toBe(true);
  });

  it("does not retire on abort (state missing) and never calls the consume seam at the pause", () => {
    const consume = vi.fn();
    expect(decideCli("ghost-epic", { consume }).epicResumeAt).toBe("abort");
    initWorktree();
    seedState("seam-epic", {
      phase: "needs-human",
      phaseLog: [
        { phase: "epic-designing", at: "t0" },
        { phase: "needs-human", at: "t1" },
      ],
    });
    const noPr: GhRunner = () => ({ stdout: "", stderr: "none", exitCode: 1 });
    expect(decideCli("seam-epic", { consume, gh: noPr }).epicResumeAt).toBe(
      "awaiting-human",
    );
    expect(consume).not.toHaveBeenCalled();
  });

  it("omits checkpointPath when no note existed", () => {
    seedState("no-note", { phase: "epic-approved" });
    const result = decideCli("no-note");
    expect(result.context.checkpointPath).toBeUndefined();
    expect(result.context.checkpointConsumed).toBe(false);
  });
});
