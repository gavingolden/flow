/**
 * Tests for flow-md-validate.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  extractHeadings,
  extractLinks,
  main,
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
