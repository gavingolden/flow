import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendRow,
  readRows,
  registryPath,
  compact,
  MAX_ROW_BYTES,
  NULL_EPOCH_TTL_MS,
  type ProcRegistryRow,
} from "./proc-registry";

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
});
