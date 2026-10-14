import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { GIT_LOCAL_ENV_VARS, withoutGitLocalEnv } from "./git-local-env";

describe("GIT_LOCAL_ENV_VARS", () => {
  it("covers every name the running git prints for --local-env-vars", () => {
    const r = spawnSync("git", ["rev-parse", "--local-env-vars"], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    const printed = r.stdout.split("\n").filter(Boolean);
    expect(printed.length).toBeGreaterThan(0);
    const missing = printed.filter((n) => !GIT_LOCAL_ENV_VARS.includes(n));
    expect(missing).toEqual([]);
  });
});

describe("withoutGitLocalEnv", () => {
  it("returns a copy lacking every listed name and keeps the rest", () => {
    const input: NodeJS.ProcessEnv = {
      PATH: "/bin",
      GIT_SSH_COMMAND: "ssh -x",
    };
    for (const name of GIT_LOCAL_ENV_VARS) input[name] = "poisoned";
    const out = withoutGitLocalEnv(input);
    for (const name of GIT_LOCAL_ENV_VARS) expect(out).not.toHaveProperty(name);
    expect(out.PATH).toBe("/bin");
    expect(out.GIT_SSH_COMMAND).toBe("ssh -x");
  });

  it("never mutates its input", () => {
    const input: NodeJS.ProcessEnv = { GIT_DIR: "/x", HOME: "/h" };
    const out = withoutGitLocalEnv(input);
    expect(input).toEqual({ GIT_DIR: "/x", HOME: "/h" });
    expect(out).not.toBe(input);
  });
});
