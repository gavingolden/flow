import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advancePhase,
  finalizePhase,
  isFixLoopReentry,
  FIX_LOOP_REENTRY_TRANSITIONS,
  PENDING_PHASE_ANCHOR,
  PHASE_EMITTERS,
  TERMINAL_PHASE_EMITTERS,
} from "./phase-advance";
import { spawnSync } from "node:child_process";
import { readState } from "./state";
import type { PhasePublisher } from "./phase-write";

let stateDir!: string;

// Injected through every seedState-based advancePhase/finalizePhase call in
// this file so no test ever falls through to the real setWindowPhase
// default and shells out to a real tmux session.
const noopPublish: PhasePublisher = () => {};

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
    const result = advancePhase("gating", {
      slug: "s1",
      dir: stateDir,
      publish: noopPublish,
    });
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
    advancePhase("gating", { slug: "s2", dir: stateDir, publish: noopPublish });
    const result = advancePhase("gating", {
      slug: "s2",
      dir: stateDir,
      publish: noopPublish,
    });
    expect(result.reason).toBe("already-at-or-past");
    expect(result.advanced).toBe(false);
    const state = readState("s2", stateDir);
    expect(state?.phaseLog ?? []).toHaveLength(0);
  });

  it("is a no-op moving backward", () => {
    seedState("s3", "merging");
    const result = advancePhase("gating", {
      slug: "s3",
      dir: stateDir,
      publish: noopPublish,
    });
    expect(result.reason).toBe("already-at-or-past");
    expect(readState("s3", stateDir)?.phase).toBe("merging");
  });

  it("is a no-op on a terminal phase", () => {
    seedState("s4", "gated");
    const result = advancePhase("merging", {
      slug: "s4",
      dir: stateDir,
      publish: noopPublish,
    });
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
    const result = advancePhase("gating", {
      slug: "s5",
      dir: stateDir,
      publish: noopPublish,
    });
    expect(result.reason).toBe("epic-phase");
    expect(readState("s5", stateDir)?.phase).toBe("epic-designing");
  });

  it("anchors ci-wait-pending at ci-wait's index so a poll after a yield never regresses it", () => {
    expect(PENDING_PHASE_ANCHOR["ci-wait-pending"]).toBe("ci-wait");
    seedState("s6", "ci-wait-pending");
    const result = advancePhase("ci-wait", {
      slug: "s6",
      dir: stateDir,
      publish: noopPublish,
    });
    expect(result.reason).toBe("already-at-or-past");
    expect(readState("s6", stateDir)?.phase).toBe("ci-wait-pending");
  });

  it("does not advance past ci-wait-pending's anchor even when the target is later", () => {
    seedState("s6b", "ci-wait-pending");
    const result = advancePhase("reviewing", {
      slug: "s6b",
      dir: stateDir,
      publish: noopPublish,
    });
    expect(result.advanced).toBe(true);
    expect(readState("s6b", stateDir)?.phase).toBe("reviewing");
  });

  it("returns no-slug and writes nothing when no slug resolves", () => {
    const result = advancePhase("gating", {
      slug: null,
      dir: stateDir,
      publish: noopPublish,
      resolveSlug: () => null,
    });
    expect(result).toEqual({
      advanced: false,
      reason: "no-slug",
      to: "gating",
    });
  });

  it("returns no-state and writes nothing when no state file exists", () => {
    const result = advancePhase("gating", {
      slug: "ghost",
      dir: stateDir,
      publish: noopPublish,
    });
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
      publish: noopPublish,
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
      publish: noopPublish,
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
        publish: noopPublish,
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
        publish: noopPublish,
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

describe("FIX_LOOP_REENTRY_TRANSITIONS / isFixLoopReentry", () => {
  it("is exactly the two named edges", () => {
    expect(FIX_LOOP_REENTRY_TRANSITIONS).toEqual({
      "ci-wait": ["implementing"],
      reviewing: ["ci-wait"],
    });
  });

  it("isFixLoopReentry reflects the table both ways", () => {
    expect(isFixLoopReentry("ci-wait", "implementing")).toBe(true);
    expect(isFixLoopReentry("reviewing", "ci-wait")).toBe(true);
    expect(isFixLoopReentry("gating", "verifying")).toBe(false);
    expect(isFixLoopReentry("ci-wait", "reviewing")).toBe(false);
  });
});

describe("advancePhase — fix-loop re-entry (backward allowance)", () => {
  it("permits ci-wait -> implementing when expectPr matches", () => {
    seedState("r1", "ci-wait", { pr: 5 });
    const result = advancePhase("implementing", {
      slug: "r1",
      dir: stateDir,
      publish: noopPublish,
      expectPr: 5,
    });
    expect(result).toEqual({
      advanced: true,
      reason: "reentered",
      from: "ci-wait",
      to: "implementing",
    });
    const state = readState("r1", stateDir);
    expect(state?.phase).toBe("implementing");
    expect(state?.phaseLog).toHaveLength(1);
  });

  it("permits the same edge from the anchored ci-wait-pending seed (proves the anchored lookup)", () => {
    seedState("r2", "ci-wait-pending", { pr: 5 });
    const result = advancePhase("implementing", {
      slug: "r2",
      dir: stateDir,
      publish: noopPublish,
      expectPr: 5,
    });
    expect(result).toEqual({
      advanced: true,
      reason: "reentered",
      from: "ci-wait-pending",
      to: "implementing",
    });
    expect(readState("r2", stateDir)?.phase).toBe("implementing");
  });

  it("permits reviewing -> ci-wait when expectPr matches", () => {
    seedState("r3", "reviewing", { pr: 5 });
    const result = advancePhase("ci-wait", {
      slug: "r3",
      dir: stateDir,
      publish: noopPublish,
      expectPr: 5,
    });
    expect(result).toEqual({
      advanced: true,
      reason: "reentered",
      from: "reviewing",
      to: "ci-wait",
    });
    expect(readState("r3", stateDir)?.phase).toBe("ci-wait");
  });

  it("refuses a table-listed backward edge with no expectPr", () => {
    seedState("r4", "ci-wait");
    const result = advancePhase("implementing", {
      slug: "r4",
      dir: stateDir,
      publish: noopPublish,
    });
    expect(result.reason).toBe("already-at-or-past");
    expect(result.advanced).toBe(false);
    expect(readState("r4", stateDir)?.phase).toBe("ci-wait");
  });

  it("refuses a backward move with a mismatched expectPr (pr-mismatch guard fires before the reentry check)", () => {
    // The pr-mismatch guard (bin/lib/phase-advance.ts's existing guard
    // chain, unchanged by this task) runs BEFORE the index/backward
    // comparison, so a mismatched expectPr never reaches the
    // isFixLoopReentry lookup at all — it is refused earlier, under
    // "pr-mismatch" rather than "already-at-or-past".
    seedState("r5", "ci-wait", { pr: 5 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = advancePhase("implementing", {
      slug: "r5",
      dir: stateDir,
      publish: noopPublish,
      expectPr: 99,
    });
    expect(result.reason).toBe("pr-mismatch");
    expect(result.advanced).toBe(false);
    expect(readState("r5", stateDir)?.phase).toBe("ci-wait");
    errorSpy.mockRestore();
  });

  it("refuses a backward pair outside the table even with a matching expectPr", () => {
    seedState("r6", "gating", { pr: 5 });
    const result = advancePhase("verifying", {
      slug: "r6",
      dir: stateDir,
      publish: noopPublish,
      expectPr: 5,
    });
    expect(result.reason).toBe("already-at-or-past");
    expect(result.advanced).toBe(false);
    expect(readState("r6", stateDir)?.phase).toBe("gating");
  });

  it("refuses a table-keyed 'from' moving to a target not listed for it", () => {
    seedState("r7", "reviewing", { pr: 5 });
    // "reviewing" is a table key, but only for -> "ci-wait", not -> "implementing".
    const result = advancePhase("implementing", {
      slug: "r7",
      dir: stateDir,
      publish: noopPublish,
      expectPr: 5,
    });
    expect(result.reason).toBe("already-at-or-past");
    expect(readState("r7", stateDir)?.phase).toBe("reviewing");
  });
});

describe("finalizePhase", () => {
  it.each(["merged", "gated", "needs-human", "cancelled"] as const)(
    "writes the %s terminal phase from a non-terminal state",
    (target) => {
      seedState(`f-${target}`, "gating");
      const result = finalizePhase(target, {
        slug: `f-${target}`,
        dir: stateDir,
        publish: noopPublish,
      });
      expect(result).toEqual({
        advanced: true,
        reason: "finalized",
        from: "gating",
        to: target,
      });
      const state = readState(`f-${target}`, stateDir);
      expect(state?.phase).toBe(target);
      expect(state?.phaseLog).toHaveLength(1);
    },
  );

  it("no-ops (already-terminal) on a re-render of an already-terminal pipeline and appends no second phaseLog entry", () => {
    seedState("f-idem", "merged");
    const result = finalizePhase("merged", {
      slug: "f-idem",
      dir: stateDir,
      publish: noopPublish,
    });
    expect(result).toEqual({
      advanced: false,
      reason: "already-terminal",
      from: "merged",
      to: "merged",
    });
    expect(readState("f-idem", stateDir)?.phaseLog ?? []).toHaveLength(0);
  });

  it("permits gated -> merged (gated is awaiting-human, not finished)", () => {
    seedState("f-gm", "gated");
    const result = finalizePhase("merged", {
      slug: "f-gm",
      dir: stateDir,
      publish: noopPublish,
    });
    expect(result.advanced).toBe(true);
    expect(readState("f-gm", stateDir)?.phase).toBe("merged");
  });

  it("refuses merged -> gated (merged is a finished phase)", () => {
    seedState("f-mg", "merged");
    const result = finalizePhase("gated", {
      slug: "f-mg",
      dir: stateDir,
      publish: noopPublish,
    });
    expect(result).toEqual({
      advanced: false,
      reason: "finished",
      from: "merged",
      to: "gated",
    });
    expect(readState("f-mg", stateDir)?.phase).toBe("merged");
  });

  it("refuses cancelled -> merged (cancelled is a finished phase)", () => {
    seedState("f-cm", "cancelled");
    const result = finalizePhase("merged", {
      slug: "f-cm",
      dir: stateDir,
      publish: noopPublish,
    });
    expect(result.reason).toBe("finished");
    expect(readState("f-cm", stateDir)?.phase).toBe("cancelled");
  });

  it("is a no-op on an epic-* phase", () => {
    seedState("f-epic", "epic-designing");
    const result = finalizePhase("cancelled", {
      slug: "f-epic",
      dir: stateDir,
      publish: noopPublish,
    });
    expect(result.reason).toBe("epic-phase");
    expect(readState("f-epic", stateDir)?.phase).toBe("epic-designing");
  });

  it("refuses a mismatched-PR finalize (FLOW_SLUG leak guard) and emits one stderr NOTICE", () => {
    seedState("f-pr", "gating", { pr: 42 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = finalizePhase("merged", {
      slug: "f-pr",
      dir: stateDir,
      publish: noopPublish,
      expectPr: 99,
    });
    expect(result.reason).toBe("pr-mismatch");
    expect(readState("f-pr", stateDir)?.phase).toBe("gating");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("returns no-slug and writes nothing when no slug resolves", () => {
    const result = finalizePhase("merged", {
      slug: null,
      dir: stateDir,
      publish: noopPublish,
      resolveSlug: () => null,
    });
    expect(result).toEqual({
      advanced: false,
      reason: "no-slug",
      to: "merged",
    });
  });

  it("returns no-state and writes nothing when no state file exists", () => {
    const result = finalizePhase("merged", {
      slug: "ghost",
      dir: stateDir,
      publish: noopPublish,
    });
    expect(result).toEqual({
      advanced: false,
      reason: "no-state",
      to: "merged",
    });
  });

  it("refuses to finalize and returns branch-mismatch when the worktree is on the wrong branch", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "finalize-phase-guard-"),
    );
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
      seedState("f-branch", "gating", { worktree });
      const result = finalizePhase("merged", {
        slug: "f-branch",
        dir: stateDir,
        publish: noopPublish,
        resolveSlug: () => null,
      });
      expect(result).toEqual({
        advanced: false,
        reason: "branch-mismatch",
        from: "gating",
        to: "merged",
      });
      expect(readState("f-branch", stateDir)?.phase).toBe("gating");
    } finally {
      errSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("TERMINAL_PHASE_EMITTERS", () => {
  it("names flow-gate-summary as the emitter for all four terminal phases", () => {
    expect(TERMINAL_PHASE_EMITTERS).toEqual({
      merged: "flow-gate-summary",
      gated: "flow-gate-summary",
      "needs-human": "flow-gate-summary",
      cancelled: "flow-gate-summary",
    });
  });
});

describe("phase publish — the regression this task exists to close: a phase written by a side-effect helper path (not flow-state-update) must publish the mirror", () => {
  it("advancePhase publishes exactly (slug, target) on a real forward advance", () => {
    seedState("pub-1", "verifying");
    const published: Array<[string, string]> = [];
    const result = advancePhase("ci-wait", {
      slug: "pub-1",
      dir: stateDir,
      publish: (slug, phase) => published.push([slug, phase]),
    });
    expect(result.advanced).toBe(true);
    expect(published).toEqual([["pub-1", "ci-wait"]]);
  });

  it("finalizePhase publishes exactly (slug, target) on a terminal write", () => {
    seedState("pub-2", "gating");
    const published: Array<[string, string]> = [];
    const result = finalizePhase("merged", {
      slug: "pub-2",
      dir: stateDir,
      publish: (slug, phase) => published.push([slug, phase]),
    });
    expect(result.advanced).toBe(true);
    expect(published).toEqual([["pub-2", "merged"]]);
  });

  it("publishes on a `reentered` fix-loop backward edge (ci-wait -> implementing)", () => {
    seedState("pub-3", "ci-wait", { pr: 5 });
    const published: Array<[string, string]> = [];
    const result = advancePhase("implementing", {
      slug: "pub-3",
      dir: stateDir,
      expectPr: 5,
      publish: (slug, phase) => published.push([slug, phase]),
    });
    expect(result.reason).toBe("reentered");
    expect(published).toEqual([["pub-3", "implementing"]]);
  });

  it("does not publish on already-at-or-past (refused advance)", () => {
    seedState("pub-neg-1", "merging");
    const published: Array<[string, string]> = [];
    const result = advancePhase("gating", {
      slug: "pub-neg-1",
      dir: stateDir,
      publish: (slug, phase) => published.push([slug, phase]),
    });
    expect(result.reason).toBe("already-at-or-past");
    expect(published).toEqual([]);
  });

  it("does not publish on branch-mismatch (refused write)", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "phase-advance-publish-guard-"),
    );
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
      seedState("pub-neg-2", "implementing", { worktree });
      const published: Array<[string, string]> = [];
      const result = advancePhase("ci-wait", {
        slug: "pub-neg-2",
        dir: stateDir,
        resolveSlug: () => null,
        publish: (slug, phase) => published.push([slug, phase]),
      });
      expect(result.reason).toBe("branch-mismatch");
      expect(published).toEqual([]);
    } finally {
      errSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not publish on pr-mismatch (refused write)", () => {
    seedState("pub-neg-3", "reviewing", { pr: 42 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const published: Array<[string, string]> = [];
    const result = advancePhase("gating", {
      slug: "pub-neg-3",
      dir: stateDir,
      expectPr: 99,
      publish: (slug, phase) => published.push([slug, phase]),
    });
    expect(result.reason).toBe("pr-mismatch");
    expect(published).toEqual([]);
    errorSpy.mockRestore();
  });

  it("does not publish on no-state (no state file to advance)", () => {
    const published: Array<[string, string]> = [];
    const result = advancePhase("gating", {
      slug: "pub-neg-4",
      dir: stateDir,
      publish: (slug, phase) => published.push([slug, phase]),
    });
    expect(result.reason).toBe("no-state");
    expect(published).toEqual([]);
  });

  it("does not publish on epic-phase (refused write)", () => {
    seedState("pub-neg-5", "epic-designing");
    const published: Array<[string, string]> = [];
    const result = advancePhase("gating", {
      slug: "pub-neg-5",
      dir: stateDir,
      publish: (slug, phase) => published.push([slug, phase]),
    });
    expect(result.reason).toBe("epic-phase");
    expect(published).toEqual([]);
  });
});
