/**
 * Tests for the plugin-root expected-children audit. Uses real scratch
 * tmpdir fixtures (`mkdtempSync` + `afterEach rm`) so real fs symlink/stat
 * semantics are exercised, matching `install-drift.test.ts`'s style.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  unexpectedPluginRootEntries,
  type PluginRootOwnership,
} from "./plugin-root-audit";

let scratch!: string;
let root!: string;
let flowSrc!: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-plugin-root-audit-"));
  root = path.join(scratch, "flow-module-copilot");
  flowSrc = path.join(scratch, "flow-src");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(flowSrc, { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Routes a call through the flow-owned ownership pair (`flowSource` ===
 * `installRoot` === `flowSrc`) — the shape every pre-existing test in this
 * file relies on to keep its expectations unchanged after ownership became
 * a required parameter. */
function audit(rootArg: string, ownership?: PluginRootOwnership) {
  return unexpectedPluginRootEntries(
    rootArg,
    ownership ?? { flowSource: flowSrc, installRoot: flowSrc },
  );
}

function writeManifest(overrides: Record<string, unknown> = {}): void {
  const dir = path.join(root, ".claude-plugin");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      $schema: "https://anthropic.com/claude-code/plugin.schema.json",
      name: "flow-module-copilot",
      version: "1.0.0",
      description: "test",
      author: { name: "flow" },
      ...overrides,
    }),
  );
}

function materializeCleanRoot(): void {
  writeManifest();
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  const target = path.join(flowSrc, "real-helper.ts");
  fs.writeFileSync(target, "export {};\n");
  fs.symlinkSync(target, path.join(root, "bin", "flow-request-copilot"));
}

