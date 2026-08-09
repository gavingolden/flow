/**
 * Tests for the plugin-root materialization primitive. Uses real temp dirs
 * (never the developer's real ~/.flow) and the REAL flow checkout as
 * `flowSource` for bin-entry resolution — read-only discovery, matching the
 * "real-registry name matching" convention in `setup.test.ts`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensurePluginRoot,
  isFlowOwnedPluginRoot,
  pluginDirArgs,
  pluginBinPath,
  withPluginPath,
  removePluginRoot,
  scanPluginRoots,
} from "./plugin-root";
import { resolveFlowSource } from "./paths";

const realFlowSource = resolveFlowSource();

let scratch!: string;
let skillsDir!: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-plugin-root-"));
  skillsDir = path.join(scratch, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function root(name = "flow-module-copilot"): string {
  return path.join(skillsDir, name);
}

function readManifestJson(r: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(r, ".claude-plugin", "plugin.json"), "utf8"),
  );
}

describe(ensurePluginRoot, () => {
  it("creates the root and writes a plugin.json that parses", () => {
    const r = root();
    const result = ensurePluginRoot({
      root: r,
      moduleId: "copilot",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    expect(result).toBe("created");
    const manifest = readManifestJson(r);
    expect(manifest.name).toBe("flow-module-copilot");
  });

  it('returns "created" then "exists" on an identical second call, with byte-identical plugin.json', () => {
    const r = root();
    const args = {
      root: r,
      moduleId: "copilot" as const,
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    };
    expect(ensurePluginRoot(args)).toBe("created");
    const manifestPath = path.join(r, ".claude-plugin", "plugin.json");
    const before = fs.readFileSync(manifestPath, "utf8");
    const beforeMtime = fs.statSync(manifestPath).mtimeMs;
    expect(ensurePluginRoot(args)).toBe("exists");
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
    expect(fs.statSync(manifestPath).mtimeMs).toBe(beforeMtime);
  });

  it('returns "updated" when the version changes, and rewrites plugin.json', () => {
    const r = root();
    ensurePluginRoot({
      root: r,
      moduleId: "copilot",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    const result = ensurePluginRoot({
      root: r,
      moduleId: "copilot",
      flowSource: realFlowSource,
      version: "2.0.0",
      includeSkills: false,
      force: false,
    });
    expect(result).toBe("updated");
    expect(readManifestJson(r).version).toBe("2.0.0");
  });

  it("emits bin/<helper> symlinks for a module that has helpers, and each resolves to the flowSource path", () => {
    const r = root();
    ensurePluginRoot({
      root: r,
      moduleId: "copilot",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    const linkPath = path.join(r, "bin", "flow-request-copilot");
    expect(fs.existsSync(linkPath)).toBe(true);
    expect(fs.realpathSync(linkPath)).toBe(
      fs.realpathSync(
        path.join(realFlowSource, "bin", "flow-request-copilot.ts"),
      ),
    );
  });

  it("emits NO bin/ directory for a module with zero helpers and zero validators", () => {
    const r = root("flow-module-stack-svelte");
    ensurePluginRoot({
      root: r,
      moduleId: "stack-svelte",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    expect(fs.existsSync(path.join(r, "bin"))).toBe(false);
  });

  it("prunes a stale flow-managed symlink from bin/ when the helper leaves the module's entry set", () => {
    const r = root();
    ensurePluginRoot({
      root: r,
      moduleId: "copilot",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    // Plant a stray flow-managed symlink simulating a helper that has since
    // left the module's entry set.
    const strayTarget = path.join(r, "bin", "flow-old-helper");
    fs.symlinkSync(
      fs.realpathSync(path.join(realFlowSource, "bin", "flow-new-worktree.ts")),
      strayTarget,
    );
    const result = ensurePluginRoot({
      root: r,
      moduleId: "copilot",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    expect(result).toBe("updated");
    expect(fs.existsSync(strayTarget)).toBe(false);
    expect(fs.existsSync(path.join(r, "bin", "flow-request-copilot"))).toBe(
      true,
    );
  });

  it("NEVER removes a real (non-symlink) file a user placed inside the root's bin/", () => {
    const r = root();
    ensurePluginRoot({
      root: r,
      moduleId: "copilot",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    const userFile = path.join(r, "bin", "my-notes.txt");
    fs.writeFileSync(userFile, "not flow's file\n");
    ensurePluginRoot({
      root: r,
      moduleId: "copilot",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    expect(fs.existsSync(userFile)).toBe(true);
    expect(fs.readFileSync(userFile, "utf8")).toBe("not flow's file\n");
  });

  it('returns "blocked" and mutates nothing when the target exists as a directory WITHOUT a flow-written plugin.json', () => {
    const r = root();
    fs.mkdirSync(r, { recursive: true });
    fs.writeFileSync(path.join(r, "some-user-file.txt"), "mine\n");
    const result = ensurePluginRoot({
      root: r,
      moduleId: "copilot",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    expect(result).toBe("blocked");
    expect(fs.existsSync(path.join(r, ".claude-plugin"))).toBe(false);
    expect(fs.existsSync(path.join(r, "some-user-file.txt"))).toBe(true);
  });

  it('returns "blocked" when the target exists with a plugin.json whose name lacks the flow-module- prefix', () => {
    const r = root();
    fs.mkdirSync(path.join(r, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(r, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "not-flow-owned", version: "1.0.0" }),
    );
    const result = ensurePluginRoot({
      root: r,
      moduleId: "copilot",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    expect(result).toBe("blocked");
  });

  it("creates no skills/ directory when includeSkills is false", () => {
    const r = root();
    ensurePluginRoot({
      root: r,
      moduleId: "copilot",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    expect(fs.existsSync(path.join(r, "skills"))).toBe(false);
  });

  // Pins `effectiveIncludeSkills`'s observable effect (PR #605): the caller's
  // blanket `includeSkills: true` is refined per-module by whether that
  // module actually owns skill rows, so a helper-only module (copilot,
  // skills: []) never gets a `skills` manifest key even when asked, while a
  // module with skill rows (core) gets it as the caller passed it.
  it("omits manifest.skills for a helper-only module (copilot) even with includeSkills: true", () => {
    const r = root("flow-module-copilot");
    ensurePluginRoot({
      root: r,
      moduleId: "copilot",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: true,
      force: false,
    });
    const manifest = readManifestJson(r);
    expect(manifest.skills).toBeUndefined();
  });

  it('sets manifest.skills = ["./skills"] for a module with skill rows (core) when includeSkills: true', () => {
    const r = root("flow-module-core");
    ensurePluginRoot({
      root: r,
      moduleId: "core",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: true,
      force: false,
    });
    const manifest = readManifestJson(r);
    expect(manifest.skills).toEqual(["./skills"]);
  });
});

describe(isFlowOwnedPluginRoot, () => {
  it("is false for a plain directory", () => {
    const r = root();
    fs.mkdirSync(r, { recursive: true });
    expect(isFlowOwnedPluginRoot(r)).toBe(false);
  });

  it("is false for a directory with malformed JSON", () => {
    const r = root();
    fs.mkdirSync(path.join(r, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(r, ".claude-plugin", "plugin.json"),
      "{ not json",
    );
    expect(isFlowOwnedPluginRoot(r)).toBe(false);
  });

  it("is true for a flow-written root", () => {
    const r = root();
    ensurePluginRoot({
      root: r,
      moduleId: "copilot",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    expect(isFlowOwnedPluginRoot(r)).toBe(true);
  });
});

describe(removePluginRoot, () => {
  it("refuses (returns false, leaves the dir) on a non-flow-owned dir", () => {
    const r = root();
    fs.mkdirSync(r, { recursive: true });
    fs.writeFileSync(path.join(r, "keep.txt"), "mine\n");
    expect(removePluginRoot(r)).toBe(false);
    expect(fs.existsSync(r)).toBe(true);
  });

  it("succeeds on a flow-owned root", () => {
    const r = root();
    ensurePluginRoot({
      root: r,
      moduleId: "copilot",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    expect(removePluginRoot(r)).toBe(true);
    expect(fs.existsSync(r)).toBe(false);
  });
});

describe(scanPluginRoots, () => {
  it("finds flow-owned roots and ignores plain skill directories sitting beside them", () => {
    ensurePluginRoot({
      root: root(),
      moduleId: "copilot",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    fs.mkdirSync(path.join(skillsDir, "flow-some-skill"), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "flow-some-skill", "SKILL.md"),
      "# not a plugin\n",
    );
    const found = scanPluginRoots(skillsDir);
    expect(found).toEqual([root()]);
  });

  it("returns [] for a missing dir", () => {
    expect(scanPluginRoots(path.join(scratch, "does-not-exist"))).toEqual([]);
  });

  it("finds a root the manifest does not know about (the OQ-7 rollback case)", () => {
    // scanPluginRoots never reads a manifest — a root materialized under a
    // pre-plugin-era manifest (or none at all) is still discoverable purely
    // from what's on disk, so a rollback across the plugin-era boundary
    // can never strand it unreapable.
    ensurePluginRoot({
      root: root(),
      moduleId: "copilot",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    expect(scanPluginRoots(skillsDir)).toEqual([root()]);
  });
});

describe(pluginDirArgs, () => {
  it("returns [] for []", () => {
    expect(pluginDirArgs([])).toEqual([]);
  });

  it("returns a flat --plugin-dir/<path> pair list otherwise", () => {
    expect(pluginDirArgs(["/a", "/b"])).toEqual([
      "--plugin-dir",
      "/a",
      "--plugin-dir",
      "/b",
    ]);
  });
});

describe(pluginBinPath, () => {
  it("skips roots whose bin/ does not exist and emits no leading/trailing colon", () => {
    const withBin = root("flow-module-research");
    ensurePluginRoot({
      root: withBin,
      moduleId: "research",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    const withoutBin = root("flow-module-stack-svelte");
    ensurePluginRoot({
      root: withoutBin,
      moduleId: "stack-svelte",
      flowSource: realFlowSource,
      version: "1.0.0",
      includeSkills: false,
      force: false,
    });
    const prefix = pluginBinPath([withoutBin, withBin]);
    expect(prefix).toBe(path.join(withBin, "bin"));
    expect(prefix.startsWith(":")).toBe(false);
    expect(prefix.endsWith(":")).toBe(false);
  });
});

describe(withPluginPath, () => {
  it("never emits a leading colon when the current PATH is empty", () => {
    expect(withPluginPath("/roots/flow-module-core/bin", "")).toBe(
      "/roots/flow-module-core/bin",
    );
  });

  it("returns undefined (no PATH override) when the plugin path is empty", () => {
    expect(withPluginPath("", "/usr/bin:/bin")).toBeUndefined();
    expect(withPluginPath("", "")).toBeUndefined();
  });

  it("appends the plugin path after the current PATH with exactly one colon when both are non-empty", () => {
    expect(withPluginPath("/roots/flow-module-core/bin", "/usr/bin")).toBe(
      "/usr/bin:/roots/flow-module-core/bin",
    );
  });

  it("returns undefined (no double-append) when the current PATH already ends with the plugin path", () => {
    expect(
      withPluginPath(
        "/roots/flow-module-core/bin",
        "/usr/bin:/roots/flow-module-core/bin",
      ),
    ).toBeUndefined();
  });

  it("returns undefined when the plugin path segment is already present in the MIDDLE of the current PATH (per-segment guard, not a whole-string startsWith)", () => {
    expect(
      withPluginPath(
        "/roots/flow-module-core/bin",
        "/usr/bin:/roots/flow-module-core/bin:/bin",
      ),
    ).toBeUndefined();
  });

  it("appends only the missing segment when one of two plugin-path segments is already present", () => {
    expect(
      withPluginPath(
        "/roots/flow-module-a/bin:/roots/flow-module-b/bin",
        "/usr/bin:/roots/flow-module-a/bin",
      ),
    ).toBe("/usr/bin:/roots/flow-module-a/bin:/roots/flow-module-b/bin");
  });

  it("returns the plugin path alone with no leading or trailing colon when the current PATH is empty", () => {
    expect(
      withPluginPath("/roots/flow-module-a/bin:/roots/flow-module-b/bin", ""),
    ).toBe("/roots/flow-module-a/bin:/roots/flow-module-b/bin");
  });

  it("preserves a pre-existing empty segment (trailing colon) in currentPath rather than collapsing it", () => {
    // currentPath already carries a trailing `:` (an empty PATH segment,
    // POSIX-legal and meaning "current working directory"). The function
    // must neither strip it nor treat it as a plugin-path segment to dedupe
    // against — it just appends after the existing string verbatim.
    expect(withPluginPath("/roots/flow-module-core/bin", "/usr/bin:")).toBe(
      "/usr/bin::/roots/flow-module-core/bin",
    );
  });

  it("preserves a pre-existing '::' (double-colon / empty-segment pair) in currentPath", () => {
    expect(
      withPluginPath("/roots/flow-module-core/bin", "/usr/bin::/bin"),
    ).toBe("/usr/bin::/bin:/roots/flow-module-core/bin");
  });
});
