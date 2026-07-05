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
  NO_INFLIGHT_WORK_PHASES,
  TERMINAL_PHASE_SET,
  type DecisionResult,
  type GhRunner,
  type GitRunner,
  type HeadCommit,
  type Inputs,
  type WorktreeInfo,
} from "./flow-resume-decide";
import {
  writeState,
  type PipelineState,
  PENDING_PHASES,
  TERMINAL_PHASES,
} from "./lib/state";

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
    checkpointExists: false,
    checkpointMarkerExists: false,
    pr: {
      kind: "found",
      state: "OPEN",
      number: 100,
      url: "https://x/y/pull/100",
    },
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

  it("returns terminal when state.phase is 'gated' and NO checkpoint marker is present (unchanged)", () => {
    // gated is normally terminal; without the one-shot checkpoint.pending
    // marker it resolves to terminal exactly as before the feedback mode.
    const r = decide(
      makeInputs({
        state: baseState({ phase: "gated" }),
        checkpointMarkerExists: false,
      }),
    );
    expect(r.resumeAt).toBe("terminal");
    expect(r.reason).toContain("gated");
  });

  it("resolves gated + checkpoint marker present → 'gated-feedback' with .context.pr populated (Story 1)", () => {
    // A gated pipeline whose worktree carries a checkpoint.pending marker is a
    // feedback-mode resume point: take a bug callout → /coder → re-verify →
    // re-gate. The branch self-populates .context.pr (it precedes the general
    // PR-population line) so Resume mode has PR context.
    const r = decide(
      makeInputs({
        state: baseState({ phase: "gated" }),
        worktree: PRESENT_WORKTREE,
        checkpointMarkerExists: true,
        checkpointExists: true,
        pr: {
          kind: "found",
          state: "OPEN",
          number: 100,
          url: "https://x/y/pull/100",
        },
      }),
    );
    expect(r.resumeAt).toBe("gated-feedback");
    expect(r.reason).toBe("gated-with-checkpoint-marker");
    expect(r.context.pr).toBe(100);
    expect(r.context.prState).toBe("OPEN");
    expect(r.context.checkpointExists).toBe(true);
  });

  it("returns terminal for gated + marker present but worktree gone (no feedback without a live worktree)", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "gated" }),
        worktree: { kind: "absent-from-state" },
        checkpointMarkerExists: true,
      }),
    );
    expect(r.resumeAt).toBe("terminal");
    expect(r.reason).toContain("gated");
  });

  it("routes gated + marker + worktree present to step-9 MERGED-cleanup (NOT gated-feedback) when the PR was merged externally", () => {
    // The PR-OPEN guard: a gated pipeline whose PR is merged on GitHub still
    // carries marker + worktree (gatherInputs de-short-circuits gated I/O), so
    // it must fall through to the merged-worktree-cleanup resolution rather than
    // entering feedback mode on an already-merged PR (which would leave the
    // worktree/branch uncleaned).
    const r = decide(
      makeInputs({
        state: baseState({ phase: "gated" }),
        worktree: PRESENT_WORKTREE,
        checkpointMarkerExists: true,
        checkpointExists: true,
        pr: {
          kind: "found",
          state: "MERGED",
          number: 100,
          url: "https://x/y/pull/100",
        },
      }),
    );
    expect(r.resumeAt).toBe("step-9");
    expect(r.reason).toBe("pr-merged-worktree-still-exists");
    expect(r.context.prState).toBe("MERGED");
  });

  it("returns terminal (pr-merged-worktree-cleaned-up) for gated + marker when the PR merged externally and the worktree is already gone", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "gated" }),
        worktree: { kind: "absent-from-state" },
        checkpointMarkerExists: true,
        pr: {
          kind: "found",
          state: "MERGED",
          number: 100,
          url: "https://x/y/pull/100",
        },
      }),
    );
    expect(r.resumeAt).toBe("terminal");
    expect(r.reason).toBe("pr-merged-worktree-cleaned-up");
  });

  it("escalates gated + marker + worktree present (NOT gated-feedback) when the PR was closed without merge externally", () => {
    // A gated PR closed-unmerged on GitHub must route to the closed-escalation
    // resolution, not feedback mode.
    const r = decide(
      makeInputs({
        state: baseState({ phase: "gated" }),
        worktree: PRESENT_WORKTREE,
        checkpointMarkerExists: true,
        checkpointExists: true,
        pr: {
          kind: "found",
          state: "CLOSED",
          number: 100,
          url: "https://x/y/pull/100",
        },
      }),
    );
    expect(r.resumeAt).toBe("escalate");
    expect(r.reason).toBe("pr-closed-without-merge");
    expect(r.context.prState).toBe("CLOSED");
  });

  it("returns terminal when state.phase is 'cancelled'", () => {
    const r = decide(makeInputs({ state: baseState({ phase: "cancelled" }) }));
    expect(r.resumeAt).toBe("terminal");
    expect(r.reason).toContain("cancelled");
  });

  it("returns terminal (NOT step-2) when phase is 'triaged-no-change' with no worktree — the reported bug", () => {
    // A no-change investigation already produced its answer and ended at
    // triaged-no-change with no worktree/plan/PR. Resuming it must re-surface
    // completion, not fall through to Row 2 and build a worktree.
    const r = decide(
      makeInputs({
        state: baseState({ phase: "triaged-no-change", worktree: undefined }),
        worktree: { kind: "absent-from-state" },
      }),
    );
    expect(r.resumeAt).toBe("terminal");
    expect(r.resumeAt).not.toBe("step-2");
    expect(r.reason).toBe("no-change-investigation-complete");
  });

  it("surfaces .context.answer on the triaged-no-change terminal verdict when the state carries one", () => {
    // A no-change pipeline persists its chat answer under state.answer; the
    // terminal verdict must carry it so resume can re-print it.
    const r = decide(
      makeInputs({
        state: baseState({
          phase: "triaged-no-change",
          worktree: undefined,
          answer: "X works by Y.",
        }),
        worktree: { kind: "absent-from-state" },
      }),
    );
    expect(r.resumeAt).toBe("terminal");
    expect(r.reason).toBe("no-change-investigation-complete");
    expect(r.context.answer).toBe("X works by Y.");
  });

  it("omits .context.answer on triaged-no-change when the state has no answer", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "triaged-no-change", worktree: undefined }),
        worktree: { kind: "absent-from-state" },
      }),
    );
    expect(r.resumeAt).toBe("terminal");
    expect(r.reason).toBe("no-change-investigation-complete");
    expect(r.context.answer).toBeUndefined();
  });

  it("returns terminal (NOT step-2) when phase is 'triage-pending-clarification' with no worktree", () => {
    // A pipeline awaiting the user's triage-clarification reply has no
    // worktree; a --resume can't re-ask in-context and must not build.
    const r = decide(
      makeInputs({
        state: baseState({
          phase: "triage-pending-clarification",
          worktree: undefined,
        }),
        worktree: { kind: "absent-from-state" },
      }),
    );
    expect(r.resumeAt).toBe("terminal");
    expect(r.resumeAt).not.toBe("step-2");
    expect(r.reason).toBe("awaiting-triage-clarification");
  });

  it("returns terminal when state.phase is 'needs-human' (canonical-set parity)", () => {
    // The prior local TERMINAL_PHASES literal omitted needs-human, so a crashed
    // escalation fell through the row tree. Sourcing from canonical lib/state
    // makes it resolve terminal like the other terminal phases.
    const r = decide(
      makeInputs({ state: baseState({ phase: "needs-human" }) }),
    );
    expect(r.resumeAt).toBe("terminal");
    expect(r.reason).toContain("needs-human");
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
        pr: {
          kind: "found",
          state: "CLOSED",
          number: 100,
          url: "https://x/y/pull/100",
        },
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
    const r = decide(
      makeInputs({
        planExists: false,
        state: baseState({ phase: "planning" }),
      }),
    );
    expect(r.resumeAt).toBe("step-3");
    expect(r.context.planExists).toBe(false);
  });

  it("resumes at step-3 when plan.md is empty (treated as missing)", () => {
    // probePlan() collapses empty + missing into the same `false` signal;
    // decide() sees only `planExists: false` either way.
    const r = decide(
      makeInputs({
        planExists: false,
        state: baseState({ phase: "planning" }),
      }),
    );
    expect(r.resumeAt).toBe("step-3");
  });
});

