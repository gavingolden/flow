import { describe, expect, it } from "vitest";
import {
  WORKTREE_CONTAINER_NAME,
  worktreeContainerDir,
  worktreeDirFor,
} from "./worktree-slot";

describe("worktreeContainerDir", () => {
  it("puts the container beside the main checkout", () => {
    expect(worktreeContainerDir("/code/repo")).toBe(
      `/code/${WORKTREE_CONTAINER_NAME}`,
    );
  });

  it("reuses the container when launched from inside a container worktree", () => {
    const inner = `/code/${WORKTREE_CONTAINER_NAME}/repo-feat`;
    expect(worktreeContainerDir(inner)).toBe(
      `/code/${WORKTREE_CONTAINER_NAME}`,
    );
    expect(worktreeDirFor(inner, "x")).toBe(
      `/code/${WORKTREE_CONTAINER_NAME}/repo-feat-x`,
    );
  });
});
