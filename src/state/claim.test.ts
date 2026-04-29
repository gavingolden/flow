import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireClaim } from "./claim.js";

const TASK_ID = "2026-04-29-claim";

// A PID that should not exist on the host. Linux/macOS PIDs are bounded
// well below 2^31; 9_999_999 is reliably absent on dev boxes and CI.
const DEAD_PID = 9_999_999;

function lockPath(taskDir: string): string {
  return path.join(taskDir, `claimed-${TASK_ID}.lock`);
}

function readPid(p: string): number | null {
  try {
    const raw = fsSync.readFileSync(p, "utf8");
    return Number.parseInt(raw.trim(), 10);
  } catch {
    return null;
  }
}

describe("acquireClaim", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-claim-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("first caller acquires; canonical lock records caller PID", () => {
    const claim = acquireClaim(tmp, TASK_ID);
    expect(claim).not.toBeNull();
    expect(claim!.pid).toBe(process.pid);
    expect(readPid(lockPath(tmp))).toBe(process.pid);
  });

  it("second caller skips when a live holder is recorded", () => {
    // Simulate a live holder by writing our own PID — `process.pid` is
    // guaranteed alive for the duration of the test.
    fsSync.writeFileSync(lockPath(tmp), `${process.pid}\n`, "utf8");
    const claim = acquireClaim(tmp, TASK_ID);
    expect(claim).toBeNull();
    // No temp file left on disk (cleanup-on-skip invariant).
    const entries = fsSync.readdirSync(tmp);
    const tempLeftovers = entries.filter((e) => e.endsWith(".tmp"));
    expect(tempLeftovers).toEqual([]);
  });

  it("steals from a dead holder and overwrites the lock with our PID", () => {
    fsSync.writeFileSync(lockPath(tmp), `${DEAD_PID}\n`, "utf8");
    const claim = acquireClaim(tmp, TASK_ID);
    expect(claim).not.toBeNull();
    expect(readPid(lockPath(tmp))).toBe(process.pid);
  });

  it("concurrent acquires in the same process — exactly one returns non-null", async () => {
    // Same-process Promise.all: the existing-holder check serialises
    // candidates 2..N because candidate 1's rename has already deposited
    // an alive PID (the test process) into the canonical path.
    const results = await Promise.all(
      Array.from({ length: 10 }, async () => acquireClaim(tmp, TASK_ID)),
    );
    const winners = results.filter((c) => c !== null);
    expect(winners).toHaveLength(1);
    expect(readPid(lockPath(tmp))).toBe(process.pid);
  });

  it("release happy path removes the lock; second release is a no-op", () => {
    const claim = acquireClaim(tmp, TASK_ID);
    expect(claim).not.toBeNull();
    claim!.release();
    expect(readPid(lockPath(tmp))).toBeNull();
    expect(() => claim!.release()).not.toThrow();
  });

  it("release after eviction does not unlink the new owner's lock", () => {
    const claim = acquireClaim(tmp, TASK_ID);
    expect(claim).not.toBeNull();
    // Simulate a stealer that decided we were dead and overwrote the
    // canonical path with their PID.
    fsSync.writeFileSync(lockPath(tmp), `${DEAD_PID}\n`, "utf8");
    claim!.release();
    // Lock still belongs to the simulated stealer.
    expect(readPid(lockPath(tmp))).toBe(DEAD_PID);
  });

  it("acquire writes our PID even when a stale temp file from a prior crash exists", () => {
    // Defence in depth: a previous run could have crashed between
    // writeFileSync(tmp) and renameSync — leaving a leftover temp. The
    // next acquire reuses (overwrites) that path and renames, ending
    // with our PID in the canonical lock.
    const stale = path.join(tmp, `claim-${TASK_ID}-${process.pid}.tmp`);
    fsSync.writeFileSync(stale, "garbage\n", "utf8");
    const claim = acquireClaim(tmp, TASK_ID);
    expect(claim).not.toBeNull();
    expect(readPid(lockPath(tmp))).toBe(process.pid);
  });

  it("respects an alive holder whose PID differs from ours", () => {
    // Use the test process's parent PID — guaranteed alive while we run
    // (the test runner spawned us). Distinct from process.pid so the
    // check exercises the non-self alive branch.
    const parentPid = process.ppid;
    if (parentPid === process.pid || parentPid === 0) {
      // Not a meaningful test in this environment; skip.
      return;
    }
    fsSync.writeFileSync(lockPath(tmp), `${parentPid}\n`, "utf8");
    const claim = acquireClaim(tmp, TASK_ID);
    expect(claim).toBeNull();
    // Lock unchanged.
    expect(readPid(lockPath(tmp))).toBe(parentPid);
  });
});
