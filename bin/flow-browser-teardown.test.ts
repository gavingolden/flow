import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// runReapMode's toReapDeps bridge calls bin/lib/liveness.ts's pidStartEpoch
// directly (not via an injectable Deps field — see that function's own
// comment on why deps.startEpochMsOf's millisecond scale is wrong here), and
// pidStartEpoch's real path forks `ps` through `Bun.spawnSync` — unavailable
// under vitest's node runtime, and never hermetic against a fixture pid
// anyway. Mock just that one export, same technique as
// bin/lib/proc-registry.test.ts.
vi.mock("./lib/liveness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/liveness")>();
  return { ...actual, pidStartEpoch: vi.fn() };
});

import {
  classifyProfileShape,
  classifyReapEnvelope,
  descendantsOf,
  main,
  recordReapOutcome,
  resolveSessionPid,
  runOrphanSweep,
  runReapMode,
  runTeardown,
  selectMcpServers,
  selectOrphanBrowsers,
  selectOrphanMcpServers,
  summarizeReapEnvelope,
  type Deps,
  type ProcRow,
  type ReapEnvelope,
} from "./flow-browser-teardown";
import { appendRow } from "./lib/proc-registry";
import { pidStartEpoch } from "./lib/liveness";
import { readState, writeState } from "./lib/state";
import { FLOW_STATE_DIR } from "./lib/paths";

const mockedPidStartEpoch = vi.mocked(pidStartEpoch);

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
    // Distinct from every pgid used across this suite's fixtures (which stay
    // well under 100000) so the reap engine's self-pgid guard never fires
    // spuriously against an unrelated test's row.
    selfPgid: 424_242,
    // Default: the group contains only its own leader — consistent with
    // this suite's fixtures, which never construct a multi-member group.
    groupMembers: (pgid) => [pgid],
    ...overrides,
  };
}

/** A registry-covered, fallback-null reap envelope — the "nothing wrong"
 * baseline `classifyReapEnvelope` / `recordReapOutcome` tests mutate. */
function zeroReapCounts() {
  return {
    reaped: 0,
    "would-reap": 0,
    "already-dead": 0,
    "skipped-epoch-mismatch": 0,
    "skipped-unsafe-pgid": 0,
    "skipped-foreign-member": 0,
    "skipped-dead-leader": 0,
    "still-alive": 0,
    failed: 0,
    "deadline-exceeded": 0,
  };
}

