import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveRepoRoot } from "./repo-root";

describe("resolveRepoRoot", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-repo-root-"));
    spawnSync("git", ["init", "-q"], { cwd: repoDir });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns the repo toplevel for a path inside a git repo", () => {
    const nested = path.join(repoDir, "nested");
    fs.mkdirSync(nested);
    const resolved = resolveRepoRoot(nested);
    // Resolve both sides through fs.realpathSync to tolerate macOS's
    // /tmp -> /private/tmp symlink, which `git rev-parse --show-toplevel`
    // reports as the realpath.
    expect(resolved).toBe(fs.realpathSync(repoDir));
  });

  it("returns null when the path is not inside a git repo", () => {
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-repo-root-outside-"),
    );
    try {
      expect(resolveRepoRoot(outside)).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("returns null when git exits non-zero (e.g. a nonexistent cwd)", () => {
    const missing = path.join(repoDir, "does-not-exist");
    expect(resolveRepoRoot(missing)).toBeNull();
  });

  it("returns null when the resolved toplevel does not exist", () => {
    // Exercises the `!fs.existsSync(out)` guard specifically — a status-0
    // git run whose reported toplevel is missing, distinct from the
    // status-non-zero branch the two cases above already cover.
    const ghost = path.join(repoDir, "ghost-worktree");
    spawnSync("git", ["config", "core.worktree", ghost], { cwd: repoDir });
    const probe = spawnSync(
      "git",
      ["-C", repoDir, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    );
    if (probe.status !== 0) {
      // Local git disagrees on reporting a missing core.worktree verbatim;
      // skip rather than fail for the wrong reason.
      return;
    }
    expect(resolveRepoRoot(repoDir)).toBeNull();
  });
});
