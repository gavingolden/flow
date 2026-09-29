import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkInstalledModules,
  checkInstallLinks,
  checkRuntimePackages,
} from "./doctor-install";
import { makeDeps } from "./doctor-test-deps";
import type { InstallDriftResult } from "./install-drift";
import type { Manifest } from "./manifest";
import type { SourceEntry } from "./sources";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-install-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const drifted = (
  ...entries: { kind: string; displayName: string }[]
): InstallDriftResult =>
  ({
    status: "drifted",
    entries: entries.map((e) => ({ ...e, target: `/x/${e.displayName}` })),
  }) as InstallDriftResult;

const notWorktree = () => ({ isWorktree: false, canonicalRoot: null });

describe("checkInstallLinks", () => {
  it("passes when the audit is clean and forwards every path from deps", () => {
    const deps = makeDeps(root);
    let seen: Record<string, unknown> = {};
    const [c] = checkInstallLinks(
      deps,
      (opts) => {
        seen = opts as Record<string, unknown>;
        return { status: "clean" };
      },
      notWorktree,
    );
    expect(c).toMatchObject({ id: "install-links", status: "pass" });
    expect(seen).toMatchObject({
      flowSource: deps.flowSource,
      installRoot: deps.installRoot,
      targets: deps.targets,
      manifestPath: deps.manifestPath,
    });
  });

  it.each(["missing", "dangling", "stale"])(
    "%s fails with the upgrade fix",
    (kind) => {
      const [c] = checkInstallLinks(
        makeDeps(root),
        () => drifted({ kind, displayName: "flow-foo" }),
        notWorktree,
      );
      expect(c.status).toBe("fail");
      expect(c.fix).toBe("flow install --upgrade");
      expect(c.details[0]).toContain("flow-foo");
    },
  );

  it("foreign/unexpected-only drift is a warn, not a fail", () => {
    const [c] = checkInstallLinks(
      makeDeps(root),
      () =>
        drifted(
          { kind: "foreign", displayName: "a" },
          { kind: "unexpected", displayName: "b" },
        ),
      notWorktree,
    );
    expect(c.status).toBe("warn");
  });

  it("lists at most 5 entries and folds the rest", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      kind: "stale",
      displayName: `h${i}`,
    }));
    const [c] = checkInstallLinks(
      makeDeps(root),
      () => drifted(...many),
      notWorktree,
    );
    expect(c.details).toHaveLength(6);
    expect(c.details[5]).toBe("(+3 more)");
  });

  it("spells the fix through the canonical checkout when the flow source is a worktree", () => {
    const [c] = checkInstallLinks(
      makeDeps(root),
      () => drifted({ kind: "stale", displayName: "x" }),
      () => ({ isWorktree: true, canonicalRoot: "/canon/flow" }),
    );
    expect(c.fix).toBe("bun /canon/flow/bin/flow install --upgrade");
  });
});

