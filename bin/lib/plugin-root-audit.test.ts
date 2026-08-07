/**
 * Tests for the plugin-root expected-children audit. Uses real scratch
 * tmpdir fixtures (`mkdtempSync` + `afterEach rm`) so real fs symlink/stat
 * semantics are exercised, matching `install-drift.test.ts`'s style.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unexpectedPluginRootEntries } from "./plugin-root-audit";

let scratch!: string;
let root!: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-plugin-root-audit-"));
  root = path.join(scratch, "flow-module-copilot");
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

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
  const target = path.join(scratch, "real-helper.ts");
  fs.writeFileSync(target, "export {};\n");
  fs.symlinkSync(target, path.join(root, "bin", "flow-request-copilot"));
}

describe(unexpectedPluginRootEntries, () => {
  it("a freshly materialized root reports no issues", () => {
    materializeCleanRoot();
    expect(unexpectedPluginRootEntries(root)).toEqual([]);
  });

  it("an extra top-level directory is an unexpected-child", () => {
    materializeCleanRoot();
    fs.mkdirSync(path.join(root, "hooks"));
    expect(unexpectedPluginRootEntries(root)).toEqual([
      { relPath: "hooks", reason: "unexpected-child" },
    ]);
  });

  it("a stray top-level file is an unexpected-child", () => {
    materializeCleanRoot();
    fs.writeFileSync(path.join(root, ".mcp.json"), "{}");
    expect(unexpectedPluginRootEntries(root)).toEqual([
      { relPath: ".mcp.json", reason: "unexpected-child" },
    ]);
  });

  it("a real regular file in bin/ is an unmanaged-bin-entry", () => {
    materializeCleanRoot();
    fs.writeFileSync(path.join(root, "bin", "curl"), "#!/bin/sh\n");
    expect(unexpectedPluginRootEntries(root)).toEqual([
      { relPath: path.join("bin", "curl"), reason: "unmanaged-bin-entry" },
    ]);
  });

  it("a dangling symlink in bin/ is an unmanaged-bin-entry", () => {
    materializeCleanRoot();
    fs.symlinkSync(
      path.join(scratch, "does-not-exist.ts"),
      path.join(root, "bin", "flow-dangling"),
    );
    const issues = unexpectedPluginRootEntries(root);
    expect(issues).toContainEqual({
      relPath: path.join("bin", "flow-dangling"),
      reason: "unmanaged-bin-entry",
    });
    expect(issues).toHaveLength(1);
  });

  it("a live symlink in bin/ is not reported (self-healing case)", () => {
    materializeCleanRoot();
    const target = path.join(scratch, "another-real-helper.ts");
    fs.writeFileSync(target, "export {};\n");
    fs.symlinkSync(target, path.join(root, "bin", "flow-another-helper"));
    expect(unexpectedPluginRootEntries(root)).toEqual([]);
  });

  it("a stray file inside .claude-plugin/ is an unexpected-child prefixed .claude-plugin/", () => {
    materializeCleanRoot();
    fs.writeFileSync(path.join(root, ".claude-plugin", "hooks.json"), "{}");
    expect(unexpectedPluginRootEntries(root)).toEqual([
      {
        relPath: path.join(".claude-plugin", "hooks.json"),
        reason: "unexpected-child",
      },
    ]);
  });

  it("a manifest declaring skills plus a skills/ dir reports no issues", () => {
    writeManifest({ skills: ["./skills"] });
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
    expect(unexpectedPluginRootEntries(root)).toEqual([]);
  });

  it("a manifest with skills: null still counts as key-present (no issue for skills/)", () => {
    writeManifest({ skills: null });
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
    expect(unexpectedPluginRootEntries(root)).toEqual([]);
  });

  it("a manifest with skills: [] still counts as key-present (no issue for skills/)", () => {
    writeManifest({ skills: [] });
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
    expect(unexpectedPluginRootEntries(root)).toEqual([]);
  });

  it("a skills/ dir WITHOUT the manifest key is an unexpected-child (key-presence, not the dir's mere existence)", () => {
    writeManifest();
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
    expect(unexpectedPluginRootEntries(root)).toEqual([
      { relPath: "skills", reason: "unexpected-child" },
    ]);
  });

  it(".DS_Store is ignored at the root, in bin/, and in .claude-plugin/", () => {
    materializeCleanRoot();
    fs.writeFileSync(path.join(root, ".DS_Store"), "");
    fs.writeFileSync(path.join(root, "bin", ".DS_Store"), "");
    fs.writeFileSync(path.join(root, ".claude-plugin", ".DS_Store"), "");
    expect(unexpectedPluginRootEntries(root)).toEqual([]);
  });

  it("a non-existent root reports no issues", () => {
    expect(
      unexpectedPluginRootEntries(path.join(scratch, "does-not-exist")),
    ).toEqual([]);
  });

  it("an unreadable/corrupt plugin.json never throws, and the rest of the walk still runs", () => {
    const dir = path.join(root, ".claude-plugin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.json"), "{ not json");
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.mkdirSync(path.join(root, "hooks"));
    expect(() => unexpectedPluginRootEntries(root)).not.toThrow();
    expect(unexpectedPluginRootEntries(root)).toEqual([
      { relPath: "hooks", reason: "unexpected-child" },
    ]);
  });

  it("a corrupt plugin.json is lenient toward skills/ — a real skills/ dir is never falsely flagged just because the manifest couldn't be read", () => {
    const dir = path.join(root, ".claude-plugin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.json"), "{ not json");
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
    expect(unexpectedPluginRootEntries(root)).toEqual([]);
  });
});
