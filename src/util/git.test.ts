import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findGitRoot } from "./git.js";

describe("findGitRoot", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-git-root-"));
    await execa("git", ["init", "-q", "--initial-branch=main", tmp]);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns the repo toplevel when called from inside the repo", async () => {
    const expected = await fs.realpath(tmp);
    const got = await findGitRoot(tmp);
    expect(got).not.toBeNull();
    expect(await fs.realpath(got!)).toBe(expected);
  });

  it("returns null outside any git repo", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "flow-git-root-out-"));
    try {
      const got = await findGitRoot(outside);
      expect(got).toBeNull();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
