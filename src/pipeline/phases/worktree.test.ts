import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureOrchestratorSymlink, ensureWorktreeInstalls } from "./worktree.js";

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

describe("ensureWorktreeInstalls", () => {
  let tmp: string;
  let worktree: string;
  // installScripts / installSkills log to stderr via console.error; silence
  // those during tests so the vitest output stays readable. The error path
  // is verified by inspecting the returned PhaseResult, not stderr.
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-worktree-install-"));
    worktree = path.join(tmp, "worktree");
    await fs.mkdir(worktree, { recursive: true });
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("populates scripts/ and .claude/skills/ with symlinks (happy path)", async () => {
    const result = await ensureWorktreeInstalls(worktree);
    expect(result.status).toBe("ok");

    // Every templates/scripts/*.ts (excluding *.test.ts) is now linked under
    // scripts/. Spot-check ci-wait — that's the script the failing user
    // report identified, and the canonical regression case.
    const ciWait = path.join(worktree, "scripts", "ci-wait.ts");
    const ciWaitStat = await fs.lstat(ciWait);
    expect(ciWaitStat.isSymbolicLink()).toBe(true);

    // .claude/skills/ has at least the pipeline skills the orchestrator
    // depends on. Spot-check the verify skill.
    const verifySkill = path.join(worktree, ".claude", "skills", "verify");
    const verifyStat = await fs.lstat(verifySkill);
    expect(verifyStat.isSymbolicLink() || verifyStat.isDirectory()).toBe(true);
  });

  it("is idempotent — second call leaves existing symlinks unchanged", async () => {
    expect((await ensureWorktreeInstalls(worktree)).status).toBe("ok");
    const before = await fs.lstat(path.join(worktree, "scripts", "ci-wait.ts"));
    expect((await ensureWorktreeInstalls(worktree)).status).toBe("ok");
    const after = await fs.lstat(path.join(worktree, "scripts", "ci-wait.ts"));
    // Same inode means the symlink wasn't unlinked + recreated. Important:
    // installScripts without --force leaves a correct symlink in place.
    expect(after.ino).toBe(before.ino);
  });

  it("preserves a user-customised real file at a script path (no --force)", async () => {
    // Pre-place a real file where a symlink would otherwise go. The default
    // install (no --force) reports it as `blocked`, leaves the file alone,
    // and still completes for every other script. The helper returns ok.
    const scriptsDir = path.join(worktree, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    const customPath = path.join(scriptsDir, "ci-wait.ts");
    const customContent = "// user-customised override\n";
    await fs.writeFile(customPath, customContent);

    const result = await ensureWorktreeInstalls(worktree);
    expect(result.status).toBe("ok");

    // Real file untouched.
    const stat = await fs.lstat(customPath);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(await fs.readFile(customPath, "utf8")).toBe(customContent);

    // Other scripts still installed.
    const fetchPr = await fs.lstat(
      path.join(scriptsDir, "fetch-pr-review.ts"),
    );
    expect(fetchPr.isSymbolicLink()).toBe(true);
  });

  it("returns a controlled failure when the install cannot proceed", async () => {
    // Pre-place a regular file at <worktree>/scripts so fs.mkdir({
    // recursive: true }) inside installScripts throws EEXIST/ENOTDIR. The
    // helper's try/catch must surface that as PhaseResult.failed rather
    // than letting it escape past the phase boundary.
    const blocker = path.join(worktree, "scripts");
    await fs.writeFile(blocker, "not a directory");

    const result = await ensureWorktreeInstalls(worktree);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain(worktree);
      expect(result.reason).toContain("install");
    }
  });
});
