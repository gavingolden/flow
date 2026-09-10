import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasPathsFrontmatter,
  parseImports,
  resolveAlwaysLoaded,
} from "./flow-context-budget";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

describe("parseImports", () => {
  it("skips a code-span-only mention of an @import", () => {
    expect(parseImports("see `@AGENTS.md` here")).toEqual([]);
  });

  it("skips an @import inside a fenced code block", () => {
    expect(parseImports("```\n@x.md\n```")).toEqual([]);
  });

  it("finds whole-line @imports", () => {
    expect(parseImports("@docs/a.md\n@b.md  ")).toEqual(["docs/a.md", "b.md"]);
  });

  it("finds an inline mid-line @import alongside a code-span mention on another line", () => {
    expect(parseImports("a `@x.md` and\n@y.md")).toEqual(["y.md"]);
  });

  it("finds a mid-sentence @import the way Claude Code resolves it", () => {
    expect(
      parseImports(
        "See @README for project overview and @package.json for available npm commands",
      ),
    ).toEqual(["README", "package.json"]);
  });

  it("strips trailing punctuation from an inline import token", () => {
    expect(
      parseImports("Full mechanics at @references/git-workflow.md."),
    ).toEqual(["references/git-workflow.md"]);
  });

  it("resolves a home-relative @~/... import token", () => {
    expect(parseImports("See @~/.claude/notes.md for context.")).toEqual([
      "~/.claude/notes.md",
    ]);
  });

  it("skips a code-span-only mention in the live AGENTS.md (smoke test)", async () => {
    const agentsContent = await fs.promises.readFile(
      path.join(REPO_ROOT, "AGENTS.md"),
      "utf8",
    );
    expect(parseImports(agentsContent)).toEqual([]);
  });

  it("finds the real @import line in the live CLAUDE.md (smoke test)", async () => {
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

  it("returns false when frontmatter exists but lacks a paths: key", () => {
    expect(hasPathsFrontmatter("---\ndescription: x\n---\nbody")).toBe(false);
  });

  it("returns false when paths: appears only in the body, not frontmatter", () => {
    expect(hasPathsFrontmatter('---\ndescription: x\n---\npaths: ["a"]')).toBe(
      false,
    );
  });

  it("returns true for an inline fixture with a paths: key", () => {
    expect(hasPathsFrontmatter('---\npaths: ["bin/**"]\n---\n')).toBe(true);
  });

  it("tolerates CRLF line endings in the frontmatter block", () => {
    expect(hasPathsFrontmatter('---\r\npaths: ["bin/**"]\r\n---\r\n')).toBe(
      true,
    );
    expect(hasPathsFrontmatter("---\r\ndescription: x\r\n---\r\nbody")).toBe(
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

  describe("fixture repo", () => {
    let tmpRoot: string | null = null;

    afterEach(() => {
      if (tmpRoot) {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = null;
      }
    });

    it("follows a multi-hop import chain, classifies unscoped/scoped rules, and drops a missing import target", async () => {
      tmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "flow-context-budget-fixture-"),
      );
      fs.writeFileSync(path.join(tmpRoot, "CLAUDE.md"), "@AGENTS.md\n");
      fs.writeFileSync(path.join(tmpRoot, "AGENTS.md"), "@docs/deep.md\n");
      fs.mkdirSync(path.join(tmpRoot, "docs"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "docs", "deep.md"),
        "@missing.md\nbody text\n",
      );
      fs.mkdirSync(path.join(tmpRoot, ".claude", "rules", "nested"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(tmpRoot, ".claude", "rules", "scoped.md"),
        '---\npaths: ["bin/**"]\n---\nscoped body\n',
      );
      fs.writeFileSync(
        path.join(tmpRoot, ".claude", "rules", "nested", "unscoped.md"),
        "no frontmatter here, so this rule loads unconditionally\n",
      );

      const result = await resolveAlwaysLoaded(tmpRoot);

      expect(
        result.alwaysLoaded.files.map((f) => path.basename(f.path)).sort(),
      ).toEqual(["AGENTS.md", "CLAUDE.md", "deep.md", "unscoped.md"]);
      expect(
        result.lazy.files.map((f) => path.basename(f.path)).sort(),
      ).toEqual(["scoped.md"]);
    });

    it("caps the import chain at MAX_IMPORT_DEPTH and drops the 5th-hop file", async () => {
      tmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "flow-context-budget-fixture-depth-"),
      );
      fs.writeFileSync(path.join(tmpRoot, "CLAUDE.md"), "@a.md\n");
      fs.writeFileSync(path.join(tmpRoot, "a.md"), "@b.md\n");
      fs.writeFileSync(path.join(tmpRoot, "b.md"), "@c.md\n");
      fs.writeFileSync(path.join(tmpRoot, "c.md"), "@d.md\n");
      fs.writeFileSync(path.join(tmpRoot, "d.md"), "@e.md\n");
      fs.writeFileSync(path.join(tmpRoot, "e.md"), "no further imports\n");

      const result = await resolveAlwaysLoaded(tmpRoot);
      const names = result.alwaysLoaded.files
        .map((f) => path.basename(f.path))
        .sort();
      expect(names).not.toContain("e.md");
      expect(names).not.toContain("d.md");
      expect(names).toEqual(["CLAUDE.md", "a.md", "b.md", "c.md"].sort());
    });
  });
});
