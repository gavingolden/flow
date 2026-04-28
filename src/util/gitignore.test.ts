import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyManagedBlock,
  type ManagedBlock,
  updateGitignoreBlock,
} from "./gitignore.js";

// --- Pure transform ---

describe(applyManagedBlock, () => {
  const block: ManagedBlock = {
    tag: "install-scripts",
    paths: ["/scripts/a.ts", "/scripts/b.ts"],
  };

  it("appends a block to an empty file", () => {
    expect(applyManagedBlock("", block)).toBe(
      [
        "# managed by flow install-scripts",
        "/scripts/a.ts",
        "/scripts/b.ts",
        "# end flow install-scripts",
        "",
      ].join("\n"),
    );
  });

  it("appends a block at EOF separated by a blank line", () => {
    const input = "node_modules/\ndist/\n";
    const out = applyManagedBlock(input, block);
    expect(out).toBe(
      [
        "node_modules/",
        "dist/",
        "",
        "# managed by flow install-scripts",
        "/scripts/a.ts",
        "/scripts/b.ts",
        "# end flow install-scripts",
        "",
      ].join("\n"),
    );
  });

  it("does not double the blank separator if the file already ends in one", () => {
    const input = "node_modules/\n\n";
    const out = applyManagedBlock(input, block);
    expect(out).toContain("node_modules/\n\n# managed by flow install-scripts");
    expect(out).not.toContain("\n\n\n");
  });

  it("replaces an existing block in place, preserving surrounding rules", () => {
    const input = [
      "node_modules/",
      "",
      "# managed by flow install-scripts",
      "/scripts/old.ts",
      "# end flow install-scripts",
      "",
      "*.log",
      "",
    ].join("\n");
    const out = applyManagedBlock(input, block);
    expect(out).toBe(
      [
        "node_modules/",
        "",
        "# managed by flow install-scripts",
        "/scripts/a.ts",
        "/scripts/b.ts",
        "# end flow install-scripts",
        "",
        "*.log",
        "",
      ].join("\n"),
    );
  });

  it("includes the optional comment line under the begin marker", () => {
    const out = applyManagedBlock("", { ...block, comment: "explanatory note" });
    expect(out).toBe(
      [
        "# managed by flow install-scripts",
        "# explanatory note",
        "/scripts/a.ts",
        "/scripts/b.ts",
        "# end flow install-scripts",
        "",
      ].join("\n"),
    );
  });

  it("returns identical content when re-applied with the same block (idempotent)", () => {
    const once = applyManagedBlock("node_modules/\n", block);
    const twice = applyManagedBlock(once, block);
    expect(twice).toBe(once);
  });

  it("removes the block when paths is empty", () => {
    const input = [
      "node_modules/",
      "",
      "# managed by flow install-scripts",
      "/scripts/a.ts",
      "# end flow install-scripts",
      "",
      "*.log",
      "",
    ].join("\n");
    const out = applyManagedBlock(input, { ...block, paths: [] });
    expect(out).toBe("node_modules/\n\n*.log\n");
  });

  it("does not touch other flow blocks (different tag)", () => {
    const input = [
      "# managed by flow install-skills",
      "/.claude/skills/foo",
      "# end flow install-skills",
      "",
      "# managed by flow install-scripts",
      "/scripts/old.ts",
      "# end flow install-scripts",
      "",
    ].join("\n");
    const out = applyManagedBlock(input, block);
    expect(out).toContain("# managed by flow install-skills\n/.claude/skills/foo\n# end flow install-skills");
    expect(out).toContain("/scripts/a.ts");
    expect(out).toContain("/scripts/b.ts");
    expect(out).not.toContain("/scripts/old.ts");
  });

  it("sorts paths in the order provided (caller controls deterministic ordering)", () => {
    const out = applyManagedBlock("", {
      ...block,
      paths: ["/scripts/z.ts", "/scripts/a.ts"],
    });
    const lines = out.split("\n");
    const z = lines.indexOf("/scripts/z.ts");
    const a = lines.indexOf("/scripts/a.ts");
    expect(z).toBeLessThan(a);
  });
});

// --- Filesystem wrapper ---

describe(updateGitignoreBlock, () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-gitignore-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("creates .gitignore when missing", async () => {
    const result = await updateGitignoreBlock(tmp, {
      tag: "install-scripts",
      paths: ["/scripts/a.ts"],
    });
    expect(result).toBe("created");
    const out = await fs.readFile(path.join(tmp, ".gitignore"), "utf8");
    expect(out).toContain("# managed by flow install-scripts");
    expect(out).toContain("/scripts/a.ts");
  });

  it("returns 'unchanged' on a no-op rewrite", async () => {
    await fs.writeFile(
      path.join(tmp, ".gitignore"),
      [
        "# managed by flow install-scripts",
        "/scripts/a.ts",
        "# end flow install-scripts",
        "",
      ].join("\n"),
    );
    const result = await updateGitignoreBlock(tmp, {
      tag: "install-scripts",
      paths: ["/scripts/a.ts"],
    });
    expect(result).toBe("unchanged");
  });

  it("returns 'updated' when paths change", async () => {
    await fs.writeFile(
      path.join(tmp, ".gitignore"),
      [
        "# managed by flow install-scripts",
        "/scripts/old.ts",
        "# end flow install-scripts",
        "",
      ].join("\n"),
    );
    const result = await updateGitignoreBlock(tmp, {
      tag: "install-scripts",
      paths: ["/scripts/new.ts"],
    });
    expect(result).toBe("updated");
    const out = await fs.readFile(path.join(tmp, ".gitignore"), "utf8");
    expect(out).toContain("/scripts/new.ts");
    expect(out).not.toContain("/scripts/old.ts");
  });

  it("does not create .gitignore when paths is empty and file is missing", async () => {
    const result = await updateGitignoreBlock(tmp, {
      tag: "install-scripts",
      paths: [],
    });
    expect(result).toBe("unchanged");
    await expect(fs.access(path.join(tmp, ".gitignore"))).rejects.toThrow();
  });
});
