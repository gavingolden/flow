/**
 * Tests for the extracted flow-ownership predicate. Covers BOTH ownership
 * polarities of the raw-OR-realpath check by CONSTRUCTING the divergence
 * rather than relying on `os.tmpdir()` routing through a symlinked prefix
 * (macOS's `/var` → `/private/var`) — that inherited routing made both
 * polarity tests pass on `ubuntu-latest`, where `mkdtempSync`'s raw path IS
 * its own realpath, even with either `some()` clause in `isFlowOwnedSymlink`
 * deleted. `scratch/alias -> scratch/physical` is a real, portable symlink
 * pair: a link/target created under the ALIAS side pins the `raw` clause
 * (the alias path never realpath-resolves to itself), and one created under
 * the PHYSICAL side pins the `resolved` clause (only realpathing the link
 * text reaches the physical root). Neither clause may be deleted without a
 * test here failing, on any platform — that is the load-bearing property of
 * this file, mirroring the vectors `setup.test.ts`'s "drift-sweeps a
 * flow-owned old-location symlink..." (line ~2932) and "drift-sweeps a
 * DANGLING flow-owned old-location symlink..." (line ~2957) regressions
 * exist to protect.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isFlowOwnedSymlink, isPathUnder } from "./flow-owned-symlink";

let scratch!: string;
/** `scratch/physical` — the real directory. */
let physical!: string;
/** `scratch/alias -> physical` — a constructed symlink indirection, so the
 * raw-vs-realpath divergence exists on every platform, not just macOS. */
let alias!: string;

beforeEach(() => {
  // realpath the scratch root itself so `physical` isn't ALSO sitting
  // behind an OS-level symlink indirection (macOS's `/var` ->
  // `/private/var`, which `os.tmpdir()` routes through) — the alias/physical
  // pair below must be the ONLY divergence under test, not stacked on top
  // of an incidental platform one.
  scratch = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "flow-owned-symlink-")),
  );
  physical = path.join(scratch, "physical");
  fs.mkdirSync(physical);
  alias = path.join(scratch, "alias");
  fs.symlinkSync(physical, alias);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe(isFlowOwnedSymlink, () => {
  it("a live symlink under a REALPATH'd root is owned — pins the `resolved` clause", () => {
    // The target FILE physically lives under `physical/`, but the symlink's
    // TARGET TEXT is written through the `alias` indirection, and the
    // ownership root is `physical`. `raw` (the un-resolved link text) is
    // alias-rooted, so `isPathUnder(raw, physical)` misses; only
    // `isPathUnder(resolved, physical)`, which realpaths the alias segment
    // away, can match.
    const target = path.join(physical, "real-target.ts");
    fs.writeFileSync(target, "export {};\n");
    const aliasedTarget = path.join(alias, "real-target.ts");
    const link = path.join(physical, "owned-link");
    fs.symlinkSync(aliasedTarget, link);
    expect(isFlowOwnedSymlink(link, [physical])).toBe(true);
  });

  it("a live symlink under the RAW (non-realpath'd) root is owned — pins the `raw` clause", () => {
    // Both the link and its target are created (and referenced) entirely
    // through the `alias` path, and the ownership root is `alias` too. `raw`
    // (the unresolved, alias-rooted link text) matches `alias` directly;
    // `resolved` follows the alias symlink to `physical` and no longer
    // mentions `alias` at all, so `isPathUnder(resolved, alias)` misses —
    // only the `raw` clause can match.
    const target = path.join(alias, "real-target.ts");
    fs.writeFileSync(target, "export {};\n");
    const link = path.join(alias, "owned-link");
    fs.symlinkSync(target, link);
    expect(isFlowOwnedSymlink(link, [alias])).toBe(true);
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
