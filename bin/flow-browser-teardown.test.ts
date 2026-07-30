import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  classifyProfileShape,
  descendantsOf,
  resolveSessionPid,
  runOrphanSweep,
  runTeardown,
  selectMcpServers,
  selectOrphanBrowsers,
  selectOrphanMcpServers,
  type Deps,
  type ProcRow,
} from "./flow-browser-teardown";

// --- Fixtures -----------------------------------------------------------

function proc(pid: number, ppid: number, command: string): ProcRow {
  return { pid, ppid, command };
}

/** A minimal working Deps fixture — tests override only what they need. */
function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    listProcs: () => [],
    kill: vi.fn(),
    alive: () => false,
    sleepMs: vi.fn(),
    env: { FLOW_PIPELINE: "1" },
    selfPid: 1,
    homeDir: "/Users/dev",
    tmpDir: "/tmp",
    nowMs: () => 0,
    ...overrides,
  };
}

describe("resolveSessionPid", () => {
  it("returns the nearest claude ancestor on a realistic chain", () => {
    const procs = [
      proc(100, 1, "tmux: server (/usr/local/var/run/tmux-501/default)"),
      proc(200, 100, "claude --add-dir /w/foo"),
      proc(300, 200, "zsh"),
      proc(400, 300, "bash"),
    ];
    expect(resolveSessionPid(procs, 400)).toBe(200);
  });

  it("SIBLING-KILLING FOOTGUN GUARD: never widens to a shared tmux server root", () => {
    const tmuxServer = proc(
      12750,
      1,
      "tmux: server (/usr/local/var/run/tmux-501/default)",
    );
    const ownSession = proc(34615, 12750, "claude --add-dir /w/mine");
    const ownDescendant = proc(34700, 34615, "bash -c ls");
    const ownServer = proc(34800, 34615, "chrome-devtools-mcp");

    // Many sibling sessions share the same tmux-server parent, each with
    // its own claude pid and its own chrome-devtools-mcp server.
    const siblings: ProcRow[] = [];
    const siblingServers: ProcRow[] = [];
    for (let i = 0; i < 26; i++) {
      const claudePid = 50000 + i;
      siblings.push(proc(claudePid, 12750, `claude --add-dir /w/sib${i}`));
      siblingServers.push(proc(60000 + i, claudePid, "chrome-devtools-mcp"));
    }

    const procs = [
      tmuxServer,
      ownSession,
      ownDescendant,
      ownServer,
      ...siblings,
      ...siblingServers,
    ];

    // (a) resolveSessionPid returns the session's OWN claude pid, never
    // the shared tmux server.
    expect(resolveSessionPid(procs, ownDescendant.pid)).toBe(ownSession.pid);

    // (b) runTeardown signals only this session's own server, none of the
    // 26 siblings'.
    const killed: number[] = [];
    const deps = fakeDeps({
      listProcs: () => procs,
      selfPid: ownDescendant.pid,
      kill: (pid) => {
        killed.push(pid);
      },
      alive: () => false,
    });
    const result = runTeardown(deps, { dryRun: false, timeoutMs: 1000 });
    expect(result.ran).toBe(true);
    expect(result.sessionPid).toBe(ownSession.pid);
    expect(killed).toEqual([ownServer.pid]);
  });

  it("returns undefined with no claude ancestor, and runTeardown yields no-session-pid with empty signalled — no widening fallback", () => {
    const procs = [
      proc(1, 0, "launchd"),
      proc(50, 1, "some-daemon"),
      proc(60, 50, "bash"),
    ];
    expect(resolveSessionPid(procs, 60)).toBeUndefined();

    const deps = fakeDeps({ listProcs: () => procs, selfPid: 60 });
    const result = runTeardown(deps, { dryRun: false, timeoutMs: 1000 });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("no-session-pid");
    expect(result.signalled).toEqual([]);
  });

  it("terminates on a PPID cycle without hanging", () => {
    const procs = [proc(1, 2, "a"), proc(2, 1, "b")];
    expect(resolveSessionPid(procs, 1)).toBeUndefined();
  });

  it("terminates on an over-long chain without hanging", () => {
    const procs: ProcRow[] = [];
    for (let i = 0; i < 200; i++) {
      procs.push(proc(i, i + 1, `proc-${i}`));
    }
    expect(resolveSessionPid(procs, 0)).toBeUndefined();
  });
});

