import { afterEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

// Real process groups, real signals and real `ps` output are facts no
// injected seam proves. POSIX-only, and launched through bun like
// bin/flow-spawn.live.test.ts. Every pid checked here is one this test
// recorded (never a host-wide pgrep).
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function psLines(): string[] {
  const r = spawnSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split("\n") : [];
}

function pidsMatching(needle: string): number[] {
  return psLines()
    .filter((l) => l.includes(needle))
    .map((l) => Number(l.trim().split(/\s+/, 1)[0]))
    .filter((p) => Number.isInteger(p) && p !== process.pid);
}

const burnersOf = (helperPid: number): number[] =>
  pidsMatching(`__burn ${helperPid} `);

async function until(
  pred: () => boolean,
  timeoutMs: number,
  stepMs = 50,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}

describeOnPosix("flow-stress (live end-to-end)", () => {
  const helpers: ChildProcess[] = [];
  const markers: string[] = [];

  afterEach(() => {
    const victims = new Set<number>();
    for (const h of helpers) {
      if (h.pid !== undefined) {
        victims.add(h.pid);
        for (const b of burnersOf(h.pid)) victims.add(b);
      }
    }
    for (const m of markers) for (const p of pidsMatching(m)) victims.add(p);
    for (const pid of victims) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    helpers.length = 0;
    markers.length = 0;
  });

  function launch(args: string[]): {
    child: ChildProcess;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  } {
    const child = spawn("bun", ["bin/flow-stress.ts", ...args], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    helpers.push(child);
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) =>
      child.on("close", (code, signal) => resolve({ code, signal })),
    );
    return { child, exited };
  }

  const uniqueSleep = (): string => {
    const marker = `300.${process.pid}${Date.now()}`;
    markers.push(marker);
    return marker;
  };

  it("propagates the command's exit code and leaves no burner on a normal exit", async () => {
    const { child, exited } = launch([
      "--cpu",
      "2",
      "--max-sec",
      "30",
      "--",
      "sh",
      "-c",
      "exit 7",
    ]);
    expect((await exited).code).toBe(7);
    expect(await until(() => burnersOf(child.pid!).length === 0, 3000)).toBe(
      true,
    );
  }, 20_000);

  it("exits 124 on timeout with the command and every burner gone", async () => {
    const marker = uniqueSleep();
    const { child, exited } = launch([
      "--cpu",
      "2",
      "--max-sec",
      "2",
      "--",
      "sleep",
      marker,
    ]);
    expect((await exited).code).toBe(124);
    expect(await until(() => burnersOf(child.pid!).length === 0, 3000)).toBe(
      true,
    );
    expect(await until(() => pidsMatching(marker).length === 0, 3000)).toBe(
      true,
    );
  }, 30_000);

  it("exits 143 on SIGTERM and leaves no burner", async () => {
    const marker = uniqueSleep();
    const { child, exited } = launch([
      "--cpu",
      "2",
      "--max-sec",
      "60",
      "--",
      "sleep",
      marker,
    ]);
    expect(await until(() => burnersOf(child.pid!).length >= 2, 5000)).toBe(
      true,
    );
    child.kill("SIGTERM");
    expect((await exited).code).toBe(143);
    expect(await until(() => burnersOf(child.pid!).length === 0, 3000)).toBe(
      true,
    );
    expect(await until(() => pidsMatching(marker).length === 0, 3000)).toBe(
      true,
    );
  }, 30_000);

  it("stops every burner within 3 s when the helper is SIGKILLed", async () => {
    const marker = uniqueSleep();
    const { child, exited } = launch([
      "--cpu",
      "2",
      "--max-sec",
      "60",
      "--",
      "sleep",
      marker,
    ]);
    expect(await until(() => burnersOf(child.pid!).length >= 2, 5000)).toBe(
      true,
    );
    child.kill("SIGKILL");
    await exited;
    expect(await until(() => burnersOf(child.pid!).length === 0, 3000)).toBe(
      true,
    );
  }, 30_000);
});
