import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPauseFlag,
  dropPauseFlag,
  isPaused,
  pauseFlagPath,
} from "./pause-flag.js";

describe("pause-flag helpers", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-pause-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("pauseFlagPath joins under the task dir as `.pause`", () => {
    expect(pauseFlagPath(tmp)).toBe(path.join(tmp, ".pause"));
  });

  it("drop creates the file; isPaused flips true; clear removes it", async () => {
    expect(isPaused(tmp)).toBe(false);
    await dropPauseFlag(tmp);
    expect(isPaused(tmp)).toBe(true);
    await clearPauseFlag(tmp);
    expect(isPaused(tmp)).toBe(false);
  });

  it("clear is idempotent (second call swallows ENOENT)", async () => {
    await expect(clearPauseFlag(tmp)).resolves.toBeUndefined();
    await expect(clearPauseFlag(tmp)).resolves.toBeUndefined();
  });

  it("drop overwrites an existing flag (re-pause is a no-op-ish)", async () => {
    await dropPauseFlag(tmp);
    await dropPauseFlag(tmp);
    expect(isPaused(tmp)).toBe(true);
  });
});
