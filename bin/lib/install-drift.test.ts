/**
 * Tests for `bin/lib/install-drift.ts`. All seams (`readManifest`,
 * `discover`, `flowSource`) are injected — no test here reads or writes the
 * real `~/.flow`. Real symlinks are created under a scratch tmpdir so the
 * missing/dangling/stale classification exercises real `fs.readlinkSync` /
 * `fs.realpathSync` semantics rather than a hand-rolled stub.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkInstallDrift,
  formatDriftNotice,
  type InstallDriftOptions,
} from "./install-drift";
import type { Manifest, SymlinkRecord } from "./manifest";
import type { SourceEntry } from "./sources";

let scratch: string;

afterEach(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

function makeScratch(): string {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "install-drift-"));
  return scratch;
}

function entry(overrides: Partial<SourceEntry> = {}): SourceEntry {
  return {
    source: "/nonexistent/source",
    target: "/nonexistent/target",
    kind: "skill",
    displayName: "flow-new-feature",
    ...overrides,
  };
}

function record(overrides: Partial<SymlinkRecord> = {}): SymlinkRecord {
  return {
    source: "/nonexistent/source",
    target: "/nonexistent/target",
    kind: "skill",
    ...overrides,
  };
}

function manifest(symlinks: SymlinkRecord[]): Manifest {
  return { version: 1, symlinks };
}

function run(opts: Partial<InstallDriftOptions>) {
  return checkInstallDrift({
    flowSource: "/flow-source",
    installRoot: "/flow-source",
    manifestPath: "/unused",
    ...opts,
  });
}

describe(checkInstallDrift, () => {
  it("reports clean when the manifest has no symlinks recorded", () => {
    const result = run({
      readManifest: () => manifest([]),
      discover: () => [entry()],
    });
    expect(result).toEqual({ status: "clean" });
  });

  it("reports clean when a manifest-recorded symlink correctly resolves to its source", () => {
    const dir = makeScratch();
    const source = path.join(dir, "source.txt");
    fs.writeFileSync(source, "content");
    const target = path.join(dir, "target-link");
    fs.symlinkSync(source, target);

    const result = run({
      readManifest: () => manifest([record({ target })]),
      discover: () => [entry({ source, target })],
    });
    expect(result).toEqual({ status: "clean" });
  });

  it("reports 'missing' when a manifest-recorded target has no symlink and no file", () => {
    const dir = makeScratch();
    const source = path.join(dir, "source.txt");
    fs.writeFileSync(source, "content");
    const target = path.join(dir, "never-linked");

    const result = run({
      readManifest: () => manifest([record({ target })]),
      discover: () => [entry({ source, target })],
    });
    expect(result).toEqual({
      status: "drifted",
      entries: [{ kind: "missing", displayName: "flow-new-feature", target }],
    });
  });

  it("does not flag a real (non-symlink) file at the target — that is user-owned, not drift", () => {
    const dir = makeScratch();
    const source = path.join(dir, "source.txt");
    fs.writeFileSync(source, "content");
    const target = path.join(dir, "user-owned.txt");
    fs.writeFileSync(target, "user content");

    const result = run({
      readManifest: () => manifest([record({ target })]),
      discover: () => [entry({ source, target })],
    });
    expect(result).toEqual({ status: "clean" });
  });

  it("reports 'dangling' when the symlink's recorded source no longer exists", () => {
    const dir = makeScratch();
    const source = path.join(dir, "gone-source.txt");
    fs.writeFileSync(source, "content");
    const target = path.join(dir, "dangling-link");
    fs.symlinkSync(source, target);
    fs.rmSync(source); // source now gone; symlink dangles

    const result = run({
      readManifest: () => manifest([record({ target })]),
      discover: () => [entry({ source, target })],
    });
    expect(result).toEqual({
      status: "drifted",
      entries: [{ kind: "dangling", displayName: "flow-new-feature", target }],
    });
  });

  it("reports 'stale' when the symlink points at a source other than what discover() now computes", () => {
    const dir = makeScratch();
    const oldSource = path.join(dir, "old-source.txt");
    const newSource = path.join(dir, "new-source.txt");
    fs.writeFileSync(oldSource, "old content");
    fs.writeFileSync(newSource, "new content");
    const target = path.join(dir, "stale-link");
    fs.symlinkSync(oldSource, target);

    const result = run({
      readManifest: () => manifest([record({ target })]),
      // discover() now says this artifact's source is newSource — the live
      // symlink still points at oldSource, e.g. a worktree-to-canonical
      // rebase that never got repaired.
      discover: () => [entry({ source: newSource, target })],
    });
    expect(result).toEqual({
      status: "drifted",
      entries: [{ kind: "stale", displayName: "flow-new-feature", target }],
    });
  });

  it("gates on module PRESENCE — a core-only install reports no drift for an optional-module artifact never linked", () => {
    const dir = makeScratch();
    const coreTarget = path.join(dir, "core-target");
    const coreSource = path.join(dir, "core-source.txt");
    fs.writeFileSync(coreSource, "x");
    fs.symlinkSync(coreSource, coreTarget);

    // "flow-research-note" is a real registry-known artifact (research
    // module) — its target is never created, and it is NOT in the
    // manifest (this install never selected the research module).
    const result = run({
      readManifest: () => manifest([record({ target: coreTarget })]),
      discover: () => [
        entry({
          source: coreSource,
          target: coreTarget,
          displayName: "flow-new-feature",
        }),
        entry({
          source: "/never/linked",
          target: path.join(dir, "research-target-never-created"),
          displayName: "flow-research-note",
        }),
      ],
    });
    expect(result).toEqual({ status: "clean" });
  });

  it("registry-unknown pass-through: an artifact no module row owns is checked even though it's not in the manifest", () => {
    const dir = makeScratch();
    const target = path.join(dir, "worktree-only-target");
    // Never created — this artifact was added in-flight (an unmerged
    // worktree skill) and is not recognised by the registry, so it must
    // still be checked (gh#435 sub-case 1's pass-through), unlike the
    // deselected-optional-module case above.
    const result = run({
      readManifest: () => manifest([record({ target: "/some/other/target" })]),
      discover: () => [
        entry({
          source: "/worktree/only-source",
          target,
          displayName: "flow-totally-unregistered-artifact",
        }),
      ],
    });
    expect(result).toEqual({
      status: "drifted",
      entries: [
        {
          kind: "missing",
          displayName: "flow-totally-unregistered-artifact",
          target,
        },
      ],
    });
  });

  it("collapses a throwing readManifest to a clean (no-drift) result — never throws", () => {
    expect(() =>
      run({
        readManifest: () => {
          throw new Error("ENOENT: no such file");
        },
        discover: () => [entry()],
      }),
    ).not.toThrow();
    const result = run({
      readManifest: () => {
        throw new Error("ENOENT: no such file");
      },
      discover: () => [entry()],
    });
    expect(result).toEqual({ status: "clean" });
  });

  it("collapses a throwing discover to a clean (no-drift) result — never throws", () => {
    const result = run({
      readManifest: () => manifest([record()]),
      discover: () => {
        throw new Error("boom");
      },
    });
    expect(result).toEqual({ status: "clean" });
  });

  it("reports multiple drift entries across kinds in one result", () => {
    const dir = makeScratch();
    const missingTarget = path.join(dir, "missing-target");
    const missingSource = path.join(dir, "missing-source.txt");
    fs.writeFileSync(missingSource, "x");

    const danglingSource = path.join(dir, "dangling-source.txt");
    fs.writeFileSync(danglingSource, "x");
    const danglingTarget = path.join(dir, "dangling-target");
    fs.symlinkSync(danglingSource, danglingTarget);
    fs.rmSync(danglingSource);

    const result = run({
      readManifest: () =>
        manifest([
          record({ target: missingTarget }),
          record({ target: danglingTarget }),
        ]),
      discover: () => [
        entry({
          source: missingSource,
          target: missingTarget,
          displayName: "a",
        }),
        entry({
          source: danglingSource,
          target: danglingTarget,
          displayName: "b",
        }),
      ],
    });
    expect(result.status).toBe("drifted");
    if (result.status === "drifted") {
      expect(result.entries.map((e) => e.kind).sort()).toEqual([
        "dangling",
        "missing",
      ]);
    }
  });
});

describe(formatDriftNotice, () => {
  it("returns null for a clean result", () => {
    expect(formatDriftNotice({ status: "clean" })).toBeNull();
  });

  it("formats a one-line notice naming counts by kind", () => {
    const notice = formatDriftNotice({
      status: "drifted",
      entries: [
        { kind: "missing", displayName: "a", target: "/t/a" },
        { kind: "missing", displayName: "b", target: "/t/b" },
        { kind: "stale", displayName: "c", target: "/t/c" },
      ],
    });
    expect(notice).toContain("3 symlink drift issues");
    expect(notice).toContain("2 missing");
    expect(notice).toContain("1 stale");
    expect(notice).toContain("flow install --upgrade");
  });
});
