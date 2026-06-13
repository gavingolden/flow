/**
 * Tests for bin/flow-release.ts — the maintainer-only release helper.
 *
 * A scripted Spawner stub (mirroring update-check.test.ts / git.test.ts)
 * returns canned SpawnSyncReturns per command, and a tmpdir holds a fake
 * package.json so readFlowVersion resolves the post-bump version.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import { parseArgs, run } from "./flow-release";
import type { Spawner } from "./lib/git";

type ScriptedReturn = { status: number; stdout?: string; stderr?: string };
type Matcher = (cmd: string, args: string[]) => boolean;
type Script = Array<{ match: Matcher; result: ScriptedReturn }>;

function ok(stdout = ""): ScriptedReturn {
  return { status: 0, stdout, stderr: "" };
}

function fail(stderr = "boom"): ScriptedReturn {
  return { status: 1, stdout: "", stderr };
}

function match(cmd: string, ...prefix: string[]): Matcher {
  return (c, args) => {
    if (c !== cmd) return false;
    if (args.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      if (args[i] !== prefix[i]) return false;
    }
    return true;
  };
}

function makeSpawn(script: Script): { spawn: Spawner; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: Spawner = (cmd, args) => {
    calls.push([cmd, ...args]);
    for (const entry of script) {
      if (entry.match(cmd, args)) return toReturn(entry.result);
    }
    throw new Error(`unscripted spawn call: ${cmd} ${args.join(" ")}`);
  };
  return { spawn, calls };
}

function toReturn(r: ScriptedReturn): SpawnSyncReturns<string> {
  return {
    pid: 0,
    output: ["", r.stdout ?? "", r.stderr ?? ""],
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status,
    signal: null,
  };
}

const cleanTreeOnMain: Script = [
  { match: match("git", "status", "--porcelain"), result: ok("") },
  {
    match: match("git", "symbolic-ref"),
    result: ok("refs/remotes/origin/main\n"),
  },
  {
    match: match("git", "rev-parse", "--abbrev-ref", "HEAD"),
    result: ok("main\n"),
  },
];

let cwd!: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-release-"));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function writePkg(version: string): void {
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ version }));
}

describe("parseArgs", () => {
  it("rejects a missing type", () => {
    const r = parseArgs([]);
    expect("error" in r).toBe(true);
  });

  it("rejects an invalid type", () => {
    const r = parseArgs(["bogus"]);
    expect("error" in r).toBe(true);
  });

  it("accepts patch|minor|major", () => {
    expect(parseArgs(["patch"])).toEqual({ type: "patch" });
    expect(parseArgs(["minor"])).toEqual({ type: "minor" });
    expect(parseArgs(["major"])).toEqual({ type: "major" });
  });
});

describe("run", () => {
  it("refuses on a dirty tree and never invokes npm version", () => {
    const { spawn, calls } = makeSpawn([
      {
        match: match("git", "status", "--porcelain"),
        result: ok("M foo.ts\n"),
      },
    ]);
    const result = run({ type: "patch", cwd, spawn });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("working tree is dirty");
    expect(calls.some((c) => c[0] === "npm")).toBe(false);
  });

  it("refuses on a non-default branch and never invokes npm version", () => {
    const { spawn, calls } = makeSpawn([
      { match: match("git", "status", "--porcelain"), result: ok("") },
      {
        match: match("git", "symbolic-ref"),
        result: ok("refs/remotes/origin/main\n"),
      },
      {
        match: match("git", "rev-parse", "--abbrev-ref", "HEAD"),
        result: ok("feature/x\n"),
      },
    ]);
    const result = run({ type: "patch", cwd, spawn });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not on default branch main");
    expect(result.error).toContain("feature/x");
    expect(calls.some((c) => c[0] === "npm")).toBe(false);
  });

  it("happy path: bumps, forwards the type, returns the version, reminds about push", () => {
    writePkg("1.1.0");
    const logs: string[] = [];
    const { spawn, calls } = makeSpawn([
      ...cleanTreeOnMain,
      { match: match("npm", "version", "minor"), result: ok("v1.1.0\n") },
    ]);
    const result = run({
      type: "minor",
      cwd,
      spawn,
      log: (s) => logs.push(s),
    });
    expect(result).toEqual({ ok: true, version: "1.1.0" });
    const npmCall = calls.find((c) => c[0] === "npm");
    expect(npmCall).toEqual([
      "npm",
      "version",
      "minor",
      "-m",
      "chore(release): %s",
    ]);
    expect(logs.join("\n")).toContain("git push --follow-tags");
  });

  it("returns an error when npm version exits non-zero", () => {
    writePkg("1.0.0");
    const { spawn } = makeSpawn([
      ...cleanTreeOnMain,
      { match: match("npm", "version", "patch"), result: fail("tag exists") },
    ]);
    const result = run({ type: "patch", cwd, spawn });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("tag exists");
  });
});
