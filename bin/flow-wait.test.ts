import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { run } from "./flow-wait";
import {
  EXIT_CODES,
  owningClaude,
  parseWaitArgs,
  runWait,
  WAIT_MAX_SEC_CAP,
  type GenericWaitDeps,
} from "./lib/wait-loop";
import type { OrphanProc } from "./lib/worktree-orphans";

function fakeDeps(over: Partial<GenericWaitDeps> = {}) {
  let t = 0;
  const deps: GenericWaitDeps = {
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
    readState: () => ({ exists: true, phase: "implementing" }),
    windowGone: () => false,
    runCondition: () => Promise.resolve(false),
    parentGone: () => false,
    ...over,
  };
  return deps;
}

describe("parseWaitArgs", () => {
  it("should parse the full flag set and the condition after --", () => {
    expect(
      parseWaitArgs([
        "--max-sec",
        "600",
        "--every",
        "5",
        "--state",
        "foo",
        "--phase",
        "merged,gated",
        "--window",
        "@7",
        "--",
        "test",
        "-f",
        "x",
      ]),
    ).toEqual({
      maxSec: 600,
      everySec: 5,
      slug: "foo",
      phases: ["merged", "gated"],
      window: "@7",
      condition: ["test", "-f", "x"],
    });
  });

  it.each([
    [[], "--max-sec is required"],
    [["--max-sec", "0", "--phase", "x"], "positive integer"],
    [["--max-sec", String(WAIT_MAX_SEC_CAP + 1), "--", "true"], "at most"],
    [["--max-sec", "5"], "give --phase"],
    [["--max-sec", "5", "--phase", "merged"], "requires --state"],
    [["--max-sec", "5", "--window", "foo", "--", "true"], "tmux window id"],
    [["--max-sec", "5", "--bogus", "1", "--", "true"], "unknown flag"],
    [["--max-sec", "5", "--"], "condition command"],
  ])("should reject %j", (argv, msg) => {
    const r = parseWaitArgs(argv);
    expect("error" in r && r.error).toContain(msg);
  });
});

describe("runWait", () => {
  const base = { maxSec: 100, everySec: 10 };

  it("should return met when the phase is wanted", async () => {
    const r = await runWait(
      { ...base, slug: "foo", phases: ["merged"] },
      fakeDeps({ readState: () => ({ exists: true, phase: "merged" }) }),
    );
    expect(r).toEqual({ outcome: "met", elapsedSec: 0, phase: "merged" });
  });

  it("should return met when the condition passes after a few ticks", async () => {
    let n = 0;
    const r = await runWait(
      { ...base, condition: ["x"] },
      fakeDeps({ runCondition: () => Promise.resolve(++n === 3) }),
    );
    expect(r).toMatchObject({ outcome: "met", elapsedSec: 20 });
  });

  it("should time out at the deadline", async () => {
    const r = await runWait({ ...base, condition: ["x"] }, fakeDeps());
    expect(r).toMatchObject({ outcome: "timeout", elapsedSec: 100 });
  });

  it("should exit state-gone once a seen state file disappears", async () => {
    let n = 0;
    const r = await runWait(
      { ...base, slug: "foo", phases: ["merged"] },
      fakeDeps({
        readState: () =>
          n++ < 2 ? { exists: true, phase: "plan" } : { exists: false },
      }),
    );
    expect(r.outcome).toBe("state-gone");
  });

  it("should give a never-seen state file a 30 s creation grace", async () => {
    let n = 0;
    const r = await runWait(
      { ...base, slug: "foo", phases: ["merged"] },
      fakeDeps({
        readState: () =>
          ++n <= 2 ? { exists: false } : { exists: true, phase: "merged" },
      }),
    );
    expect(r.outcome).toBe("met");
    const never = await runWait(
      { ...base, slug: "foo", phases: ["merged"] },
      fakeDeps({ readState: () => ({ exists: false }) }),
    );
    expect(never).toMatchObject({ outcome: "state-gone", elapsedSec: 30 });
  });

  it("should exit window-gone and phase-terminal", async () => {
    expect(
      (
        await runWait(
          { ...base, window: "@7", condition: ["x"] },
          fakeDeps({ windowGone: () => true }),
        )
      ).outcome,
    ).toBe("window-gone");
    const r = await runWait(
      { ...base, slug: "foo", phases: ["merged"] },
      fakeDeps({ readState: () => ({ exists: true, phase: "needs-human" }) }),
    );
    expect(r).toMatchObject({
      outcome: "phase-terminal",
      phase: "needs-human",
    });
  });

  it("should check parent-gone before anything else", async () => {
    const runCondition = vi.fn(() => Promise.resolve(true));
    const r = await runWait(
      { ...base, condition: ["x"] },
      fakeDeps({ parentGone: () => true, runCondition }),
    );
    expect(r.outcome).toBe("parent-gone");
    expect(runCondition).not.toHaveBeenCalled();
  });
});

describe("owningClaude", () => {
  const p = (pid: number, ppid: number, command: string): OrphanProc => ({
    pid,
    ppid,
    pgid: pid,
    uid: 1,
    tty: null,
    ageSec: 1,
    cpuSec: 0,
    command,
    cwd: null,
  });

  it("should find the nearest claude ancestor through the zsh wrapper", () => {
    const procs = [
      p(1, 0, "launchd"),
      p(10, 1, "/Users/x/.local/bin/claude --y"),
      p(20, 10, "/bin/zsh -c eval"),
      p(30, 20, "bun flow-wait"),
    ];
    expect(owningClaude(30, procs, () => 99)).toEqual({
      pid: 10,
      startEpoch: 99,
    });
  });

  it("should return null when no ancestor is claude", () => {
    expect(owningClaude(30, [p(30, 1, "bun x")])).toBeNull();
  });
});

describe("run", () => {
  it("should print one JSON line and map the outcome to its exit code", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await run(
      ["--max-sec", "5", "--every", "5", "--", "x"],
      fakeDeps(),
    );
    expect(code).toBe(EXIT_CODES.timeout);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      outcome: "timeout",
    });
    log.mockRestore();
  });

  it("should exit 2 with usage on bad args", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await run(["--max-sec", "x"], fakeDeps())).toBe(2);
    err.mockRestore();
  });
});

describe("flow-wait CLI (real process)", () => {
  const bun = spawnSync("bun", ["--version"]).status === 0;
  const script = path.join(__dirname, "flow-wait.ts");

  it.skipIf(!bun)(
    "should meet a passing condition with its own process group",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-"));
      fs.writeFileSync(path.join(dir, "ok"), "");
      const r = spawnSync(
        "bun",
        [
          script,
          "--max-sec",
          "5",
          "--every",
          "1",
          "--",
          "test",
          "-f",
          path.join(dir, "ok"),
        ],
        {
          encoding: "utf8",
        },
      );
      fs.rmSync(dir, { recursive: true, force: true });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ outcome: "met" });
    },
    20_000,
  );

  it.skipIf(!bun)(
    "should time out with exit 3 on a failing condition",
    () => {
      const r = spawnSync(
        "bun",
        [script, "--max-sec", "1", "--every", "1", "--", "false"],
        { encoding: "utf8" },
      );
      expect(r.status).toBe(3);
    },
    20_000,
  );
});