describe("descendantsOf", () => {
  it("is transitive, excludes the root, and is cycle-safe", () => {
    const procs = [
      proc(1, 0, "root"),
      proc(2, 1, "child"),
      proc(3, 2, "grandchild"),
      proc(4, 999, "unrelated"),
      // cycle: 5 -> 6 -> 5 (neither reachable from root, but must not spin)
      proc(5, 6, "cyc-a"),
      proc(6, 5, "cyc-b"),
    ];
    const out = descendantsOf(procs, 1).map((p) => p.pid);
    expect(out.sort()).toEqual([2, 3]);
    expect(out).not.toContain(1);
  });
});

describe("selectMcpServers", () => {
  it("selects exactly the bare server row among all three live command shapes", () => {
    const sessionPid = 100;
    const procs = [
      proc(sessionPid, 1, "claude --add-dir /w"),
      proc(200, sessionPid, "npm exec chrome-devtools-mcp@latest --isolated"),
      proc(201, sessionPid, "chrome-devtools-mcp"),
      proc(
        202,
        sessionPid,
        "/usr/local/bin/node .../node_modules/chrome-devtools-mcp/build/src/telemetry/watchdog/main.js --parent-pid=200",
      ),
    ];
    const out = selectMcpServers(procs, sessionPid);
    expect(out.map((p) => p.pid)).toEqual([201]);
  });

  it("never selects the user's own Chrome or a sibling session's server", () => {
    const sessionPid = 100;
    const procs = [
      proc(sessionPid, 1, "claude --add-dir /w"),
      proc(201, sessionPid, "chrome-devtools-mcp"),
      proc(
        1,
        1,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
      proc(300, 1, "claude --add-dir /w/other"),
      proc(301, 300, "chrome-devtools-mcp"),
    ];
    const out = selectMcpServers(procs, sessionPid).map((p) => p.pid);
    expect(out).toEqual([201]);
  });
});

describe("runTeardown", () => {
  const sessionPid = 100;
  function serverProcs(): ProcRow[] {
    return [
      proc(sessionPid, 1, "claude --add-dir /w"),
      proc(201, sessionPid, "chrome-devtools-mcp"),
    ];
  }

  it("SIGTERM is the exact recorded signal, and the source file never contains 'SIGKILL'", () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const deps = fakeDeps({
      listProcs: serverProcs,
      selfPid: sessionPid,
      kill: (pid, signal) => {
        killed.push({ pid, signal });
      },
      alive: () => false,
    });
    runTeardown(deps, { dryRun: false, timeoutMs: 1000 });
    expect(killed).toEqual([{ pid: 201, signal: "SIGTERM" }]);

    const source = readFileSync(
      new URL("./flow-browser-teardown.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("SIGKILL");
  });

  it("dryRun true signals nothing", () => {
    const kill = vi.fn();
    const deps = fakeDeps({
      listProcs: serverProcs,
      selfPid: sessionPid,
      kill,
    });
    const result = runTeardown(deps, { dryRun: true, timeoutMs: 1000 });
    expect(result.dryRun).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    expect(result.stillAlive).toEqual([]);
  });

  it("FLOW_PIPELINE unset yields not-a-pipeline-session", () => {
    const deps = fakeDeps({ env: {} });
    const result = runTeardown(deps, { dryRun: false, timeoutMs: 1000 });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("not-a-pipeline-session");
  });

  it("an explicit sessionPid bypasses the FLOW_PIPELINE gate", () => {
    const deps = fakeDeps({
      env: {},
      listProcs: serverProcs,
      alive: () => false,
    });
    const result = runTeardown(deps, {
      dryRun: false,
      sessionPid,
      timeoutMs: 1000,
    });
    expect(result.ran).toBe(true);
    expect(result.skipReason).toBeUndefined();
  });

  it("listProcs returning undefined yields ps-unavailable", () => {
    const deps = fakeDeps({ listProcs: () => undefined });
    const result = runTeardown(deps, { dryRun: false, timeoutMs: 1000 });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("ps-unavailable");
  });

  it("no MCP server under the session yields no-mcp-server", () => {
    const deps = fakeDeps({
      listProcs: () => [proc(sessionPid, 1, "claude --add-dir /w")],
      selfPid: sessionPid,
    });
    const result = runTeardown(deps, { dryRun: false, timeoutMs: 1000 });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("no-mcp-server");
  });

  it("a process that survives the poll window is reported in stillAlive and no second signal is sent", () => {
    const killCalls: number[] = [];
    let clock = 0;
    const deps = fakeDeps({
      listProcs: serverProcs,
      selfPid: sessionPid,
      kill: (pid) => {
        killCalls.push(pid);
      },
      alive: () => true, // never exits within the poll window
      sleepMs: (ms) => {
        clock += ms;
      },
      nowMs: () => clock,
    });
    const result = runTeardown(deps, { dryRun: false, timeoutMs: 500 });
    expect(result.stillAlive).toEqual([201]);
    // Exactly one kill call — no escalation to a second/harder signal.
    expect(killCalls).toEqual([201]);
  });
});

describe("classifyProfileShape", () => {
  const opts = { homeDir: "/Users/dev", tmpDir: "/private/tmp/xyz" };

  it("classifies the chrome-devtools-mcp cache profile", () => {
    expect(
      classifyProfileShape("/Users/dev/.cache/chrome-devtools-mcp/x", opts),
    ).toBe("chrome-devtools-mcp-cache");
  });

  it("classifies the verified go-rod path, and the Linux /tmp shape", () => {
    expect(
      classifyProfileShape(
        "/private/tmp/xyz/rod/user-data/99b0c95236a886aa",
        opts,
      ),
    ).toBe("go-rod-temp");
    expect(classifyProfileShape("/tmp/rod/user-data/abc123", opts)).toBe(
      "go-rod-temp",
    );
  });

  it("TEMP-ROOT ANCHORING GUARD: a real project dir never matches", () => {
    expect(
      classifyProfileShape("/Users/dev/code/rod/user-data/abc", opts),
    ).toBe("unmatched");
  });

  it("rejects a non-hex final segment under a temp root", () => {
    expect(
      classifyProfileShape("/private/tmp/xyz/rod/user-data/NotHex", opts),
    ).toBe("unmatched");
  });
});

describe("selectOrphanBrowsers", () => {
  const opts = { homeDir: "/Users/dev", tmpDir: "/private/tmp/xyz" };
  const rodUserDataDir = "/private/tmp/xyz/rod/user-data/99b0c95236a886aa";
  const rodRootCommand = `/path/to/chrome --headless --enable-automation --remote-debugging-port=0 --disable-background-networking --user-data-dir=${rodUserDataDir}`;

  it("selects the verified go-rod root with profileShape go-rod-temp and matched:true", () => {
    const procs = [proc(500, 1, rodRootCommand)];
    const out = selectOrphanBrowsers(procs, opts);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      pid: 500,
      profileShape: "go-rod-temp",
      matched: true,
    });
  });

  it("HELPER-CHILD GUARD: never selects the root's --type= helper children", () => {
    const root = proc(500, 1, rodRootCommand);
    const helpers = [
      proc(
        501,
        500,
        `chrome --type=renderer --user-data-dir=${rodUserDataDir}`,
      ),
      proc(
        502,
        500,
        `chrome --type=gpu-process --user-data-dir=${rodUserDataDir}`,
      ),
      proc(503, 500, `chrome --type=utility --user-data-dir=${rodUserDataDir}`),
      proc(504, 500, `chrome --type=utility --user-data-dir=${rodUserDataDir}`),
    ];
    const out = selectOrphanBrowsers([root, ...helpers], opts);
    expect(out.map((r) => r.pid)).toEqual([500]);
  });

  it("DEVELOPER-CHROME GUARD: an automation Chrome at ppid 1 with a real profile dir is emitted matched:false, never signalled even with yes:true", () => {
    const devChrome = proc(
      600,
      1,
      "/path/to/chrome --enable-automation --disable-background-networking --user-data-dir=/Users/dev/.config/chrome-testing",
    );
    const out = selectOrphanBrowsers([devChrome], opts);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ pid: 600, matched: false });

    const kill = vi.fn();
    const deps = fakeDeps({ listProcs: () => [devChrome], kill });
    const sweepResult = runOrphanSweep(deps, { yes: true, ...opts });
    expect(sweepResult.signalled).not.toContain(600);
    expect(kill).not.toHaveBeenCalledWith(600, "SIGTERM");
  });

  it("a row missing --disable-background-networking is not selected", () => {
    const noDbn = proc(
      700,
      1,
      `/path/to/chrome --enable-automation --user-data-dir=${rodUserDataDir}`,
    );
    expect(selectOrphanBrowsers([noDbn], opts)).toEqual([]);
  });
});

