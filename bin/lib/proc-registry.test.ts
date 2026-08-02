import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// defaultIsLive calls liveness.ts's pidStartEpoch directly (not via an
// injectable dep), and pidStartEpoch's real path forks `ps` through
// `Bun.spawnSync` — unavailable under vitest's node runtime. Mock just
// that one export so defaultIsLive is exercisable against `process.pid`
// with no real spawning, per the fix-applier brief.
vi.mock("./liveness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./liveness")>();
  return { ...actual, pidStartEpoch: vi.fn() };
});

import {
  appendRow,
  readRows,
  registryPath,
  compact,
  defaultIsLive,
  MAX_ROW_BYTES,
  NULL_EPOCH_TTL_MS,
  type ProcRegistryRow,
} from "./proc-registry";
import { pidStartEpoch } from "./liveness";

const mockedPidStartEpoch = vi.mocked(pidStartEpoch);

function makeRow(overrides: Partial<ProcRegistryRow> = {}): ProcRegistryRow {
  return {
    pgid: 100,
    pid: 100,
    startEpoch: 1_700_000_000,
    slug: "csv-export",
    class: "default",
    argv: ["bun", "bin/flow-spawn.ts", "--slug", "csv-export"],
    recordedAt: 1_700_000_000_000,
    sessionPid: 200,
    sessionStartEpoch: 1_699_999_999,
    ...overrides,
  };
}

