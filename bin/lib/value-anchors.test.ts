import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ANCHOR_RE,
  extractPathAnchors,
  resolveAnchorRepoRoot,
} from "./value-anchors";

describe("extractPathAnchors", () => {
  it("extracts a bare file:line anchor's path (line suffix not part of the match)", () => {
    expect(
      extractPathAnchors("**Problem:** thing broke [anchor: src/foo.ts:42]"),
    ).toEqual(["src/foo.ts"]);
  });

  it("extracts a backticked file anchor and strips the backticks", () => {
    expect(extractPathAnchors("[anchor: `bin/lib/repo-root.ts:10`]")).toEqual([
      "bin/lib/repo-root.ts",
    ]);
  });

  it("does not treat a command->output anchor as a file anchor", () => {
    expect(extractPathAnchors("[anchor: `gh issue list` → 30]")).toEqual([]);
  });

  it("does not treat a PR/issue reference anchor as a file anchor", () => {
    expect(extractPathAnchors("[anchor: PR #519]")).toEqual([]);
  });

  it("does not treat a measured number as a file anchor", () => {
    expect(extractPathAnchors("[anchor: 1.8s]")).toEqual([]);
    expect(extractPathAnchors("[anchor: v2.1.234]")).toEqual([]);
  });

  it("does not treat quoted user words as a file anchor", () => {
    expect(
      extractPathAnchors('[anchor: "issues are written without a template"]'),
    ).toEqual([]);
  });

  it("drops a ~/-prefixed anchor", () => {
    expect(extractPathAnchors("[anchor: ~/notes.md]")).toEqual([]);
    expect(extractPathAnchors("[anchor: ~]")).toEqual([]);
  });

  it("extracts multiple anchors from one block", () => {
    expect(
      extractPathAnchors("[anchor: a/b.ts:1] some text [anchor: c/d.ts:2,3]"),
    ).toEqual(["a/b.ts", "c/d.ts"]);
  });

  it("returns an empty array for text with no anchors", () => {
    expect(extractPathAnchors("no anchors here")).toEqual([]);
  });

  it("ANCHOR_RE is exported for reuse by consumers", () => {
    expect(ANCHOR_RE).toBeInstanceOf(RegExp);
  });
});

describe("resolveAnchorRepoRoot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "value-anchors-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves the repo root from a plan file's directory inside a git repo", () => {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
    const planFile = path.join(repoRoot, ".flow-tmp", "plan.md");
    expect(resolveAnchorRepoRoot(planFile)).toBe(repoRoot);
  });

  it("resolves to a genuinely different root than process.cwd() for a plan file in a separate git repo", () => {
    execFileSync("git", ["init", "-q"], { cwd: tmpDir });
    const nestedDir = path.join(tmpDir, "nested");
    fs.mkdirSync(nestedDir);
    const planFile = path.join(nestedDir, "plan.md");
    const resolvedRoot = fs.realpathSync(resolveAnchorRepoRoot(planFile));
    const expectedRoot = fs.realpathSync(tmpDir);
    expect(resolvedRoot).toBe(expectedRoot);
    expect(resolvedRoot).not.toBe(fs.realpathSync(process.cwd()));
  });

  it("falls back to process.cwd() outside a git repo", () => {
    const planFile = path.join(tmpDir, "plan.md");
    expect(resolveAnchorRepoRoot(planFile)).toBe(process.cwd());
  });

  it("falls back to process.cwd() when planMdFile is undefined", () => {
    expect(resolveAnchorRepoRoot(undefined)).toBe(process.cwd());
  });
});
