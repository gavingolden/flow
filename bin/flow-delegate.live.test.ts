import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// End-to-end regression for the leaked-agy bug: the real `flow-delegate`
// binary against a FAKE `agy` shell script first on a temp PATH (temp HOME,
// so no real config or telemetry is touched). Never invokes a real agy and
// only signals pids/groups this test started. POSIX only.
const hasBun =
  spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
const describeLive =
  process.platform === "win32" || !hasBun ? describe.skip : describe;

const DELEGATE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "flow-delegate.ts",
);

let dir: string;
const tracked = new Set<number>();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-delegate-live-"));
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

function writeFakeAgy(body: string): void {
  fs.writeFileSync(path.join(dir, "bin", "agy"), `#!/bin/sh\n${body}\n`, {
    mode: 0o755,
  });
}

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: path.join(dir, "home"),
    PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}`,
  };
}

const ARGS = (out: string) => [
  DELEGATE,
  "--prompt",
  "hi",
  "--task",
  "leak",
  "--out",
  out,
];

describeLive("flow-delegate leaves nothing running", () => {
  it("stops a helper the fake agy forked once flow-delegate returns", async () => {
    writeFakeAgy(
      `sleep 300 >/dev/null 2>&1 &\necho $! > ${dir}/helper.pid\necho hello\nexit 0`,
    );
    const r = spawnSync("bun", ARGS(path.join(dir, "a.md")), {
      env: env(),
      encoding: "utf8",
      timeout: 30_000,
    });
    const helper = track("helper.pid");
    const lines = r.stdout.trim().split("\n");
    const envelope = JSON.parse(lines[lines.length - 1] as string);
    expect(envelope.task).toBe("leak");
    expect(await waitFor(() => !isAlive(helper), 2000)).toBe(true);
  }, 40_000);

  it("reports spawn-failed when the guard cannot start agy", () => {
    fs.writeFileSync(
      path.join(dir, "bin", "agy"),
      "#!/nonexistent/interpreter\n",
      { mode: 0o755 },
    );
    const r = spawnSync("bun", ARGS(path.join(dir, "c.md")), {
      env: env(),
      encoding: "utf8",
      timeout: 30_000,
    });
    const lines = r.stdout.trim().split("\n");
    const envelope = JSON.parse(lines[lines.length - 1] as string);
    expect(envelope.ran).toBe(false);
    expect(envelope.skipReason).toBe("spawn-failed");
    expect(envelope.stderrTail).toContain("could not start agy");
  }, 40_000);

  it("stops fake agy and its helper after the caller's whole process group is SIGKILLed", async () => {
    writeFakeAgy(
      `echo $$ > ${dir}/agy.pid\nsleep 300 >/dev/null 2>&1 &\necho $! > ${dir}/helper.pid\nwhile :; do sleep 1; done`,
    );
    const p = spawn("bun", ARGS(path.join(dir, "b.md")), {
      env: env(),
      detached: true,
      stdio: "ignore",
    });
    const groupId = p.pid as number;
    tracked.add(groupId);
    expect(
      await waitFor(
        () =>
          readPid("agy.pid") !== undefined &&
          readPid("helper.pid") !== undefined,
        15_000,
      ),
    ).toBe(true);
    const agy = track("agy.pid");
    const helper = track("helper.pid");
    expect(isAlive(agy)).toBe(true);

    process.kill(-groupId, "SIGKILL");

    expect(await waitFor(() => !isAlive(agy) && !isAlive(helper), 4000)).toBe(
      true,
    );
  }, 40_000);
});
