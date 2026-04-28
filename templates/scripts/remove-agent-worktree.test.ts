/**
 * Tests for remove-agent-worktree.ts
 */

import { describe, expect, it } from "vitest";
import { parseWorktreeListOutput } from "./remove-agent-worktree";

// --- parseWorktreeListOutput ---

describe(parseWorktreeListOutput, () => {
  it("should parse a single worktree entry", () => {
    const raw = [
      "worktree /Users/me/code/flow",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
    ].join("\n");

    const entries = parseWorktreeListOutput(raw);
    expect(entries).toEqual([{ path: "/Users/me/code/flow", branch: "main" }]);
  });

  it("should parse multiple worktree entries", () => {
    const raw = [
      "worktree /Users/me/code/flow",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /Users/me/code/flow-feature-foo",
      "HEAD def456",
      "branch refs/heads/feature/foo",
      "",
    ].join("\n");

    const entries = parseWorktreeListOutput(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      path: "/Users/me/code/flow",
      branch: "main",
    });
    expect(entries[1]).toEqual({
      path: "/Users/me/code/flow-feature-foo",
      branch: "feature/foo",
    });
  });

  it("should strip refs/heads/ prefix from branch names", () => {
    const raw = ["worktree /repo", "branch refs/heads/agent/improve-tooltips", ""].join("\n");

    const entries = parseWorktreeListOutput(raw);
    expect(entries[0].branch).toBe("agent/improve-tooltips");
  });

  it("should handle bare worktree entries", () => {
    const raw = ["worktree /repo.git", "bare", ""].join("\n");

    const entries = parseWorktreeListOutput(raw);
    expect(entries).toEqual([{ path: "/repo.git", bare: true }]);
  });

  it("should handle entries without a trailing blank line", () => {
    const raw = ["worktree /repo", "branch refs/heads/main"].join("\n");

    const entries = parseWorktreeListOutput(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ path: "/repo", branch: "main" });
  });

  it("should return empty array for empty input", () => {
    expect(parseWorktreeListOutput("")).toEqual([]);
  });

  it("should handle detached HEAD entries (no branch line)", () => {
    const raw = ["worktree /repo", "HEAD abc123", "detached", ""].join("\n");

    const entries = parseWorktreeListOutput(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("/repo");
    expect(entries[0].branch).toBeUndefined();
  });
});
