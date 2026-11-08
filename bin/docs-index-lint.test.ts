import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { validateFile } from "./flow-md-validate";

/**
 * Every top-level docs/*.md and every docs/<dir>/README.md must be linked
 * from the root README or docs/README.md; each subdir README owns its own
 * children. fs reads only.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const read = (rel: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const docsDir = path.join(REPO_ROOT, "docs");
const entries = fs.readdirSync(docsDir, { withFileTypes: true });
const topLevel = entries
  .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "README.md")
  .map((e) => `docs/${e.name}`);
const subdirReadmes = entries
  .filter(
    (e) =>
      e.isDirectory() && fs.existsSync(path.join(docsDir, e.name, "README.md")),
  )
  .map((e) => `docs/${e.name}/README.md`);

const rootReadme = read("README.md");
const linkTargets = (text: string, base: string): Set<string> => {
  const targets = new Set<string>();
  for (const m of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
    targets.add(path.posix.normalize(path.posix.join(base, m[1])));
  }
  return targets;
};
const reachable = new Set([
  ...linkTargets(rootReadme, "."),
  ...linkTargets(read("docs/README.md"), "docs"),
]);

describe("docs reachability", () => {
  it("should link every top-level doc and docs/*/README.md", () => {
    const orphans = [...topLevel, ...subdirReadmes].filter(
      (f) => !reachable.has(f),
    );
    expect(orphans).toEqual([]);
  });

  it("should find docs to check", () => {
    expect(topLevel.length).toBeGreaterThan(0);
    expect(subdirReadmes.length).toBeGreaterThan(0);
  });

  it("should link the docs index and tmux guide near the top of the README", () => {
    const head = rootReadme.split("\n").slice(0, 40).join("\n");
    expect(head).toContain("docs/README.md");
    expect(head).toContain("docs/tmux.md");
  });

  it("should keep the README under its word cap and links valid", () => {
    // Counting rule: whitespace-separated tokens (matches `wc -w`).
    expect(rootReadme.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(
      1000,
    );
    expect(rootReadme).toContain("docs/demo/tmux.gif");
    expect(
      fs.statSync(path.join(REPO_ROOT, "docs/demo/tmux.gif")).size,
    ).toBeLessThan(1_500_000);
    for (const f of [
      "README.md",
      "docs/README.md",
      "docs/tmux.md",
      "docs/getting-started.md",
    ])
      expect(validateFile(path.join(REPO_ROOT, f)), f).toEqual([]);
  });
});
