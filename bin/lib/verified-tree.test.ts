import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { withoutGitLocalEnv } from "./git-local-env";
import {
  discardVerifiedTree,
  readVerifiedTree,
  recordVerifiedTree,
  reusablePasses,
  VERIFIED_TREE_MAX_AGE_MS,
  workingTreeId,
  type VerifiedTreeMemo,
} from "./verified-tree";

const ENV: NodeJS.ProcessEnv = {
  ...withoutGitLocalEnv(process.env),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

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

const memoOf = (
  at: string,
  extra: Partial<VerifiedTreeMemo> = {},
): VerifiedTreeMemo => ({
  version: 2,
  tree: "T1",
  passed: { k: { name: "npm run test", durationMs: 50, at } },
  failed: {},
  ...extra,
});

describe("verified-tree", () => {
  let repo: string;
  const memoFile = () =>
    git(
      repo,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "flow-verified-tree.json",
    );
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

    it("counts an untracked file even when status.showUntrackedFiles=no", () => {
      git(repo, "config", "status.showUntrackedFiles", "no");
      fs.writeFileSync(path.join(repo, "hidden.txt"), "x\n");
      expect(workingTreeId(repo)).not.toBe(
        git(repo, "rev-parse", "HEAD^{tree}"),
      );
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

    it("reads a corrupt file, a v1 memo, or a v2 memo without failed as null", () => {
      recordVerifiedTree("T1", [pass("npm run test")], repo);
      const p = memoFile();
      fs.writeFileSync(p, "{not json");
      expect(readVerifiedTree(repo)).toBeNull();
      fs.writeFileSync(
        p,
        JSON.stringify({ version: 1, tree: "x", passed: {} }),
      );
      expect(readVerifiedTree(repo)).toBeNull();
      fs.writeFileSync(
        p,
        JSON.stringify({ version: 2, tree: "x", passed: {} }),
      );
      expect(readVerifiedTree(repo)).toBeNull();
    });

    it("does not replay a pass after the same check failed on the tree", () => {
      const key = JSON.stringify(["npm", "run", "test"]);
      recordVerifiedTree("T1", [pass("npm run test", { passed: false })], repo);
      recordVerifiedTree("T1", [pass("npm run test")], repo);
      const memo = readVerifiedTree(repo);
      expect(Object.keys(memo?.failed ?? {})).toEqual([key]);
      expect(memo?.passed).toEqual({});
      expect(reusablePasses(memo, "T1", Date.now()).size).toBe(0);
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

  describe("reusablePasses", () => {
    const now = Date.parse("2026-01-01T01:00:00.000Z");
    const iso = (ms: number) => new Date(ms).toISOString();

    it("returns a fresh same-tree pass", () => {
      const out = reusablePasses(memoOf(iso(now - 1000)), "T1", now);
      expect([...out.keys()]).toEqual(["k"]);
      expect(out.get("k")).toEqual({ name: "npm run test", durationMs: 50 });
    });

    it("keeps an entry exactly at the max age and excludes an older one", () => {
      const edge = iso(now - VERIFIED_TREE_MAX_AGE_MS);
      expect(reusablePasses(memoOf(edge), "T1", now).size).toBe(1);
      const stale = iso(now - VERIFIED_TREE_MAX_AGE_MS - 1);
      expect(reusablePasses(memoOf(stale), "T1", now).size).toBe(0);
    });

    it("honours an injected max age", () => {
      expect(
        reusablePasses(memoOf(iso(now - 5000)), "T1", now, 1000).size,
      ).toBe(0);
    });

    it("excludes an unparseable or future-dated timestamp", () => {
      expect(reusablePasses(memoOf("not a date"), "T1", now).size).toBe(0);
      expect(reusablePasses(memoOf(iso(now + 1000)), "T1", now).size).toBe(0);
    });

    it("is empty for a different tree, a null tree, or a null memo", () => {
      const memo = memoOf(iso(now));
      expect(reusablePasses(memo, "T2", now).size).toBe(0);
      expect(reusablePasses(memo, null, now).size).toBe(0);
      expect(reusablePasses(null, "T1", now).size).toBe(0);
    });

    it("excludes a key that is in failed", () => {
      const memo = memoOf(iso(now), {
        failed: { k: { name: "npm run test", at: iso(now) } },
      });
      expect(reusablePasses(memo, "T1", now).size).toBe(0);
    });
  });

  describe("discardVerifiedTree", () => {
    it("removes a memo that belongs to the tree", () => {
      recordVerifiedTree("T1", [pass("npm run test")], repo);
      discardVerifiedTree("T1", repo);
      expect(readVerifiedTree(repo)).toBeNull();
      expect(fs.existsSync(memoFile())).toBe(false);
    });

    it("leaves a memo for another tree, and tolerates null or no memo", () => {
      recordVerifiedTree("T1", [pass("npm run test")], repo);
      discardVerifiedTree("T2", repo);
      discardVerifiedTree(null, repo);
      expect(readVerifiedTree(repo)?.tree).toBe("T1");
      fs.rmSync(memoFile());
      expect(() => discardVerifiedTree("T1", repo)).not.toThrow();
    });
  });
});
