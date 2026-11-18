import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pidStartEpoch } from "./liveness";
import { sweepStaleShells, defaultStaleShellDeps } from "./stale-shells-run";
import { ORPHAN_PS_ARGS, parsePsTable } from "./worktree-orphans-ps";

// A real setsid'd group leader carrying the wrapper-shaped argv is a POSIX
// fact no injected seam proves. The defaults are inert under Node, so this
// file injects node:child_process-backed readers.
const describeOnPosix =
  process.platform === "win32" || spawnSync("perl", ["-e", "1"]).status !== 0
    ? describe.skip
    : describe;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describeOnPosix("sweepStaleShells (live)", () => {
  let root: string;
  const spawned: number[] = [];

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ss-live-")));
  });

  afterEach(() => {
    for (const pid of spawned) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    spawned.length = 0;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("should stop a setsid'd wrapper-shaped shell that watches a closed state file", async () => {
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir);
    const watched = path.join(stateDir, "live-slug.json");
    const argv0 = `/bin/zsh -c source ${root}/.claude/shell-snapshots/snapshot-zsh-1-a.sh && eval 'sleep 300 ${watched}' < /dev/null && pwd -P >| /tmp/claude-live-cwd`;
    // perl setsid()s then exec's a second perl that sleeps; the wrapper-shaped
    // text rides along as an ignored operand so `ps` shows it. A short-lived
    // `sh` parent backgrounds it so init reaps it (a zombie child of the test
    // process would still answer kill -0).
    const pid = await new Promise<number>((resolve, reject) => {
      const sh = spawn(
        "sh",
        [
          "-c",
          'perl -MPOSIX -e "POSIX::setsid(); exec @ARGV" perl -e "sleep 300" "$1" >/dev/null 2>&1 </dev/null & echo $!',
          "sh",
          argv0,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let out = "";
      sh.stdout.on("data", (d) => (out += String(d)));
      sh.on("error", reject);
      sh.on("close", () => resolve(Number(out.trim())));
    });
    spawned.push(pid);
    for (let i = 0; i < 150 && !alive(pid); i++) spawnSync("sleep", ["0.1"]);

    const deps = {
      ...defaultStaleShellDeps({ stateDir, home: root }),
      listProcs: () => {
        const r = spawnSync("ps", [...ORPHAN_PS_ARGS], {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C" },
        });
        return r.status === 0 ? parsePsTable(r.stdout) : undefined;
      },
      startEpochOf: (p: number) =>
        pidStartEpoch(p, {
          spawnPs: (q, env) => {
            const r = spawnSync("ps", ["-o", "lstart=", "-p", String(q)], {
              encoding: "utf8",
              env,
            });
            return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
          },
        }),
      paneWindows: () => new Map(),
      registeredPids: () => new Set<number>(),
      // the test runner is not a Claude child, so mark the leader as one
      selfPid: process.pid,
    };
    let procs = deps.listProcs() ?? [];
    // setsid() and exec land a beat after the pid is visible
    for (let i = 0; i < 150; i++) {
      const seen = procs.find((p) => p.pid === pid);
      if (seen?.pgid === pid && seen.command.includes("eval '")) break;
      spawnSync("sleep", ["0.1"]);
      procs = deps.listProcs() ?? [];
    }
    const row = procs.find((p) => p.pid === pid);
    expect(row?.pgid).toBe(pid);

    const r = sweepStaleShells(
      { ...deps, listProcs: () => procs },
      { act: true, targets: [{ slug: "live-slug" }], minAgeSec: 0 },
    );

    expect(r.signalled).toContain(pid);
    for (let i = 0; i < 30 && alive(pid); i++) spawnSync("sleep", ["0.1"]);
    expect(alive(pid)).toBe(false);
  }, 60_000);
});
