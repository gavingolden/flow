/**
 * Tests for new-agent-worktree.ts
 */

import { describe, expect, it } from "vitest";
import { SYMLINK_FILES, toDirSuffix } from "./new-agent-worktree";

describe(toDirSuffix, () => {
  it("should replace slashes with hyphens", () => {
    expect(toDirSuffix("feature/new-chart")).toBe("feature-new-chart");
  });

  it("should handle multiple slashes", () => {
    expect(toDirSuffix("scope/area/task")).toBe("scope-area-task");
  });

  it("should return unchanged string when no slashes", () => {
    expect(toDirSuffix("simple-branch")).toBe("simple-branch");
  });

  it("should handle trailing slash", () => {
    expect(toDirSuffix("feature/")).toBe("feature-");
  });

  it("should handle leading slash", () => {
    expect(toDirSuffix("/feature")).toBe("-feature");
  });
});

describe("SYMLINK_FILES", () => {
  it("should include .env", () => {
    expect(SYMLINK_FILES).toContain(".env");
  });

  it("should include .claude/settings.local.json", () => {
    expect(SYMLINK_FILES).toContain(".claude/settings.local.json");
  });
});
