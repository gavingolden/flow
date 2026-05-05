import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decide,
  hasPrReviewCommit,
  parseArgs,
  run,
  type CiState,
  type DecisionResult,
  type GhRunner,
  type GitRunner,
  type HeadCommit,
  type Inputs,
  type PrInfo,
  type WorktreeInfo,
} from "./flow-resume-decide";
import { writeState, type PipelineState } from "./lib/state";

// ---------------------------------------------------------------------------
// makeInputs(): default Inputs that lands at the auto-merge gate.
// Each test overrides the field(s) it cares about.
// ---------------------------------------------------------------------------

const PRESENT_WORKTREE: WorktreeInfo = { kind: "present", path: "/tmp/wt" };

function baseState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    slug: "test",
    phase: "reviewing",
    repo: "/tmp/repo",
    worktree: "/tmp/wt",
    updatedAt: "2026-04-30T12:00:00Z",
    ...overrides,
  };
}

function makeInputs(overrides: Partial<Inputs> = {}): Inputs {
  return {
    slug: "test",
    state: baseState(),
    worktree: PRESENT_WORKTREE,
    planExists: true,
    pr: { kind: "found", state: "OPEN", number: 100, url: "https://x/y/pull/100" },
    hasSkillAdditions: false,
    ciState: { kind: "all-terminal" },
    headCommit: { subject: "review: applied findings", body: "" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Pre-tree edge cases
// ---------------------------------------------------------------------------

describe("decide() — pre-tree edge cases", () => {
  it("returns terminal when state.phase is 'merged'", () => {
    const r = decide(makeInputs({ state: baseState({ phase: "merged" }) }));
    expect(r.resumeAt).toBe("terminal");
    expect(r.reason).toContain("merged");
  });

  it("returns terminal when state.phase is 'gated'", () => {
    const r = decide(makeInputs({ state: baseState({ phase: "gated" }) }));
    expect(r.resumeAt).toBe("terminal");
    expect(r.reason).toContain("gated");
  });

  it("returns terminal when state.phase is 'cancelled'", () => {
    const r = decide(makeInputs({ state: baseState({ phase: "cancelled" }) }));
    expect(r.resumeAt).toBe("terminal");
    expect(r.reason).toContain("cancelled");
  });

  it("escalates with worktree-missing-on-resume when path is set but dir is gone", () => {
    const r = decide(
      makeInputs({
        worktree: { kind: "missing-on-disk", path: "/tmp/gone" },
      }),
    );
    expect(r.resumeAt).toBe("escalate");
    expect(r.reason).toBe("worktree-missing-on-resume");
  });

  it("escalates with pr-closed-without-merge when PR state is CLOSED", () => {
    const r = decide(
      makeInputs({
        pr: { kind: "found", state: "CLOSED", number: 100, url: "https://x/y/pull/100" },
      }),
    );
    expect(r.resumeAt).toBe("escalate");
    expect(r.reason).toBe("pr-closed-without-merge");
    expect(r.context.prState).toBe("CLOSED");
  });
});

// ---------------------------------------------------------------------------
// 2. Decision tree row-by-row
// ---------------------------------------------------------------------------

describe("decide() — row 2 (worktree)", () => {
  it("advances past row 2 when worktree is present (auto-merge gate reached)", () => {
    const r = decide(makeInputs());
    expect(r.resumeAt).not.toBe("step-2");
    expect(r.resumeAt).toBe("step-9"); // at the gate
  });

  it("resumes at step-2 when state.worktree is unset", () => {
    const r = decide(
      makeInputs({
        state: baseState({ worktree: undefined, phase: "worktree-create" }),
        worktree: { kind: "absent-from-state" },
      }),
    );
    expect(r.resumeAt).toBe("step-2");
  });
});

describe("decide() — row 3 (plan)", () => {
  it("advances past row 3 when plan.md exists", () => {
    const r = decide(makeInputs({ planExists: true }));
    expect(r.resumeAt).not.toBe("step-3");
  });

  it("resumes at step-3 when plan.md is missing", () => {
    const r = decide(makeInputs({ planExists: false, state: baseState({ phase: "planning" }) }));
    expect(r.resumeAt).toBe("step-3");
    expect(r.context.planExists).toBe(false);
  });

  it("resumes at step-3 when plan.md is empty (treated as missing)", () => {
    // probePlan() collapses empty + missing into the same `false` signal;
    // decide() sees only `planExists: false` either way.
    const r = decide(makeInputs({ planExists: false, state: baseState({ phase: "planning" }) }));
    expect(r.resumeAt).toBe("step-3");
  });
});

describe("decide() — row 4 (approval)", () => {
  it("advances past row 4 when phase is 'implementing' (post-approval)", () => {
    const r = decide(makeInputs({ state: baseState({ phase: "implementing" }) }));
    expect(r.resumeAt).not.toBe("step-4");
  });

  it("resumes at step-4 when phase is 'plan-pending-review'", () => {
    const r = decide(makeInputs({ state: baseState({ phase: "plan-pending-review" }) }));
    expect(r.resumeAt).toBe("step-4");
  });
});

describe("decide() — row 5 (implement / PR exists)", () => {
  it("advances past row 5 when a PR exists for the branch", () => {
    const r = decide(makeInputs());
    expect(r.resumeAt).not.toBe("step-5");
  });

  it("resumes at step-5 when no PR exists for the branch", () => {
    const r = decide(
      makeInputs({
        pr: { kind: "none" },
        state: baseState({ phase: "implementing" }),
      }),
    );
    expect(r.resumeAt).toBe("step-5");
  });
});

describe("decide() — row 5.5 (re-symlink)", () => {
  it("advances past row 5.5 when phase is 'verifying' (post-symlink)", () => {
    const r = decide(makeInputs({ state: baseState({ phase: "verifying" }) }));
    expect(r.resumeAt).not.toBe("step-5.5");
  });

  it("advances past row 5.5 when phase is pre-symlink AND no skill additions", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "implementing" }),
        hasSkillAdditions: false,
      }),
    );
    expect(r.resumeAt).not.toBe("step-5.5");
  });

  it("resumes at step-5.5 when phase is 'implementing' AND skills/agents files were added", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "implementing" }),
        hasSkillAdditions: true,
      }),
    );
    expect(r.resumeAt).toBe("step-5.5");
    expect(r.context.hasSkillAdditions).toBe(true);
  });
});

