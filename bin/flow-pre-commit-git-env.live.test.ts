import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GIT_LOCAL_ENV_VARS } from "./lib/git-local-env";

/**
 * The issue's own reproduction end to end: `flow-pre-commit` started with
 * git's repo-pointing variables set (as a git hook in a linked worktree does)
 * must hand its checks an environment without any of them. A real linked
 * worktree + a real probe script, so a regression in the spawn wiring (not
 * just in the helper) fails here.
 */
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "flow-pre-commit.ts");
const bunOnPath = spawnSync("bun", ["--version"]).status === 0;

const GIT_ISOLATION = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ISOLATION },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

describeOnPosix("flow-pre-commit git environment scrub (live)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "flow-pre-commit-git-env-")),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(!bunOnPath)(
    "launches a configured check without any git repo-pointing variable",
    () => {
      const main = path.join(root, "main");
      const worktree = path.join(root, "wt");
      const probeOut = path.join(root, "probe.env");
      const probe = path.join(root, "probe.sh");
      fs.writeFileSync(probe, `#!/bin/sh\nenv > "${probeOut}"\n`);

      fs.mkdirSync(main);
      git(main, ["init", "-q", "-b", "main"]);
      git(main, ["config", "user.email", "t@t"]);
      git(main, ["config", "user.name", "t"]);
      fs.mkdirSync(path.join(main, ".flow"));
      fs.writeFileSync(
        path.join(main, ".flow", "pre-commit.json"),
        JSON.stringify([
          { name: "probe", prefixes: ["probe/"], checks: [`sh ${probe}`] },
        ]),
      );
      fs.mkdirSync(path.join(main, "probe"));
      fs.writeFileSync(path.join(main, "probe", "a.txt"), "a\n");
      git(main, ["add", "-A"]);
      git(main, ["commit", "-q", "-m", "init"]);
      git(main, ["worktree", "add", "-q", "-b", "feature", worktree]);
      fs.writeFileSync(path.join(worktree, "probe", "a.txt"), "changed\n");

      const gitDir = git(worktree, [
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
      ]);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...GIT_ISOLATION,
        GIT_DIR: gitDir,
      };
      delete env.FLOW_SLUG;

      const result = spawnSync("bun", [scriptPath, "--json"], {
        cwd: worktree,
        encoding: "utf8",
        env,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);

      const seen = fs
        .readFileSync(probeOut, "utf8")
        .split("\n")
        .map((line) => line.split("=")[0]);
      const leaked = GIT_LOCAL_ENV_VARS.filter((name) => seen.includes(name));
      expect(leaked).toEqual([]);
      expect(seen).toContain("GIT_CONFIG_NOSYSTEM");
    },
    60_000,
  );
});
