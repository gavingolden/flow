/**
 * Tests for `bin/lib/update-check.ts` — the read-only staleness check.
 *
 * No real git, network, or `~/.flow` access. A scripted Spawner stub
 * (mirroring `git.test.ts`'s `makeSpawn`) returns canned SpawnSyncReturns
 * per command, and the cache lives in a tmpdir file injected via `cachePath`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import {
  checkForUpdate,
  formatUpdateNotice,
  type UpdateCheckResult,
} from "./update-check";
import type { Spawner } from "./git";

type ScriptedReturn = { status: number; stdout?: string; stderr?: string };
type Matcher = (cmd: string, args: string[]) => boolean;
type Script = Array<{ match: Matcher; result: ScriptedReturn }>;

function ok(stdout = ""): ScriptedReturn {
  return { status: 0, stdout, stderr: "" };
}

function fail(stderr = "boom"): ScriptedReturn {
  return { status: 128, stdout: "", stderr };
}

function matchArgs(...prefix: string[]): Matcher {
  return (_cmd, args) => {
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

/** Default probe set for a successful fetch path with a configurable count. */
function probes(count: string): Script {
  return [
    { match: matchArgs("status", "--porcelain"), result: ok() },
    {
      match: matchArgs("symbolic-ref"),
      result: ok("refs/remotes/origin/main\n"),
    },
    { match: matchArgs("fetch", "origin"), result: ok() },
    { match: matchArgs("rev-list", "--count"), result: ok(count) },
  ];
}

const NOTIFY = () => ({ update: { checkFor: "notify" } });

let scratch!: string;
let cachePath!: string;
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-update-check-"));
  cachePath = path.join(scratch, "update-check.json");
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("checkForUpdate — behind", () => {
  it("should report behind with the upgrade command when local HEAD is behind origin", () => {
    const { spawn } = makeSpawn(probes("4\n"));
    const result = checkForUpdate({
      source: "/repo",
      spawn,
      now: NOW,
      cachePath,
      readConfigFile: NOTIFY,
      env: {},
    });
    expect(result).toEqual({
      status: "behind",
      behind: 4,
      upgradeCmd: "flow setup --upgrade",
    });
  });
});

describe("checkForUpdate — current", () => {
  it("should report current when rev-list count is zero", () => {
    const { spawn } = makeSpawn(probes("0\n"));
    const result = checkForUpdate({
      source: "/repo",
      spawn,
      now: NOW,
      cachePath,
      readConfigFile: NOTIFY,
      env: {},
    });
    expect(result).toEqual({ status: "current" });
  });
});