describe("decide() — row 6 (verify)", () => {
  it("advances past row 6 when phase is 'ci-wait'", () => {
    const r = decide(makeInputs({ state: baseState({ phase: "ci-wait" }) }));
    expect(r.resumeAt).not.toBe("step-6");
  });

  it("resumes at step-6 when phase is 'installing-skills'", () => {
    const r = decide(makeInputs({ state: baseState({ phase: "installing-skills" }) }));
    expect(r.resumeAt).toBe("step-6");
  });
});

describe("decide() — row 7 (ci-wait)", () => {
  it("advances past row 7 when every check is in a terminal state", () => {
    const r = decide(makeInputs({ ciState: { kind: "all-terminal" } }));
    expect(r.resumeAt).not.toBe("step-7");
  });

  it("resumes at step-7 when at least one check is still pending", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "ci-wait" }),
        ciState: { kind: "pending" },
      }),
    );
    expect(r.resumeAt).toBe("step-7");
  });

  it("resumes at step-7 when the checks list is empty (CI configured, not yet reported)", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "ci-wait" }),
        ciState: { kind: "no-checks-reported" },
      }),
    );
    expect(r.resumeAt).toBe("step-7");
    expect(r.reason).toMatch(/yet/i);
  });
});

describe("decide() — row 8 (pr-review on HEAD)", () => {
  it("advances past row 8 when subject starts with 'review:'", () => {
    const r = decide(
      makeInputs({ headCommit: { subject: "review: applied findings", body: "" } }),
    );
    expect(r.resumeAt).not.toBe("step-8");
  });

  it("advances past row 8 when body has a Co-Authored-By pr-review trailer", () => {
    const r = decide(
      makeInputs({
        headCommit: {
          subject: "fix: address review (pr-review #42)",
          body: "Why: ...\n\nCo-Authored-By: pr-review <bot@flow>",
        },
      }),
    );
    expect(r.resumeAt).not.toBe("step-8");
  });

  it("resumes at step-8 when HEAD commit shows no pr-review marker", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "reviewing" }),
        headCommit: { subject: "feat: add foo", body: "Why: ..." },
      }),
    );
    expect(r.resumeAt).toBe("step-8");
    expect(r.context.headCommitSubject).toBe("feat: add foo");
  });
});