describe("proc-registry", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-proc-registry-"));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("creates the procs directory on first append when absent", () => {
    const dir = path.join(baseDir, "procs");
    expect(fs.existsSync(dir)).toBe(false);
    const result = appendRow(makeRow(), baseDir);
    expect(result.written).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("accumulates every row across concurrent appends against the same slug", async () => {
    // appendFileSync is synchronous, so this exercises interleaved-callers
    // correctness (no torn/lost writes) rather than true OS-level
    // concurrency — see the artifact's rejected_alternatives for why a
    // worker-thread/subprocess variant was not used here.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        Promise.resolve().then(() =>
          appendRow(makeRow({ pid: 100 + i, pgid: 100 + i }), baseDir),
        ),
      ),
    );
    const { rows, malformed } = readRows("csv-export", baseDir);
    expect(rows).toHaveLength(8);
    expect(malformed).toBe(0);
  });

  it("skips blank lines silently and counts only unparseable/invalid lines as malformed", () => {
    const target = registryPath("csv-export", baseDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const validLine = JSON.stringify(makeRow());
    fs.writeFileSync(target, `${validLine}\nnot-json-garbage\n\n`);
    const { rows, malformed } = readRows("csv-export", baseDir);
    expect(rows).toHaveLength(1);
    expect(malformed).toBe(1);
  });

  it("truncates argv from the tail while retaining argv[0] and argv[1], staying within MAX_ROW_BYTES", () => {
    const hugeArgv = [
      "bun",
      "bin/flow-spawn.ts",
      ...Array(2000).fill("x".repeat(20)),
    ];
    const result = appendRow(makeRow({ argv: hugeArgv }), baseDir);
    expect(result.written).toBe(true);
    const { rows, malformed } = readRows("csv-export", baseDir);
    expect(malformed).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].argvTruncated).toBe(true);
    expect(rows[0].argv[0]).toBe("bun");
    expect(rows[0].argv[1]).toBe("bin/flow-spawn.ts");
    const line = fs.readFileSync(registryPath("csv-export", baseDir), "utf8");
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(MAX_ROW_BYTES);
  });

  it("throws on an invalid slug", () => {
    expect(() => registryPath("../escape", baseDir)).toThrow();
    expect(() => registryPath("Bad_Slug", baseDir)).toThrow();
  });

  it("compact keeps only the live-and-epoch-matching row", () => {
    const live = makeRow({ pid: 1, pgid: 1, startEpoch: 500 });
    const deadPid = makeRow({ pid: 2, pgid: 2, startEpoch: 500 });
    const epochMismatch = makeRow({ pid: 3, pgid: 3, startEpoch: 999 });
    appendRow(live, baseDir);
    appendRow(deadPid, baseDir);
    appendRow(epochMismatch, baseDir);

    const currentEpochs: Record<number, number | null> = {
      1: 500,
      2: null,
      3: 111,
    };
    const result = compact("csv-export", baseDir, {
      isLive: (row) =>
        row.startEpoch !== null &&
        currentEpochs[row.pid] !== null &&
        currentEpochs[row.pid] === row.startEpoch,
    });
    expect(result).toEqual({ kept: 1, dropped: 2 });
    const { rows } = readRows("csv-export", baseDir);
    expect(rows).toHaveLength(1);
    expect(rows[0].pid).toBe(1);
  });

  it("age-GCs a null-epoch row past NULL_EPOCH_TTL_MS while keeping a fresh one", () => {
    const stale = makeRow({
      pid: 10,
      pgid: 10,
      startEpoch: null,
      recordedAt: 0,
    });
    const fresh = makeRow({
      pid: 11,
      pgid: 11,
      startEpoch: null,
      recordedAt: 1_000_000,
    });
    appendRow(stale, baseDir);
    appendRow(fresh, baseDir);

    const now = 1_000_000 + NULL_EPOCH_TTL_MS - 1; // fresh row is within TTL
    const result = compact("csv-export", baseDir, { nowMs: () => now });
    expect(result).toEqual({ kept: 1, dropped: 1 });
    const { rows } = readRows("csv-export", baseDir);
    expect(rows.map((r) => r.pid)).toEqual([11]);
  });

  it("returns {written: false, error} rather than throwing when the target is unwritable", () => {
    const asFile = path.join(baseDir, "procs");
    fs.writeFileSync(asFile, ""); // occupy the dir path with a plain file
    const result = appendRow(makeRow(), baseDir);
    expect(result.written).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error).toBeTruthy();
  });

  it("creates the procs dir and the registry file with owner-only modes (argv can carry secrets)", () => {
    appendRow(makeRow(), baseDir);
    const dir = path.join(baseDir, "procs");
    const target = registryPath("csv-export", baseDir);
    // & 0o777 strips the file-type bits statSync's mode otherwise carries.
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("compact preserves a row appended after its read snapshot but before its rename (A1 regression)", () => {
    const before = makeRow({ pid: 1, pgid: 1, startEpoch: 500 });
    appendRow(before, baseDir);

    const target = registryPath("csv-export", baseDir);
    const result = compact("csv-export", baseDir, {
      isLive: (row) => row.startEpoch === 500,
      // Simulates a concurrent appendRow landing between compact's
      // snapshot read and its rename.
      afterSnapshot: () => {
        const raced = makeRow({ pid: 2, pgid: 2, startEpoch: 500 });
        fs.appendFileSync(target, `${JSON.stringify(raced)}\n`);
      },
    });
    // `kept` reflects the liveness decision over the snapshot (pid 1 only —
    // pid 2 was never evaluated, it raced in afterward), but the row on
    // disk after compact must still include it: the offset-reread
    // reconciliation preserves it verbatim rather than erasing it.
    expect(result.kept).toBe(1);

    const { rows } = readRows("csv-export", baseDir);
    expect(rows.map((r) => r.pid).sort()).toEqual([1, 2]);
  });

  it("cleans up its temp file instead of leaking it when the rename fails (A2 regression)", () => {
    appendRow(makeRow(), baseDir);
    compact("csv-export", baseDir, {
      rename: () => {
        throw new Error("simulated rename failure");
      },
    });
    const leftovers = fs
      .readdirSync(path.join(baseDir, "procs"))
      .filter((f) => f.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });

  it("bails out without rewriting when the registry exists but fails to read (C regression)", () => {
    appendRow(makeRow(), baseDir);
    const target = registryPath("csv-export", baseDir);
    const before = fs.readFileSync(target, "utf8");
    fs.chmodSync(target, 0o000);

    let result: { kept: number; dropped: number };
    try {
      result = compact("csv-export", baseDir);
    } finally {
      fs.chmodSync(target, 0o600); // restore so afterEach's rmSync can clean up
    }
    expect(result).toEqual({ kept: 0, dropped: 0 });
    // The registry on disk must be untouched — not rewritten to empty.
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("does not set argvTruncated when nothing was actually dropped, even if the row starts over budget (B regression)", () => {
    // A single argv element right at the retention floor (argv.length===2)
    // that still doesn't need dropping past minKeep exercises the "started
    // over budget but nothing droppable was dropped" edge precisely.
    const row = makeRow({ argv: ["bun", "x".repeat(MAX_ROW_BYTES + 200)] });
    const result = appendRow(row, baseDir);
    expect(result.written).toBe(true);
    const { rows } = readRows("csv-export", baseDir);
    expect(rows).toHaveLength(1);
    // Nothing could be dropped (already at the argv[0]+argv[1] floor with
    // only 2 elements) so argvTruncated must stay unset, documenting the
    // one invariant gap rather than mislabeling it as "truncated".
    expect(rows[0].argvTruncated).toBeUndefined();
  });
});

describe("defaultIsLive", () => {
  afterEach(() => {
    mockedPidStartEpoch.mockReset();
  });

  it("returns false for a null startEpoch without probing the pid", () => {
    expect(
      defaultIsLive({
        pgid: 1,
        pid: 1,
        startEpoch: null,
        slug: "csv-export",
        class: "default",
        argv: [],
        recordedAt: 0,
        sessionPid: null,
        sessionStartEpoch: null,
      }),
    ).toBe(false);
  });

  it("returns true against this test process's own pid when the recorded epoch matches", () => {
    mockedPidStartEpoch.mockReturnValue(500);
    const row: ProcRegistryRow = {
      pgid: process.pid,
      pid: process.pid,
      startEpoch: 500,
      slug: "csv-export",
      class: "default",
      argv: [],
      recordedAt: 0,
      sessionPid: null,
      sessionStartEpoch: null,
    };
    expect(defaultIsLive(row)).toBe(true);
    expect(mockedPidStartEpoch).toHaveBeenCalledWith(process.pid);
  });

  it("distinguishes epoch mismatch from mere liveness against this test's own live pid", () => {
    mockedPidStartEpoch.mockReturnValue(999); // pid is "alive" but the epoch has moved on
    const row: ProcRegistryRow = {
      pgid: process.pid,
      pid: process.pid,
      startEpoch: 500, // deliberately mismatched against the mocked current epoch
      slug: "csv-export",
      class: "default",
      argv: [],
      recordedAt: 0,
      sessionPid: null,
      sessionStartEpoch: null,
    };
    // A mismatched startEpoch against a live pid is correctly NOT live —
    // the epoch match, not mere liveness, is what defaultIsLive checks
    // (the pid-reuse guard the module doc comment describes).
    expect(defaultIsLive(row)).toBe(false);
  });

  it("returns false when the current probe reports no process at all (null)", () => {
    mockedPidStartEpoch.mockReturnValue(null);
    expect(
      defaultIsLive({
        pgid: 999_999,
        pid: 999_999,
        startEpoch: 123,
        slug: "csv-export",
        class: "default",
        argv: [],
        recordedAt: 0,
        sessionPid: null,
        sessionStartEpoch: null,
      }),
    ).toBe(false);
  });
});
