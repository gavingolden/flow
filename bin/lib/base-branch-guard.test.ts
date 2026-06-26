import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BASE_BRANCH_GUARD_HOOK,
  baseBranchGuardDecision,
  installBaseBranchGuard,
} from "./base-branch-guard";

describe("baseBranchGuardDecision", () => {
  it("refuses when both session markers are set AND HEAD is the default branch", () => {
    expect(
      baseBranchGuardDecision({
        sessionId: "sess-1",
        flowSlug: "csv-export",
        currentBranch: "main",
        defaultBranch: "main",
      }),
    ).toBe("refuse");
  });

  it("allows when the session id is missing (the user's own manual commit)", () => {
    expect(
      baseBranchGuardDecision({
        flowSlug: "csv-export",
        currentBranch: "main",
        defaultBranch: "main",
      }),
    ).toBe("allow");
  });

  it("allows when the flow-slug pane marker is missing (a hand-driven Claude session)", () => {
    expect(
      baseBranchGuardDecision({
        sessionId: "sess-1",
        currentBranch: "main",
        defaultBranch: "main",
      }),
    ).toBe("allow");
  });

  it("allows when on a feature branch even with both markers set", () => {
    expect(
      baseBranchGuardDecision({
        sessionId: "sess-1",
        flowSlug: "csv-export",
        currentBranch: "feature/csv-export",
        defaultBranch: "main",
      }),
    ).toBe("allow");
  });
});

describe("installBaseBranchGuard", () => {
  let repoDir!: string;
  let errors!: string[];

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-bbg-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const hookPath = () => path.join(repoDir, ".git", "hooks", "pre-commit");

  it("installs when there is no pre-commit hook and no core.hooksPath", () => {
    const result = installBaseBranchGuard(repoDir);
    expect(result).toEqual({ installed: true, reason: "installed" });
    expect(fs.existsSync(hookPath())).toBe(true);
    expect(fs.readFileSync(hookPath(), "utf8")).toBe(BASE_BRANCH_GUARD_HOOK);
    // Executable for the owner — git only runs an executable hook.
    expect(fs.statSync(hookPath()).mode & 0o111).not.toBe(0);
  });

  it("skips + warns when a different pre-commit hook already exists (never clobbers)", () => {
    const sentinel = "#!/bin/sh\n# user's own hook\nexit 0\n";
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath(), sentinel, "utf8");

    const result = installBaseBranchGuard(repoDir);
    expect(result).toEqual({ installed: false, reason: "exists" });
    // The user's hook is left untouched.
    expect(fs.readFileSync(hookPath(), "utf8")).toBe(sentinel);
    expect(errors.join("\n")).toMatch(/existing pre-commit hook present/);
  });

  it("skips when the repo configures core.hooksPath", () => {
    const customHooks = path.join(repoDir, "my-hooks");
    fs.mkdirSync(customHooks, { recursive: true });
    execFileSync("git", ["config", "core.hooksPath", customHooks], {
      cwd: repoDir,
    });

    const result = installBaseBranchGuard(repoDir);
    expect(result).toEqual({ installed: false, reason: "hooks-path" });
    // No pre-commit written into the default hooks dir.
    expect(fs.existsSync(hookPath())).toBe(false);
    expect(errors.join("\n")).toMatch(/configures core\.hooksPath/);
  });

  it("is idempotent — a second install over our own hook is a no-op", () => {
    const first = installBaseBranchGuard(repoDir);
    expect(first).toEqual({ installed: true, reason: "installed" });
    const contentAfterFirst = fs.readFileSync(hookPath(), "utf8");

    const second = installBaseBranchGuard(repoDir);
    expect(second).toEqual({ installed: true, reason: "idempotent" });
    expect(fs.readFileSync(hookPath(), "utf8")).toBe(contentAfterFirst);
    expect(fs.readFileSync(hookPath(), "utf8")).toBe(BASE_BRANCH_GUARD_HOOK);
  });
});

// Exercises the emitted sh hook through a REAL `git commit`. The hook's only
// non-git dependency is `tmux show-options ... @flow-slug`, so a tiny `tmux`
// PATH shim stands in for a live tmux server — that is the single seam between
// the unit-tested decision function and the actual per-commit behaviour.
describe("BASE_BRANCH_GUARD_HOOK (integration: real git commit)", () => {
  let repoDir!: string;
  let shimDir!: string;

  const writeTmuxShim = (slug: string) => {
    const p = path.join(shimDir, "tmux");
    fs.writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "${slug}"\n`, "utf8");
    fs.chmodSync(p, 0o755);
  };

  type Env = Record<string, string | undefined>;

  // Base env with the ambient flow-session markers stripped (this very test
  // process runs inside one), so each case opts INTO exactly the markers it
  // needs. shimDir is prefixed so the `tmux` shim wins while real `git`/`sh`
  // still resolve from the rest of PATH.
  const baseEnv = (): Env => {
    const env: Env = {
      ...(process.env as Env),
      PATH: `${shimDir}:${process.env.PATH}`,
    };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.TMUX_PANE;
    return env;
  };

  const tryCommit = (
    env: Env,
    file: string,
  ): { ok: boolean; stderr: string } => {
    fs.writeFileSync(path.join(repoDir, file), `${file}\n`, "utf8");
    execFileSync("git", ["add", file], { cwd: repoDir });
    try {
      execFileSync("git", ["commit", "-m", `add ${file}`], {
        cwd: repoDir,
        encoding: "utf8",
        env: env as NodeJS.ProcessEnv,
      });
      return { ok: true, stderr: "" };
    } catch (err) {
      const e = err as { stderr?: Buffer | string };
      return { ok: false, stderr: String(e.stderr ?? "") };
    }
  };

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-bbg-hook-"));
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-bbg-shim-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "t@example.com"], {
      cwd: repoDir,
    });
    execFileSync("git", ["config", "user.name", "Flow Test"], { cwd: repoDir });
    installBaseBranchGuard(repoDir);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
  });

  it("refuses a default-branch commit inside a flow session", () => {
    writeTmuxShim("csv-export");
    const r = tryCommit(
      { ...baseEnv(), CLAUDE_CODE_SESSION_ID: "sess-1", TMUX_PANE: "%1" },
      "a.txt",
    );
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/refusing to commit on the base branch/);
  });

  it("allows a feature-branch commit inside a flow session", () => {
    writeTmuxShim("csv-export");
    execFileSync("git", ["checkout", "-b", "feature/csv-export"], {
      cwd: repoDir,
    });
    const r = tryCommit(
      { ...baseEnv(), CLAUDE_CODE_SESSION_ID: "sess-1", TMUX_PANE: "%1" },
      "b.txt",
    );
    expect(r.ok).toBe(true);
  });

  it("allows a default-branch commit outside a flow session (no session id)", () => {
    writeTmuxShim("csv-export");
    const r = tryCommit({ ...baseEnv(), TMUX_PANE: "%1" }, "c.txt");
    expect(r.ok).toBe(true);
  });

  it("allows a default-branch commit when the pane carries no @flow-slug", () => {
    writeTmuxShim(""); // empty slug → guard is inert
    const r = tryCommit(
      { ...baseEnv(), CLAUDE_CODE_SESSION_ID: "sess-1", TMUX_PANE: "%1" },
      "d.txt",
    );
    expect(r.ok).toBe(true);
  });
});
