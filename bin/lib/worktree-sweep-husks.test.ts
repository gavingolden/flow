import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PipelineState } from "./state";
import type { OrphanProc } from "./worktree-orphans";
import type { FactDeps, RunResult } from "./worktree-sweep-facts";
import { gatherHuskFacts } from "./worktree-sweep-husks";
import { HUSK_SCAN_CAP } from "./worktree-sweep-rules";
import {
  buildUsageIndex,
  danglingContainerMounts,
  defaultReadCwds,
  type UsageIndex,
} from "./worktree-sweep-usage";

const res = (over: Partial<RunResult> = {}): RunResult => ({
  status: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...over,
});
const proc = (pid: number, ppid = 1, command = "node x"): OrphanProc => ({
  pid,
  ppid,
  pgid: pid,
  uid: 1,
  tty: null,
  ageSec: 1,
  cpuSec: 1,
  command,
  cwd: null,
});

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sweep-husks-")));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function deps(over: Partial<FactDeps> = {}): FactDeps {
  return {
    run: () => res(),
    listStates: () => [],
    liveness: () => "stale",
    windowOpen: () => false,
    cwd: tmp,
    nowMs: () => Date.now(),
    flowSourcePaths: [],
    listProcs: () => [],
    readCwds: () => new Map(),
    selfPids: [100],
    ...over,
  };
}

const NO_USAGE: UsageIndex = {
  processesInside: () => [],
  containersMounting: () => [],
  containersUnknown: false,
  mounts: [],
};

describe("buildUsageIndex", () => {
  it("indexes processes by working directory and excludes the sweep itself and its ancestors", () => {
    const wt = path.join(tmp, "repo-a");
    fs.mkdirSync(wt);
    const procs = [proc(100, 50), proc(50, 1), proc(7, 1, "vite dev")];
    const cwds = new Map([
      [100, wt],
      [50, wt],
      [7, path.join(wt, "sub")],
    ]);
    fs.mkdirSync(path.join(wt, "sub"));

    const usage = buildUsageIndex(
      deps({ listProcs: () => procs, readCwds: () => cwds }),
    );

    expect(usage.processesInside(wt)).toEqual([
      { pid: 7, command: "vite dev" },
    ]);
    expect(usage.processesSkipped).toBeUndefined();
  });

  it("records a named skip when the process table is unreadable", () => {
    expect(
      buildUsageIndex(deps({ listProcs: () => undefined })).processesSkipped,
    ).toBe("ps-unavailable");
  });

  it("records a named skip when working directories are unreadable", () => {
    const usage = buildUsageIndex(
      deps({ listProcs: () => [proc(7)], readCwds: () => undefined }),
    );
    expect(usage.processesSkipped).toBe("lsof-unavailable");
  });

  it("names the docker skip when docker is absent or unresponsive", () => {
    const absent = buildUsageIndex(deps({ run: () => res({ status: null }) }));
    expect(absent.dockerSkipped).toBe("docker-not-installed");
    const hung = buildUsageIndex(
      deps({ run: () => res({ status: null, timedOut: true }) }),
    );
    expect(hung.dockerSkipped).toBe("docker-unresponsive");
  });

  it("maps containers to the bind-mount sources inside a path", () => {
    const run: FactDeps["run"] = (_c, args) =>
      args[0] === "ps"
        ? res({ stdout: "abc\n" })
        : res({
            stdout: `/supabase_db\t${tmp}/repo-a/supabase\t/other\t\n`,
          });
    const usage = buildUsageIndex(deps({ run }));
    expect(usage.containersMounting(`${tmp}/repo-a`)).toEqual(["supabase_db"]);
    expect(usage.containersMounting(`${tmp}/repo-b`)).toEqual([]);
    expect(usage.containersUnknown).toBe(false);
  });

  it("keeps a mount source that contains a space whole", () => {
    fs.mkdirSync(path.join(tmp, "my repo-a"));
    const run: FactDeps["run"] = (_c, args) =>
      args[0] === "ps"
        ? res({ stdout: "abc\n" })
        : res({ stdout: `/db\t${tmp}/my repo-a\t\n` });
    const usage = buildUsageIndex(deps({ run }));
    expect(usage.containersMounting(`${tmp}/my repo-a`)).toEqual(["db"]);
  });

  it("canonicalizes a mount source reached through a symlink", () => {
    const real = path.join(tmp, "real-a");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(tmp, "link-a"));
    const run: FactDeps["run"] = (_c, args) =>
      args[0] === "ps"
        ? res({ stdout: "abc\n" })
        : res({ stdout: `/db\t${tmp}/link-a\t\n` });
    expect(buildUsageIndex(deps({ run })).containersMounting(real)).toEqual([
      "db",
    ]);
  });

  describe("Docker that cannot be checked", () => {
    const failing =
      (
        ps: Partial<RunResult>,
        insp: Partial<RunResult> = {},
      ): FactDeps["run"] =>
      (_c, args) =>
        args[0] === "ps" ? res({ stdout: "abc\n", ...ps }) : res(insp);

    it("sweeps normally when the daemon is not running", () => {
      const usage = buildUsageIndex(
        deps({
          run: failing({
            status: 1,
            stdout: "",
            stderr:
              "Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?",
          }),
        }),
      );
      expect(usage.dockerSkipped).toBe("docker-not-running");
      expect(usage.containersUnknown).toBe(false);
    });

    it("fails closed on a timeout, an unexplained ps failure and an unexplained inspect failure", () => {
      for (const run of [
        failing({ timedOut: true, status: null }),
        failing({ status: 1, stderr: "boom" }),
        failing({}, { status: 1, stderr: "boom" }),
        failing({}, { timedOut: true, status: null }),
      ]) {
        const usage = buildUsageIndex(deps({ run }));
        expect(usage.dockerSkipped).toBe("docker-unresponsive");
        expect(usage.containersUnknown).toBe(true);
      }
    });

    it("keeps the mounts inspect printed when a container vanished mid-run", () => {
      const usage = buildUsageIndex(
        deps({
          run: failing(
            {},
            {
              status: 1,
              stdout: `/db\t${tmp}/repo-a\t\n`,
              stderr: "Error: No such object: gone",
            },
          ),
        }),
      );
      expect(usage.containersUnknown).toBe(false);
      expect(usage.containersMounting(`${tmp}/repo-a`)).toEqual(["db"]);
    });
  });

  it("treats an empty cwd answer for live pids as unreadable but an empty pid list as fine", () => {
    expect(defaultReadCwds([123])).toBeUndefined();
    expect(defaultReadCwds([])).toEqual(new Map());
  });
});

