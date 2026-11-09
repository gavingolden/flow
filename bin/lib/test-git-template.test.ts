import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureMinimalGitTemplate,
  GIT_TEMPLATE_DIRNAME,
} from "./test-git-template";

const STOCK_HEAD = "# git ls-files --others --exclude-from=.git/info/exclude";

function mkdir700(p: string): void {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  fs.chmodSync(p, 0o700);
}

function expectMinimal(root: string, dir: string): void {
  expect(fs.readdirSync(dir).sort()).toEqual(["hooks", "info"]);
  expect(fs.readdirSync(path.join(dir, "hooks"))).toEqual([]);
  expect(fs.readdirSync(path.join(dir, "info"))).toEqual(["exclude"]);
  expect(
    fs
      .readFileSync(path.join(dir, "info", "exclude"), "utf8")
      .startsWith(STOCK_HEAD),
  ).toBe(true);
  expect(fs.readdirSync(root)).toEqual([GIT_TEMPLATE_DIRNAME]);
}

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

describe("heal", () => {
  let root: string;
  let finalDir: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-git-tpl-heal-"));
    finalDir = path.join(root, GIT_TEMPLATE_DIRNAME);
    mkdir700(finalDir);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function heals(): void {
    expect(ensureMinimalGitTemplate(root)).toBe(finalDir);
    expectMinimal(root, finalDir);
  }

  it("heals an incomplete template owned by us", () => {
    mkdir700(path.join(finalDir, "junk"));
    heals();
  });

  it("heals a user-owned template that carries an extra hook", () => {
    ensureMinimalGitTemplate(root);
    fs.writeFileSync(
      path.join(finalDir, "hooks", "pre-commit"),
      "#!/bin/sh\n",
      {
        mode: 0o755,
      },
    );
    heals();
  });

  it("heals a template with only hooks/", () => {
    mkdir700(path.join(finalDir, "hooks"));
    heals();
  });

  it("heals a template with hooks/ and an empty info/", () => {
    mkdir700(path.join(finalDir, "hooks"));
    mkdir700(path.join(finalDir, "info"));
    heals();
  });

  it("heals an empty template dir", () => {
    heals();
  });

  it("heals an info/exclude with a different body", () => {
    mkdir700(path.join(finalDir, "hooks"));
    mkdir700(path.join(finalDir, "info"));
    fs.writeFileSync(path.join(finalDir, "info", "exclude"), "other\n");
    heals();
  });

  it("heals an extra top-level config file", () => {
    ensureMinimalGitTemplate(root);
    fs.writeFileSync(path.join(finalDir, "config"), "[core]\n");
    heals();
  });

  it("heals hooks/ that is a regular file", () => {
    fs.writeFileSync(path.join(finalDir, "hooks"), "x");
    heals();
  });

  it("replaces an info/exclude symlink without touching its target", () => {
    mkdir700(path.join(finalDir, "hooks"));
    mkdir700(path.join(finalDir, "info"));
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-git-tpl-out-"),
    );
    const outside = path.join(outsideDir, "target");
    fs.writeFileSync(outside, "keep me\n");
    fs.symlinkSync(outside, path.join(finalDir, "info", "exclude"));

    heals();

    expect(fs.readFileSync(outside, "utf8")).toBe("keep me\n");
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("clears group/other-write bits on a writable hooks/", () => {
    ensureMinimalGitTemplate(root);
    fs.chmodSync(path.join(finalDir, "hooks"), 0o777);

    heals();

    expect(fs.statSync(path.join(finalDir, "hooks")).mode & 0o022).toBe(0);
  });

  it("replaces a user-owned regular file at the template path", () => {
    fs.rmSync(finalDir, { recursive: true });
    fs.writeFileSync(finalDir, "not a dir");
    heals();
  });

  it("keeps the same info/exclude inode on a call after a heal", () => {
    mkdir700(path.join(finalDir, "hooks"));
    heals();
    const ino = fs.statSync(path.join(finalDir, "info", "exclude")).ino;

    ensureMinimalGitTemplate(root);

    expect(fs.statSync(path.join(finalDir, "info", "exclude")).ino).toBe(ino);
  });
});

describe("squat refusal", () => {
  let root: string;
  let finalDir: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-git-tpl-squat-"));
    finalDir = path.join(root, GIT_TEMPLATE_DIRNAME);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function refused(reason: RegExp): void {
    expect(() => ensureMinimalGitTemplate(root)).toThrow(
      /refusing to use git template dir/,
    );
    expect(() => ensureMinimalGitTemplate(root)).toThrow(
      /remove it and re-run/,
    );
    expect(() => ensureMinimalGitTemplate(root)).toThrow(reason);
  }

  it("refuses a symlink and leaves it and its target alone", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "flow-git-tpl-other-"));
    try {
      const target = ensureMinimalGitTemplate(other);
      fs.symlinkSync(target, finalDir);

      refused(/symlink/);

      expect(fs.lstatSync(finalDir).isSymbolicLink()).toBe(true);
      expectMinimal(other, target);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("refuses a directory owned by another uid", () => {
    mkdir700(finalDir);
    fs.mkdirSync(path.join(finalDir, "junk"));
    vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);

    refused(/owned by uid/);

    expect(fs.readdirSync(finalDir)).toEqual(["junk"]);
  });

  it("refuses a group/other-writable top dir without changing it", () => {
    mkdir700(finalDir);
    fs.chmodSync(finalDir, 0o777);

    refused(/group\/other-writable/);

    expect(fs.statSync(finalDir).mode & 0o777).toBe(0o777);
    expect(fs.readdirSync(finalDir)).toEqual([]);
  });
});

