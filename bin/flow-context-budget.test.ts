import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  hasPathsFrontmatter,
  parseImports,
  resolveAlwaysLoaded,
} from "./flow-context-budget";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

describe("parseImports", () => {
  it("skips a code-span-only mention of an @import", async () => {
    const agentsContent = await fs.promises.readFile(
      path.join(REPO_ROOT, "AGENTS.md"),
      "utf8",
    );
    expect(parseImports(agentsContent)).toEqual([]);
  });

  it("finds a real @import line", async () => {
    const claudeContent = await fs.promises.readFile(
      path.join(REPO_ROOT, "CLAUDE.md"),
      "utf8",
    );
    expect(parseImports(claudeContent)).toEqual(["AGENTS.md"]);
  });
});

describe("hasPathsFrontmatter", () => {
  it("returns true for the supervisor-contracts rule file", async () => {
    const content = await fs.promises.readFile(
      path.join(REPO_ROOT, ".claude", "rules", "flow-supervisor-contracts.md"),
      "utf8",
    );
    expect(hasPathsFrontmatter(content)).toBe(true);
  });

  it("returns true for the bin-conventions rule file", async () => {
    const content = await fs.promises.readFile(
      path.join(REPO_ROOT, ".claude", "rules", "flow-bin-conventions.md"),
      "utf8",
    );
    expect(hasPathsFrontmatter(content)).toBe(true);
  });

  it("returns false with no frontmatter", () => {
    expect(hasPathsFrontmatter("# just a heading\nno frontmatter here")).toBe(
      false,
    );
  });
});

describe("resolveAlwaysLoaded", () => {
  it("lists exactly CLAUDE.md and AGENTS.md as eager and both rule files as lazy", async () => {
    const result = await resolveAlwaysLoaded(REPO_ROOT);
    const eagerNames = result.alwaysLoaded.files
      .map((f) => path.basename(f.path))
      .sort();
    expect(eagerNames).toEqual(["AGENTS.md", "CLAUDE.md"]);

    const lazyNames = result.lazy.files
      .map((f) => path.basename(f.path))
      .sort();
    expect(lazyNames).toEqual([
      "flow-bin-conventions.md",
      "flow-supervisor-contracts.md",
    ]);
  });
});