describe("checkInstalledModules", () => {
  const entry = (over: Partial<SourceEntry>): SourceEntry => ({
    source: "/src",
    target: path.join(root, "nowhere"),
    kind: "bin",
    displayName: "flow-pre-commit",
    ...over,
  });
  const empty: Manifest = { version: 1, symlinks: [] };

  it("fails on a registered helper with no link and no record, naming it", async () => {
    const deps = makeDeps(root);
    const target = path.join(deps.targets.binDir, "flow-pre-commit");
    const out = await checkInstalledModules(deps, {
      readManifest: () => empty,
      readSelection: () => undefined,
      discover: async () => [entry({ target })],
      inspect: notWorktree,
    });
    expect(out[0].status).toBe("fail");
    expect(out[0].summary).toContain("flow-pre-commit");
    expect(out[0].fix).toBe("flow install --upgrade (then re-run flow doctor)");
  });

  it("does not fail when the link exists or the install record lists it", async () => {
    const deps = makeDeps(root);
    const linked = path.join(root, "linked");
    fs.symlinkSync("/nonexistent", linked);
    const recorded = path.join(root, "recorded");
    const out = await checkInstalledModules(deps, {
      readManifest: () => ({
        version: 1,
        symlinks: [{ source: "/s", target: recorded, kind: "bin" }],
      }),
      readSelection: () => undefined,
      discover: async () => [
        entry({ target: linked }),
        entry({ target: recorded, displayName: "flow-state-update" }),
      ],
    });
    expect(out[0].status).toBe("pass");
  });

  it("ignores registry-unknown artifacts and non-artifact kinds", async () => {
    const out = await checkInstalledModules(makeDeps(root), {
      readManifest: () => empty,
      readSelection: () => undefined,
      discover: async () => [
        entry({ displayName: "not-in-registry-xyz" }),
        entry({ kind: "completion", displayName: "flow.bash" }),
        entry({ kind: "plugin", displayName: "flow-module-core" }),
      ],
    });
    expect(out[0].status).toBe("pass");
  });

  it("pass summary names active/inactive modules and the checkout compared against", async () => {
    const deps = makeDeps(root);
    const out = await checkInstalledModules(deps, {
      readManifest: () => empty,
      readSelection: () => ["core"],
      discover: async () => [],
    });
    expect(out[0].summary).toContain("active: core");
    expect(out[0].summary).toContain("inactive:");
    expect(out[0].details.join(" ")).toContain(
      `checked against the flow checkout at ${deps.installRoot}`,
    );
  });

  it("discovers from the canonical root as both source and install root, with the selection", async () => {
    const deps = makeDeps(root, { installRoot: "/canon", flowSource: "/wt" });
    const calls: unknown[][] = [];
    await checkInstalledModules(deps, {
      readManifest: () => empty,
      readSelection: () => ["research"],
      discover: async (...args: unknown[]) => {
        calls.push(args);
        return [];
      },
    });
    expect(calls[0].slice(0, 2)).toEqual(["/canon", "/canon"]);
    expect(calls[0][2]).toEqual(expect.arrayContaining(["core", "research"]));
    expect(calls[0][3]).toBe(deps.targets);
  });

  it("falls back to the install-record breadth, then core, without a recorded selection", async () => {
    const seen: string[][] = [];
    const discover = async (_a: string, _b: string, ids: readonly string[]) => {
      seen.push([...ids]);
      return [];
    };
    await checkInstalledModules(makeDeps(root), {
      readManifest: () => ({
        version: 1,
        symlinks: [
          {
            source: "/s",
            target: "/t/flow-delegate",
            kind: "bin",
          },
        ],
      }),
      readSelection: () => undefined,
      discover,
    });
    await checkInstalledModules(makeDeps(root), {
      readManifest: () => empty,
      readSelection: () => undefined,
      discover,
    });
    expect(seen[0]).toEqual(expect.arrayContaining(["core", "research"]));
    expect(seen[1]).toEqual(["core"]);
  });
});

describe("checkRuntimePackages", () => {
  it("passes when nothing is missing", () => {
    const [c] = checkRuntimePackages(makeDeps(root), () => ({ missing: [] }));
    expect(c.status).toBe("pass");
  });

  it("fails naming the packages with an npm install fix at the canonical root", () => {
    const deps = makeDeps(root, { installRoot: "/canon/flow" });
    const [c] = checkRuntimePackages(deps, () => ({ missing: ["picomatch"] }));
    expect(c.status).toBe("fail");
    expect(c.summary).toContain("picomatch");
    expect(c.fix).toBe("cd /canon/flow && npm install");
  });

  it("reads the real package.json at the root by default", () => {
    fs.mkdirSync(path.join(root, "flow-checkout"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "flow-checkout", "package.json"),
      JSON.stringify({ dependencies: { "never-installed-pkg": "1" } }),
    );
    const [c] = checkRuntimePackages(makeDeps(root));
    expect(c.status).toBe("fail");
    expect(c.summary).toContain("never-installed-pkg");
  });
});
