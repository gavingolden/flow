import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLOW_STATUS_FILENAME, readFlowStatus, relativeTime } from "./flow-status";

let dir!: string;
let warnings!: string[];
let originalStderr!: typeof process.stderr.write;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-status-"));
  warnings = [];
  originalStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    warnings.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.stderr.write = originalStderr;
});

function writeStatus(body: string): void {
  fs.writeFileSync(path.join(dir, FLOW_STATUS_FILENAME), body);
}

describe(readFlowStatus, () => {
  it("parses both fields", () => {
    writeStatus("phase: implementing\nlast_transition_at: 2026-04-30T18:42:11Z\n");
    expect(readFlowStatus(dir)).toEqual({
      phase: "implementing",
      lastTransitionAt: "2026-04-30T18:42:11Z",
    });
    expect(warnings).toEqual([]);
  });

  it("tolerates trailing whitespace and CRLF line endings", () => {
    writeStatus("phase:   reviewing  \r\nlast_transition_at:  2026-04-30T18:42:11Z\r\n");
    expect(readFlowStatus(dir)).toEqual({
      phase: "reviewing",
      lastTransitionAt: "2026-04-30T18:42:11Z",
    });
  });

  it("returns null when the file is missing (no warning)", () => {
    expect(readFlowStatus(dir)).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("returns null + warns when the file lacks colons", () => {
    writeStatus("not key value\nstill not\n");
    expect(readFlowStatus(dir)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("malformed");
  });

  it("returns null + warns when phase is missing", () => {
    writeStatus("last_transition_at: 2026-04-30T18:42:11Z\n");
    expect(readFlowStatus(dir)).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it("returns null + warns when last_transition_at is unparseable", () => {
    writeStatus("phase: implementing\nlast_transition_at: not-a-date\n");
    expect(readFlowStatus(dir)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unparseable");
  });
});

describe(relativeTime, () => {
  const NOW = Date.UTC(2026, 3, 30, 12, 30, 0);

  it("formats sub-minute as seconds (5s boundary)", () => {
    expect(relativeTime(NOW - 5_000, NOW)).toBe("5s ago");
  });
  it("formats sub-hour as minutes (90s → 1m)", () => {
    expect(relativeTime(NOW - 90_000, NOW)).toBe("1m ago");
  });
  it("formats sub-day as hours (2h)", () => {
    expect(relativeTime(NOW - 2 * 60 * 60_000, NOW)).toBe("2h ago");
  });
  it("formats multi-day (3d)", () => {
    expect(relativeTime(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe("3d ago");
  });
  it("clamps negative deltas to 0s", () => {
    expect(relativeTime(NOW + 5_000, NOW)).toBe("0s ago");
  });
});