describe("decide() — row 4 (approval)", () => {
  it("advances past row 4 when phase is 'implementing' (post-approval)", () => {
    const r = decide(
      makeInputs({ state: baseState({ phase: "implementing" }) }),
    );
    expect(r.resumeAt).not.toBe("step-4");
  });

  it("resumes at step-4 when phase is 'plan-pending-review'", () => {
    const r = decide(
      makeInputs({ state: baseState({ phase: "plan-pending-review" }) }),
    );
    expect(r.resumeAt).toBe("step-4");
  });

  it("resumes at step-4 when phase is 'approval-pending-clarification' (no-regression — has in-flight work)", () => {
    // approval-pending-clarification occurs AFTER the worktree + plan exist, so
    // it has in-flight work and must keep falling through to its Row 4 routing
    // — it is deliberately NOT in NO_INFLIGHT_WORK_PHASES.
    const r = decide(
      makeInputs({
        state: baseState({ phase: "approval-pending-clarification" }),
      }),
    );
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
    const r = decide(
      makeInputs({ state: baseState({ phase: "installing-skills" }) }),
    );
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

  it("resumes at step-7 when phase is 'ci-wait-pending' (yielded while flow-ci-wait was backgrounded)", () => {
    // ci-wait-pending implies verify is complete just as ci-wait does, so a
    // crash while yielded must resume at step-7 (re-enter the poll loop),
    // not fall through to step-6.
    const r = decide(
      makeInputs({
        state: baseState({ phase: "ci-wait-pending" }),
        ciState: { kind: "pending" },
      }),
    );
    expect(r.resumeAt).toBe("step-7");
  });
});

describe("decide() — row 8 (pr-review on HEAD)", () => {
  it("advances past row 8 when subject starts with 'review:'", () => {
    const r = decide(
      makeInputs({
        headCommit: { subject: "review: applied findings", body: "" },
      }),
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
        pr: {
          kind: "found",
          state: "MERGED",
          number: 100,
          url: "https://x/y/pull/100",
        },
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
        pr: {
          kind: "found",
          state: "MERGED",
          number: 100,
          url: "https://x/y/pull/100",
        },
        worktree: { kind: "absent-from-state" },
        state: baseState({ worktree: undefined }),
      }),
    );
    expect(r.resumeAt).toBe("terminal");
    expect(r.reason).toBe("pr-merged-worktree-cleaned-up");
  });
});

