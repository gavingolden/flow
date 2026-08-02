import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Real pgid isolation and a real, parseable row are facts no injected seam
// in flow-spawn.test.ts can prove — this is the one end-to-end test that
// launches through the actual `bin/flow-spawn.ts` binary. `ps`'s pgid
// column and negative-pid group signalling are POSIX-only, so the whole
// file is a no-op on win32.
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

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

describeOnPosix("flow-spawn (live end-to-end)", () => {
  let home: string;
  // Torn down unconditionally in afterEach so a failed assertion above can
  // never leak a sleeper past the suite. Never assert via a host-global
  // `pgrep -f` — that false-positives against an unrelated developer
  // process on the same host; every check here targets a SPECIFIC pid this
  // test itself recorded.
  let cleanupPgids: number[];
  let cleanupPids: number[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "flow-spawn-live-home-"));
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

  it("launches a real process in its own process group and records a matching row", async () => {
    const slug = `live-${process.pid}-${Date.now()}`;
    const jsonlPath = path.join(
      home,
      ".flow",
      "state",
      "procs",
      `${slug}.jsonl`,
    );

    // NEVER await this — it stays alive (bounded to two `sleep 30`s) until
    // the afterEach kill below; awaiting it would blow the suite's 5000ms
    // default test timeout.
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

    const row = await waitForRow(jsonlPath);
    cleanupPgids.push(row.pgid);

    expect(row.pgid).toBe(row.pid);
    expect(row.slug).toBe(slug);
    expect(row.class).toBe("default");
    expect(row.argv).toEqual(["sh", "-c", "sleep 30 & sleep 30"]);

    const childInfo = psInfo(row.pid);
    expect(
      childInfo,
      "expected the launched child to still be alive",
    ).toBeDefined();
    expect(childInfo!.pgid).toBe(row.pid);

    const wrapperInfo =
      wrapper.pid === undefined ? undefined : psInfo(wrapper.pid);
    expect(wrapperInfo, "expected the wrapper to still be alive").toBeDefined();
    // The wrapper was launched WITHOUT detached:true, so it inherits this
    // test process's own process group — a distinct group from the
    // detached child it spawned.
    expect(childInfo!.pgid).not.toBe(wrapperInfo!.pgid);
  });

  it("propagates the child's exit code end-to-end", () => {
    const slug = `live-exit-${process.pid}-${Date.now()}`;
    const r = spawnSync(
      "bun",
      ["bin/flow-spawn.ts", "--slug", slug, "--", "sh", "-c", "exit 42"],
      { cwd: repoRoot, env: launchEnv(), encoding: "utf8" },
    );
    expect(r.status).toBe(42);
  });
});
