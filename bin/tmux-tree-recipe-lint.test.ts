import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PHASE_SHORT } from "./lib/state";

/**
 * docs/tmux-tree.conf is a user-facing contract: users `source-file` it, so a
 * renamed option or phase value silently blanks their tree view. fs reads
 * only — the verify job has neither tmux nor vhs; the Demo render workflow
 * runs the real render (docs/demo/README.md).
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const read = (rel: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

// Parsed from source: `FLOW_SLUG_OPTION` is deliberately module-private
// (pane-read-lint pins that only exported constants are published badges), so
// an import would miss it.
const PUBLISHED = new Set(
  [
    ...read("bin/lib/tmux.ts").matchAll(
      /const FLOW_[A-Z0-9_]+_OPTION = "(@flow-[a-z-]+)"/g,
    ),
  ].map((m) => m[1]),
);

const recipeLines = read("docs/tmux-tree.conf")
  .split("\n")
  .filter((l) => l.trim() !== "" && !l.startsWith("#"));
const line = recipeLines[0] ?? "";

describe("docs/tmux-tree.conf", () => {
  it("should hold exactly one bind-key choose-tree line", () => {
    expect(recipeLines).toHaveLength(1);
    expect(line.startsWith("bind-key w choose-tree")).toBe(true);
  });

  it("should appear byte-for-byte in docs/tmux.md", () => {
    expect(read("docs/tmux.md")).toContain(line);
  });

  it("should reference only options flow publishes", () => {
    for (const o of [
      "@flow-slug",
      "@flow-phase",
      "@flow-phase-short",
      "@flow-repo",
      "@flow-epic",
      "@flow-kind",
      "@flow-pr",
    ])
      expect(PUBLISHED.has(o), o).toBe(true);
    const used = line.match(/@[a-z][a-z-]*/g) ?? [];
    expect(used.length).toBeGreaterThan(0);
    for (const opt of used) expect(PUBLISHED.has(opt), opt).toBe(true);
  });

  it("should compare phase-short only against real PHASE_SHORT values", () => {
    const values = new Set(Object.values(PHASE_SHORT));
    const compared = [
      ...line.matchAll(/#\{==:#\{@flow-phase-short\},([^}]+)\}/g),
    ].map((m) => m[1]);
    expect(compared.length).toBeGreaterThan(0);
    for (const v of compared) expect(values.has(v), v).toBe(true);
    expect([...values].some((v) => v.endsWith("?"))).toBe(true);
  });

  it("should match waiting phases with *[?], not a bare *?", () => {
    expect(line).toContain("#{m:*[?],");
    expect(line).not.toMatch(/#\{m:\*\?,/);
  });

  it("should expand the PR number only inside its guard with a literal # escape", () => {
    const guard = "#{?#{@flow-pr},###{@flow-pr},";
    expect(line).toContain(guard);
    const stripped = line.split(guard).join("");
    const rest = stripped.match(/\{@flow-pr\}/g) ?? [];
    expect(rest).toHaveLength(0);
  });
});

describe("recipe column widths", () => {
  const width = (token: string): number =>
    Number(line.match(new RegExp(`#\\{p(\\d+):[^ ]*${token}`))?.[1]);

  it("should pad the phase column to the longest PHASE_SHORT value", () => {
    const longest = Math.max(
      ...Object.values(PHASE_SHORT).map((v) => v.length),
    );
    expect(width("@flow-phase-short")).toBeGreaterThanOrEqual(longest);
  });

  it("should pad the PR column to # plus five digits", () => {
    expect(width("@flow-pr")).toBeGreaterThanOrEqual(6);
  });

  it("should keep a pane row branch so split windows render", () => {
    expect(line).toContain("#{?pane_format,");
  });
});

describe("docs/demo/tmux.tape", () => {
  it("should type the README's source-file step and reload", () => {
    const echo = read("README.md").match(
      /^\s*(echo 'source-file [^']+tmux-tree\.conf' >> ~\/\.tmux\.conf)$/m,
    )?.[1];
    expect(echo).toBeDefined();
    const tape = read("docs/demo/tmux.tape");
    expect(tape).toContain(`Type "${echo}"`);
    expect(tape).toContain('Type "tmux source-file ~/.tmux.conf"');
    expect(read("docs/tmux.md")).toContain(echo!);
  });

  it("should route every tmux call through the private flow-demo socket", () => {
    const tape = read("docs/demo/tmux.tape");
    const typed = tape.split("\n").filter((l) => l.startsWith("Type"));
    const wrap = typed.findIndex((l) =>
      l.includes('tmux() { command tmux -L flow-demo "$@"; }'),
    );
    expect(wrap).toBeGreaterThanOrEqual(0);
    for (const l of typed.slice(0, wrap)) expect(l).not.toMatch(/\btmux\b/);
    expect(tape).toContain('rm -rf "${D:?}"');
    const script = read("docs/demo/render-tmux-tree.ts");
    for (const m of script.matchAll(/spawnSync\("tmux", \[([^\]]*)\]/g))
      expect(m[1]).toContain('"-L", "flow-demo"');
  });
});