describe(unexpectedPluginRootEntries, () => {
  it("a freshly materialized root reports no issues", () => {
    materializeCleanRoot();
    expect(audit(root)).toEqual([]);
  });

  it("an extra top-level directory is an unexpected-child", () => {
    materializeCleanRoot();
    fs.mkdirSync(path.join(root, "hooks"));
    expect(audit(root)).toEqual([
      { relPath: "hooks", reason: "unexpected-child" },
    ]);
  });

  it("a stray top-level file is an unexpected-child", () => {
    materializeCleanRoot();
    fs.writeFileSync(path.join(root, ".mcp.json"), "{}");
    expect(audit(root)).toEqual([
      { relPath: ".mcp.json", reason: "unexpected-child" },
    ]);
  });

  it("a real regular file in bin/ is an unmanaged-bin-entry", () => {
    materializeCleanRoot();
    fs.writeFileSync(path.join(root, "bin", "curl"), "#!/bin/sh\n");
    expect(audit(root)).toEqual([
      { relPath: path.join("bin", "curl"), reason: "unmanaged-bin-entry" },
    ]);
  });

  it("a dangling symlink in bin/ is a dangling-bin-symlink, not an unmanaged-bin-entry", () => {
    materializeCleanRoot();
    fs.symlinkSync(
      path.join(scratch, "does-not-exist.ts"),
      path.join(root, "bin", "flow-dangling"),
    );
    const issues = audit(root);
    expect(issues).toContainEqual({
      relPath: path.join("bin", "flow-dangling"),
      reason: "dangling-bin-symlink",
    });
    expect(issues).toHaveLength(1);
  });

  it("a live symlink resolving inside flowSource is not reported (flow put it there)", () => {
    materializeCleanRoot();
    const target = path.join(flowSrc, "another-real-helper.ts");
    fs.writeFileSync(target, "export {};\n");
    fs.symlinkSync(target, path.join(root, "bin", "flow-another-helper"));
    expect(audit(root)).toEqual([]);
  });

  it("a real directory in bin/ is an unmanaged-bin-entry", () => {
    materializeCleanRoot();
    fs.mkdirSync(path.join(root, "bin", "stray-dir"));
    const issues = audit(root);
    expect(issues).toContainEqual({
      relPath: path.join("bin", "stray-dir"),
      reason: "unmanaged-bin-entry",
    });
    expect(issues).toHaveLength(1);
  });

  it("a live symlink to a directory resolving inside flowSource is not reported (flow put it there)", () => {
    materializeCleanRoot();
    const targetDir = path.join(flowSrc, "real-dir");
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, path.join(root, "bin", "flow-dir-link"));
    expect(audit(root)).toEqual([]);
  });

  it("a live symlink resolving OUTSIDE flowSource/installRoot is reported as foreign-live-bin-symlink", () => {
    materializeCleanRoot();
    const outside = path.join(scratch, "not-flow-src");
    fs.mkdirSync(outside, { recursive: true });
    const target = path.join(outside, "foreign-helper.ts");
    fs.writeFileSync(target, "#!/bin/sh\n");
    fs.symlinkSync(target, path.join(root, "bin", "flow-foreign-helper"));
    const issues = audit(root);
    expect(issues).toContainEqual({
      relPath: path.join("bin", "flow-foreign-helper"),
      reason: "foreign-live-bin-symlink",
    });
    expect(issues).toHaveLength(1);
  });

  it("a live symlink resolving inside installRoot (distinct from flowSource) is not reported", () => {
    materializeCleanRoot();
    const installRoot = path.join(scratch, "install-root");
    fs.mkdirSync(installRoot, { recursive: true });
    const target = path.join(installRoot, "canonical-helper.ts");
    fs.writeFileSync(target, "export {};\n");
    fs.symlinkSync(target, path.join(root, "bin", "flow-canonical-helper"));
    expect(audit(root, { flowSource: flowSrc, installRoot })).toEqual([]);
  });

  it("a foreign live symlink written with RELATIVE link text is still reported", () => {
    materializeCleanRoot();
    const outside = path.join(scratch, "not-flow-src");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "foreign-helper.ts"), "#!/bin/sh\n");
    fs.symlinkSync(
      path.join("..", "..", "not-flow-src", "foreign-helper.ts"),
      path.join(root, "bin", "flow-relative-foreign"),
    );
    const issues = audit(root);
    expect(issues).toContainEqual({
      relPath: path.join("bin", "flow-relative-foreign"),
      reason: "foreign-live-bin-symlink",
    });
  });

  it("a foreign live symlink pointing at a DIRECTORY is reported", () => {
    materializeCleanRoot();
    const outside = path.join(scratch, "not-flow-src");
    const targetDir = path.join(outside, "foreign-dir");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.symlinkSync(targetDir, path.join(root, "bin", "flow-foreign-dir"));
    const issues = audit(root);
    expect(issues).toContainEqual({
      relPath: path.join("bin", "flow-foreign-dir"),
      reason: "foreign-live-bin-symlink",
    });
  });

  it("never throws when flowSource/installRoot do not exist on disk", () => {
    materializeCleanRoot();
    const missing = path.join(scratch, "no-such-flow-src");
    expect(() =>
      unexpectedPluginRootEntries(root, {
        flowSource: missing,
        installRoot: missing,
      }),
    ).not.toThrow();
  });

  it("a stray file inside .claude-plugin/ is an unexpected-child prefixed .claude-plugin/", () => {
    materializeCleanRoot();
    fs.writeFileSync(path.join(root, ".claude-plugin", "hooks.json"), "{}");
    expect(audit(root)).toEqual([
      {
        relPath: path.join(".claude-plugin", "hooks.json"),
        reason: "unexpected-child",
      },
    ]);
  });

  it("a manifest declaring skills plus a skills/ dir reports no issues", () => {
    writeManifest({ skills: ["./skills"] });
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
    expect(audit(root)).toEqual([]);
  });

  it("a manifest with skills: null does NOT declare skills — skills/ is reported (shape check, not key presence)", () => {
    writeManifest({ skills: null });
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
    expect(audit(root)).toEqual([
      { relPath: "skills", reason: "unexpected-child" },
    ]);
  });

  it("a manifest with skills: [] does NOT declare skills — skills/ is reported (the empty array is the named evasion)", () => {
    writeManifest({ skills: [] });
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
    expect(audit(root)).toEqual([
      { relPath: "skills", reason: "unexpected-child" },
    ]);
  });

  it("a manifest with skills: ['./skills', 1] does NOT declare skills — every element must be a string", () => {
    writeManifest({ skills: ["./skills", 1] });
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
    expect(audit(root)).toEqual([
      { relPath: "skills", reason: "unexpected-child" },
    ]);
  });

  it("a manifest with skills: 'yes' (a scalar) does NOT declare skills — skills/ is reported", () => {
    writeManifest({ skills: "yes" });
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
    expect(audit(root)).toEqual([
      { relPath: "skills", reason: "unexpected-child" },
    ]);
  });

  it("a plugin.json that parses to a bare string (non-object) never throws and does not flag skills/", () => {
    const dir = path.join(root, ".claude-plugin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "plugin.json"),
      JSON.stringify("not-an-object"),
    );
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
    expect(() => audit(root)).not.toThrow();
    expect(audit(root)).toEqual([]);
  });

  it("a skills/ dir WITHOUT the manifest key is an unexpected-child (key-presence, not the dir's mere existence)", () => {
    writeManifest();
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
    expect(audit(root)).toEqual([
      { relPath: "skills", reason: "unexpected-child" },
    ]);
  });

  it(".DS_Store is ignored at the root, in bin/, and in .claude-plugin/", () => {
    materializeCleanRoot();
    fs.writeFileSync(path.join(root, ".DS_Store"), "");
    fs.writeFileSync(path.join(root, "bin", ".DS_Store"), "");
    fs.writeFileSync(path.join(root, ".claude-plugin", ".DS_Store"), "");
    expect(audit(root)).toEqual([]);
  });

  it("a non-existent root reports no issues", () => {
    expect(audit(path.join(scratch, "does-not-exist"))).toEqual([]);
  });

  it("an unreadable/corrupt plugin.json never throws, and the rest of the walk still runs", () => {
    const dir = path.join(root, ".claude-plugin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.json"), "{ not json");
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.mkdirSync(path.join(root, "hooks"));
    expect(() => audit(root)).not.toThrow();
    expect(audit(root)).toEqual([
      { relPath: "hooks", reason: "unexpected-child" },
    ]);
  });

  it("a corrupt plugin.json is lenient toward skills/ — a real skills/ dir is never falsely flagged just because the manifest couldn't be read", () => {
    const dir = path.join(root, ".claude-plugin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.json"), "{ not json");
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
    expect(audit(root)).toEqual([]);
  });
});
