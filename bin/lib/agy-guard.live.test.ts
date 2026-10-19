import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GUARD_DEADLINE_MARKER } from "./agy-guard";

// Real process groups, real signals, fake `agy` shell scripts in a temp
// dir: the facts no injected seam in agy-guard.test.ts can prove. POSIX
// only. Every signal below targets a pid or group this test started;
// nothing here ever touches a real `agy`.
const hasBun =
  spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
const describeLive =
  process.platform === "win32" || !hasBun ? describe.skip : describe;

const GUARD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "agy-guard.ts",
);

let dir: string;
const tracked = new Set<number>();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-guard-live-"));
});

afterEach(() => {
  for (const pid of tracked) {
    for (const target of [pid, -pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // ESRCH: already gone
      }
    }
  }
  tracked.clear();
  fs.rmSync(dir, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return !ps.stdout.trim().startsWith("Z");
}

function readPid(name: string): number | undefined {
  try {
    const n = Number(fs.readFileSync(path.join(dir, name), "utf8").trim());
    return Number.isInteger(n) && n > 1 ? n : undefined;
  } catch {
    return undefined;
  }
}

function track(name: string): number {
  const pid = readPid(name);
  if (pid === undefined) throw new Error(`pid file ${name} missing`);
  tracked.add(pid);
  return pid;
}

function writeFake(name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

const FORKING_LOOP = (d: string) =>
  `echo $$ > ${d}/agy.pid\nsleep 300 &\necho $! > ${d}/helper.pid\nwhile :; do sleep 1; done`;

describeLive("agy-guard against real processes", () => {
  it("(1) sweeps a helper left behind after agy exits", async () => {
    const fake = writeFake(
      "agy",
      `sleep 300 &\necho $! > ${dir}/helper.pid\nexit 1`,
    );
    const r = spawnSync("bun", [GUARD, "--deadline-ms", "60000", "--", fake], {
      encoding: "utf8",
      timeout: 20_000,
    });
    const helper = track("helper.pid");
    expect(r.status).toBe(1);
    expect(await waitFor(() => !isAlive(helper), 2000)).toBe(true);
  }, 30_000);

  it("(2) force-kills an agy that ignores the polite stop at the deadline", async () => {
    const fake = writeFake(
      "agy",
      `echo $$ > ${dir}/agy.pid\ntrap '' TERM\nwhile :; do sleep 1; done`,
    );
    const r = spawnSync("bun", [GUARD, "--deadline-ms", "500", "--", fake], {
      encoding: "utf8",
      timeout: 20_000,
    });
    const agy = track("agy.pid");
    expect(r.status).toBe(124);
    expect(r.stderr).toContain(GUARD_DEADLINE_MARKER);
    expect(r.stderr).toContain("--print-timeout");
    expect(await waitFor(() => !isAlive(agy), 7000)).toBe(true);
  }, 30_000);

  it("(3) survives a force-kill of the parent's whole process group and stops agy", async () => {
    const fake = writeFake("agy", FORKING_LOOP(dir));
    const parent = path.join(dir, "parent.ts");
    fs.writeFileSync(
      parent,
      `import { openSync } from "node:fs";
const [bun, guard, fake, out] = process.argv.slice(2);
const fd = openSync(out, "w");
Bun.spawnSync([bun, guard, "--deadline-ms", "60000", "--", fake], {
  stdin: "ignore",
  stdout: fd,
  stderr: "pipe",
  detached: true,
});
`,
    );
    const p = spawn(
      "bun",
      [parent, "bun", GUARD, fake, path.join(dir, "out.txt")],
      { detached: true, stdio: "ignore" },
    );
    const parentPid = p.pid as number;
    tracked.add(parentPid);
    expect(
      await waitFor(
        () =>
          readPid("agy.pid") !== undefined &&
          readPid("helper.pid") !== undefined,
        10_000,
      ),
    ).toBe(true);
    const agy = track("agy.pid");
    const helper = track("helper.pid");
    expect(isAlive(agy)).toBe(true);

    process.kill(-parentPid, "SIGKILL");

    expect(await waitFor(() => !isAlive(agy) && !isAlive(helper), 4000)).toBe(
      true,
    );
  }, 30_000);

  it("(4) stops agy when an intermediate shell starts the guard and exits", async () => {
    const fake = writeFake("agy", FORKING_LOOP(dir));
    spawnSync("sh", ["-c", `bun ${GUARD} --deadline-ms 60000 -- ${fake} &`], {
      stdio: "ignore",
      timeout: 10_000,
    });
    expect(
      await waitFor(() => readPid("helper.pid") !== undefined, 10_000),
    ).toBe(true);
    const agy = track("agy.pid");
    const helper = track("helper.pid");
    expect(await waitFor(() => !isAlive(agy) && !isAlive(helper), 4000)).toBe(
      true,
    );
  }, 30_000);
});
