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
 * is observed, not inferred. `--reuse-verified-tree` replays the same memo
 * outside the push path, but never for a check that failed on the tree and
 * never from a run whose own checks changed tracked files.
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

  it.skipIf(!bunOnPath)(
    "does not reuse when the pushed sha is not HEAD",
    () => {
      fs.writeFileSync(path.join(repo, "probe", "a.txt"), "second\n");
      git(repo, ["commit", "-q", "-am", "second"]);
      const first = runPreCommit(["--json"]);
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(count()).toBe(1);

      const older = git(repo, ["rev-parse", "HEAD~1"]);
      const stale = runPreCommit(
        ["--pre-push"],
        `refs/heads/feature ${older} refs/heads/feature ${ZERO_SHA}\n`,
      );
      expect(stale.status, stale.stdout + stale.stderr).toBe(0);
      expect(count()).toBe(2);
      expect(stale.stdout).not.toContain("an earlier run on this exact tree");
    },
    120_000,
  );

  it.skipIf(!bunOnPath)(
    "records nothing when any planned check mutates, and records when all are read-only",
    () => {
      const memo = git(repo, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "flow-verified-tree.json",
      ]);
      const readOnly = runPreCommit(["--json"]);
      expect(readOnly.status, readOnly.stdout + readOnly.stderr).toBe(0);
      expect(fs.existsSync(memo)).toBe(true);
      fs.rmSync(memo);

      const pkgPath = path.join(repo, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      pkg.scripts.build = "true";
      fs.writeFileSync(pkgPath, JSON.stringify(pkg));
      fs.writeFileSync(
        path.join(repo, ".flow", "pre-commit.json"),
        JSON.stringify([
          {
            name: "probe",
            prefixes: ["probe/"],
            checks: ["npm run build", "npm run test"],
          },
        ]),
      );
      git(repo, ["commit", "-q", "-am", "add mutating build check"]);

      const mutating = runPreCommit(["--json"]);
      expect(mutating.status, mutating.stdout + mutating.stderr).toBe(0);
      expect(fs.existsSync(memo)).toBe(false);
    },
    120_000,
  );

  const memoPath = () =>
    git(repo, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "flow-verified-tree.json",
    ]);

  const setTestScript = (script: string) => {
    const pkgPath = path.join(repo, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.scripts.test = script;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg));
    git(repo, ["commit", "-q", "-am", "test script"]);
  };

  type Row = { name: string; dedupedFrom?: string };
  const rowsOf = (stdout: string) => JSON.parse(stdout).results as Row[];

  it.skipIf(!bunOnPath)(
    "--reuse-verified-tree replays a recorded pass on the identical tree and reports the saving",
    () => {
      const first = runPreCommit(["--json"]);
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(count()).toBe(1);

      const memoBefore = fs.readFileSync(memoPath(), "utf8");
      const reused = runPreCommit(["--json", "--reuse-verified-tree"]);
      expect(reused.status, reused.stdout + reused.stderr).toBe(0);
      expect(count()).toBe(1);
      expect(
        rowsOf(reused.stdout).find((r) => r.name === "npm run test")
          ?.dedupedFrom,
      ).toBe("earlier-run");
      expect(JSON.parse(reused.stdout).earlierRunSavedMs).toBeGreaterThan(0);
      expect(fs.readFileSync(memoPath(), "utf8")).toBe(memoBefore);
    },
    120_000,
  );

  it.skipIf(!bunOnPath)(
    "--reuse-verified-tree replays on a dirty (uncommitted) tree",
    () => {
      fs.writeFileSync(path.join(repo, "probe", "a.txt"), "dirty\n");
      expect(runPreCommit(["--json"]).status).toBe(0);
      expect(count()).toBe(1);
      const reused = runPreCommit(["--json", "--reuse-verified-tree"]);
      expect(count()).toBe(1);
      expect(
        rowsOf(reused.stdout).find((r) => r.name === "npm run test")
          ?.dedupedFrom,
      ).toBe("earlier-run");
    },
    120_000,
  );

  it.skipIf(!bunOnPath)(
    "executes every check without the flag even on an identical tree",
    () => {
      runPreCommit(["--json"]);
      const again = runPreCommit(["--json"]);
      expect(again.status, again.stdout + again.stderr).toBe(0);
      expect(count()).toBe(2);
      expect(JSON.parse(again.stdout)).not.toHaveProperty("earlierRunSavedMs");
    },
    120_000,
  );

  it.skipIf(!bunOnPath)(
    "executes every check under the flag once the tree changed",
    () => {
      runPreCommit(["--json"]);
      fs.writeFileSync(path.join(repo, "probe", "a.txt"), "edited\n");
      const changed = runPreCommit(["--json", "--reuse-verified-tree"]);
      expect(changed.status, changed.stdout + changed.stderr).toBe(0);
      expect(count()).toBe(2);
      expect(
        rowsOf(changed.stdout).every((r) => r.dedupedFrom !== "earlier-run"),
      ).toBe(true);
    },
    120_000,
  );

  it.skipIf(!bunOnPath)(
    "executes under the flag a check that failed and then passed on the tree",
    () => {
      const gate = path.join(root, "gate");
      fs.writeFileSync(gate, "");
      setTestScript(`echo ran >> ${counter}; test ! -e ${gate}`);

      const failing = runPreCommit(["--json"]);
      expect(failing.status).not.toBe(0);
      expect(count()).toBe(1);

      fs.rmSync(gate);
      const passing = runPreCommit(["--json"]);
      expect(passing.status, passing.stdout + passing.stderr).toBe(0);
      expect(count()).toBe(2);

      const flagged = runPreCommit(["--json", "--reuse-verified-tree"]);
      expect(flagged.status, flagged.stdout + flagged.stderr).toBe(0);
      expect(count()).toBe(3);
      expect(
        rowsOf(flagged.stdout).every((r) => r.dedupedFrom !== "earlier-run"),
      ).toBe(true);
    },
    120_000,
  );

  it.skipIf(!bunOnPath)(
    "leaves no memo for the start tree when a check edits a tracked file",
    () => {
      const gate = path.join(root, "gate");
      setTestScript(
        `echo ran >> ${counter}; if [ -e ${gate} ]; then echo x >> probe/a.txt; fi`,
      );

      const recording = runPreCommit(["--json"]);
      expect(recording.status, recording.stdout + recording.stderr).toBe(0);
      expect(fs.existsSync(memoPath())).toBe(true);

      fs.writeFileSync(gate, "");
      const mutating = runPreCommit(["--json"]);
      expect(mutating.status, mutating.stdout + mutating.stderr).toBe(0);
      expect(fs.existsSync(memoPath())).toBe(false);
    },
    120_000,
  );
});
