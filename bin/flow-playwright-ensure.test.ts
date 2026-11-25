import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run, type EnsureCliDeps } from "./flow-playwright-ensure";
import type { EnsureResult } from "./lib/playwright-browsers";

function result(over: Partial<EnsureResult>): EnsureResult {
  return {
    outcome: "present",
    reason: null,
    revision: "1255",
    packageVersion: "@playwright/test 1.65.1",
    durationMs: 12_000,
    ...over,
  };
}

function setup(r: EnsureResult) {
  const out: string[] = [];
  const err: string[] = [];
  const ensure = vi.fn(async () => r);
  const deps: EnsureCliDeps = {
    ensure,
    print: (l) => out.push(l),
    printErr: (l) => err.push(l),
  };
  return { deps, ensure, out, err };
}

describe("flow-playwright-ensure", () => {
  it("prints the line when it installed", async () => {
    const { deps, out } = setup(result({ outcome: "installed" }));
    expect(await run([], deps)).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("installed chromium build 1255");
  });

  it("prints nothing when the build is present", async () => {
    const { deps, out, err } = setup(result({ outcome: "present" }));
    expect(await run([], deps)).toBe(0);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  it("exits 0 and says so when the install failed", async () => {
    const { deps, out } = setup(
      result({ outcome: "failed", reason: "install-timeout" }),
    );
    expect(await run([], deps)).toBe(0);
    expect(out[0]).toContain("not installed (the download timed out)");
  });

  it("exits 2 with usage on an unknown argument", async () => {
    const { deps, err, ensure } = setup(result({}));
    expect(await run(["--bogus"], deps)).toBe(2);
    expect(err.join("\n")).toContain("usage: flow-playwright-ensure");
    expect(ensure).not.toHaveBeenCalled();
  });

  it("exits 2 when --worktree has no value", async () => {
    const { deps, err } = setup(result({}));
    expect(await run(["--worktree"], deps)).toBe(2);
    expect(err.join("\n")).toContain("usage:");
  });

  it("honours --worktree", async () => {
    const { deps, ensure } = setup(result({}));
    await run(["--worktree", "/some/wt"], deps);
    expect(ensure).toHaveBeenCalledWith(path.resolve("/some/wt"));
  });

  it("defaults to the current directory", async () => {
    const { deps, ensure } = setup(result({}));
    await run([], deps);
    expect(ensure).toHaveBeenCalledWith(process.cwd());
  });
});
