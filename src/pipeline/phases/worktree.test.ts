import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureOrchestratorSymlink } from "./worktree.js";

describe("ensureOrchestratorSymlink", () => {
  let tmp: string;
  let mainRepo: string;
  let worktree: string;
  let target: string;
  let linkPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-symlink-"));
    mainRepo = path.join(tmp, "main");
    worktree = path.join(tmp, "worktree");
    await fs.mkdir(path.join(mainRepo, ".orchestrator", "tasks"), {
      recursive: true,
    });
    await fs.mkdir(worktree, { recursive: true });
    target = path.join(mainRepo, ".orchestrator");
    linkPath = path.join(worktree, ".orchestrator");
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("creates the symlink when nothing exists at the path", async () => {
    const result = await ensureOrchestratorSymlink(worktree, mainRepo);
    expect(result.status).toBe("ok");
    const stat = await fs.lstat(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await fs.readlink(linkPath)).toBe(target);
  });

  it("leaves an existing correct symlink untouched (idempotent)", async () => {
    expect((await ensureOrchestratorSymlink(worktree, mainRepo)).status).toBe(
      "ok",
    );
    const firstStat = await fs.lstat(linkPath);
    expect((await ensureOrchestratorSymlink(worktree, mainRepo)).status).toBe(
      "ok",
    );
    const secondStat = await fs.lstat(linkPath);
    expect(secondStat.ino).toBe(firstStat.ino);
  });

  it("replaces a wrong-target symlink", async () => {
    const otherTarget = path.join(tmp, "other-orchestrator");
    await fs.mkdir(otherTarget, { recursive: true });
    // Pre-existing symlink pointing at the wrong place.
    await fs.symlink(otherTarget, linkPath, "dir");
    const result = await ensureOrchestratorSymlink(worktree, mainRepo);
    expect(result.status).toBe("ok");
    expect(await fs.readlink(linkPath)).toBe(target);
  });

  it("refuses to overwrite a regular file at the symlink path", async () => {
    await fs.writeFile(linkPath, "preexisting content");
    const result = await ensureOrchestratorSymlink(worktree, mainRepo);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain(linkPath);
      expect(result.reason).toContain("not a symlink");
    }
  });

  it("refuses to overwrite a regular directory at the symlink path", async () => {
    await fs.mkdir(linkPath);
    await fs.writeFile(path.join(linkPath, "stash"), "x");
    const result = await ensureOrchestratorSymlink(worktree, mainRepo);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("not a symlink");
    }
  });

  it("returns a controlled failure when the worktree directory does not exist", async () => {
    // Parent dir missing → fs.symlink throws ENOENT. The wrapper must convert
    // it into a PhaseResult instead of letting it escape.
    const missingWorktree = path.join(tmp, "does-not-exist");
    const result = await ensureOrchestratorSymlink(missingWorktree, mainRepo);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("orchestrator symlink");
    }
  });
});