describe("decide() — row 9 (gate) — load-bearing precedence", () => {
  it("resumes at step-9 with reason 'at-auto-merge-gate' when PR is OPEN", () => {
    const r = decide(makeInputs());
    expect(r.resumeAt).toBe("step-9");
    expect(r.reason).toBe("at-auto-merge-gate");
    expect(r.context.prState).toBe("OPEN");
  });

  it("resumes at step-9 (NOT step-10) when PR is MERGED but worktree still exists", () => {
    // The load-bearing precedence: supervisor must enter step-9's MERGED-cleanup
    // branch and NOT re-run gh pr merge on an already-merged PR.
    const r = decide(
      makeInputs({
        pr: { kind: "found", state: "MERGED", number: 100, url: "https://x/y/pull/100" },
      }),
    );
    expect(r.resumeAt).toBe("step-9");
    expect(r.reason).toBe("pr-merged-worktree-still-exists");
    expect(r.context.prState).toBe("MERGED");
  });
});

describe("decide() — row 10 (merge)", () => {
  it("returns terminal when PR is MERGED and worktree is absent", () => {
    const r = decide(
      makeInputs({
        pr: { kind: "found", state: "MERGED", number: 100, url: "https://x/y/pull/100" },
        worktree: { kind: "absent-from-state" },
        state: baseState({ worktree: undefined }),
      }),
    );
    expect(r.resumeAt).toBe("terminal");
    expect(r.reason).toBe("pr-merged-worktree-cleaned-up");
  });
});

// ---------------------------------------------------------------------------
// hasPrReviewCommit — small helper, exhaustive cases
// ---------------------------------------------------------------------------

describe(hasPrReviewCommit, () => {
  it("returns false for null", () => {
    expect(hasPrReviewCommit(null)).toBe(false);
  });

  it("returns true for 'review:' subject prefix", () => {
    expect(hasPrReviewCommit({ subject: "review: foo", body: "" })).toBe(true);
  });

  it("returns true for a Co-Authored-By pr-review trailer", () => {
    const c: HeadCommit = {
      subject: "fix: x",
      body: "Why: y\n\nCo-Authored-By: pr-review <bot@flow>",
    };
    expect(hasPrReviewCommit(c)).toBe(true);
  });

  it("returns false for unrelated commits", () => {
    expect(hasPrReviewCommit({ subject: "feat: thing", body: "Why: thing" })).toBe(false);
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

  it("rejects an unknown flag after the slug", () => {
    expect(parseArgs(["foo", "--bogus"])).toEqual({ error: "unknown flag: --bogus" });
  });

  it("accepts a single slug positional", () => {
    expect(parseArgs(["my-slug"])).toEqual({ slug: "my-slug" });
  });
});

// ---------------------------------------------------------------------------
// 4. run() integration — tmpdir state + worktree fixture
// ---------------------------------------------------------------------------

let stateDir!: string;
let worktreeRoot!: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-resume-state-"));
  worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-resume-wt-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(worktreeRoot, { recursive: true, force: true });
});

function seedState(slug: string, overrides: Partial<PipelineState> = {}): void {
  writeState(
    {
      slug,
      phase: "implementing",
      repo: "/tmp/repo",
      worktree: worktreeRoot,
      updatedAt: "2026-04-30T12:00:00Z",
      ...overrides,
    },
    stateDir,
  );
}

