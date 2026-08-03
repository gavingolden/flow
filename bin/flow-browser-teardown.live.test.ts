import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Real pgid isolation and a real group-kill reaching a spawned subtree are
// facts no injected seam in flow-browser-teardown.test.ts can prove — this
// is the one end-to-end suite that runs the actual `--reap` CLI against a
// real process tree. `ps`'s pgid column and negative-pid group signalling
// are POSIX-only, so the whole file is a no-op on win32.
//
// This file matches the vitest include glob `bin/**/*.test.ts`, so it runs
// in CI on ubuntu-latest too — every `ps` invocation and assertion below
// must be portable across macOS and Linux. That is exactly what contract
// adjustment A2 in bin/flow-browser-teardown.ts guards (a per-row `ps -g
// <pgid>` would plausibly over-match on Linux); the "real reap" case below
// is the positive proof that the membership check admits legitimate
// descendants on both platforms rather than silently over-refusing.
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/**
 * A pid that (barring an implausible coincidence) never resolves to a real
 * `claude` process in the live table — passed to every `--reap` invocation
 * below as `--session-pid` so the ancestry FALLBACK's explicit-sessionPid
 * verification always fails closed (`no-session-pid`), and the fallback
 * never walks THIS HOST's real process ancestry. Only the registry-driven
 * reap path is under test here; the fallback's own behaviour is already
 * covered by the injected-Deps suite in flow-browser-teardown.test.ts —
 * exercising it for real here would risk signalling a real
 * chrome-devtools-mcp server if this suite happens to run inside a live
 * flow-pipeline session.
 */
const UNRESOLVABLE_SESSION_PID = "999999999";

function psInfo(
  pid: number,
): { pid: number; pgid: number; ppid: number } | undefined {
  const r = spawnSync("ps", ["-o", "pid=,pgid=,ppid=", "-p", String(pid)], {
    encoding: "utf8",
  });
  if (r.status !== 0) return undefined;
  const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(r.stdout.trim());
  if (!m) return undefined;
  return { pid: Number(m[1]), pgid: Number(m[2]), ppid: Number(m[3]) };
}

/** Every pgid among the direct children of `ppid` — used to close the leak
 * window when `waitForRow` times out before the registry row (and its
 * pgid) is ever recorded, so the afterEach kill still targets the
 * launched-but-unrecorded process group instead of only the wrapper. */
function childPgids(ppid: number): number[] {
  const r = spawnSync("ps", ["-A", "-o", "pid=,pgid=,ppid="], {
    encoding: "utf8",
  });
  if (r.status !== 0) return [];
  const pgids = new Set<number>();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    if (Number(m[3]) === ppid) pgids.add(Number(m[2]));
  }
  return [...pgids];
}

/** Direct child PIDS (not pgids) of `ppid` — used to prove a group kill
 * reached a spawned grandchild, not merely the recorded leader pid. */
function directChildPids(ppid: number): number[] {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  if (r.status !== 0) return [];
  const pids: number[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    if (Number(m[2]) === ppid) pids.push(Number(m[1]));
  }
  return pids;
}

type LiveRow = {
  pid: number;
  pgid: number;
  slug: string;
  class: string;
  argv: string[];
  recordedAt: number;
  sessionPid: number | null;
  sessionStartEpoch: number | null;
};