describe("checkForUpdate — skipped", () => {
  it("should skip with not-a-git-repo when git status exits non-zero", () => {
    const { spawn } = makeSpawn([
      { match: matchArgs("status", "--porcelain"), result: fail("not a repo") },
    ]);
    const result = checkForUpdate({
      source: "/repo",
      spawn,
      now: NOW,
      cachePath,
      readConfigFile: NOTIFY,
      env: {},
    });
    expect(result).toEqual({ status: "skipped", reason: "not-a-git-repo" });
  });

  it("should skip with no-default-branch when resolveDefaultBranch yields nothing", () => {
    const { spawn } = makeSpawn([
      { match: matchArgs("status", "--porcelain"), result: ok() },
      { match: matchArgs("symbolic-ref"), result: fail() },
      { match: matchArgs("remote", "show"), result: fail() },
      { match: matchArgs("rev-parse", "--verify"), result: fail() },
    ]);
    const result = checkForUpdate({
      source: "/repo",
      spawn,
      now: NOW,
      cachePath,
      readConfigFile: NOTIFY,
      env: {},
    });
    expect(result).toEqual({ status: "skipped", reason: "no-default-branch" });
  });

  it("should skip with fetch-failed when git fetch exits non-zero", () => {
    const { spawn } = makeSpawn([
      { match: matchArgs("status", "--porcelain"), result: ok() },
      {
        match: matchArgs("symbolic-ref"),
        result: ok("refs/remotes/origin/main\n"),
      },
      { match: matchArgs("fetch", "origin"), result: fail("network down") },
    ]);
    const result = checkForUpdate({
      source: "/repo",
      spawn,
      now: NOW,
      cachePath,
      readConfigFile: NOTIFY,
      env: {},
    });
    expect(result).toEqual({ status: "skipped", reason: "fetch-failed" });
  });

  it("should skip with disabled and perform zero spawns when config checkFor is off", () => {
    const { spawn, calls } = makeSpawn([]);
    const result = checkForUpdate({
      source: "/repo",
      spawn,
      now: NOW,
      cachePath,
      readConfigFile: () => ({ update: { checkFor: "off" } }),
      env: {},
    });
    expect(result).toEqual({ status: "skipped", reason: "disabled" });
    expect(calls.length).toBe(0);
  });

  it("should skip with disabled and perform zero spawns when FLOW_UPDATE_CHECK env is off", () => {
    const { spawn, calls } = makeSpawn([]);
    const result = checkForUpdate({
      source: "/repo",
      spawn,
      now: NOW,
      cachePath,
      readConfigFile: NOTIFY,
      env: { FLOW_UPDATE_CHECK: "off" },
    });
    expect(result).toEqual({ status: "skipped", reason: "disabled" });
    expect(calls.length).toBe(0);
  });

  it("should never throw when git status spawn itself throws", () => {
    const spawn: Spawner = () => {
      throw new Error("spawn exploded");
    };
    const result = checkForUpdate({
      source: "/repo",
      spawn,
      now: NOW,
      cachePath,
      readConfigFile: NOTIFY,
      env: {},
    });
    expect(result.status).toBe("skipped");
  });
});

describe("checkForUpdate — throttle", () => {
  it("should perform zero git fetch within the 24h throttle window", () => {
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ lastCheckedMs: NOW - 60 * 60 * 1000, behind: 3 }),
    );
    const { spawn, calls } = makeSpawn([]);
    const result = checkForUpdate({
      source: "/repo",
      spawn,
      now: NOW,
      cachePath,
      readConfigFile: NOTIFY,
      env: {},
    });
    expect(result).toEqual({
      status: "behind",
      behind: 3,
      upgradeCmd: "flow setup --upgrade",
    });
    expect(calls.find((c) => c[1] === "fetch")).toBeUndefined();
    expect(calls.length).toBe(0);
  });

  it("should re-check and update the cache after the throttle interval elapses", () => {
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ lastCheckedMs: NOW - 25 * 60 * 60 * 1000, behind: 3 }),
    );
    const { spawn, calls } = makeSpawn(probes("7\n"));
    const result = checkForUpdate({
      source: "/repo",
      spawn,
      now: NOW,
      cachePath,
      readConfigFile: NOTIFY,
      env: {},
    });
    expect(result).toEqual({
      status: "behind",
      behind: 7,
      upgradeCmd: "flow setup --upgrade",
    });
    expect(calls.find((c) => c[1] === "fetch")).toBeDefined();
    const rewritten = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    expect(rewritten).toEqual({ lastCheckedMs: NOW, behind: 7 });
  });
});

describe("formatUpdateNotice", () => {
  it("formatUpdateNotice returns null for current and skipped, and a string containing the count + command for behind", () => {
    expect(formatUpdateNotice({ status: "current" })).toBeNull();
    expect(
      formatUpdateNotice({ status: "skipped", reason: "fetch-failed" }),
    ).toBeNull();

    const behind: UpdateCheckResult = {
      status: "behind",
      behind: 5,
      upgradeCmd: "flow setup --upgrade",
    };
    const notice = formatUpdateNotice(behind);
    expect(notice).not.toBeNull();
    expect(notice).toContain("5 commits behind");
    expect(notice).toContain("flow setup --upgrade");
  });

  it("uses the singular 'commit' for a single-commit gap", () => {
    const notice = formatUpdateNotice({
      status: "behind",
      behind: 1,
      upgradeCmd: "flow setup --upgrade",
    });
    expect(notice).toContain("1 commit behind");
    expect(notice).not.toContain("1 commits");
  });
});
