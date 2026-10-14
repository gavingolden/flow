import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * End to end for same-tree reuse: a green read-only check recorded by a
 * normal run is NOT executed again by a `--pre-push` run on the identical
 * clean tree, and IS executed again once the tree has changed. The check is a
 * real `npm run test` whose script appends to a counter file, so "did it run"
 * is observed, not inferred.
 */
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "flow-pre-commit.ts");
const bunOnPath = spawnSync("bun", ["--version"]).status === 0;

const GIT_ISOLATION = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const ZERO_SHA = "0".repeat(40);

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ISOLATION },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

describeOnPosix("flow-pre-commit same-tree reuse (live)", () => {
  let root: string;
  let repo: string;
  let home: string;
  let counter: string;

  beforeEach(() => {
    if (!bunOnPath) return;
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "flow-pre-commit-reuse-")),
    );
    repo = path.join(root, "repo");
    home = path.join(root, "home");
    counter = path.join(root, "counter");
    fs.mkdirSync(repo);
    fs.mkdirSync(home);
    fs.writeFileSync(counter, "");

    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "0.0.1",
        scripts: { test: `echo ran >> ${counter}` },
      }),
    );
    fs.mkdirSync(path.join(repo, ".flow"));
    fs.writeFileSync(
      path.join(repo, ".flow", "pre-commit.json"),
      JSON.stringify([
        { name: "probe", prefixes: ["probe/"], checks: ["npm run test"] },
      ]),
    );
    fs.mkdirSync(path.join(repo, "probe"));
    fs.writeFileSync(path.join(repo, "probe", "a.txt"), "base\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    const remote = path.join(root, "origin.git");
    git(root, ["init", "-q", "--bare", "-b", "main", remote]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-q", "origin", "main"]);
    git(repo, ["fetch", "-q", "origin"]);
    git(repo, ["remote", "set-head", "origin", "main"]);

    git(repo, ["switch", "-q", "-c", "feature"]);
    fs.writeFileSync(path.join(repo, "probe", "a.txt"), "feature\n");
    git(repo, ["commit", "-q", "-am", "feature"]);
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const count = () =>
    fs.readFileSync(counter, "utf8").split("\n").filter(Boolean).length;

  function runPreCommit(args: string[], input?: string) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...GIT_ISOLATION,
      HOME: home,
    };
    delete env.FLOW_SLUG;
    return spawnSync("bun", [scriptPath, ...args], {
      cwd: repo,
      encoding: "utf8",
      env,
      input,
    });
  }

  const pushLine = () =>
    `refs/heads/feature ${git(repo, ["rev-parse", "HEAD"])} refs/heads/feature ${ZERO_SHA}\n`;

  it.skipIf(!bunOnPath)(
    "reuses a same-tree pass at push time, and re-runs once the tree changed",
    () => {
      const first = runPreCommit(["--json"]);
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(count()).toBe(1);

      const reused = runPreCommit(["--pre-push"], pushLine());
      expect(reused.status, reused.stdout + reused.stderr).toBe(0);
      expect(count()).toBe(1);
      expect(reused.stdout).toContain(
        "reused from an earlier run on this exact tree",
      );

      const reusedJson = runPreCommit(["--pre-push", "--json"], pushLine());
      expect(reusedJson.status, reusedJson.stderr).toBe(0);
      const rows = JSON.parse(reusedJson.stdout).results as Array<{
        name: string;
        dedupedFrom?: string;
      }>;
      expect(rows.find((r) => r.name === "npm run test")?.dedupedFrom).toBe(
        "earlier-run",
      );
      expect(count()).toBe(1);

      fs.writeFileSync(path.join(repo, "probe", "a.txt"), "edited\n");
      git(repo, ["commit", "-q", "-am", "edit"]);
      const rerun = runPreCommit(["--pre-push"], pushLine());
      expect(rerun.status, rerun.stdout + rerun.stderr).toBe(0);
      expect(count()).toBe(2);
      expect(rerun.stdout).not.toContain("an earlier run on this exact tree");
    },
    120_000,
  );

  it.skipIf(!bunOnPath)(
    "does not reuse at push time when the working tree is dirty",
    () => {
      const first = runPreCommit(["--json"]);
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(count()).toBe(1);

      fs.writeFileSync(path.join(repo, "probe", "untracked.txt"), "u\n");
      const dirty = runPreCommit(["--pre-push"], pushLine());
      expect(dirty.status, dirty.stdout + dirty.stderr).toBe(0);
      expect(count()).toBe(2);
    },
    120_000,
  );
});
