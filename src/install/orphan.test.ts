import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeOrphanIfManaged } from "./orphan.js";

let repoRoot!: string;
let sourceRoot!: string;

// A real source-tree file outside `repoRoot`. Symlinks pointing at it pass
// the source-containment check, so any path-traversal escape would actually
// fire `fs.unlink` if the containment guard were missing.
let sourceFile!: string;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-orphan-repo-"));
  sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-orphan-src-"));
  sourceFile = path.join(sourceRoot, "real.ts");
  await fs.writeFile(sourceFile, "// source");
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
  await fs.rm(sourceRoot, { recursive: true, force: true });
});

describe(removeOrphanIfManaged, () => {
  it("removes a symlink under the expected prefix whose target lives in source", async () => {
    const targetDir = path.join(repoRoot, "scripts");
    await fs.mkdir(targetDir, { recursive: true });
    const link = path.join(targetDir, "old.ts");
    await fs.symlink(sourceFile, link);

    const removed = await removeOrphanIfManaged({
      repoRoot,
      gitignorePath: "/scripts/old.ts",
      sourceRoot,
      expectedPrefix: "/scripts/",
    });

    expect(removed).toBe(true);
    await expect(fs.lstat(link)).rejects.toThrow();
  });

  it("rejects paths missing the expected prefix", async () => {
    // Even though a symlink lives at the resolved location and would pass
    // the source-containment check, the prefix gate must short-circuit.
    const targetDir = path.join(repoRoot, "elsewhere");
    await fs.mkdir(targetDir, { recursive: true });
    const link = path.join(targetDir, "x.ts");
    await fs.symlink(sourceFile, link);

    const removed = await removeOrphanIfManaged({
      repoRoot,
      gitignorePath: "/elsewhere/x.ts",
      sourceRoot,
      expectedPrefix: "/scripts/",
    });

    expect(removed).toBe(false);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("rejects a path whose '..' segments escape repoRoot", async () => {
    // Stage a symlink *outside* repoRoot pointing into the source tree —
    // exactly the shape of a successful traversal exploit if the guard were
    // missing. The function must short-circuit on the containment check
    // and never touch the filesystem.
    const outsideDir = path.dirname(repoRoot);
    const outsideLink = path.join(outsideDir, "should-not-be-deleted.ts");
    await fs.symlink(sourceFile, outsideLink);

    try {
      const repoBaseName = path.basename(repoRoot);
      // Crafted gitignore entry: starts with /scripts/ to pass the prefix
      // check, but then climbs out of `repoRoot/scripts/` into the parent
      // directory via `..` segments.
      const malicious = `/scripts/../../${repoBaseName === "" ? "x" : ""}../should-not-be-deleted.ts`;

      const removed = await removeOrphanIfManaged({
        repoRoot,
        gitignorePath: malicious,
        sourceRoot,
        expectedPrefix: "/scripts/",
      });

      expect(removed).toBe(false);
      // The symlink outside repoRoot must be untouched.
      expect((await fs.lstat(outsideLink)).isSymbolicLink()).toBe(true);
    } finally {
      await fs.unlink(outsideLink).catch(() => {});
    }
  });

  it("rejects a non-symlink path under the prefix (real file)", async () => {
    const targetDir = path.join(repoRoot, "scripts");
    await fs.mkdir(targetDir, { recursive: true });
    const realFile = path.join(targetDir, "real.ts");
    await fs.writeFile(realFile, "// user");

    const removed = await removeOrphanIfManaged({
      repoRoot,
      gitignorePath: "/scripts/real.ts",
      sourceRoot,
      expectedPrefix: "/scripts/",
    });

    expect(removed).toBe(false);
    expect((await fs.lstat(realFile)).isFile()).toBe(true);
  });

  it("rejects a symlink whose target does NOT resolve under sourceRoot", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-outside-"));
    const outsideTarget = path.join(outsideDir, "user.ts");
    await fs.writeFile(outsideTarget, "// user");
    try {
      const targetDir = path.join(repoRoot, "scripts");
      await fs.mkdir(targetDir, { recursive: true });
      const link = path.join(targetDir, "user-pointed.ts");
      await fs.symlink(outsideTarget, link);

      const removed = await removeOrphanIfManaged({
        repoRoot,
        gitignorePath: "/scripts/user-pointed.ts",
        sourceRoot,
        expectedPrefix: "/scripts/",
      });

      expect(removed).toBe(false);
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
