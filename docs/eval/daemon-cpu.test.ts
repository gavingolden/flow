import { describe, expect, it } from "vitest";
import {
  DAEMONS,
  diffSamples,
  main,
  median,
  parsePsOutput,
  parsePsTime,
  parseTopKernelTask,
  type DaemonSample,
} from "./daemon-cpu";

describe("parsePsTime", () => {
  it.each([
    ["0:01.50", 1.5],
    ["123:45.00", 123 * 60 + 45],
    ["1:02:03.50", 3723.5],
    ["2-03:04:05", 2 * 86400 + 3 * 3600 + 4 * 60 + 5],
    ["123:04:05.67", 123 * 3600 + 4 * 60 + 5.67],
  ])("parses %s", (text, sec) => {
    expect(parsePsTime(text)).toBeCloseTo(sec, 5);
  });

  it("throws on garbage", () => {
    expect(() => parsePsTime("soon")).toThrow();
  });
});

describe("parsePsOutput", () => {
  it("matches daemons by comm basename and ignores everything else", () => {
    const out = [
      "  101   0:12.34 /usr/libexec/syspolicyd",
      "  202   1:00.00 /System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Support/mds",
      "  203   2:00.00 /System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Support/mds_stores",
      "  304   0:00.10 /usr/sbin/cfprefsd",
      "  305   0:00.10 /Applications/mds helper.app/Contents/MacOS/other",
    ].join("\n");
    expect(parsePsOutput(out)).toEqual([
      { daemon: "syspolicyd", pid: 101, cpuSec: 12.34 },
      { daemon: "mds", pid: 202, cpuSec: 60 },
      { daemon: "mds_stores", pid: 203, cpuSec: 120 },
    ]);
  });
});

describe("parseTopKernelTask", () => {
  it("reads pid 0 from top output", () => {
    const out = "Processes: 1\n\nPID    TIME\n0      12:34.56\n";
    expect(parseTopKernelTask(out)).toEqual({
      daemon: "kernel_task",
      pid: 0,
      cpuSec: 12 * 60 + 34.56,
    });
  });

  it("returns null when pid 0 is absent", () => {
    expect(parseTopKernelTask("PID TIME\n55 0:01.00\n")).toBeNull();
  });
});

describe("diffSamples", () => {
  const s = (daemon: DaemonSample["daemon"], pid: number, cpuSec: number) => ({
    daemon,
    pid,
    cpuSec,
  });

  it("counts a new pid fully and flags an exited pid", () => {
    const r = diffSamples(
      [s("mds", 1, 10), s("fseventsd", 2, 5)],
      [s("mds", 1, 12.5), s("mds", 9, 3)],
    );
    expect(r.net.mds).toBeCloseTo(5.5);
    expect(r.net.fseventsd).toBe(0);
    expect(r.pidExited).toBe(true);
  });

  it("clamps negative per-pid deltas to zero and fills every key", () => {
    const r = diffSamples([s("mds", 1, 10)], [s("mds", 1, 4)]);
    expect(r.net.mds).toBe(0);
    expect(r.pidExited).toBe(false);
    expect(Object.keys(r.net).sort()).toEqual([...DAEMONS].sort());
  });
});

describe("median", () => {
  it("handles odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it("throws on empty", () => {
    expect(() => median([])).toThrow();
  });
});

describe("main", () => {
  it("skips on non-macOS", async () => {
    const lines: string[] = [];
    const code = await main(["--", "true"], {
      platform: "linux",
      write: (t) => lines.push(t),
    });
    expect(code).toBe(0);
    expect(JSON.parse(lines.join(""))).toEqual({ skipped: "not-macos" });
  });

  it("subtracts the idle control and reports medianNet", async () => {
    const cpu = [0, 10, 10, 11, 11, 21, 21, 22];
    let i = 0;
    const sample = () => [
      { daemon: "syspolicyd" as const, pid: 1, cpuSec: cpu[i++] },
    ];
    const lines: string[] = [];
    let clock = 0;
    const code = await main(
      ["--repeat", "2", "--control", "--label", "x", "--", "cmd"],
      {
        platform: "darwin",
        sample,
        spawn: () => 0,
        sleep: () => {},
        now: () => (clock += 500),
        loadAvg1: () => 1.5,
        write: (t) => lines.push(t),
      },
    );
    const out = JSON.parse(lines.join(""));
    expect(code).toBe(0);
    expect(out.label).toBe("x");
    expect(out.runs).toHaveLength(2);
    expect(out.runs[0].net.syspolicyd).toBe(9);
    expect(out.runs[0].control.daemons.syspolicyd).toBe(1);
    expect(out.medianNet.syspolicyd).toBe(9);
    expect(out.medianWallSec).toBe(0.5);
    expect(out.host.loadAvg1AtStart).toBe(1.5);
  });

  it("sleeps the idle control for the run's wall time", async () => {
    const cpu = [0, 10, 10, 11, 11, 21, 21, 22];
    let i = 0;
    const sample = () => [
      { daemon: "syspolicyd" as const, pid: 1, cpuSec: cpu[i++] },
    ];
    const slept: number[] = [];
    let clock = 0;
    await main(["--repeat", "2", "--control", "--", "cmd"], {
      platform: "darwin",
      sample,
      spawn: () => 0,
      sleep: (s) => {
        slept.push(s);
      },
      now: () => (clock += 500),
      loadAvg1: () => 1.5,
      write: () => {},
    });
    expect(slept).toEqual([0.5, 0.5]);
  });
});
