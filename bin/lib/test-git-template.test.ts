import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureMinimalGitTemplate,
  GIT_TEMPLATE_DIRNAME,
} from "./test-git-template";

describe(ensureMinimalGitTemplate, () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-git-tpl-test-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates only an empty hooks/ and info/exclude", () => {
    const dir = ensureMinimalGitTemplate(root);

    expect(dir).toBe(path.join(root, GIT_TEMPLATE_DIRNAME));
    expect(fs.readdirSync(dir).sort()).toEqual(["hooks", "info"]);
    expect(fs.readdirSync(path.join(dir, "hooks"))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, "info"))).toEqual(["exclude"]);
    expect(fs.readFileSync(path.join(dir, "info", "exclude"), "utf8")).toMatch(
      /^# git ls-files --others --exclude-from=\.git\/info\/exclude/,
    );
    expect(fs.readdirSync(root)).toEqual([GIT_TEMPLATE_DIRNAME]);
  });

  it("returns the same path without rewriting on a second call", () => {
    const first = ensureMinimalGitTemplate(root);
    const ino = fs.statSync(path.join(first, "info", "exclude")).ino;

    const second = ensureMinimalGitTemplate(root);

    expect(second).toBe(first);
    expect(fs.statSync(path.join(second, "info", "exclude")).ino).toBe(ino);
  });

  it("returns the winner's path when another worker wins the rename race", () => {
    const finalDir = path.join(root, GIT_TEMPLATE_DIRNAME);
    const realRename = nodeFs.renameSync;
    // The namespace is frozen, so spy on the CJS object and re-sync the ESM view.
    vi.spyOn(nodeFs, "renameSync").mockImplementation((from, to) => {
      // Another worker lands a current tree first, so the real rename fails.
      nodeFs.cpSync(String(from), String(to), { recursive: true });
      realRename(from, to);
    });
    syncBuiltinESMExports();

    expect(ensureMinimalGitTemplate(root)).toBe(finalDir);
    expect(fs.readdirSync(root)).toEqual([GIT_TEMPLATE_DIRNAME]);
  });

  it("rethrows a rename failure when the existing dir is not current", () => {
    fs.mkdirSync(path.join(root, GIT_TEMPLATE_DIRNAME, "junk"), {
      recursive: true,
    });

    expect(() => ensureMinimalGitTemplate(root)).toThrow();
    expect(fs.readdirSync(root)).toEqual([GIT_TEMPLATE_DIRNAME]);
  });
});

describe("suite-wide GIT_TEMPLATE_DIR", () => {
  it("makes git init write no sample hooks and no description", () => {
    expect(process.env.GIT_TEMPLATE_DIR).toBeTruthy();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "flow-git-tpl-init-"));
    try {
      const r = spawnSync("git", ["init", "-q"], {
        cwd: repo,
        encoding: "utf8",
        env: process.env,
      });
      expect(r.status).toBe(0);

      const gitDir = path.join(repo, ".git");
      expect(fs.readdirSync(path.join(gitDir, "hooks"))).toEqual([]);
      expect(fs.existsSync(path.join(gitDir, "description"))).toBe(false);
      expect(fs.existsSync(path.join(gitDir, "info", "exclude"))).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