describe("concurrent heal", () => {
  let root: string;
  let finalDir: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-git-tpl-conc-"));
    finalDir = path.join(root, GIT_TEMPLATE_DIRNAME);
    mkdir700(finalDir);
    mkdir700(path.join(finalDir, "hooks"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("tolerates another run finishing the repair mid-heal", () => {
    const donor = fs.mkdtempSync(path.join(os.tmpdir(), "flow-git-tpl-donor-"));
    try {
      const stock = fs.readFileSync(
        path.join(ensureMinimalGitTemplate(donor), "info", "exclude"),
        "utf8",
      );
      const realRename = nodeFs.renameSync;
      let first = true;
      vi.spyOn(nodeFs, "renameSync").mockImplementation((from, to) => {
        if (first) {
          first = false;
          nodeFs.writeFileSync(path.join(finalDir, "info", "exclude"), stock, {
            mode: 0o644,
          });
        }
        realRename(from, to);
      });
      syncBuiltinESMExports();

      expect(ensureMinimalGitTemplate(root)).toBe(finalDir);
      expectMinimal(root, finalDir);
    } finally {
      fs.rmSync(donor, { recursive: true, force: true });
    }
  });

  it("converges when four processes heal at once", async () => {
    mkdir700(path.join(finalDir, "info"));
    const modulePath = path.join(import.meta.dirname, "test-git-template.ts");
    const script = `import { ensureMinimalGitTemplate as e } from ${JSON.stringify(modulePath)}; console.log(e(process.env.R));`;

    const runs = Array.from(
      { length: 4 },
      () =>
        new Promise<{ code: number | null; out: string; err: string }>(
          (resolve) => {
            const child = spawn("bun", ["-e", script], {
              env: { ...process.env, R: root },
            });
            let out = "";
            let err = "";
            child.stdout.on("data", (b) => (out += b));
            child.stderr.on("data", (b) => (err += b));
            child.on("error", (e) =>
              resolve({ code: null, out: "", err: String(e) }),
            );
            child.on("close", (code) =>
              resolve({ code, out: out.trim(), err }),
            );
          },
        ),
    );
    const results = await Promise.all(runs);

    for (const r of results) {
      expect(r, r.err).toMatchObject({ code: 0, out: finalDir });
    }
    expectMinimal(root, finalDir);
  }, 30_000);
});