function cleanEnvelope(slug: string): ReapEnvelope {
  return {
    mode: "reap",
    registry: {
      ran: true,
      dryRun: false,
      slug,
      rows: [],
      counts: zeroReapCounts(),
      malformed: 0,
    },
    fallback: null,
    fallbackSkipReason: "registry-covered",
    postRegistered: 0,
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

  // Regression: the selector used a bare `command.includes(...)` substring
  // test, so ANY in-session descendant whose command line merely MENTIONED
  // the string was a SIGTERM target. Verified live on 2026-07-31: it killed
  // an unrelated in-session `sleep` and the `zsh -c` wrapper of the Bash
  // call running the teardown itself (exit 144 = 128+SIGTERM), while no
  // real server was running at all.
  it("never selects a process that merely mentions the string in its argv", () => {
    const sessionPid = 100;
    const procs = [
      proc(sessionPid, 1, "claude --add-dir /w"),
      proc(201, sessionPid, "chrome-devtools-mcp"),
      proc(202, sessionPid, "grep -rn chrome-devtools-mcp skills/pipeline/"),
      proc(
        203,
        sessionPid,
        "/bin/zsh -c source /h/.claude/shell-snapshots/s.sh && flow-browser-teardown --json # chrome-devtools-mcp",
      ),
      proc(204, sessionPid, "vim bin/flow-browser-teardown.ts"),
      // A runtime process whose ENTRYPOINT-shaped string is only a search
      // pattern, not the script it runs.
      proc(205, sessionPid, "grep -rn node_modules/.bin/chrome-devtools-mcp ."),
    ];
    expect(selectMcpServers(procs, sessionPid).map((p) => p.pid)).toEqual([
      201,
    ]);
  });

  it("selects a runtime process whose script argument is the server entrypoint", () => {
    const sessionPid = 100;
    const procs = [
      proc(sessionPid, 1, "claude --add-dir /w"),
      proc(
        201,
        sessionPid,
        "/h/.fnm/node-versions/v24/installation/bin/node /h/.npm/_npx/abc/node_modules/.bin/chrome-devtools-mcp --isolated",
      ),
      proc(
        202,
        sessionPid,
        "/usr/local/bin/node /h/node_modules/chrome-devtools-mcp/build/src/index.js",
      ),
    ];
    expect(selectMcpServers(procs, sessionPid).map((p) => p.pid)).toEqual([
      201, 202,
    ]);
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

  // PR #491: a harder signal (or a group kill) skips the MCP server's own
  // `shutdown()` handler and orphans Chrome to PPID 1. This test's source
  // guard MUST stay enforceable even after this file's own PR introduces
  // SIGKILL for the reap engine's `default` class — see the companion
  // "never escalates" assertions over the recording kill spy in
  // `bin/lib/reap.test.ts`'s "mcp-server class" describe block, which
  // proves the same no-escalation invariant for `bin/lib/reap.ts`'s
  // mcp-server dispatch branch (that file legitimately contains the
  // SIGKILL literal for the unrelated `default` class, so a source-text
  // assertion can't be reused there).
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

    const source = fs.readFileSync(
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
    expect(result.signalled).toEqual([]);
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

  it("SCOPE-ESCAPE GUARD: an explicit sessionPid that does not resolve to a real claude process yields no-session-pid, never a whole-table sweep", () => {
    const deps = fakeDeps({
      env: {},
      listProcs: serverProcs,
      alive: () => false,
    });
    // pid 0 is the synthetic parent of pid 1 — descendantsOf(procs, 0) would
    // enumerate the entire process table if this guard were absent.
    for (const badPid of [0, 1, -5]) {
      const result = runTeardown(deps, {
        dryRun: false,
        sessionPid: badPid,
        timeoutMs: 1000,
      });
      expect(result.ran).toBe(false);
      expect(result.skipReason).toBe("no-session-pid");
    }
  });

  it("SCOPE-ESCAPE GUARD: an explicit sessionPid pointing at a real but non-claude process yields no-session-pid", () => {
    const deps = fakeDeps({
      env: {},
      listProcs: serverProcs,
      alive: () => false,
    });
    const result = runTeardown(deps, {
      dryRun: false,
      sessionPid: 201, // the chrome-devtools-mcp server row, not the claude row
      timeoutMs: 1000,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("no-session-pid");
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
  const serverCommand =
    "/usr/local/bin/node .../node_modules/chrome-devtools-mcp/build/src/main.js";

  it("selects a ppid-1 server and a parent-gone server; excludes a live-claude-parented server and the wrapper/watchdog", () => {
    const procs = [
      proc(10, 1, serverCommand), // ppid 1 -> selected
      proc(20, 9999, serverCommand), // parent gone -> selected
      proc(30, 1, "claude --add-dir /w"), // a live claude in the table
      proc(40, 30, serverCommand), // parented by a live claude -> not selected
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

  it("ENTRYPOINT-ANCHOR GUARD: a bare argv substring match at ppid 1 (not the real server entrypoint) is never selected", () => {
    const procs = [
      // A user's own process, or another user's nohup'd tail, that happens
      // to mention "chrome-devtools-mcp" in a log-path argument, but is not
      // the server binary itself.
      proc(70, 1, "tail -f /home/otheruser/.cache/chrome-devtools-mcp/out.log"),
      proc(71, 1, "nohup sh -c 'echo chrome-devtools-mcp watcher started' &"),
    ];
    expect(selectOrphanMcpServers(procs)).toEqual([]);
  });

  it("recognizes the node_modules/.bin/chrome-devtools-mcp entrypoint shape", () => {
    const procs = [
      proc(80, 1, "/path/to/node_modules/.bin/chrome-devtools-mcp --isolated"),
    ];
    expect(selectOrphanMcpServers(procs).map((p) => p.pid)).toEqual([80]);
  });

  // Regression (false NEGATIVE): the entrypoint regex alone never matched
  // the MOST COMMON live shape — argv[0] rewritten by the npx shim to the
  // bare `chrome-devtools-mcp`. Observed live: 12 of 12 server rows on the
  // host carried exactly that shape, so an orphan in that shape was swept
  // straight past and its Chrome left running.
  it("selects an orphaned server whose argv[0] is the bare rewritten name", () => {
    const procs = [
      proc(90, 1, "chrome-devtools-mcp"),
      proc(91, 1, "chrome-devtools-mcp  "), // trailing argv padding, as ps renders it
      proc(92, 7777, "chrome-devtools-mcp"), // parent gone -> also selected
    ];
    expect(selectOrphanMcpServers(procs).map((p) => p.pid)).toEqual([
      90, 91, 92,
    ]);
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
  const server = proc(
    700,
    9999,
    "/usr/local/bin/node .../node_modules/chrome-devtools-mcp/build/src/main.js",
  );

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

  it("dryRun true finds rows but never signals, even with yes:true", () => {
    const devChrome = proc(
      600,
      1,
      "chrome --enable-automation --disable-background-networking --user-data-dir=/Users/dev/.config/chrome-testing",
    );
    const kill = vi.fn();
    const deps = fakeDeps({
      listProcs: () => [rodRoot, devChrome, server],
      kill,
    });
    const result = runOrphanSweep(deps, { yes: true, dryRun: true, ...opts });
    expect(result.signalled).toEqual([]);
    expect(result.found.length + result.foundServers.length).toBeGreaterThan(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it("listProcs returning undefined yields ran:false with skipReason ps-unavailable", () => {
    const deps = fakeDeps({ listProcs: () => undefined });
    const result = runOrphanSweep(deps, { yes: false, ...opts });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("ps-unavailable");
    expect(result.found).toEqual([]);
    expect(result.foundServers).toEqual([]);
  });
});

describe("classifyProfileShape — verified live shapes that can result in a SIGTERM", () => {
  it("classifies puppeteer's isolated temp-profile shape (chrome-devtools-mcp-isolated), the shape marked UNCONFIRMED BY OBSERVATION but still allowlisted", () => {
    const opts = { homeDir: "/Users/dev", tmpDir: "/private/tmp/xyz" };
    expect(
      classifyProfileShape(
        "/private/tmp/xyz/puppeteer_dev_chrome_profile-AbC123",
        opts,
      ),
    ).toBe("chrome-devtools-mcp-isolated");

    // And feeding it through selectOrphanBrowsers end-to-end: matched:true,
    // eligible for --yes signalling.
    const command = `/path/to/chrome --enable-automation --disable-background-networking --user-data-dir=/private/tmp/xyz/puppeteer_dev_chrome_profile-AbC123`;
    const out = selectOrphanBrowsers([proc(900, 1, command)], opts);
    expect(out[0]).toMatchObject({
      profileShape: "chrome-devtools-mcp-isolated",
      matched: true,
    });
  });

  it("classifies the verified-live /var/folders/ temp root (macOS TMPDIR), matched:true and eligible for --yes", () => {
    const opts = { homeDir: "/Users/dev", tmpDir: "/private/tmp/xyz" };
    const userDataDir =
      "/var/folders/8z/abc123/T/rod/user-data/99b0c95236a886aa";
    expect(classifyProfileShape(userDataDir, opts)).toBe("go-rod-temp");

    const command = `/path/to/chrome --enable-automation --disable-background-networking --user-data-dir=${userDataDir}`;
    const out = selectOrphanBrowsers([proc(901, 1, command)], opts);
    expect(out[0]).toMatchObject({
      profileShape: "go-rod-temp",
      matched: true,
    });
  });
});

describe("runReapMode — fallback", () => {
  const sessionPid = 100;
  function serverProcs(): ProcRow[] {
    return [
      proc(sessionPid, 1, "claude --add-dir /w"),
      proc(201, sessionPid, "chrome-devtools-mcp"),
    ];
  }

  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-teardown-reap-test-"),
    );
    mockedPidStartEpoch.mockReset();
    mockedPidStartEpoch.mockReturnValue(1_000);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("an empty registry still runs the ancestry teardown and reports it under fallback with fallbackSkipReason null", () => {
    const deps = fakeDeps({
      listProcs: serverProcs,
      selfPid: sessionPid,
      alive: () => false,
    });
    const envelope = runReapMode(deps, {
      dryRun: false,
      slug: "empty-registry-slug",
      timeoutMs: 1000,
      baseDir,
    });
    expect(envelope.registry.ran).toBe(false);
    expect(envelope.registry.skipReason).toBe("no-rows");
    expect(envelope.fallback).not.toBeNull();
    expect(envelope.fallback?.ran).toBe(true);
    expect(envelope.fallbackSkipReason).toBeNull();
    // D3 post-hoc registration: the ancestry walk found a server the
    // registry didn't know about, so it gets recorded for a later reap.
    expect(envelope.postRegistered).toBe(1);
  });

  it("a registry carrying a LIVE mcp-server row does not run the fallback and reports registry-covered", () => {
    appendRow(
      {
        pgid: 500,
        pid: 500,
        startEpoch: 1_000,
        slug: "covered-slug",
        class: "mcp-server",
        argv: ["chrome-devtools-mcp"],
        recordedAt: 0,
        sessionPid: null,
        sessionStartEpoch: null,
      },
      baseDir,
    );
    const listProcs = vi.fn(serverProcs);
    const deps = fakeDeps({
      listProcs,
      selfPid: sessionPid,
      alive: () => true,
    });
    const envelope = runReapMode(deps, {
      // would-reap counts as "covered" too — dry-run never sends a signal
      // but still proves the registry already knows about this server.
      dryRun: true,
      slug: "covered-slug",
      timeoutMs: 1000,
      baseDir,
    });
    expect(envelope.registry.ran).toBe(true);
    expect(envelope.registry.rows[0]?.outcome).toBe("would-reap");
    expect(envelope.fallback).toBeNull();
    expect(envelope.fallbackSkipReason).toBe("registry-covered");
    // The ancestry walk never even runs when the registry already covers
    // the MCP surface.
    expect(listProcs).not.toHaveBeenCalled();
  });

  it("an unsatisfied FLOW_PIPELINE / --session-pid gate reports not-gated", () => {
    const deps = fakeDeps({
      env: {}, // FLOW_PIPELINE unset, no explicit sessionPid passed below
      listProcs: serverProcs,
      selfPid: sessionPid,
    });
    const envelope = runReapMode(deps, {
      dryRun: false,
      slug: "ungated-slug",
      timeoutMs: 1000,
      baseDir,
    });
    expect(envelope.fallback).toBeNull();
    expect(envelope.fallbackSkipReason).toBe("not-gated");
  });

  it("dryRun:true with a resolved slug performs ZERO registry writes — the post-hoc D3 registration guard's `opts.dryRun` arm", () => {
    const registryFile = path.join(baseDir, "procs", "dry-run-slug.jsonl");
    const listProcs = vi.fn(serverProcs);
    const deps = fakeDeps({
      listProcs,
      selfPid: sessionPid,
      alive: () => false,
    });
    const envelope = runReapMode(deps, {
      dryRun: true,
      slug: "dry-run-slug",
      timeoutMs: 1000,
      baseDir,
    });
    // The ancestry fallback still ran and found a server it would otherwise
    // post-hoc register, but dryRun:true must suppress the write entirely.
    expect(envelope.fallback?.ran).toBe(true);
    expect(envelope.postRegistered).toBe(0);
    expect(fs.existsSync(registryFile)).toBe(false);
  });

  it("a resolved slug with dryRun:false but no fallback servers found performs ZERO registry writes — the `slug === undefined` arm has no bearing here, but the loop body simply has nothing to append", () => {
    const registryFile = path.join(baseDir, "procs", "no-servers-slug.jsonl");
    const deps = fakeDeps({
      listProcs: () => [proc(sessionPid, 1, "claude --add-dir /w")],
      selfPid: sessionPid,
    });
    const envelope = runReapMode(deps, {
      dryRun: false,
      slug: "no-servers-slug",
      timeoutMs: 1000,
      baseDir,
    });
    expect(envelope.postRegistered).toBe(0);
    expect(fs.existsSync(registryFile)).toBe(false);
  });

  it("a satisfied gate with no MCP server under the session reports no-servers", () => {
    const deps = fakeDeps({
      listProcs: () => [proc(sessionPid, 1, "claude --add-dir /w")],
      selfPid: sessionPid,
    });
    const envelope = runReapMode(deps, {
      dryRun: false,
      slug: "no-servers-slug",
      timeoutMs: 1000,
      baseDir,
    });
    expect(envelope.fallback).toBeNull();
    expect(envelope.fallbackSkipReason).toBe("no-servers");
  });
});

describe("classifyReapEnvelope", () => {
  it("classifies a clean envelope as ok with no problems", () => {
    expect(classifyReapEnvelope(cleanEnvelope("clean-slug"))).toEqual({
      status: "ok",
      problems: [],
    });
  });

  it.each([
    "failed",
    "still-alive",
    "deadline-exceeded",
    "skipped-dead-leader",
  ] as const)("marks unclean when registry.counts.%s > 0", (countKey) => {
    const envelope = cleanEnvelope("unclean-slug");
    envelope.registry.counts[countKey] = 1;
    const result = classifyReapEnvelope(envelope);
    expect(result.status).toBe("unclean");
    expect(result.problems.some((p) => p.includes(countKey))).toBe(true);
  });

  it("marks unclean when registry.malformed > 0", () => {
    const envelope = cleanEnvelope("malformed-slug");
    envelope.registry.malformed = 1;
    const result = classifyReapEnvelope(envelope);
    expect(result.status).toBe("unclean");
    expect(result.problems.some((p) => p.includes("malformed"))).toBe(true);
  });

  it("marks unclean when fallback.stillAlive is non-empty", () => {
    const envelope = cleanEnvelope("fallback-slug");
    envelope.fallback = {
      ran: true,
      sessionPid: 100,
      dryRun: false,
      signalled: [],
      stillAlive: [201],
    };
    envelope.fallbackSkipReason = null;
    const result = classifyReapEnvelope(envelope);
    expect(result.status).toBe("unclean");
    expect(result.problems.some((p) => p.includes("stillAlive"))).toBe(true);
  });

  it("marks unclean when fallbackSkipReason is not-gated", () => {
    const envelope = cleanEnvelope("not-gated-slug");
    envelope.fallbackSkipReason = "not-gated";
    const result = classifyReapEnvelope(envelope);
    expect(result.status).toBe("unclean");
    expect(result.problems.some((p) => p.includes("not-gated"))).toBe(true);
  });

  it("stays ok for every safety-refusal skip reason (already-dead, skipped-epoch-mismatch, skipped-unsafe-pgid, skipped-foreign-member)", () => {
    const envelope = cleanEnvelope("safety-slug");
    envelope.registry.counts["already-dead"] = 1;
    envelope.registry.counts["skipped-epoch-mismatch"] = 1;
    envelope.registry.counts["skipped-unsafe-pgid"] = 1;
    envelope.registry.counts["skipped-foreign-member"] = 1;
    expect(classifyReapEnvelope(envelope)).toEqual({
      status: "ok",
      problems: [],
    });
  });
});

describe("recordReapOutcome", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-teardown-record-test-"),
    );
  });

  afterEach(() => {
    // Undo the permission-lockdown test's chmod before rmSync — deleting a
    // read-only FILE only needs write permission on the containing
    // directory, but leaving the file locked down is needless mess.
    for (const entry of fs.readdirSync(stateDir)) {
      fs.chmodSync(path.join(stateDir, entry), 0o644);
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("writes state.reap for an existing pipeline without bumping updatedAt", () => {
    writeState(
      {
        slug: "record-slug",
        phase: "merged",
        repo: "/tmp/repo",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      stateDir,
    );
    const envelope = cleanEnvelope("record-slug");
    const result = recordReapOutcome(envelope, {
      stateDir,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(result).toEqual({ written: true });
    const state = readState("record-slug", stateDir);
    expect(state?.reap).toEqual({
      at: "2026-01-02T00:00:00.000Z",
      status: "ok",
      summary: summarizeReapEnvelope(envelope),
      ran: true,
    });
    // A plain state write, not a phase transition — updatedAt must not move.
    expect(state?.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("records problems and ran:false when the registry never ran and the fallback didn't either", () => {
    const envelope = cleanEnvelope("unclean-record-slug");
    envelope.registry.ran = false;
    envelope.registry.dryRun = false;
    envelope.registry.counts.failed = 1;
    envelope.fallback = null;
    envelope.fallbackSkipReason = "not-gated";
    writeState(
      {
        slug: "unclean-record-slug",
        phase: "gated",
        repo: "/tmp/repo",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      stateDir,
    );
    const result = recordReapOutcome(envelope, {
      stateDir,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(result).toEqual({ written: true });
    const state = readState("unclean-record-slug", stateDir);
    expect(state?.reap?.status).toBe("unclean");
    expect(state?.reap?.ran).toBe(false);
    expect(state?.reap?.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("failed"),
        "fallback: not-gated",
      ]),
    );
  });

  it("returns {written:false} without creating a file when no state exists for the slug", () => {
    const envelope = cleanEnvelope("missing-state-slug");
    const result = recordReapOutcome(envelope, { stateDir });
    expect(result).toEqual({ written: false });
    expect(fs.existsSync(path.join(stateDir, "missing-state-slug.json"))).toBe(
      false,
    );
  });

  it("returns {written:false, warning} without throwing when the state file is unwritable", () => {
    writeState(
      {
        slug: "locked-slug",
        phase: "merged",
        repo: "/tmp/repo",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      stateDir,
    );
    const filePath = path.join(stateDir, "locked-slug.json");
    fs.chmodSync(filePath, 0o444);
    const envelope = cleanEnvelope("locked-slug");
    // A throw here would fail the test on its own — the assertions below
    // additionally pin the documented no-throw contract's return shape.
    const result = recordReapOutcome(envelope, { stateDir });
    expect(result.written).toBe(false);
    expect(result.warning).toBeTruthy();
  });
});

describe("main — --reap --record", () => {
  const originalSlug = process.env.FLOW_SLUG;
  const originalPipeline = process.env.FLOW_PIPELINE;

  afterEach(() => {
    if (originalSlug === undefined) delete process.env.FLOW_SLUG;
    else process.env.FLOW_SLUG = originalSlug;
    if (originalPipeline === undefined) delete process.env.FLOW_PIPELINE;
    else process.env.FLOW_PIPELINE = originalPipeline;
  });

  it("--dry-run --record never writes a state file, even for a resolvable slug", () => {
    // A random slug: main() has no state-dir injection seam, so this is the
    // only safe way to exercise the real FLOW_STATE_DIR without risking a
    // collision with a real pipeline's state file.
    const slug = `flow-teardown-test-${randomUUID()}`;
    delete process.env.FLOW_PIPELINE;
    const statePath = path.join(FLOW_STATE_DIR, `${slug}.json`);
    expect(fs.existsSync(statePath)).toBe(false);
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = main(["--reap", "--dry-run", "--record", "--slug", slug]);
      expect(code).toBe(0);
      expect(fs.existsSync(statePath)).toBe(false);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
      fs.rmSync(statePath, { force: true });
    }
  });

  it("writes the progress line to stderr (not stdout) and names the resolved slug", () => {
    delete process.env.FLOW_PIPELINE;
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = main([
        "--reap",
        "--dry-run",
        "--slug",
        "progress-line-slug",
      ]);
      expect(code).toBe(0);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "flow-browser-teardown: reaping registered processes for progress-line-slug…",
        ),
      );
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("suppresses the progress line under --json, and --json's stdout stays exactly one parseable envelope", () => {
    delete process.env.FLOW_SLUG;
    delete process.env.FLOW_PIPELINE;
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = main(["--reap", "--json", "--dry-run"]);
      expect(code).toBe(0);
      expect(errSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("reaping registered processes"),
      );
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(() =>
        JSON.parse(logSpy.mock.calls[0]?.[0] as string),
      ).not.toThrow();
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("main — --reap --json envelope", () => {
  it("emits one parseable object carrying mode, registry.rows, registry.counts, fallback, fallbackSkipReason, and postRegistered, and exits 0", () => {
    // Defensively cleared so the registry phase resolves no slug at all
    // (a true no-op, never touching ~/.flow/state/procs/) and the ancestry
    // fallback's own pipeline gate fails before any signal — --dry-run is
    // an additional belt-and-suspenders guard on top of that, since main()
    // has no CLI flag to sandbox the registry baseDir the way every other
    // reap test in this file does via an injected `baseDir`.
    const originalSlug = process.env.FLOW_SLUG;
    const originalPipeline = process.env.FLOW_PIPELINE;
    delete process.env.FLOW_SLUG;
    delete process.env.FLOW_PIPELINE;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = main(["--reap", "--json", "--dry-run"]);
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
      expect(parsed.mode).toBe("reap");
      expect(parsed).toHaveProperty("registry.rows");
      expect(parsed).toHaveProperty("registry.counts");
      expect(parsed).toHaveProperty("fallback");
      expect(parsed).toHaveProperty("fallbackSkipReason");
      expect(parsed).toHaveProperty("postRegistered");
    } finally {
      logSpy.mockRestore();
      if (originalSlug === undefined) delete process.env.FLOW_SLUG;
      else process.env.FLOW_SLUG = originalSlug;
      if (originalPipeline === undefined) delete process.env.FLOW_PIPELINE;
      else process.env.FLOW_PIPELINE = originalPipeline;
    }
  });
});

describe("summarizeReapEnvelope — summary", () => {
  it("names failed, still-alive, and skipped-* counts explicitly, and a non-null fallbackSkipReason when the fallback did not run", () => {
    const envelope: ReapEnvelope = {
      mode: "reap",
      registry: {
        ran: true,
        dryRun: false,
        slug: "summary-slug",
        rows: [],
        counts: {
          reaped: 0,
          "would-reap": 0,
          "already-dead": 0,
          "skipped-epoch-mismatch": 0,
          "skipped-unsafe-pgid": 1,
          "skipped-foreign-member": 0,
          "skipped-dead-leader": 0,
          "still-alive": 1,
          failed: 1,
          "deadline-exceeded": 0,
        },
        malformed: 0,
      },
      fallback: null,
      fallbackSkipReason: "not-gated",
      postRegistered: 0,
    };
    const line = summarizeReapEnvelope(envelope);
    expect(line).toContain("failed=1");
    expect(line).toContain("still-alive=1");
    expect(line).toContain("skipped-unsafe-pgid=1");
    expect(line).toContain("fallbackSkipReason=not-gated");
  });

  it("reports ran=true and no fallbackSkipReason when the fallback DID run", () => {
    const envelope: ReapEnvelope = {
      mode: "reap",
      registry: {
        ran: false,
        dryRun: false,
        skipReason: "no-rows",
        rows: [],
        counts: {
          reaped: 0,
          "would-reap": 0,
          "already-dead": 0,
          "skipped-epoch-mismatch": 0,
          "skipped-unsafe-pgid": 0,
          "skipped-foreign-member": 0,
          "skipped-dead-leader": 0,
          "still-alive": 0,
          failed: 0,
          "deadline-exceeded": 0,
        },
        malformed: 0,
      },
      fallback: {
        ran: true,
        sessionPid: 100,
        dryRun: false,
        signalled: [{ pid: 201, command: "chrome-devtools-mcp" }],
        stillAlive: [],
      },
      fallbackSkipReason: null,
      postRegistered: 0,
    };
    const line = summarizeReapEnvelope(envelope);
    expect(line).toContain("fallback: ran=true");
    expect(line).not.toContain("fallbackSkipReason");
  });
});
