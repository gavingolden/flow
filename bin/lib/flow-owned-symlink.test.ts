/**
 * Tests for the extracted flow-ownership predicate. Covers BOTH ownership
 * polarities of the raw-OR-realpath check — `mkdtempSync(os.tmpdir())` on
 * macOS yields `/var/folders/...`, which realpaths to
 * `/private/var/folders/...`, so a root derived from ONE of those two forms
 * exercises only ONE of the two `some()` clauses in
 * `isFlowOwnedSymlink`. Neither clause may be deleted without a test here
 * failing — that is the load-bearing property of this file, mirroring the
 * vectors `setup.test.ts`'s "drift-sweeps a flow-owned old-location
 * symlink..." (line ~2932) and "drift-sweeps a DANGLING flow-owned
 * old-location symlink..." (line ~2957) regressions exist to protect.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isFlowOwnedSymlink, isPathUnder } from "./flow-owned-symlink";

let scratch!: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-owned-symlink-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe(isFlowOwnedSymlink, () => {
  it("a live symlink under a REALPATH'd root is owned — pins the `resolved` clause", () => {
    // The root is realpath'd (/private/var/... on macOS); the link and its
    // target are created under the RAW scratch path. Only `isPathUnder(resolved, root)`
    // can match here — the raw clause alone would compare a /var/... raw
    // path against a /private/var/... root and miss.
    const root = fs.realpathSync(scratch);
    const target = path.join(scratch, "real-target.ts");
    fs.writeFileSync(target, "export {};\n");
    const link = path.join(scratch, "owned-link");
    fs.symlinkSync(target, link);
    expect(isFlowOwnedSymlink(link, [root])).toBe(true);
  });

  it("a live symlink under the RAW (non-realpath'd) root is owned — pins the `raw` clause", () => {
    // The root is the raw mkdtempSync path; nothing here is realpath'd.
    // `isPathUnder(resolved, root)` compares a /private/var/... resolved
    // target against a /var/... root and misses — only `isPathUnder(raw, root)`
    // matches. Without the `raw` clause this vector alone would false-negate.
    const target = path.join(scratch, "real-target.ts");
    fs.writeFileSync(target, "export {};\n");
    const link = path.join(scratch, "owned-link");
    fs.symlinkSync(target, link);
    expect(isFlowOwnedSymlink(link, [scratch])).toBe(true);
  });

  it("relative link text resolves against path.dirname(linkPath)", () => {
    const root = scratch;
    const subdir = path.join(scratch, "sub");
    fs.mkdirSync(subdir);
    const target = path.join(scratch, "relative-target.ts");
    fs.writeFileSync(target, "export {};\n");
    const link = path.join(subdir, "owned-link");
    fs.symlinkSync(path.join("..", "relative-target.ts"), link);
    expect(isFlowOwnedSymlink(link, [root])).toBe(true);
  });

  it("a live symlink resolving outside every root is not owned", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "flow-outside-"));
    try {
      const target = path.join(outside, "foreign-target.ts");
      fs.writeFileSync(target, "export {};\n");
      const link = path.join(scratch, "foreign-link");
      fs.symlinkSync(target, link);
      expect(isFlowOwnedSymlink(link, [scratch])).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a non-symlink path is not owned", () => {
    const file = path.join(scratch, "real-file.ts");
    fs.writeFileSync(file, "export {};\n");
    expect(isFlowOwnedSymlink(file, [scratch])).toBe(false);
  });

  it("an unreadable/nonexistent path never throws and is not owned", () => {
    expect(() =>
      isFlowOwnedSymlink(path.join(scratch, "does-not-exist"), [scratch]),
    ).not.toThrow();
    expect(
      isFlowOwnedSymlink(path.join(scratch, "does-not-exist"), [scratch]),
    ).toBe(false);
  });

  it("roots that do not exist on disk never throw and are not owned", () => {
    const target = path.join(scratch, "real-target.ts");
    fs.writeFileSync(target, "export {};\n");
    const link = path.join(scratch, "owned-link");
    fs.symlinkSync(target, link);
    const missingRoot = path.join(scratch, "no-such-root");
    expect(() => isFlowOwnedSymlink(link, [missingRoot])).not.toThrow();
    expect(isFlowOwnedSymlink(link, [missingRoot])).toBe(false);
  });

  it("a dangling symlink whose raw path is under a root is owned (the realpath-fallback branch)", () => {
    const target = path.join(scratch, "gone-target.ts");
    fs.writeFileSync(target, "export {};\n");
    const link = path.join(scratch, "dangling-owned-link");
    fs.symlinkSync(target, link);
    fs.rmSync(target); // dangles; realpathSync(raw) now throws
    expect(isFlowOwnedSymlink(link, [scratch])).toBe(true);
  });

  it("a dangling symlink whose raw path is outside every root is not owned", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "flow-outside-"));
    try {
      const target = path.join(outside, "gone-target.ts");
      fs.writeFileSync(target, "export {};\n");
      const link = path.join(scratch, "dangling-foreign-link");
      fs.symlinkSync(target, link);
      fs.rmSync(target);
      expect(isFlowOwnedSymlink(link, [scratch])).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe(isPathUnder, () => {
  it("is true when child equals parent", () => {
    expect(isPathUnder("/a/b", "/a/b")).toBe(true);
  });

  it("is true when child is nested under parent", () => {
    expect(isPathUnder("/a/b/c", "/a/b")).toBe(true);
  });

  it("is false when child is outside parent", () => {
    expect(isPathUnder("/a/c", "/a/b")).toBe(false);
  });

  it("is false when child is a sibling prefix-match (not a real path segment boundary)", () => {
    expect(isPathUnder("/a/bcd", "/a/b")).toBe(false);
  });
});