async function waitForRow(
  jsonlPath: string,
  timeoutMs = 2000,
): Promise<LiveRow> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(jsonlPath)) {
      const text = fs.readFileSync(jsonlPath, "utf8").trim();
      if (text.length > 0) {
        return JSON.parse(text.split("\n")[0]) as LiveRow;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for a registry row at ${jsonlPath}`);
}

/** Polls until `ppid` has at least `minCount` direct children, or the
 * timeout elapses (returning whatever was found). `sh -c "sleep 30 & sleep
 * 30"` forks its background job a moment after the parent itself starts,
 * so this closes that startup race. */
async function waitForChildren(
  ppid: number,
  minCount: number,
  timeoutMs = 2000,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let kids = directChildPids(ppid);
  while (kids.length < minCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    kids = directChildPids(ppid);
  }
  return kids;
}

type ReapCliRow = {
  pid: number;
  pgid: number;
  class: string;
  outcome: string;
  signals: string[];
};

type ReapCliResult = {
  registry: { ran: boolean; rows: ReapCliRow[] };
};

function runReapCli(
  home: string,
  slug: string,
  extraArgs: string[] = [],
): ReapCliResult {
  const r = spawnSync(
    "bun",
    [
      "bin/flow-browser-teardown.ts",
      "--reap",
      "--slug",
      slug,
      "--session-pid",
      UNRESOLVABLE_SESSION_PID,
      "--json",
      ...extraArgs,
    ],
    { cwd: repoRoot, env: { ...process.env, HOME: home }, encoding: "utf8" },
  );
  if (r.error || r.status !== 0) {
    throw new Error(
      `flow-browser-teardown --reap exited ${r.status}: ${r.stderr}`,
    );
  }
  return JSON.parse(r.stdout) as ReapCliResult;
}

describeOnPosix("flow-browser-teardown --reap (live end-to-end)", () => {
  let home: string;
  // Torn down unconditionally in afterEach so a failed assertion above can
  // never leak a sleeper past the suite. Never assert via a host-global
  // `pgrep -f` — that false-positives against an unrelated developer
  // process on the same host; every check here targets a SPECIFIC pid this
  // test itself recorded.
  let cleanupPgids: number[];
  let cleanupPids: number[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "flow-teardown-live-home-"));
    cleanupPgids = [];
    cleanupPids = [];
  });

  afterEach(() => {
    for (const pgid of cleanupPgids) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // already gone — fine
      }
    }
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone — fine
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  function launchEnv(): NodeJS.ProcessEnv {
    const { FLOW_SLUG: _dropped, ...rest } = process.env;
    return { ...rest, HOME: home };
  }

  async function launchSleeper(slug: string): Promise<LiveRow> {
    const jsonlPath = path.join(
      home,
      ".flow",
      "state",
      "procs",
      `${slug}.jsonl`,
    );

    // NEVER await this — it stays alive (bounded to two `sleep 30`s) until
    // this suite's afterEach kill (or the reap CLI's own kill, in the
    // destructive cases below).
    const wrapper = spawn(
      "bun",
      [
        "bin/flow-spawn.ts",
        "--slug",
        slug,
        "--",
        "sh",
        "-c",
        "sleep 30 & sleep 30",
      ],
      { cwd: repoRoot, env: launchEnv(), stdio: "ignore" },
    );
    if (wrapper.pid !== undefined) cleanupPids.push(wrapper.pid);

    let row: LiveRow;
    try {
      row = await waitForRow(jsonlPath);
    } catch (e) {
      if (wrapper.pid !== undefined) {
        for (const pgid of childPgids(wrapper.pid)) cleanupPgids.push(pgid);
      }
      throw e;
    }
    cleanupPgids.push(row.pgid);
    return row;
  }

  it("dry-run: sends no signal — both the parent and its child are still alive afterwards", async () => {
    const slug = `live-reap-dry-${process.pid}-${Date.now()}`;
    const row = await launchSleeper(slug);
    const children = await waitForChildren(row.pid, 1);
    expect(
      children.length,
      "expected the launched sleeper to have forked at least one child",
    ).toBeGreaterThan(0);

    const result = runReapCli(home, slug, ["--dry-run"]);
    expect(result.registry.ran).toBe(true);
    expect(result.registry.rows).toHaveLength(1);
    expect(result.registry.rows[0].outcome).toBe("would-reap");
    expect(result.registry.rows[0].signals).toEqual([]);

    expect(
      psInfo(row.pid),
      "expected the parent to still be alive",
    ).toBeDefined();
    expect(
      psInfo(children[0]),
      "expected the child to still be alive",
    ).toBeDefined();
  });

  it("real reap: kill(-pgid) reaches the whole subtree — the parent AND its child are both gone", async () => {
    const slug = `live-reap-real-${process.pid}-${Date.now()}`;
    const row = await launchSleeper(slug);
    const children = await waitForChildren(row.pid, 1);
    expect(children.length).toBeGreaterThan(0);
    const childPid = children[0];

    const result = runReapCli(home, slug);
    expect(result.registry.ran).toBe(true);
    expect(result.registry.rows).toHaveLength(1);
    expect(result.registry.rows[0].outcome).toBe("reaped");

    // The CLI's own bounded grace-wait already ran before returning; a
    // short extra poll absorbs the remaining margin for `ps` to catch up
    // to the kernel's own bookkeeping.
    const deadline = Date.now() + 2000;
    while (
      Date.now() < deadline &&
      (psInfo(row.pid) !== undefined || psInfo(childPid) !== undefined)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(psInfo(row.pid), "expected the parent to be gone").toBeUndefined();
    expect(psInfo(childPid), "expected the child to be gone").toBeUndefined();
  }, 15000);

  it("sibling: reaping one slug never touches a sibling slug's live sleeper", async () => {
    const slugA = `live-reap-sib-a-${process.pid}-${Date.now()}`;
    const slugB = `live-reap-sib-b-${process.pid}-${Date.now()}`;
    const rowA = await launchSleeper(slugA);
    const rowB = await launchSleeper(slugB);

    const result = runReapCli(home, slugA);
    expect(result.registry.rows).toHaveLength(1);
    expect(result.registry.rows[0].outcome).toBe("reaped");

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && psInfo(rowA.pid) !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(
      psInfo(rowA.pid),
      "expected slug-a's sleeper to be gone",
    ).toBeUndefined();
    expect(
      psInfo(rowB.pid),
      "expected slug-b's sleeper to be untouched",
    ).toBeDefined();
  }, 15000);

  it("epoch mismatch: a hand-written row with a mismatched startEpoch over a genuinely live pid is skipped, and the pid stays alive", async () => {
    const slug = `live-reap-epoch-${process.pid}-${Date.now()}`;
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const childPid = child.pid;
    if (childPid === undefined) {
      throw new Error("failed to spawn the epoch-mismatch sleeper");
    }
    cleanupPgids.push(childPid);
    cleanupPids.push(childPid);

    // Let the OS actually schedule/start it (and settle into its own
    // process group as the detached leader) before probing its pgid below.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const info = psInfo(childPid);
    if (info === undefined) {
      throw new Error("expected the hand-spawned sleeper to be alive");
    }

    const jsonlPath = path.join(
      home,
      ".flow",
      "state",
      "procs",
      `${slug}.jsonl`,
    );
    fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
    const row = {
      pgid: info.pgid,
      pid: childPid,
      // Deliberately wrong — the real process started long after epoch 1.
      startEpoch: 1,
      slug,
      class: "default",
      argv: ["sleep", "30"],
      recordedAt: Date.now(),
      sessionPid: null,
      sessionStartEpoch: null,
    };
    fs.appendFileSync(jsonlPath, `${JSON.stringify(row)}\n`);

    const result = runReapCli(home, slug);
    expect(result.registry.rows).toHaveLength(1);
    expect(result.registry.rows[0].outcome).toBe("skipped-epoch-mismatch");
    expect(result.registry.rows[0].signals).toEqual([]);

    expect(
      psInfo(childPid),
      "expected the epoch-mismatched pid to still be alive",
    ).toBeDefined();
  });
});
