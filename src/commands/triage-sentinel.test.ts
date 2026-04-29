import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TRIAGE_SENTINEL_ENV,
  cleanupSentinel,
  createSentinelPath,
  readSentinelTaskId,
} from "./triage-sentinel.js";

function tmpFile(label: string): string {
  return path.join(
    os.tmpdir(),
    `flow-triage-test-${label}-${randomBytes(8).toString("hex")}.id`,
  );
}

describe("createSentinelPath", () => {
  it("returns a path under os.tmpdir()", () => {
    const p = createSentinelPath();
    expect(p.startsWith(os.tmpdir())).toBe(true);
  });

  it("returns a unique path on every call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(createSentinelPath());
    expect(seen.size).toBe(100);
  });
});

describe("readSentinelTaskId", () => {
  const written: string[] = [];

  afterEach(async () => {
    while (written.length) {
      const p = written.pop()!;
      await fs.unlink(p).catch(() => {});
    }
  });

  async function write(content: string): Promise<string> {
    const p = tmpFile("read");
    await fs.writeFile(p, content, "utf8");
    written.push(p);
    return p;
  }

  it("returns null for a non-existent path", async () => {
    const p = tmpFile("missing");
    expect(await readSentinelTaskId(p)).toBeNull();
  });

  it("returns null for an empty file", async () => {
    const p = await write("");
    expect(await readSentinelTaskId(p)).toBeNull();
  });

  it("returns null for a whitespace-only file", async () => {
    const p = await write("   \n\t\n");
    expect(await readSentinelTaskId(p)).toBeNull();
  });

  it("returns the trimmed id with a trailing newline", async () => {
    const p = await write("2026-04-27-fix-thing\n");
    expect(await readSentinelTaskId(p)).toBe("2026-04-27-fix-thing");
  });

  it("tolerates leading whitespace and CRLF", async () => {
    const p = await write("  2026-04-27-fix-thing\r\n");
    expect(await readSentinelTaskId(p)).toBe("2026-04-27-fix-thing");
  });
});

describe("cleanupSentinel", () => {
  it("removes an existing file", async () => {
    const p = tmpFile("cleanup");
    await fs.writeFile(p, "x", "utf8");
    await cleanupSentinel(p);
    await expect(fs.access(p)).rejects.toThrow();
  });

  it("is a no-op on a missing path", async () => {
    const p = tmpFile("cleanup-missing");
    await expect(cleanupSentinel(p)).resolves.toBeUndefined();
  });
});

describe("concurrency: each parent reads its own sentinel", () => {
  // Regression test for the directory-diff misattribution bug. We pick
  // ids such that A is lex-greater than B — under the old dir-diff +
  // lex-max code, parent B would have wrongly seen A's id. With the
  // sentinel pattern, each parent reads exactly the file it created,
  // so attribution is correct regardless of completion order.
  let sentinelA: string;
  let sentinelB: string;

  beforeEach(() => {
    sentinelA = tmpFile("A");
    sentinelB = tmpFile("B");
  });

  afterEach(async () => {
    await cleanupSentinel(sentinelA);
    await cleanupSentinel(sentinelB);
  });

  it("two concurrent fake-triage subprocesses each write only their own sentinel", async () => {
    const idA = "2026-04-29-zzz-late";
    const idB = "2026-04-29-aaa-early";
    const writerScript =
      'require("fs").writeFileSync(process.env.FLOW_TRIAGE_TASK_ID_FILE, process.env.FAKE_ID + "\\n")';

    const childA = execa("node", ["-e", writerScript], {
      env: {
        ...process.env,
        [TRIAGE_SENTINEL_ENV]: sentinelA,
        FAKE_ID: idA,
      },
    });
    const childB = execa("node", ["-e", writerScript], {
      env: {
        ...process.env,
        [TRIAGE_SENTINEL_ENV]: sentinelB,
        FAKE_ID: idB,
      },
    });

    await Promise.all([childA, childB]);

    expect(await readSentinelTaskId(sentinelA)).toBe(idA);
    expect(await readSentinelTaskId(sentinelB)).toBe(idB);
  });
});
