import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it } from "vitest";
import { branchChangedFiles, changedSinceCommit } from "./ui-review-diff";

type Call = { args: string[]; cwd?: string };

function fakeSpawn(
  responder: (args: string[]) => { status: number; stdout?: string },
) {
  const calls: Call[] = [];
  const spawn = (_cmd: string, args: string[], options: { cwd?: string }) => {
    calls.push({ args, cwd: options.cwd });
    const r = responder(args);
    return {
      status: r.status,
      stdout: r.stdout ?? "",
      stderr: "",
    } as SpawnSyncReturns<string>;
  };
  return { spawn, calls };
}

describe("branchChangedFiles", () => {
  it("diffs against origin/<prBase> when the base is given", () => {
    const { spawn, calls } = fakeSpawn(() => ({
      status: 0,
      stdout: "a.svelte\nb.ts\n",
    }));
    expect(branchChangedFiles("/w", "release", { spawn })).toEqual([
      "a.svelte",
      "b.ts",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      "diff",
      "--name-only",
      "origin/release...HEAD",
    ]);
    expect(calls[0].cwd).toBe("/w");
  });

  it("falls back to the resolved default branch without a base", () => {
    const { spawn, calls } = fakeSpawn((args) =>
      args[0] === "symbol-ref" || args[0] === "symbolic-ref"
        ? { status: 0, stdout: "refs/remotes/origin/trunk\n" }
        : { status: 0, stdout: "x.css\n" },
    );
    expect(branchChangedFiles("/w", undefined, { spawn })).toEqual(["x.css"]);
    expect(calls[calls.length - 1].args[2]).toBe("origin/trunk...HEAD");
  });

  it("returns null when git fails", () => {
    const { spawn } = fakeSpawn(() => ({ status: 128 }));
    expect(branchChangedFiles("/w", "main", { spawn })).toBeNull();
  });

  it("returns null when no default branch resolves", () => {
    const { spawn } = fakeSpawn(() => ({ status: 1 }));
    expect(branchChangedFiles("/w", null, { spawn })).toBeNull();
  });
});

describe("changedSinceCommit", () => {
  it("diffs the recorded commit against HEAD", () => {
    const { spawn, calls } = fakeSpawn(() => ({
      status: 0,
      stdout: "a.svelte\n",
    }));
    expect(changedSinceCommit("/w", "abc123", { spawn })).toEqual(["a.svelte"]);
    expect(calls[0].args[2]).toBe("abc123...HEAD");
  });

  it("returns null when the commit is unreadable", () => {
    const { spawn } = fakeSpawn(() => ({ status: 128 }));
    expect(changedSinceCommit("/w", "abc123", { spawn })).toBeNull();
  });
});
