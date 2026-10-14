import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  readVerifiedTree,
  recordVerifiedTree,
  workingTreeId,
} from "./verified-tree";

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
delete ENV.GIT_DIR;
delete ENV.GIT_INDEX_FILE;
delete ENV.GIT_WORK_TREE;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const pass = (cmd: string, extra: object = {}) => ({
  argv: cmd.split(" "),
  name: cmd,
  passed: true,
  durationMs: 50,
  ...extra,
});

describe("verified-tree", () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "flow-verified-tree-test-")),
    );
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  describe("workingTreeId", () => {
    it("is HEAD^{tree} on a clean tree", () => {
      expect(workingTreeId(repo)).toBe(git(repo, "rev-parse", "HEAD^{tree}"));
    });

    it("differs from HEAD^{tree} once a tracked file is edited", () => {
      fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
      const id = workingTreeId(repo);
      expect(id).toMatch(/^[0-9a-f]{40,64}$/);
      expect(id).not.toBe(git(repo, "rev-parse", "HEAD^{tree}"));
    });

    it("counts an untracked non-ignored file, and its content", () => {
      const head = git(repo, "rev-parse", "HEAD^{tree}");
      fs.writeFileSync(path.join(repo, "new.txt"), "one\n");
      const one = workingTreeId(repo);
      fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
      const two = workingTreeId(repo);
      expect(one).not.toBe(head);
      expect(two).not.toBe(one);
    });

    it("ignores an ignored file", () => {
      fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "ignore");
      fs.writeFileSync(path.join(repo, "ignored.txt"), "x\n");
      expect(workingTreeId(repo)).toBe(git(repo, "rev-parse", "HEAD^{tree}"));
    });

    it("equals the committed tree id once the same dirty content is committed", () => {
      fs.writeFileSync(path.join(repo, "new.txt"), "one\n");
      const dirty = workingTreeId(repo);
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "more");
      expect(workingTreeId(repo)).toBe(dirty);
    });

    it("leaves the real index untouched", () => {
      fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
      fs.writeFileSync(path.join(repo, "new.txt"), "one\n");
      const before = git(repo, "ls-files", "-s");
      workingTreeId(repo);
      expect(git(repo, "ls-files", "-s")).toBe(before);
      expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
    });

    it("returns null outside a repository", () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vt-out-"));
      try {
        expect(workingTreeId(outside)).toBeNull();
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe("recordVerifiedTree / readVerifiedTree", () => {
    it("returns null before anything is recorded", () => {
      expect(readVerifiedTree(repo)).toBeNull();
    });

    it("records passing read-only checks keyed by argv", () => {
      recordVerifiedTree("T1", [pass("npm run test")], repo);
      const memo = readVerifiedTree(repo);
      expect(memo?.tree).toBe("T1");
      expect(Object.keys(memo?.passed ?? {})).toEqual([
        JSON.stringify(["npm", "run", "test"]),
      ]);
    });

    it("merges into an entry for the same tree", () => {
      recordVerifiedTree("T1", [pass("npm run test")], repo);
      recordVerifiedTree("T1", [pass("npm run lint")], repo);
      expect(Object.keys(readVerifiedTree(repo)?.passed ?? {})).toHaveLength(2);
    });

    it("replaces the entry when the tree differs", () => {
      recordVerifiedTree("T1", [pass("npm run test")], repo);
      recordVerifiedTree("T2", [pass("npm run lint")], repo);
      const memo = readVerifiedTree(repo);
      expect(memo?.tree).toBe("T2");
      expect(Object.keys(memo?.passed ?? {})).toEqual([
        JSON.stringify(["npm", "run", "lint"]),
      ]);
    });

    it("excludes mutating, failing and skipped entries", () => {
      recordVerifiedTree(
        "T1",
        [
          pass("npm run build"),
          pass("npm run test", { passed: false }),
          pass("actionlint", { skipped: true }),
          pass("npm run lint"),
        ],
        repo,
      );
      expect(Object.keys(readVerifiedTree(repo)?.passed ?? {})).toEqual([
        JSON.stringify(["npm", "run", "lint"]),
      ]);
    });

    it("drops an earlier pass when the same check fails on the same tree", () => {
      recordVerifiedTree("T1", [pass("npm run test")], repo);
      recordVerifiedTree("T1", [pass("npm run test", { passed: false })], repo);
      expect(readVerifiedTree(repo)?.passed).toEqual({});
    });

    it("reads a corrupt file as null", () => {
      recordVerifiedTree("T1", [pass("npm run test")], repo);
      const p = git(
        repo,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "flow-verified-tree.json",
      );
      fs.writeFileSync(p, "{not json");
      expect(readVerifiedTree(repo)).toBeNull();
      fs.writeFileSync(
        p,
        JSON.stringify({ version: 2, tree: "x", passed: {} }),
      );
      expect(readVerifiedTree(repo)).toBeNull();
    });

    it("never throws outside a repository", () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vt-out-"));
      try {
        expect(() =>
          recordVerifiedTree("T1", [pass("npm run test")], outside),
        ).not.toThrow();
        expect(readVerifiedTree(outside)).toBeNull();
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it("keeps the memo in the worktree's private git folder, out of status", () => {
      recordVerifiedTree("T1", [pass("npm run test")], repo);
      expect(git(repo, "status", "--porcelain")).toBe("");
    });
  });
});