describe("gatherHuskFacts", () => {
  const repo = () => path.join(tmp, "repo");
  beforeEach(() => fs.mkdirSync(repo()));

  it("collects files, top-level names and an mtime covering directories", () => {
    const husk = path.join(tmp, "repo-old");
    fs.mkdirSync(path.join(husk, ".vite", "deps"), { recursive: true });
    fs.writeFileSync(path.join(husk, ".vite", "deps", "a.js"), "x");
    const old = new Date(Date.now() - 10 * 3_600_000);
    for (const p of [path.join(husk, ".vite", "deps", "a.js")])
      fs.utimesSync(p, old, old);

    const [f] = gatherHuskFacts([repo()], deps(), NO_USAGE);

    expect(f.files).toEqual([".vite/deps/a.js"]);
    expect(f.topLevel).toEqual([".vite"]);
    expect(f.newestMtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });

  it("gives a just-created empty folder a recent mtime", () => {
    fs.mkdirSync(path.join(tmp, "repo-fresh"));
    const [f] = gatherHuskFacts([repo()], deps(), NO_USAGE);
    expect(f.files).toEqual([]);
    expect(f.nowMs - f.newestMtimeMs).toBeLessThan(60_000);
  });

  it("skips a .git-bearing sibling and a symlinked sibling", () => {
    fs.mkdirSync(path.join(tmp, "repo-wt"));
    fs.writeFileSync(path.join(tmp, "repo-wt", ".git"), "gitdir: x");
    fs.mkdirSync(path.join(tmp, "elsewhere"));
    fs.symlinkSync(path.join(tmp, "elsewhere"), path.join(tmp, "repo-link"));
    expect(gatherHuskFacts([repo()], deps(), NO_USAGE)).toEqual([]);
  });

  it("stops at the entry cap and reports the scan as truncated", () => {
    const husk = path.join(tmp, "repo-big");
    fs.mkdirSync(husk);
    for (let i = 0; i <= HUSK_SCAN_CAP; i++)
      fs.writeFileSync(path.join(husk, `f${i}`), "");
    const [f] = gatherHuskFacts([repo()], deps(), NO_USAGE);
    expect(f.scanTruncated).toBe(true);
  });

  it("flags a folder git lists as registered", () => {
    const husk = path.join(tmp, "repo-reg");
    fs.mkdirSync(husk);
    const run: FactDeps["run"] = () =>
      res({ stdout: `worktree ${repo()}\n\nworktree ${husk}\n\n` });
    expect(
      gatherHuskFacts([repo()], deps({ run }), NO_USAGE)[0].registered,
    ).toBe(true);
  });

  it("reserves a folder whose pipeline window is still open or whose unfinished liveness is unknown, not a finished unknown one", () => {
    const names = ["open", "running", "finished"];
    for (const n of names) fs.mkdirSync(path.join(tmp, `repo-${n}`));
    const states = names.map((n) => ({
      slug: n,
      phase: n === "finished" ? "merged" : "implementing",
      repo: repo(),
      reservedWorktree: path.join(tmp, `repo-${n}`),
    })) as PipelineState[];
    const facts = gatherHuskFacts(
      [repo()],
      deps({
        listStates: () => states,
        liveness: (s) => (s.slug === "open" ? "stale" : "unknown"),
        windowOpen: (slug) => slug === "open",
      }),
      NO_USAGE,
    );
    const by = Object.fromEntries(
      facts.map((f) => [path.basename(f.path), f.reservedByActive]),
    );
    expect(by).toEqual({
      "repo-open": true,
      "repo-running": true,
      "repo-finished": false,
    });
  });

  it("flags the leftover folder the sweep was launched from and carries an unknown Docker", () => {
    const husk = path.join(tmp, "repo-here");
    fs.mkdirSync(path.join(husk, "sub"), { recursive: true });
    const usage: UsageIndex = { ...NO_USAGE, containersUnknown: true };
    const [f] = gatherHuskFacts(
      [repo()],
      deps({ cwd: path.join(husk, "sub") }),
      usage,
    );
    expect(f.containsLaunchDir).toBe(true);
    expect(f.containersMounting).toBe("unknown");
  });

  it("holds reservations only for alive or unknown owners", () => {
    const live = path.join(tmp, "repo-live");
    const dead = path.join(tmp, "repo-dead");
    fs.mkdirSync(live);
    fs.mkdirSync(dead);
    const states = [
      {
        slug: "l",
        phase: "triaged-no-change",
        repo: repo(),
        reservedWorktree: live,
      },
      {
        slug: "d",
        phase: "triaged-no-change",
        repo: repo(),
        reservedWorktree: dead,
      },
    ] as PipelineState[];
    const facts = gatherHuskFacts(
      [repo()],
      deps({
        listStates: () => states,
        liveness: (s) => (s.slug === "l" ? "unknown" : "stale"),
      }),
      NO_USAGE,
    );
    const by = Object.fromEntries(
      facts.map((f) => [path.basename(f.path), f.reservedByActive]),
    );
    expect(by).toEqual({ "repo-live": true, "repo-dead": false });
  });

  it("carries the usage index's unknown-process flag and container names", () => {
    fs.mkdirSync(path.join(tmp, "repo-x"));
    const usage: UsageIndex = {
      ...NO_USAGE,
      processesSkipped: "ps-unavailable",
      containersMounting: () => ["supabase_db"],
    };
    const [f] = gatherHuskFacts([repo()], deps(), usage);
    expect(f.processesUnknown).toBe(true);
    expect(f.containersMounting).toEqual(["supabase_db"]);
  });
});

describe("danglingContainerMounts", () => {
  it("reports a container mounting a deleted sibling folder and one mounting a leftover", () => {
    const repo = path.join(tmp, "repo");
    const gone = path.join(tmp, "repo-gone", "supabase");
    const left = path.join(tmp, "repo-left", "supabase");
    const usage: UsageIndex = {
      ...NO_USAGE,
      mounts: [
        { container: "supabase_db", sources: [gone, "/var/run/docker.sock"] },
        { container: "supabase_kong", sources: [left] },
        { container: "fine", sources: [path.join(tmp, "repo-ok")] },
      ],
    };
    const out = danglingContainerMounts(
      usage,
      [repo],
      (p) => p === path.join(tmp, "repo-ok") || p === left,
      [path.join(tmp, "repo-left")],
    );
    expect(out).toEqual([
      { container: "supabase_db", source: gone },
      { container: "supabase_kong", source: left },
    ]);
  });
});
