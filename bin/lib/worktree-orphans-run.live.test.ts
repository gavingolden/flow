import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pidStartEpoch } from "./liveness";
import {
  ORPHAN_PS_ARGS,
  parseLsofCwd,
  parsePsTable,
} from "./worktree-orphans-ps";
import {
  defaultOrphanSweepDeps,
  sweepWorktreeOrphans,
  type OrphanSweepDeps,
} from "./worktree-orphans-run";

// Real orphan reparenting and `ps`/`lsof` columns are POSIX facts no injected
// seam proves. The defaults are inert under Node, so this file injects
// node:child_process-backed readers instead.
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

function nodeDeps(stateDir: string): OrphanSweepDeps {
  return {
    ...defaultOrphanSweepDeps({ stateDir }),
    listProcs: () => {
      const r = spawnSync("ps", [...ORPHAN_PS_ARGS], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      });
      return r.status === 0 ? parsePsTable(r.stdout) : undefined;
    },
    cwdOf: (pids) => {
      const r = spawnSync(
        "lsof",
        ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"],
        { encoding: "utf8" },
      );
      return parseLsofCwd(r.stdout ?? "");
    },
    startEpochOf: (pid) =>
      pidStartEpoch(pid, {
        spawnPs: (p, env) => {
          const r = spawnSync("ps", ["-o", "lstart=", "-p", String(p)], {
            encoding: "utf8",
            env,
          });
          return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
        },
      }),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A detached leader shell backgrounds `sleep` and exits, so the sleep is
// reparented to init with a dead process-group leader and no terminal.
function leaveOrphan(cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "sh",
      ["-c", "sleep 300 >/dev/null 2>&1 </dev/null & echo $!"],
      { cwd, detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.on("error", reject);
    child.on("close", () => resolve(Number(out.trim())));
  });
}

describeOnPosix("sweepWorktreeOrphans (live)", () => {
  let root: string;
  let wt: string;
  let sibling: string;
  const spawned: number[] = [];

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wo-live-")));
    wt = path.join(root, "wt");
    sibling = `${wt}-bar`;
    fs.mkdirSync(wt);
    fs.mkdirSync(sibling);
  });

  afterEach(() => {
    for (const pid of spawned) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    spawned.length = 0;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("should stop an orphan in the worktree and leave the -bar sibling alive", async () => {
    const mine = await leaveOrphan(wt);
    const theirs = await leaveOrphan(sibling);
    spawned.push(mine, theirs);
    // sleep needs a beat to be visible and for sh to be gone
    for (let i = 0; i < 50 && !(alive(mine) && alive(theirs)); i++) {
      spawnSync("sleep", ["0.1"]);
    }
    const stateDir = path.join(root, "state");
    const r = sweepWorktreeOrphans(nodeDeps(stateDir), {
      worktree: wt,
      act: true,
      busyOnly: false,
    });

    expect(r.signalled).toContain(mine);
    expect(r.signalled).not.toContain(theirs);
    for (let i = 0; i < 30 && alive(mine); i++) spawnSync("sleep", ["0.1"]);
    expect(alive(mine)).toBe(false);
    expect(alive(theirs)).toBe(true);
  }, 30_000);
});
