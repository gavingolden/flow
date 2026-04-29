import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  pidFilePath,
  readPidFileSync,
  unlinkPidFileSync,
  writePidFileSync,
} from "./runner-pid.js";

describe("runner-pid helpers", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-pid-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("write → read → unlink round-trip", () => {
    writePidFileSync(tmp, 12345);
    expect(readPidFileSync(tmp)).toBe(12345);
    unlinkPidFileSync(tmp);
    expect(readPidFileSync(tmp)).toBeNull();
  });

  it("unlink swallows ENOENT (idempotent)", () => {
    expect(() => unlinkPidFileSync(tmp)).not.toThrow();
    expect(() => unlinkPidFileSync(tmp)).not.toThrow();
  });

  it("pidFilePath joins under the task dir", () => {
    expect(pidFilePath(tmp)).toBe(path.join(tmp, "runner.pid"));
  });
});
