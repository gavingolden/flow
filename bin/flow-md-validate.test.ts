/**
 * Tests for flow-md-validate.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  extractHeadings,
  extractLinks,
  gitEnv,
  listMarkdownFiles,
  main,
  MarkdownEnumerationError,
  parseFrontmatter,
  runValidation,
  slugifyHeading,
  stripCode,
  validateFile,
  walkMarkdownFiles,
} from "./flow-md-validate";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-md-validate-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(relPath: string, content: string): string {
  const full = path.join(tmp, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// Strip GIT_* so the fixture's `git init` never resolves against the
// outer repo vitest itself runs inside (this suite can inherit GIT_DIR /
// GIT_WORK_TREE from a pre-push hook context). Reuses the production
// `gitEnv` strip rather than duplicating it, so the fixture can't drift
// from the behaviour it exercises.
const gitFixtureEnv = gitEnv;

function gitc(cwd: string, args: string[]) {
  return spawnSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, env: gitFixtureEnv(), encoding: "utf8" },
  );
}

function initRepo(dir: string): void {
  spawnSync("git", ["init", "-q", "-b", "main"], {
    cwd: dir,
    env: gitFixtureEnv(),
  });
  gitc(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
}

describe(slugifyHeading, () => {
  it("lowercases and hyphenates spaces", () => {
    expect(slugifyHeading("Hello World")).toBe("hello-world");
  });

  it("strips backticks and emphasis markers", () => {
    expect(slugifyHeading("Use `flow` *now*")).toBe("use-flow-now");
  });

  it("strips most punctuation", () => {
    expect(slugifyHeading("What's New?")).toBe("whats-new");
  });

  it("preserves underscores (GitHub keeps them)", () => {
    expect(slugifyHeading("`state_unsafe_mutation` Error")).toBe(
      "state_unsafe_mutation-error",
    );
  });

  it("does not collapse repeated hyphens (GitHub does not)", () => {
    expect(slugifyHeading("Svelte 4 -> 5 Migration")).toBe(
      "svelte-4---5-migration",
    );
  });

  it("drops emoji and stand-alone punctuation, keeping surrounding hyphens", () => {
    expect(slugifyHeading("Status ✅ Done")).toBe("status--done");
  });

  it("returns empty string for purely-punctuation headings", () => {
    expect(slugifyHeading("???")).toBe("");
  });
});

describe(stripCode, () => {
  it("preserves line count by replacing fenced blocks with spaces", () => {
    const input = "before\n```js\nlet x = 1;\n```\nafter";
    const stripped = stripCode(input);
    expect(stripped.split("\n").length).toBe(input.split("\n").length);
    expect(stripped).toContain("before");
    expect(stripped).toContain("after");
    expect(stripped).not.toContain("let");
  });

  it("strips inline-code spans on non-fenced lines", () => {
    const input = "inline `code [`fake`](nope.md)` here";
    const stripped = stripCode(input);
    expect(stripped).not.toContain("`");
    expect(stripped).not.toContain("[");
  });

  it("does not strip non-code text", () => {
    const input = "see [docs](./other.md) for details";
    expect(stripCode(input)).toBe(input);
  });

  it("preserves column offsets within a line", () => {
    const input = "x `abc` y";
    const stripped = stripCode(input);
    expect(stripped.length).toBe(input.length);
    expect(stripped.indexOf("y")).toBe(input.indexOf("y"));
  });
});

describe(extractHeadings, () => {
  it("captures atx-style headings with correct line numbers", () => {
    const source = "# Top\n\n## Sub\n\nbody\n\n### Deep\n";
    expect(extractHeadings(source)).toEqual([
      { line: 1, slug: "top" },
      { line: 3, slug: "sub" },
      { line: 7, slug: "deep" },
    ]);
  });

  it("ignores headings inside fenced code blocks", () => {
    const source = "# Real\n```\n# Fake\n```\n";
    expect(extractHeadings(source)).toEqual([{ line: 1, slug: "real" }]);
  });

  it("dedups repeated headings with -1, -2 suffixes", () => {
    const source = "# Setup\n\n# Setup\n\n# Setup\n";
    expect(extractHeadings(source)).toEqual([
      { line: 1, slug: "setup" },
      { line: 3, slug: "setup-1" },
      { line: 5, slug: "setup-2" },
    ]);
  });

  it("handles trailing closing hashes", () => {
    expect(extractHeadings("## Title ##\n")).toEqual([
      { line: 1, slug: "title" },
    ]);
  });
});

describe(extractLinks, () => {
  it("captures relative-path links with line numbers", () => {
    const source = "see [a](./a.md)\n\nand [b](./b.md)";
    expect(extractLinks(source)).toEqual([
      { line: 1, raw: "./a.md", isImage: false },
      { line: 3, raw: "./b.md", isImage: false },
    ]);
  });

  it("flags image syntax", () => {
    const source = "![alt](./pic.png)";
    expect(extractLinks(source)).toEqual([
      { line: 1, raw: "./pic.png", isImage: true },
    ]);
  });

  it("ignores links inside code blocks", () => {
    const source = "```\n[fake](./nope.md)\n```\n";
    expect(extractLinks(source)).toEqual([]);
  });

  it("ignores links inside inline-code spans", () => {
    expect(extractLinks("`[fake](./nope.md)`")).toEqual([]);
  });

  it("supports anchor-only links", () => {
    expect(extractLinks("[s](#section)")).toEqual([
      { line: 1, raw: "#section", isImage: false },
    ]);
  });

  it("captures external links (caller filters them)", () => {
    expect(extractLinks("[home](https://example.com)")).toEqual([
      { line: 1, raw: "https://example.com", isImage: false },
    ]);
  });
});

describe(parseFrontmatter, () => {
  it("returns the inner block for a well-formed frontmatter", () => {
    const fm = parseFrontmatter(
      "---\nname: foo\ndescription: bar\n---\n\n# body\n",
    );
    expect(fm).toContain("name: foo");
    expect(fm).toContain("description: bar");
  });

  it("returns null when there is no opening delimiter", () => {
    expect(parseFrontmatter("# body\n")).toBeNull();
  });

  it("returns null when the closing delimiter is missing", () => {
    expect(parseFrontmatter("---\nname: foo\nbody\n")).toBeNull();
  });

  it("handles CRLF line endings", () => {
    const fm = parseFrontmatter("---\r\nname: foo\r\n---\r\n");
    expect(fm).toContain("name: foo");
  });
});

describe(walkMarkdownFiles, () => {
  it("returns the file itself when given a single .md file", () => {
    const f = write("a.md", "# a");
    expect(walkMarkdownFiles(f)).toEqual([f]);
  });

  it("returns empty for a non-markdown file", () => {
    const f = write("a.ts", "x");
    expect(walkMarkdownFiles(f)).toEqual([]);
  });

  it("recurses into directories and ignores .git, node_modules, .flow-tmp", () => {
    write("docs/x.md", "# x");
    write("docs/sub/y.md", "# y");
    write("node_modules/skip.md", "# skip");
    write(".git/skip.md", "# skip");
    write(".flow-tmp/plan.md", "# plan");
    write("README.md", "# readme");
    const found = walkMarkdownFiles(tmp)
      .map((p) => path.relative(tmp, p))
      .sort();
    expect(found).toEqual(["README.md", "docs/sub/y.md", "docs/x.md"]);
  });
});

describe(listMarkdownFiles, () => {
  it("skips gitignored trees inside a git work tree (#606 repro)", () => {
    initRepo(tmp);
    write(".gitignore", "vend/\n");
    write("README.md", "# readme\n");
    write("vend/provider/README.md", "[x](contributing/development.md)\n");
    gitc(tmp, ["add", "-A"]);
    gitc(tmp, ["commit", "-q", "-m", "init tree"]);

    const report = runValidation(tmp);
    expect(report.violations).toEqual([]);
    const found = listMarkdownFiles(tmp).map((p) => path.relative(tmp, p));
    expect(found.some((p) => p.split(path.sep).includes("vend"))).toBe(false);
  });

  it("still catches real breakage in a tracked file", () => {
    initRepo(tmp);
    write("docs/a.md", "[gone](./does-not-exist.md)\n");
    gitc(tmp, ["add", "-A"]);
    gitc(tmp, ["commit", "-q", "-m", "add docs"]);

    const report = runValidation(tmp);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].kind).toBe("broken-link-target");
  });

  it("checks untracked-not-ignored files too", () => {
    initRepo(tmp);
    write("new.md", "[gone](./does-not-exist.md)\n");

    const report = runValidation(tmp);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].kind).toBe("broken-link-target");
  });

  it("skips tracked-but-deleted paths without throwing", () => {
    initRepo(tmp);
    const d = write("docs/d.md", "# D\n");
    gitc(tmp, ["add", "-A"]);
    gitc(tmp, ["commit", "-q", "-m", "add d"]);
    fs.rmSync(d);

    expect(() => runValidation(tmp)).not.toThrow();
    const found = listMarkdownFiles(tmp).map((p) => path.relative(tmp, p));
    expect(found).not.toContain("docs/d.md");
  });

  it("falls back to walkMarkdownFiles outside a git work tree", () => {
    write("docs/x.md", "# x");
    write("README.md", "# readme");
    write("node_modules/skip.md", "# skip");
    write(".git/skip.md", "# skip");
    write(".flow-tmp/plan.md", "# plan");
    const found = listMarkdownFiles(tmp)
      .map((p) => path.relative(tmp, p))
      .sort();
    expect(found).toEqual(["README.md", "docs/x.md"]);
  });

  it("scopes to a subdirectory target inside a repo", () => {
    initRepo(tmp);
    write("docs/a.md", "# A\n");
    write("other/b.md", "# B\n");
    gitc(tmp, ["add", "-A"]);
    gitc(tmp, ["commit", "-q", "-m", "add files"]);

    const docsDir = path.join(tmp, "docs");
    const found = listMarkdownFiles(docsDir);
    expect(found).toEqual([path.join(docsDir, "a.md")]);
  });

  it("warns and exits 2 (never falls back to a blind walk) on enumeration failure", async () => {
    initRepo(tmp);
    write(".gitignore", "vend/\n");
    write("README.md", "# readme\n");
    write("vend/provider/README.md", "# vendored\n");
    gitc(tmp, ["add", "-A"]);
    gitc(tmp, ["commit", "-q", "-m", "init tree"]);

    // Corrupt the index so `rev-parse --is-inside-work-tree` still
    // succeeds but `ls-files` exits non-zero.
    fs.writeFileSync(path.join(tmp, ".git", "index"), "x");

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(() => listMarkdownFiles(tmp)).toThrow(MarkdownEnumerationError);
      expect(errSpy.mock.calls.flat().join(" ")).toMatch(
        /git enumeration failed.*not falling back to a walk/,
      );

      const found2 = walkMarkdownFiles(tmp).map((p) => path.relative(tmp, p));
      // Sanity: a blind walk WOULD have found the ignored file — proving
      // the enumeration-failed branch deliberately skips rather than
      // falling back to it.
      expect(found2.some((p) => p.split(path.sep).includes("vend"))).toBe(true);

      expect(await main([tmp])).toBe(2);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("still skips IGNORE_DIRS inside a work tree", () => {
    initRepo(tmp);
    write(".flow-tmp/plan.md", "[gone](./nope.md)\n");
    write("node_modules/pkg/README.md", "[gone](./nope.md)\n");
    write("README.md", "# readme\n");
    gitc(tmp, ["add", "-A", "-f"]);
    gitc(tmp, ["commit", "-q", "-m", "track vendored md"]);

    const found = listMarkdownFiles(tmp).map((p) => path.relative(tmp, p));
    expect(found).toEqual(["README.md"]);
    expect(runValidation(tmp).violations).toEqual([]);
  });

  it("ignores a leaked GIT_DIR/GIT_WORK_TREE from a hook context", () => {
    initRepo(tmp);
    write("tracked.md", "# tracked\n");
    gitc(tmp, ["add", "-A"]);
    gitc(tmp, ["commit", "-q", "-m", "t"]);

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "flow-md-outside-"));
    fs.writeFileSync(path.join(outside, "only.md"), "# only\n");
    const saved = {
      d: process.env.GIT_DIR,
      w: process.env.GIT_WORK_TREE,
    };
    process.env.GIT_DIR = path.join(tmp, ".git");
    process.env.GIT_WORK_TREE = tmp;
    try {
      // Without the strip, the probe answers "true" for `outside` and
      // ls-files enumerates the OTHER repo's files.
      expect(listMarkdownFiles(outside)).toEqual([
        path.join(outside, "only.md"),
      ]);
    } finally {
      saved.d ? (process.env.GIT_DIR = saved.d) : delete process.env.GIT_DIR;
      saved.w
        ? (process.env.GIT_WORK_TREE = saved.w)
        : delete process.env.GIT_WORK_TREE;
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("skips tracked symlinks (live and dangling)", () => {
    initRepo(tmp);
    write("real.md", "# real\n");
    fs.symlinkSync("real.md", path.join(tmp, "live-link.md"));
    fs.symlinkSync("gone.md", path.join(tmp, "dead-link.md"));
    gitc(tmp, ["add", "-A"]);
    gitc(tmp, ["commit", "-q", "-m", "links"]);

    const found = listMarkdownFiles(tmp).map((p) => path.relative(tmp, p));
    expect(found).toEqual(["real.md"]);
    expect(() => runValidation(tmp)).not.toThrow();
  });
});

describe(validateFile, () => {
  it("reports no violations for a clean file", () => {
    const a = write("a.md", "# A\n[other](./b.md)\n");
    write("b.md", "# B\n");
    expect(validateFile(a)).toEqual([]);
  });

  it("detects broken relative-path links", () => {
    const a = write("a.md", "[gone](./does-not-exist.md)\n");
    expect(validateFile(a)).toMatchObject([
      { line: 1, kind: "broken-link-target", detail: "./does-not-exist.md" },
    ]);
  });

  it("detects broken cross-file heading anchors", () => {
    const a = write("a.md", "[ref](./b.md#missing)\n");
    write("b.md", "# B\n## Real Section\n");
    expect(validateFile(a)).toMatchObject([
      { line: 1, kind: "broken-link-anchor", detail: "./b.md#missing" },
    ]);
  });

  it("accepts valid cross-file heading anchors", () => {
    const a = write("a.md", "[ref](./b.md#real-section)\n");
    write("b.md", "# B\n## Real Section\n");
    expect(validateFile(a)).toEqual([]);
  });

  it("detects in-page anchor mismatches", () => {
    const a = write("a.md", "# Top\n\n[ref](#nope)\n");
    expect(validateFile(a)).toMatchObject([
      { line: 3, kind: "broken-link-anchor", detail: "#nope" },
    ]);
  });

  it("accepts valid in-page anchors", () => {
    const a = write("a.md", "# Top\n\n[ref](#top)\n");
    expect(validateFile(a)).toEqual([]);
  });

  it("ignores external links", () => {
    const a = write(
      "a.md",
      "[home](https://example.com)\n[mail](mailto:x@y.z)\n",
    );
    expect(validateFile(a)).toEqual([]);
  });

  it("treats a file:// link as external, never resolving it against the filesystem", () => {
    // Regression: EXTERNAL_RE previously omitted the `file` scheme, so a
    // committed `[label](file:///abs/path)` markdown link (e.g. the
    // clickable-output docs this PR adds) got path.resolve()'d and
    // reported as a broken-link-target, turning the docs-scope gate red.
    const a = write("a.md", "[abs](file:///abs/does-not-exist/path)\n");
    expect(validateFile(a)).toEqual([]);
  });

  it("ignores image links", () => {
    const a = write("a.md", "![pic](./does-not-exist.png)\n");
    expect(validateFile(a)).toEqual([]);
  });

  it("ignores links inside code blocks and inline code", () => {
    const a = write(
      "a.md",
      "```\n[fake](./nope.md)\n```\n\nAlso `[fake](./nope.md)` inline.\n",
    );
    expect(validateFile(a)).toEqual([]);
  });

  it("detects SKILL.md missing frontmatter", () => {
    const a = write("skills/x/SKILL.md", "# X\n\nbody\n");
    expect(validateFile(a)).toMatchObject([
      { line: 1, kind: "missing-frontmatter" },
    ]);
  });

  it("detects SKILL.md missing name field", () => {
    const a = write("skills/x/SKILL.md", "---\ndescription: foo\n---\n\n# X\n");
    expect(validateFile(a)).toMatchObject([
      { line: 1, kind: "missing-frontmatter-name" },
    ]);
  });

  it("accepts SKILL.md with name", () => {
    const a = write(
      "skills/x/SKILL.md",
      "---\nname: x\ndescription: foo\n---\n\n# X\n",
    );
    expect(validateFile(a)).toEqual([]);
  });

  it("does not require frontmatter on non-SKILL.md files", () => {
    const a = write("docs/x.md", "# X\n\nbody\n");
    expect(validateFile(a)).toEqual([]);
  });
});

describe(runValidation, () => {
  it("aggregates files, links, and violations across a tree", () => {
    write("a.md", "# A\n[good](./b.md)\n[bad](./missing.md)\n");
    write("b.md", "# B\n");
    const report = runValidation(tmp);
    expect(report.fileCount).toBe(2);
    expect(report.linkCount).toBe(2);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].kind).toBe("broken-link-target");
  });

  it("returns a clean report when there are no violations", () => {
    write("a.md", "# A\n");
    write("b.md", "# B\n");
    const report = runValidation(tmp);
    expect(report.violations).toEqual([]);
  });

  it("sorts violations by file then by line", () => {
    write("z.md", "[bad](./missing-z.md)\n");
    write("a.md", "[bad1](./missing.md)\n[bad2](./missing.md)\n");
    const report = runValidation(tmp);
    const order = report.violations.map(
      (v) => `${path.basename(v.file)}:${v.line}`,
    );
    expect(order).toEqual(["a.md:1", "a.md:2", "z.md:1"]);
  });
});

describe(main, () => {
  it("returns 0 on a clean tree and prints a summary", async () => {
    write("a.md", "# A\n");
    const log: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => log.push(args.join(" "));
    try {
      const code = await main([tmp]);
      expect(code).toBe(0);
    } finally {
      console.log = origLog;
    }
    expect(log.some((l) => l.includes("0 violations"))).toBe(true);
  });

  it("returns 1 when violations exist", async () => {
    write("a.md", "[bad](./missing.md)\n");
    const log: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => log.push(args.join(" "));
    try {
      const code = await main([tmp]);
      expect(code).toBe(1);
    } finally {
      console.log = origLog;
    }
    expect(log.some((l) => l.includes("broken-link-target"))).toBe(true);
  });

  it("returns 2 with a usage error when no path is given", async () => {
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.join(" "));
    try {
      const code = await main([]);
      expect(code).toBe(2);
    } finally {
      console.error = origErr;
    }
    expect(errs.some((l) => l.includes("Usage:"))).toBe(true);
  });

  it("returns 2 when the path does not exist", async () => {
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.join(" "));
    try {
      const code = await main([path.join(tmp, "no-such-dir")]);
      expect(code).toBe(2);
    } finally {
      console.error = origErr;
    }
    expect(errs.some((l) => l.includes("does not exist"))).toBe(true);
  });

  it("returns 2 when more than one argument is given", async () => {
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.join(" "));
    try {
      const code = await main([tmp, tmp]);
      expect(code).toBe(2);
    } finally {
      console.error = origErr;
    }
    expect(errs.some((l) => l.includes("too many arguments"))).toBe(true);
  });

  it("returns 0 on --help", async () => {
    const log: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => log.push(args.join(" "));
    try {
      expect(await main(["--help"])).toBe(0);
      expect(await main(["-h"])).toBe(0);
    } finally {
      console.log = origLog;
    }
    expect(log.some((l) => l.includes("Usage:"))).toBe(true);
  });
});

describe("main --fix-pr-body / --check-pr-body", () => {
  it("--fix-pr-body rewrites a malformed file in place and exits 0", async () => {
    const file = write(
      "body.md",
      "<details><summary>x</summary>\ncontent\n</details>\nafter\n",
    );
    const log: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => log.push(args.join(" "));
    try {
      const code = await main(["--fix-pr-body", file]);
      expect(code).toBe(0);
    } finally {
      console.log = origLog;
    }
    const out = fs.readFileSync(file, "utf8");
    expect(out).toContain("<summary>x</summary>\n\ncontent");
    expect(out).toContain("</details>\n\nafter");
    expect(log.some((l) => l.includes("normalized 2"))).toBe(true);
  });

  it("--fix-pr-body is a no-op on an already-clean file and still exits 0", async () => {
    const clean = "<details><summary>x</summary>\n\ncontent\n\n</details>\n";
    const file = write("clean.md", clean);
    const log: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => log.push(args.join(" "));
    try {
      const code = await main(["--fix-pr-body", file]);
      expect(code).toBe(0);
    } finally {
      console.log = origLog;
    }
    expect(fs.readFileSync(file, "utf8")).toBe(clean);
    expect(log.some((l) => l.includes("normalized 0"))).toBe(true);
  });

  it("--check-pr-body exits 1 and reports defects without mutating the file", async () => {
    const malformed =
      "<details><summary>x</summary>\ncontent\n</details>\nafter\n";
    const file = write("check.md", malformed);
    const log: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => log.push(args.join(" "));
    try {
      const code = await main(["--check-pr-body", file]);
      expect(code).toBe(1);
    } finally {
      console.log = origLog;
    }
    expect(fs.readFileSync(file, "utf8")).toBe(malformed);
    expect(log.some((l) => l.includes("missing-blank-after-summary"))).toBe(
      true,
    );
    expect(
      log.some((l) => l.includes("missing-blank-after-details-close")),
    ).toBe(true);
  });

  it("--check-pr-body exits 0 on a clean file", async () => {
    const clean = "<details><summary>x</summary>\n\ncontent\n\n</details>\n";
    const file = write("check-clean.md", clean);
    const code = await main(["--check-pr-body", file]);
    expect(code).toBe(0);
  });

  it("does not break the existing single-path repo-walk contract", async () => {
    write("a.md", "# A\n");
    expect(await main([tmp])).toBe(0);
  });
});
