import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAgy, checkClaude, checkGh, checkTmux } from "./doctor-tools";
import { makeDeps, scriptedRun, type RunCall } from "./doctor-test-deps";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-tools-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(cfg: unknown): void {
  const p = path.join(root, "home", ".flow", "config.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg));
}

const missing = { notFound: true, status: null };

describe("checkGh", () => {
  it("fails with brew install gh when gh is not on PATH", () => {
    const [c] = checkGh(makeDeps(root, { run: scriptedRun(() => missing) }));
    expect(c).toMatchObject({ status: "fail", fix: "brew install gh" });
  });

  it("fails with gh auth login when signed out, and never prints gh output", () => {
    const [c] = checkGh(
      makeDeps(root, {
        run: scriptedRun(() => ({
          status: 1,
          stdout: "token ghp_SECRET123",
          stderr: "You are not logged in as SECRETUSER",
        })),
      }),
    );
    expect(c).toMatchObject({ status: "fail", fix: "gh auth login" });
    expect(JSON.stringify(c)).not.toMatch(/SECRET/);
  });

  it("passes when signed in without echoing stdout", () => {
    const [c] = checkGh(
      makeDeps(root, {
        run: scriptedRun(() => ({
          status: 0,
          stdout: "Logged in as SECRETUSER",
        })),
      }),
    );
    expect(c.status).toBe("pass");
    expect(JSON.stringify(c)).not.toMatch(/SECRETUSER/);
  });

  it("warns, not fails, when the check times out", () => {
    const [c] = checkGh(
      makeDeps(root, {
        run: scriptedRun(() => ({ status: null, timedOut: true })),
      }),
    );
    expect(c.status).toBe("warn");
  });
});

describe("checkTmux", () => {
  it("skips under the plain launcher when tmux is missing", () => {
    const [c] = checkTmux(makeDeps(root, { run: scriptedRun(() => missing) }));
    expect(c).toMatchObject({
      status: "skip",
      summary: "not needed by the plain launcher",
    });
  });

  it("fails under the tmux launcher when tmux is missing", () => {
    writeConfig({ launcher: "tmux" });
    const [c] = checkTmux(makeDeps(root, { run: scriptedRun(() => missing) }));
    expect(c.status).toBe("fail");
    expect(c.fix).toContain("brew install tmux");
  });

  it("passes with the version when tmux is present", () => {
    const [c] = checkTmux(
      makeDeps(root, {
        run: scriptedRun(() => ({ status: 0, stdout: "tmux 3.5a\n" })),
      }),
    );
    expect(c).toMatchObject({ status: "pass", summary: "tmux 3.5a" });
  });
});

describe("checkClaude", () => {
  it("passes when claude --version runs, through deps.run", () => {
    const calls: RunCall[] = [];
    const [c] = checkClaude(
      makeDeps(root, { run: scriptedRun(() => ({ status: 0 }), calls) }),
    );
    expect(c.status).toBe("pass");
    expect(calls[0]).toEqual({ cmd: "claude", args: ["--version"] });
  });

  it("fails with install guidance when claude is not on PATH", () => {
    const [c] = checkClaude(
      makeDeps(root, { run: scriptedRun(() => missing) }),
    );
    expect(c.status).toBe("fail");
    expect(c.summary).toContain("not on PATH");
    expect(c.fix).toContain("Install it");
  });

  it("fails when claude exits non-zero", () => {
    const [c] = checkClaude(
      makeDeps(root, {
        run: scriptedRun(() => ({ status: 1, stderr: "broken install" })),
      }),
    );
    expect(c.status).toBe("fail");
    expect(c.summary).toContain("broken install");
  });
});

describe("checkAgy", () => {
  const active = { researchActive: () => true };
  const models =
    "Fetching available models...\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\nclaude-x\tClaude X\n";

  it("skips when the research module is not active, without spawning agy", () => {
    const calls: RunCall[] = [];
    const [c] = checkAgy(
      makeDeps(root, { run: scriptedRun(() => ({ status: 0 }), calls) }),
      { researchActive: () => false },
    );
    expect(c.status).toBe("skip");
    expect(calls).toEqual([]);
  });

  it("passes on exit 0 with at least one model row, with a 15s timeout", () => {
    const seen: (number | undefined)[] = [];
    const deps = makeDeps(root, {
      run: (cmd, args, opts) => {
        seen.push(opts?.timeoutMs);
        return scriptedRun(() => ({ status: 0, stdout: models }))(
          cmd,
          args,
          opts,
        );
      },
    });
    const [c] = checkAgy(deps, active);
    expect(c).toMatchObject({
      status: "pass",
      summary: "agy responds and lists models; quota not checked",
    });
    expect(seen).toEqual([15000]);
  });

  it("warns 'research steps will be skipped' when agy is missing, never fails", () => {
    writeConfig({ modules: ["core", "research", "copilot"] });
    const [c] = checkAgy(
      makeDeps(root, { run: scriptedRun(() => missing) }),
      active,
    );
    expect(c.status).toBe("warn");
    expect(c.summary).toContain("research steps will be skipped");
    expect(c.fix).toBe("flow install --modules core,copilot");
  });

  it("warns 'not signed in' on an auth-shaped failure", () => {
    const [c] = checkAgy(
      makeDeps(root, {
        run: scriptedRun(() => ({ status: 1, stderr: "Error: not logged in" })),
      }),
      active,
    );
    expect(c.status).toBe("warn");
    expect(c.summary).toContain("not signed in");
    expect(c.fix).toBe("agy models");
  });

  it("warns 'could not confirm' on exit 0 with no model rows or any other failure", () => {
    for (const out of [
      { status: 0, stdout: "Fetching available models...\n" },
      { status: 2, stderr: "boom" },
      { status: null, timedOut: true },
    ]) {
      const [c] = checkAgy(
        makeDeps(root, { run: scriptedRun(() => out) }),
        active,
      );
      expect(c.status).toBe("warn");
      expect(c.summary).toContain("could not confirm");
      expect(c.fix).toBe("agy models");
    }
  });

  it("derives research activity from deps.configPath by default", () => {
    writeConfig({ modules: ["core"] });
    const [c] = checkAgy(makeDeps(root, { run: scriptedRun(() => missing) }));
    expect(c.status).toBe("skip");
    writeConfig({ modules: ["core", "research"] });
    const [d] = checkAgy(makeDeps(root, { run: scriptedRun(() => missing) }));
    expect(d.status).toBe("warn");
  });
});