/** Initialises a real git repo at worktreeRoot with one initial commit so probeWorktree returns "present". */
function initWorktree(): void {
  spawnSync("git", ["init", "-b", "main"], { cwd: worktreeRoot });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: worktreeRoot });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: worktreeRoot });
  spawnSync("git", ["commit", "--allow-empty", "-m", "feat: initial"], { cwd: worktreeRoot });
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
    // Same exit-0-for-every-decision contract as flow-ci-wait /
    // flow-gate-decide — supervisor doc captures stdout via
    // RESULT=$(flow-resume-decide "$SLUG") and branches on .resumeAt;
    // a non-zero exit would trip strict-shell callers before they
    // could read the abort JSON.
    const { writes, restore } = captureStdout();
    const exit = run(["nonexistent-slug"], { stateDir, gh: vi.fn(), git: vi.fn() });
    restore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.resumeAt).toBe("abort");
    expect(result.reason).toBe("state-missing-on-resume");
  });

  it("exits 0 with step-3 JSON when worktree exists but plan.md is absent", () => {
    initWorktree();
    seedState("alpha", { phase: "planning" });
    // gh + git stubs: gh returns no PR; git only used by probeWorktree path
    // (which falls back to the real defaultGit since we don't override). For
    // this test we DO override git so probeWorktree returns present without
    // hitting the real binary, AND probeBranch/probeSkillAdditions/probeHeadCommit
    // don't trip on the lack of upstream config.
    const git: GitRunner = (argv) => {
      if (argv[0] === "rev-parse") return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (argv[0] === "branch") return { stdout: "main\n", stderr: "", exitCode: 0 };
      if (argv[0] === "symbolic-ref") return { stdout: "", stderr: "no upstream", exitCode: 1 };
      if (argv[0] === "diff") return { stdout: "", stderr: "", exitCode: 0 };
      if (argv[0] === "log") return { stdout: "feat: initial\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const gh: GhRunner = () => ({
      stdout: "",
      stderr: "no pull requests found",
      exitCode: 1,
    });
    const { writes, restore } = captureStdout();
    const exit = run(["alpha"], { stateDir, gh, git });
    restore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.resumeAt).toBe("step-3");
  });

  it("exits 0 with step-5 JSON when plan.md exists but no PR is found for the branch", () => {
    initWorktree();
    fs.mkdirSync(path.join(worktreeRoot, ".flow-tmp"));
    fs.writeFileSync(path.join(worktreeRoot, ".flow-tmp", "plan.md"), "# PRD\n\nbecause.\n");
    seedState("beta", { phase: "implementing" });
    const git: GitRunner = (argv) => {
      if (argv[0] === "rev-parse") return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (argv[0] === "branch") return { stdout: "feature\n", stderr: "", exitCode: 0 };
      if (argv[0] === "symbolic-ref") return { stdout: "", stderr: "", exitCode: 1 };
      if (argv[0] === "diff") return { stdout: "", stderr: "", exitCode: 0 };
      if (argv[0] === "log") return { stdout: "feat: initial\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const gh: GhRunner = () => ({
      stdout: "",
      stderr: "no pull requests found",
      exitCode: 1,
    });
    const { writes, restore } = captureStdout();
    const exit = run(["beta"], { stateDir, gh, git });
    restore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.resumeAt).toBe("step-5");
    expect(result.context.planExists).toBe(true);
  });

  it("exits 0 with terminal JSON when state.phase is 'merged'", () => {
    seedState("gamma", { phase: "merged" });
    const { writes, restore } = captureStdout();
    const exit = run(["gamma"], { stateDir, gh: vi.fn(), git: vi.fn() });
    restore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.resumeAt).toBe("terminal");
  });

  it("exits 2 with usage error on bad CLI args", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--bogus"], { stateDir, gh: vi.fn(), git: vi.fn() });
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });

  it("auto-resolves the slug from $TMUX_PANE when omitted", () => {
    seedState("kappa", { phase: "merged" });
    const { writes, restore } = captureStdout();
    const exit = run([], {
      stateDir,
      gh: vi.fn(),
      git: vi.fn(),
      resolveSlug: () => "kappa",
    });
    restore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.resumeAt).toBe("terminal");
    expect(result.context.slug).toBe("kappa");
  });

  it("prefers an explicit slug over the pane resolver (back-compat)", () => {
    seedState("lambda", { phase: "merged" });
    seedState("other-pipeline", { phase: "merged" });
    const { writes, restore } = captureStdout();
    const exit = run(["lambda"], {
      stateDir,
      gh: vi.fn(),
      git: vi.fn(),
      resolveSlug: () => "other-pipeline",
    });
    restore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.context.slug).toBe("lambda");
  });

  it("exits 2 with a clear error when no slug given and pane has none either", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run([], {
      stateDir,
      gh: vi.fn(),
      git: vi.fn(),
      resolveSlug: () => null,
    });
    expect(exit).toBe(2);
    expect(errSpy.mock.calls.flat().join("\n")).toContain("@flow-slug");
    errSpy.mockRestore();
  });
});