describe("selectOrphanMcpServers", () => {
  it("selects a ppid-1 server and a parent-gone server; excludes a live-claude-parented server and the wrapper/watchdog", () => {
    const procs = [
      proc(10, 1, "chrome-devtools-mcp"), // ppid 1 -> selected
      proc(20, 9999, "chrome-devtools-mcp"), // parent gone -> selected
      proc(30, 1, "claude --add-dir /w"), // a live claude in the table
      proc(40, 30, "chrome-devtools-mcp"), // parented by a live claude -> not selected
      proc(50, 1, "npm exec chrome-devtools-mcp@latest --isolated"), // wrapper
      proc(
        60,
        1,
        "node .../node_modules/chrome-devtools-mcp/build/src/telemetry/watchdog/main.js --parent-pid=50",
      ), // watchdog
    ];
    const out = selectOrphanMcpServers(procs).map((p) => p.pid);
    expect(out.sort()).toEqual([10, 20]);
  });
});

describe("runOrphanSweep", () => {
  const opts = { homeDir: "/Users/dev", tmpDir: "/private/tmp/xyz" };
  const rodUserDataDir = "/private/tmp/xyz/rod/user-data/99b0c95236a886aa";
  const rodRoot = proc(
    500,
    1,
    `chrome --enable-automation --disable-background-networking --user-data-dir=${rodUserDataDir}`,
  );
  const server = proc(700, 9999, "chrome-devtools-mcp");

  it("without yes, signalled is empty and found/foundServers are still populated", () => {
    const kill = vi.fn();
    const deps = fakeDeps({ listProcs: () => [rodRoot, server], kill });
    const result = runOrphanSweep(deps, { yes: false, ...opts });
    expect(result.signalled).toEqual([]);
    expect(result.found).toHaveLength(1);
    expect(result.foundServers).toHaveLength(1);
    expect(kill).not.toHaveBeenCalled();
  });

  it("with yes, only matched rows and sessionless servers are signalled, each with SIGTERM", () => {
    const devChrome = proc(
      600,
      1,
      "chrome --enable-automation --disable-background-networking --user-data-dir=/Users/dev/.config/chrome-testing",
    );
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const deps = fakeDeps({
      listProcs: () => [rodRoot, devChrome, server],
      kill: (pid, signal) => {
        killed.push({ pid, signal });
      },
    });
    const result = runOrphanSweep(deps, { yes: true, ...opts });
    expect(result.signalled.sort()).toEqual([500, 700]);
    expect(killed).toEqual(
      expect.arrayContaining([
        { pid: 500, signal: "SIGTERM" },
        { pid: 700, signal: "SIGTERM" },
      ]),
    );
    expect(killed.find((k) => k.pid === 600)).toBeUndefined();
  });

  it("works with FLOW_PIPELINE unset — not gated on the pipeline env marker", () => {
    const deps = fakeDeps({ env: {}, listProcs: () => [rodRoot, server] });
    const result = runOrphanSweep(deps, { yes: false, ...opts });
    expect(result.ran).toBe(true);
    expect(result.found).toHaveLength(1);
  });
});
