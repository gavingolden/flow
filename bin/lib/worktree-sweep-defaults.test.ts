import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.fn();
vi.mock("node:child_process", () => ({ spawnSync }));

const {
  cleanChildEnv,
  realRun,
  removeScriptPath,
  removeViaScript,
  REMOVE_TIMEOUT_MS,
} = await import("./worktree-sweep-defaults");

afterEach(() => spawnSync.mockReset());

describe("removeViaScript", () => {
  it("runs the module-relative remover from the main checkout with a 120 s timeout and no pipeline identity", () => {
    spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    vi.stubEnv("FLOW_SLUG", "parent");
    vi.stubEnv("TMUX_PANE", "%1");

    const r = removeViaScript("/code/repo-a", "/code/repo", true);

    const [cmd, args, opts] = spawnSync.mock.calls[0];
    expect(r.ok).toBe(true);
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual([
      removeScriptPath(),
      "/code/repo-a",
      "--delete-branch",
    ]);
    expect(path.basename(removeScriptPath())).toBe("flow-remove-worktree.ts");
    expect(opts.cwd).toBe("/code/repo");
    expect(opts.timeout).toBe(REMOVE_TIMEOUT_MS);
    expect(REMOVE_TIMEOUT_MS).toBe(120_000);
    expect(opts.env.FLOW_SLUG).toBeUndefined();
    expect(opts.env.TMUX_PANE).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("omits --delete-branch for a closed PR and reports a failed removal with its message", () => {
    spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "has changes" });
    const r = removeViaScript("/code/repo-a", "/code/repo", false);
    expect(spawnSync.mock.calls[0][1]).toEqual([
      removeScriptPath(),
      "/code/repo-a",
    ]);
    expect(r).toEqual({ ok: false, message: "has changes" });
  });
});

describe("realRun", () => {
  it("maps a timeout and a missing binary to distinct results", () => {
    spawnSync.mockReturnValueOnce({
      status: null,
      error: { code: "ETIMEDOUT" },
    });
    expect(realRun("gh", [], { timeoutMs: 1 }).timedOut).toBe(true);
    spawnSync.mockReturnValueOnce({ status: null, error: { code: "ENOENT" } });
    const r = realRun("docker", [], { timeoutMs: 1 });
    expect(r).toMatchObject({ status: null, timedOut: false });
  });
});

describe("cleanChildEnv", () => {
  it("drops FLOW_SLUG and TMUX_PANE and keeps the rest", () => {
    expect(
      cleanChildEnv({ FLOW_SLUG: "a", TMUX_PANE: "%1", PATH: "/bin" }),
    ).toEqual({
      PATH: "/bin",
    });
  });
});
