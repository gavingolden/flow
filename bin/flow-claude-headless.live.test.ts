import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Real processes, a FAKE `claude` shell script first on a temp PATH (temp
// HOME, so no real config or telemetry is touched). Every signal targets a
// pid or group this test started. POSIX only.
const hasBun =
  spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
const describeLive =
  process.platform === "win32" || !hasBun ? describe.skip : describe;

const HEADLESS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "flow-claude-headless.ts",
);

let dir: string;
const tracked = new Set<number>();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-claude-headless-live-"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.mkdirSync(path.join(dir, "home"));
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

describeLive("flow-claude-headless caller-death cleanup", () => {
  it("stops the claude -p group (leader and helper) once its caller exits", async () => {
    fs.writeFileSync(
      path.join(dir, "bin", "claude"),
      `#!/bin/sh\necho $$ > ${dir}/claude.pid\nsleep 300 >/dev/null 2>&1 &\necho $! > ${dir}/helper.pid\nwhile :; do sleep 1; done\n`,
      { mode: 0o755 },
    );
    const env = { ...process.env };
    delete env.FLOW_HEADLESS_DEPTH;
    delete env.FLOW_SLUG;
    env.HOME = path.join(dir, "home");
    env.PATH = `${path.join(dir, "bin")}:${process.env.PATH ?? ""}`;
    // The intermediate shell backgrounds the wrapper and exits at once, so
    // the wrapper's caller (its parent) is gone while claude -p still runs.
    spawnSync(
      "sh",
      [
        "-c",
        `bun ${HEADLESS} --prompt hi --model sonnet --effort low --timeout-sec 120 --out ${dir}/out.json >/dev/null 2>&1 &`,
      ],
      { env, stdio: "ignore", timeout: 10_000 },
    );
    expect(
      await waitFor(
        () =>
          readPid("claude.pid") !== undefined &&
          readPid("helper.pid") !== undefined,
        15_000,
      ),
    ).toBe(true);
    const claude = track("claude.pid");
    const helper = track("helper.pid");
    expect(
      await waitFor(() => !isAlive(claude) && !isAlive(helper), 8000),
    ).toBe(true);
  }, 40_000);
});
