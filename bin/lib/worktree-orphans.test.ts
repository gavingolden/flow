import { describe, expect, it } from "vitest";
import {
  BUSY_MIN_AGE_SEC,
  isProtectedCommand,
  isUnderPath,
  leaderDead,
  ownerOf,
  prefilterCandidates,
  selectWorktreeOrphans,
  type OrphanProc,
} from "./worktree-orphans";

const UID = 501;
const WT = "/x/flow-foo";

function proc(over: Partial<OrphanProc> & { pid: number }): OrphanProc {
  return {
    ppid: 1,
    pgid: 9000,
    uid: UID,
    tty: null,
    ageSec: 600,
    cpuSec: 0,
    command: "sleep 100",
    cwd: WT,
    ...over,
  };
}

const opts = {
  selfUid: UID,
  registeredPids: new Set<number>(),
  registeredPgids: new Set<number>(),
  busyOnly: false,
};

describe("ownerOf / isUnderPath", () => {
  it("should respect the / boundary between sibling worktrees", () => {
    expect(isUnderPath("/x/flow-foo-bar/src", "/x/flow-foo")).toBe(false);
    expect(isUnderPath("/x/flow-foo/src", "/x/flow-foo")).toBe(true);
    expect(isUnderPath("/x/flow-foo", "/x/flow-foo")).toBe(true);
    expect(
      ownerOf("/x/flow-foo-bar/src", ["/x/flow-foo", "/x/flow-foo-bar"]),
    ).toBe("/x/flow-foo-bar");
  });

  it("should pick the longest match across nested worktrees", () => {
    expect(ownerOf("/x/a/b/c", ["/x/a", "/x/a/b"])).toBe("/x/a/b");
  });

  it("should return null for a null or outside cwd", () => {
    expect(ownerOf(null, [WT])).toBeNull();
    expect(ownerOf("/tmp", [WT])).toBeNull();
  });
});

describe("leaderDead", () => {
  it("should treat a pgid with no live process as dead and a self-leader as alive", () => {
    expect(leaderDead(proc({ pid: 5, pgid: 4 }), new Set([5]))).toBe(true);
    expect(leaderDead(proc({ pid: 5, pgid: 4 }), new Set([4, 5]))).toBe(false);
    expect(leaderDead(proc({ pid: 5, pgid: 5 }), new Set([5]))).toBe(false);
  });
});

describe("prefilterCandidates", () => {
  it("should keep a PPID-1 same-uid terminal-less dead-leader root", () => {
    const r = proc({ pid: 10 });
    expect(prefilterCandidates([r], opts)).toEqual([r]);
  });

  it.each([
    ["a terminal", { tty: "ttys001" }],
    ["a live parent", { ppid: 77 }],
    ["another uid", { uid: 999 }],
  ])("should reject a process with %s", (_n, over) => {
    expect(prefilterCandidates([proc({ pid: 10, ...over })], opts)).toEqual([]);
  });

  it("should reject a registered pid and a registered pgid", () => {
    const r = proc({ pid: 10 });
    expect(
      prefilterCandidates([r], { ...opts, registeredPids: new Set([10]) }),
    ).toEqual([]);
    expect(
      prefilterCandidates([r], { ...opts, registeredPgids: new Set([9000]) }),
    ).toEqual([]);
  });

  it("should reject a daemon that leads its own live group", () => {
    expect(prefilterCandidates([proc({ pid: 10, pgid: 10 })], opts)).toEqual(
      [],
    );
  });

  it("should reject a group whose leader is still in the table", () => {
    const leader = proc({ pid: 9000, pgid: 9000, ppid: 50 });
    const r = proc({ pid: 10 });
    expect(prefilterCandidates([leader, r], opts)).toEqual([]);
  });

  it("should never return a protected MCP- or Chrome-shaped root", () => {
    const cmds = [
      "node /opt/chrome-devtools-mcp/index.js",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --foo",
      "/usr/bin/foo --user-data-dir=/tmp/p",
    ];
    for (const [i, command] of cmds.entries()) {
      expect(
        prefilterCandidates([proc({ pid: 10 + i, command })], opts),
      ).toEqual([]);
    }
  });

  it("should skip roots younger than the busy age in busyOnly mode", () => {
    const young = proc({ pid: 10, ageSec: BUSY_MIN_AGE_SEC - 1 });
    expect(prefilterCandidates([young], { ...opts, busyOnly: true })).toEqual(
      [],
    );
    expect(prefilterCandidates([young], opts)).toEqual([young]);
  });
});

describe("isProtectedCommand", () => {
  it("should not flag ordinary commands that mention chrome as a path segment", () => {
    expect(isProtectedCommand("go test ./chrome/...")).toBe(false);
  });
});

describe("selectWorktreeOrphans", () => {
  const sel = (cands: OrphanProc[], table = cands) =>
    selectWorktreeOrphans(cands, table, { worktree: WT, allWorktrees: [WT] });

  it("should mark 78 loops at 20% each as one busy group", () => {
    const roots = Array.from({ length: 78 }, (_, i) =>
      proc({ pid: 100 + i, cpuSec: 0.2 * 600 }),
    );
    const out = sel(roots);
    expect(out).toHaveLength(78);
    expect(out.every((o) => o.busy)).toBe(true);
  });

  it("should not call one idle root busy", () => {
    const out = sel([proc({ pid: 100, cpuSec: 1 })]);
    expect(out[0].busy).toBe(false);
  });

  it("should call an idle root over a busy child busy and attach the child", () => {
    const root = proc({ pid: 100, cpuSec: 0 });
    const child = proc({ pid: 101, ppid: 100, pgid: 9000, cpuSec: 500 });
    const out = sel([root], [root, child]);
    expect(out[0].busy).toBe(true);
    expect(out[0].descendants).toEqual([101]);
  });

  it("should collect nested descendants but not a protected one", () => {
    const root = proc({ pid: 100 });
    const kid = proc({ pid: 101, ppid: 100 });
    const grand = proc({ pid: 102, ppid: 101 });
    const chrome = proc({
      pid: 103,
      ppid: 100,
      command: "/x/Google Chrome --y",
    });
    const out = sel([root], [root, kid, grand, chrome]);
    expect(out[0].descendants.sort()).toEqual([101, 102]);
  });

  it("should not call a group busy below the age floor", () => {
    const out = sel([proc({ pid: 100, ageSec: 60, cpuSec: 60 })]);
    expect(out[0].busy).toBe(false);
  });

  it("should select by the 25% boundary", () => {
    expect(sel([proc({ pid: 1, cpuSec: 150 })])[0].busy).toBe(true);
    expect(sel([proc({ pid: 1, cpuSec: 149 })])[0].busy).toBe(false);
  });

  it("should not select another pipeline's, an outside, or an unreadable cwd", () => {
    const out = sel([
      proc({ pid: 1, cwd: "/x/flow-foo-bar/src" }),
      proc({ pid: 2, cwd: "/tmp", command: `sh -c cd ${WT}` }),
      proc({ pid: 3, cwd: null, command: `sh -c cd ${WT}` }),
    ]);
    expect(out).toEqual([]);
  });

  it("should carry only the command basename", () => {
    const out = sel([
      proc({ pid: 1, command: "/usr/bin/sleep 99 --secret=x" }),
    ]);
    expect(out[0].command0).toBe("sleep");
  });
});