// ---------------------------------------------------------------------------
// Canonical phase-set parity (anti-drift guard) — the divergence this fix closed
// ---------------------------------------------------------------------------

describe("canonical phase-set parity", () => {
  it("TERMINAL_PHASE_SET equals the canonical lib/state TERMINAL_PHASES (no drift)", () => {
    // The bug was a second, hand-maintained copy that drifted (omitted
    // needs-human). Sourcing from canonical and asserting equality here means
    // a future canonical change can't silently desync the resume reader.
    expect([...TERMINAL_PHASE_SET].sort()).toEqual([...TERMINAL_PHASES].sort());
  });

  it("every NO_INFLIGHT_WORK_PHASES member is a canonical PENDING_PHASES member", () => {
    for (const phase of NO_INFLIGHT_WORK_PHASES) {
      expect(PENDING_PHASES as readonly string[]).toContain(phase);
    }
  });

  it("NO_INFLIGHT_WORK_PHASES excludes the pending phases that DO have in-flight work", () => {
    for (const phase of [
      "plan-pending-review",
      "approval-pending-clarification",
      "ci-wait-pending",
    ]) {
      expect(NO_INFLIGHT_WORK_PHASES.has(phase)).toBe(false);
    }
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
    expect(
      hasPrReviewCommit({ subject: "feat: thing", body: "Why: thing" }),
    ).toBe(false);
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
    expect(parseArgs(["foo", "--bogus"])).toEqual({
      error: "unknown flag: --bogus",
    });
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
    // Same exit-0-for-every-decision contract as flow-ci-wait /
    // flow-gate-decide — supervisor doc captures stdout via
    // RESULT=$(flow-resume-decide "$SLUG") and branches on .resumeAt;
    // a non-zero exit would trip strict-shell callers before they
    // could read the abort JSON.
    const { writes, restore } = captureStdout();
    const exit = run(["nonexistent-slug"], {
      stateDir,
      gh: vi.fn(),
      git: vi.fn(),
    });
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
      if (argv[0] === "rev-parse")
        return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (argv[0] === "branch")
        return { stdout: "main\n", stderr: "", exitCode: 0 };
      if (argv[0] === "symbolic-ref")
        return { stdout: "", stderr: "no upstream", exitCode: 1 };
      if (argv[0] === "diff") return { stdout: "", stderr: "", exitCode: 0 };
      if (argv[0] === "log")
        return { stdout: "feat: initial\n", stderr: "", exitCode: 0 };
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
    fs.writeFileSync(
      path.join(worktreeRoot, ".flow-tmp", "plan.md"),
      "# PRD\n\nbecause.\n",
    );
    seedState("beta", { phase: "implementing" });
    const git: GitRunner = (argv) => {
      if (argv[0] === "rev-parse")
        return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (argv[0] === "branch")
        return { stdout: "feature\n", stderr: "", exitCode: 0 };
      if (argv[0] === "symbolic-ref")
        return { stdout: "", stderr: "", exitCode: 1 };
      if (argv[0] === "diff") return { stdout: "", stderr: "", exitCode: 0 };
      if (argv[0] === "log")
        return { stdout: "feat: initial\n", stderr: "", exitCode: 0 };
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

  it("exits 0 with terminal JSON when state.phase is 'triaged-no-change' and no worktree (the reported bug, end-to-end)", () => {
    // The live repro: state {phase: triaged-no-change, no worktree/plan/pr}.
    // Must return terminal, NOT step-2, and must not probe gh/git at all
    // (the vi.fn() stubs would throw on an unexpected shape if called).
    seedState("delta", { phase: "triaged-no-change", worktree: undefined });
    const gh = vi.fn();
    const git = vi.fn();
    const { writes, restore } = captureStdout();
    const exit = run(["delta"], { stateDir, gh, git });
    restore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.resumeAt).toBe("terminal");
    expect(result.resumeAt).not.toBe("step-2");
    expect(result.reason).toBe("no-change-investigation-complete");
    expect(gh).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// checkpoint / clear / resume wiring (Stories 2 & 6)
// ---------------------------------------------------------------------------

describe("decide() — checkpoint re-injection + auto-checkpoint resume", () => {
  it("surfaces checkpointExists in the decision context when checkpoint.md is present (Story 2)", () => {
    const r = decide(makeInputs({ checkpointExists: true }));
    // Resume mode reads context.checkpointExists to decide whether to re-inject
    // checkpoint.md and consume the one-shot marker.
    expect(r.context.checkpointExists).toBe(true);
  });

  it("leaves checkpointExists false when no checkpoint.md exists", () => {
    const r = decide(makeInputs({ checkpointExists: false }));
    expect(r.context.checkpointExists).toBe(false);
  });

  it("resolves checkpoint-pending-clear to step-5 — the approval→implement hand-off has no PR yet (Story 6)", () => {
    const r = decide(
      makeInputs({
        state: baseState({ phase: "checkpoint-pending-clear" }),
        pr: { kind: "none" },
      }),
    );
    // checkpoint-pending-clear is a POST_APPROVAL phase (passes Row 4), and no
    // PR exists at the auto-checkpoint boundary, so Row 5 resumes at implement —
    // NOT step-4 re-approval.
    expect(r.resumeAt).toBe("step-5");
  });
});
