import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advancePhase,
  PENDING_PHASE_ANCHOR,
  PHASE_EMITTERS,
} from "./phase-advance";
import { spawnSync } from "node:child_process";
import { readState } from "./state";

let stateDir!: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-advance-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function seedState(
  slug: string,
  phase: string,
  extra: Record<string, unknown> = {},
): void {
  const state: Record<string, unknown> = {
    slug,
    phase,
    repo: "/tmp/repo",
    updatedAt: "2026-04-30T12:00:00Z",
    ...extra,
  };
  fs.writeFileSync(
    path.join(stateDir, `${slug}.json`),
    JSON.stringify(state) + "\n",
  );
}

describe("advancePhase", () => {
  it("advances forward and appends exactly one phaseLog entry", () => {
    seedState("s1", "reviewing");
    const result = advancePhase("gating", { slug: "s1", dir: stateDir });
    expect(result).toEqual({
      advanced: true,
      reason: "advanced",
      from: "reviewing",
      to: "gating",
    });
    const state = readState("s1", stateDir);
    expect(state?.phase).toBe("gating");
    expect(state?.phaseLog).toHaveLength(1);
    expect(state?.phaseLog?.[0]?.phase).toBe("gating");
  });

  it("is a no-op on equal phase and adds no second phaseLog entry", () => {
    seedState("s2", "gating");
    advancePhase("gating", { slug: "s2", dir: stateDir });
    const result = advancePhase("gating", { slug: "s2", dir: stateDir });
    expect(result.reason).toBe("already-at-or-past");
    expect(result.advanced).toBe(false);
    const state = readState("s2", stateDir);
    expect(state?.phaseLog ?? []).toHaveLength(0);
  });

  it("is a no-op moving backward", () => {
    seedState("s3", "merging");
    const result = advancePhase("gating", { slug: "s3", dir: stateDir });
    expect(result.reason).toBe("already-at-or-past");
    expect(readState("s3", stateDir)?.phase).toBe("merging");
  });

  it("is a no-op on a terminal phase", () => {
    seedState("s4", "gated");
    const result = advancePhase("merging", { slug: "s4", dir: stateDir });
    expect(result).toEqual({
      advanced: false,
      reason: "terminal",
      from: "gated",
      to: "merging",
    });
    expect(readState("s4", stateDir)?.phase).toBe("gated");
  });

  it("is a no-op on an epic-* phase", () => {
    seedState("s5", "epic-designing");
    const result = advancePhase("gating", { slug: "s5", dir: stateDir });
    expect(result.reason).toBe("epic-phase");
    expect(readState("s5", stateDir)?.phase).toBe("epic-designing");
  });

  it("anchors ci-wait-pending at ci-wait's index so a poll after a yield never regresses it", () => {
    expect(PENDING_PHASE_ANCHOR["ci-wait-pending"]).toBe("ci-wait");
    seedState("s6", "ci-wait-pending");
    const result = advancePhase("ci-wait", { slug: "s6", dir: stateDir });
    expect(result.reason).toBe("already-at-or-past");
    expect(readState("s6", stateDir)?.phase).toBe("ci-wait-pending");
  });

  it("does not advance past ci-wait-pending's anchor even when the target is later", () => {
    seedState("s6b", "ci-wait-pending");
    const result = advancePhase("reviewing", { slug: "s6b", dir: stateDir });
    expect(result.advanced).toBe(true);
    expect(readState("s6b", stateDir)?.phase).toBe("reviewing");
  });

  it("returns no-slug and writes nothing when no slug resolves", () => {
    const result = advancePhase("gating", {
      slug: null,
      dir: stateDir,
      resolveSlug: () => null,
    });
    expect(result).toEqual({
      advanced: false,
      reason: "no-slug",
      to: "gating",
    });
  });

  it("returns no-state and writes nothing when no state file exists", () => {
    const result = advancePhase("gating", { slug: "ghost", dir: stateDir });
    expect(result).toEqual({
      advanced: false,
      reason: "no-state",
      to: "gating",
    });
  });

  it("does not advance a mismatched-PR pipeline (FLOW_SLUG leak guard) and emits one stderr NOTICE", () => {
    seedState("s7", "reviewing", { pr: 42 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = advancePhase("gating", {
      slug: "s7",
      dir: stateDir,
      expectPr: 99,
    });
    expect(result.reason).toBe("pr-mismatch");
    expect(result.advanced).toBe(false);
    expect(readState("s7", stateDir)?.phase).toBe("reviewing");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain(
      "NOTICE — phase-advance: slug s7 is pipeline for PR #42, not #99; not advancing.",
    );
    errorSpy.mockRestore();
  });

  it("advances when expectPr matches state.pr", () => {
    seedState("s8", "reviewing", { pr: 7 });
    const result = advancePhase("gating", {
      slug: "s8",
      dir: stateDir,
      expectPr: 7,
    });
    expect(result.advanced).toBe(true);
  });

  it("refuses to advance and returns branch-mismatch when the worktree is on the wrong branch", () => {
    // Real single-worktree git repo on "actual-branch", with a
    // `.flow-branch` marker claiming "expected-branch" — mirrors
    // flow-state-update.test.ts's makeWorktreeFixture.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase-advance-guard-"));
    const worktree = path.join(root, "wt");
    fs.mkdirSync(worktree);
    spawnSync("git", ["init", "-b", "actual-branch"], { cwd: worktree });
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: worktree,
    });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: worktree });
    spawnSync("git", ["commit", "--allow-empty", "-m", "initial"], {
      cwd: worktree,
    });
    fs.writeFileSync(path.join(worktree, ".flow-branch"), "expected-branch\n");

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      seedState("s9", "implementing", { worktree });
      const result = advancePhase("ci-wait", {
        slug: "s9",
        dir: stateDir,
        resolveSlug: () => null,
      });
      expect(result).toEqual({
        advanced: false,
        reason: "branch-mismatch",
        from: "implementing",
        to: "ci-wait",
      });
      expect(readState("s9", stateDir)?.phase).toBe("implementing");
    } finally {
      errSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("advances normally when the worktree branch matches the marker", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "phase-advance-guard-ok-"),
    );
    const worktree = path.join(root, "wt");
    fs.mkdirSync(worktree);
    spawnSync("git", ["init", "-b", "matching-branch"], { cwd: worktree });
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: worktree,
    });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: worktree });
    spawnSync("git", ["commit", "--allow-empty", "-m", "initial"], {
      cwd: worktree,
    });
    fs.writeFileSync(path.join(worktree, ".flow-branch"), "matching-branch\n");

    try {
      seedState("s10", "implementing", { worktree });
      const result = advancePhase("ci-wait", {
        slug: "s10",
        dir: stateDir,
        resolveSlug: () => null,
      });
      expect(result.advanced).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("PHASE_EMITTERS", () => {
  it("maps every emitted phase to its owning helper and does not contradict flow-stop-guard's phase set", () => {
    expect(PHASE_EMITTERS).toEqual({
      implementing: "flow-open-pr",
      verifying: "flow-verify-prep",
      "ci-wait": "flow-ci-check",
      reviewing: "flow-fetch-pr-review",
      gating: "flow-gate-decide",
      merging: "flow-merge-guard",
    });
  });
});
