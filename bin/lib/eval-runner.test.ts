import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChildArgv,
  buildChildEnv,
  childArgvDigest,
  probeClaude,
  probeFlowInstall,
  renderPrompt,
  runScenarioOnce,
  type SpawnFn,
} from "./eval-runner";
import type { MaterializedFixture } from "./eval-fixture";
import type { ResolvedScenario } from "./eval-suite";

function makeFixture(
  overrides: Partial<MaterializedFixture> = {},
): MaterializedFixture {
  return {
    root: "/tmp/fixture-root",
    repoDir: "/tmp/fixture-root/repo",
    claudeHome: "/tmp/fixture-root/claude-home",
    bareClaudeHome: "/tmp/fixture-root/bare-claude-home",
    pluginRoots: [
      "/tmp/fixture-root/claude-home/.claude/skills/flow-module-core",
    ],
    shimDir: "/tmp/fixture-root/shims",
    slug: "eval-suite-s1-r1",
    stateDir: "/tmp/state",
    teardown: () => {},
    ...overrides,
  };
}

function makeScenario(
  overrides: Partial<ResolvedScenario> = {},
): ResolvedScenario {
  return {
    id: "s1",
    title: "S1",
    provenance: "test",
    prompt: "prompt.md",
    dir: "/evals/suite/s1",
    runs: 1,
    maxBudgetUsd: 4,
    timeoutSec: 60,
    allowedTools: ["Bash", "Read"],
    graders: [{ id: "g1", kind: "file", file: "$REPO/x.txt", exists: true }],
    ...overrides,
  };
}

describe("probeClaude", () => {
  it("returns claude-not-on-path when --version fails", () => {
    const run = vi.fn(() => ({ exitCode: 1, stdout: "" }));
    const result = probeClaude("claude", run);
    expect(result).toEqual({
      ok: false,
      reason: "claude-not-on-path",
      notice: expect.any(String),
    });
  });

  it("returns claude-not-authenticated when auth status is not logged in", () => {
    const run = vi.fn((argv: string[]) => {
      if (argv.includes("--version"))
        return { exitCode: 0, stdout: "2.1.239 (Claude Code)" };
      return { exitCode: 0, stdout: JSON.stringify({ loggedIn: false }) };
    });
    const result = probeClaude("claude", run);
    expect(result).toEqual({
      ok: false,
      reason: "claude-not-authenticated",
      notice: expect.any(String),
    });
  });

  it("returns ok with version when on PATH and logged in", () => {
    const run = vi.fn((argv: string[]) => {
      if (argv.includes("--version"))
        return { exitCode: 0, stdout: "2.1.239 (Claude Code)" };
      return { exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) };
    });
    const result = probeClaude("claude", run);
    expect(result).toEqual({ ok: true, version: "2.1.239" });
  });
});

describe("probeFlowInstall", () => {
  it("returns flow-not-installed when the global agents dir is absent", () => {
    const result = probeFlowInstall(() => false, "/home/eval-user");
    expect(result).toEqual({
      ok: false,
      reason: "flow-not-installed",
      notice: expect.any(String),
    });
  });

  it("returns ok when the global agents dir exists", () => {
    const result = probeFlowInstall(
      (p) => p.endsWith("flow-module-core/agents"),
      "/home/eval-user",
    );
    expect(result.ok).toBe(true);
  });
});

describe("buildChildArgv", () => {
  it("matches the exact contracted shape, including optional toggles", () => {
    const scenario = makeScenario();
    const fixture = makeFixture();
    const argv = buildChildArgv(scenario, fixture, {
      claudeBin: "claude",
      sessionId: "sess-1",
      prompt: "hello",
    });
    expect(argv).toEqual([
      "claude",
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--verbose",
      "--add-dir",
      fixture.claudeHome,
      "--plugin-dir",
      fixture.pluginRoots[0],
      "--setting-sources",
      "project",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--allowedTools",
      "Bash,Read",
      "--disallowedTools",
      "Bash(git push:*),Bash(gh pr merge:*),Bash(gh pr create:*),Bash(gh pr close:*),Bash(gh release:*),Bash(rm -rf node_modules*)",
      "--max-budget-usd",
      "4",
      "--session-id",
      "sess-1",
      "--no-session-persistence",
    ]);
  });

  it("emits --permission-prompts immediately followed by none", () => {
    const argv = buildChildArgv(makeScenario(), makeFixture(), {
      claudeBin: "claude",
      sessionId: "sess-1",
      prompt: "hello",
    });
    const idx = argv.indexOf("--permission-prompts");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("none");
  });

  it("'without' arm: omits every --plugin-dir and points --add-dir at bareClaudeHome", () => {
    const fixture = makeFixture();
    const argv = buildChildArgv(makeScenario(), fixture, {
      claudeBin: "claude",
      sessionId: "sess-1",
      prompt: "hello",
      arm: "without",
    });
    expect(argv).not.toContain("--plugin-dir");
    const addDirIdx = argv.indexOf("--add-dir");
    expect(argv[addDirIdx + 1]).toBe(fixture.bareClaudeHome);
  });

  it("'with' arm (explicit or default) is byte-identical", () => {
    const scenario = makeScenario();
    const fixture = makeFixture();
    const explicit = buildChildArgv(scenario, fixture, {
      claudeBin: "claude",
      sessionId: "sess-1",
      prompt: "hello",
      arm: "with",
    });
    const defaulted = buildChildArgv(scenario, fixture, {
      claudeBin: "claude",
      sessionId: "sess-1",
      prompt: "hello",
    });
    expect(explicit).toEqual(defaulted);
  });

  it("adds --json-schema and --model, and omits --no-session-persistence when keepSessions is set", () => {
    const scenario = makeScenario();
    const fixture = makeFixture();
    const argv = buildChildArgv(scenario, fixture, {
      claudeBin: "claude",
      sessionId: "sess-1",
      prompt: "hello",
      resultSchema: { type: "object" },
      model: "haiku",
      keepSessions: true,
    });
    expect(argv).not.toContain("--no-session-persistence");
    expect(argv).toContain("--json-schema");
    expect(argv[argv.indexOf("--json-schema") + 1]).toBe(
      JSON.stringify({ type: "object" }),
    );
    expect(argv.slice(-2)).toEqual(["--model", "haiku"]);
  });

  it("adds --effort when opts.effort is set", () => {
    const scenario = makeScenario();
    const fixture = makeFixture();
    const argv = buildChildArgv(scenario, fixture, {
      claudeBin: "claude",
      sessionId: "sess-1",
      prompt: "hello",
      effort: "medium",
    });
    expect(argv.slice(-2)).toEqual(["--effort", "medium"]);
  });

  it("omits --effort when opts.effort is unset", () => {
    const scenario = makeScenario();
    const fixture = makeFixture();
    const argv = buildChildArgv(scenario, fixture, {
      claudeBin: "claude",
      sessionId: "sess-1",
      prompt: "hello",
    });
    expect(argv).not.toContain("--effort");
  });
});

describe("childArgvDigest", () => {
  it("is stable across runs that differ only in prompt/session-id/fixture path", () => {
    const scenario = makeScenario();
    const fixture = makeFixture();
    const argvA = buildChildArgv(scenario, fixture, {
      claudeBin: "claude",
      sessionId: "sess-1",
      prompt: "do the first thing",
    });
    const argvB = buildChildArgv(
      scenario,
      makeFixture({ root: "/tmp/other-fixture-root" }),
      {
        claudeBin: "claude",
        sessionId: "sess-2-totally-different-uuid",
        prompt: "do a completely different, much longer thing",
      },
    );
    expect(childArgvDigest(argvA)).toBe(childArgvDigest(argvB));
  });

  it("changes when a digested permission flag's value changes", () => {
    const scenario = makeScenario();
    const fixture = makeFixture();
    const argvA = buildChildArgv(scenario, fixture, {
      claudeBin: "claude",
      sessionId: "sess-1",
      prompt: "hello",
    });
    const argvB = argvA.map((tok, i) =>
      argvA[i - 1] === "--permission-mode" ? "acceptEdits" : tok,
    );
    expect(childArgvDigest(argvA)).not.toBe(childArgvDigest(argvB));
  });

  it("changes when the --plugin-dir count changes", () => {
    const scenario = makeScenario();
    const withPlugin = buildChildArgv(scenario, makeFixture(), {
      claudeBin: "claude",
      sessionId: "sess-1",
      prompt: "hello",
    });
    const withoutPlugin = buildChildArgv(scenario, makeFixture(), {
      claudeBin: "claude",
      sessionId: "sess-1",
      prompt: "hello",
      arm: "without",
    });
    expect(childArgvDigest(withPlugin)).not.toBe(
      childArgvDigest(withoutPlugin),
    );
  });
});

describe("buildChildEnv", () => {
  it("drops FLOW_SLUG/TMUX_PANE/CLAUDECODE and sets FLOW_PIPELINE/FLOW_EVAL_FIXTURE", () => {
    const scenario = makeScenario();
    const fixture = makeFixture();
    const base = {
      FLOW_SLUG: "parent-pipeline",
      TMUX_PANE: "%1",
      CLAUDECODE: "1",
      PATH: "/usr/bin",
      HOME: "/home/eval-user",
    };
    const env = buildChildEnv(scenario, fixture, base);
    expect(env.FLOW_SLUG).toBeUndefined();
    expect(env.TMUX_PANE).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.FLOW_PIPELINE).toBe("1");
    expect(env.FLOW_EVAL_FIXTURE).toBe(fixture.repoDir);
    expect(env.HOME).toBe("/home/eval-user");
  });

  it("sets FLOW_SLUG only when scenario.env.flowSlug is true", () => {
    const fixture = makeFixture();
    const withFlag = buildChildEnv(
      makeScenario({ env: { flowSlug: true } }),
      fixture,
      { PATH: "/usr/bin" },
    );
    expect(withFlag.FLOW_SLUG).toBe(fixture.slug);

    const withoutFlag = buildChildEnv(makeScenario(), fixture, {
      PATH: "/usr/bin",
    });
    expect(withoutFlag.FLOW_SLUG).toBeUndefined();
  });

  it("puts the shim dir at the front of PATH so shims shadow real binaries", () => {
    const fixture = makeFixture({ pluginRoots: [] });
    const env = buildChildEnv(makeScenario(), fixture, {
      PATH: "/usr/bin:/bin",
    });
    expect(env.PATH!.startsWith(fixture.shimDir + ":")).toBe(true);
  });

  it("puts the fixture's plugin bin/ ahead of the inherited PATH, not appended", () => {
    const pluginRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-eval-plugin-root-"),
    );
    fs.mkdirSync(path.join(pluginRoot, "bin"));
    const fixture = makeFixture({ pluginRoots: [pluginRoot] });
    try {
      const base = { PATH: "/usr/bin:/bin" };
      const env = buildChildEnv(makeScenario(), fixture, base);
      const pluginBin = path.join(pluginRoot, "bin");
      const parts = env.PATH!.split(":");
      expect(parts[0]).toBe(fixture.shimDir);
      expect(parts.indexOf(pluginBin)).toBeGreaterThan(-1);
      expect(parts.indexOf(pluginBin)).toBeLessThan(parts.indexOf("/usr/bin"));
    } finally {
      fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it("'without' arm: no PATH segment resolves to a path containing flow-module-, and the composed argv's --add-dir target carries no flow-module-* entry on disk", () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-eval-anti-leak-"),
    );
    try {
      const claudeHome = path.join(tmpRoot, "claude-home");
      const bareClaudeHome = path.join(tmpRoot, "bare-claude-home");
      const pluginRoot = path.join(
        claudeHome,
        ".claude",
        "skills",
        "flow-module-core",
      );
      fs.mkdirSync(path.join(pluginRoot, "bin"), { recursive: true });
      fs.mkdirSync(path.join(bareClaudeHome, ".claude", "skills"), {
        recursive: true,
      });
      const fixture = makeFixture({
        claudeHome,
        bareClaudeHome,
        pluginRoots: [pluginRoot],
      });
      const scenario = makeScenario();

      const argv = buildChildArgv(scenario, fixture, {
        claudeBin: "claude",
        sessionId: "sess-1",
        prompt: "hello",
        arm: "without",
      });
      const env = buildChildEnv(
        scenario,
        fixture,
        { PATH: "/usr/bin:/bin" },
        "without",
      );

      for (const tok of argv) {
        expect(tok).not.toContain("flow-module-");
      }
      for (const seg of env.PATH!.split(":")) {
        expect(seg).not.toContain("flow-module-");
      }
      const addDirIdx = argv.indexOf("--add-dir");
      const addDirTarget = argv[addDirIdx + 1];
      expect(addDirTarget).toBe(bareClaudeHome);
      const skillsDir = path.join(addDirTarget, ".claude", "skills");
      const entries = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : [];
      expect(entries.some((e) => e.startsWith("flow-module-"))).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("renderPrompt", () => {
  it("wraps preload files as eval-context blocks and expands $REPO in prompt.md", () => {
    const scenario = makeScenario({ preload: ["plan-digest.md"] });
    const fixture = makeFixture();
    const files: Record<string, string> = {
      [path.join(scenario.dir, "plan-digest.md")]: "PLAN CONTENT",
      [path.join(scenario.dir, "prompt.md")]: "Work in $REPO now.",
    };
    const readFile = (p: string) => files[p] ?? "";
    const prompt = renderPrompt(scenario, fixture, readFile);
    expect(prompt).toContain('<eval-context name="plan-digest.md">');
    expect(prompt).toContain("PLAN CONTENT");
    expect(prompt).toContain(`Work in ${fixture.repoDir} now.`);
  });

  it("prefixes the byte-exact resume seed, containing /flow-pipeline and --resume mode", () => {
    const scenario = makeScenario({ promptSeed: "resume" });
    const fixture = makeFixture();
    const files: Record<string, string> = {
      [path.join(scenario.dir, "prompt.md")]: "Stop before editing.",
    };
    const prompt = renderPrompt(scenario, fixture, (p) => files[p] ?? "");
    expect(prompt).toContain("/flow-pipeline");
    expect(prompt).toContain("--resume mode");
    expect(prompt).toContain(fixture.slug);
  });

  it("builds the terminal seed from the fixture's seeded state and checkpoint body", () => {
    const scenario = makeScenario({ promptSeed: "terminal" });
    const fixture = makeFixture();
    const files: Record<string, string> = {
      [path.join(scenario.dir, "prompt.md")]: "Orient only.",
      [`${fixture.stateDir}/${fixture.slug}.json`]: JSON.stringify({
        phase: "merged",
        repo: fixture.repoDir,
        worktree: fixture.repoDir,
        pr: 42,
      }),
      [`${fixture.stateDir}/checkpoints/${fixture.slug}/checkpoint.md`]:
        "terminal recap notes",
    };
    const prompt = renderPrompt(scenario, fixture, (p) => {
      if (files[p] !== undefined) return files[p];
      throw new Error(`unexpected read: ${p}`);
    });
    expect(prompt).toContain("terminal recap notes");
    expect(prompt).toContain("#42");
    expect(prompt).toContain("Orient only.");
  });
});

describe("runScenarioOnce", () => {
  let outDir!: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-eval-runner-test-"));
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("streams stdout to stream.jsonl, writes prompt.txt, and parses the envelope", async () => {
    const fs = await import("node:fs");
    const scenario = makeScenario();
    const fixture = makeFixture();
    const files: Record<string, string> = {
      [path.join(scenario.dir, "prompt.md")]: "do the thing",
    };
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0.01,
      duration_ms: 10,
      session_id: "s",
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
      permission_denials: [],
    });

    const fakeSpawn: SpawnFn = (_argv, _env, _cwd, onStdout) => {
      onStdout(resultLine + "\n");
      return { exited: Promise.resolve(0), kill: () => {} };
    };

    const outcome = await runScenarioOnce(scenario, fixture, {
      claudeBin: "claude",
      outDir,
      sessionId: "sess-1",
      spawn: fakeSpawn,
      readFile: (p) => files[p] ?? "",
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.result?.subtype).toBe("success");
    expect(fs.readFileSync(path.join(outDir, "prompt.txt"), "utf8")).toContain(
      "do the thing",
    );
    expect(
      fs.readFileSync(path.join(outDir, "stream.jsonl"), "utf8"),
    ).toContain('"type":"result"');
  });

  it("writes assistant-text.txt containing only assistant-emitted text, excluding user-role content", async () => {
    const fs = await import("node:fs");
    const scenario = makeScenario();
    const fixture = makeFixture();
    const files: Record<string, string> = {
      [path.join(scenario.dir, "prompt.md")]: "do the thing",
    };
    const userLine = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            text: "skill prose containing a fake NOTICE — agent-fallback: nope",
          },
        ],
      },
    });
    const assistantLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "real assistant output" }] },
    });
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0.01,
      duration_ms: 10,
      session_id: "s",
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
      permission_denials: [],
    });

    const fakeSpawn: SpawnFn = (_argv, _env, _cwd, onStdout) => {
      onStdout([userLine, assistantLine, resultLine].join("\n") + "\n");
      return { exited: Promise.resolve(0), kill: () => {} };
    };

    const outcome = await runScenarioOnce(scenario, fixture, {
      claudeBin: "claude",
      outDir,
      sessionId: "sess-1",
      spawn: fakeSpawn,
      readFile: (p) => files[p] ?? "",
    });
    expect(outcome.assistantTextPath).toBe(
      path.join(outDir, "assistant-text.txt"),
    );
    const assistantTextContent = fs.readFileSync(
      outcome.assistantTextPath,
      "utf8",
    );
    expect(assistantTextContent).toBe("real assistant output");
    expect(assistantTextContent).not.toContain("agent-fallback");
  });

  it("drains stderr chunks into <outDir>/stderr.txt", async () => {
    const scenario = makeScenario();
    const fixture = makeFixture();
    const files: Record<string, string> = {
      [path.join(scenario.dir, "prompt.md")]: "hi",
    };
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0.01,
      duration_ms: 10,
      session_id: "s",
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
      permission_denials: [],
    });

    const fakeSpawn: SpawnFn = (_argv, _env, _cwd, onStdout, onStderr) => {
      onStdout(resultLine + "\n");
      onStderr?.("warning: something noisy\n");
      return { exited: Promise.resolve(0), kill: () => {} };
    };

    await runScenarioOnce(scenario, fixture, {
      claudeBin: "claude",
      outDir,
      sessionId: "sess-1",
      spawn: fakeSpawn,
      readFile: (p) => files[p] ?? "",
    });
    expect(fs.readFileSync(path.join(outDir, "stderr.txt"), "utf8")).toBe(
      "warning: something noisy\n",
    );
  });

  it("kills the child and reports timedOut when timeoutSec elapses", async () => {
    vi.useFakeTimers();
    const scenario = makeScenario({ timeoutSec: 1 });
    const fixture = makeFixture();
    const files: Record<string, string> = {
      [path.join(scenario.dir, "prompt.md")]: "hi",
    };

    let killed = false;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const fakeSpawn: SpawnFn = () => ({
      exited,
      kill: () => {
        killed = true;
        resolveExit(-1);
      },
    });

    try {
      const promise = runScenarioOnce(scenario, fixture, {
        claudeBin: "claude",
        outDir,
        sessionId: "sess-1",
        spawn: fakeSpawn,
        readFile: (p) => files[p] ?? "",
      });
      await vi.advanceTimersByTimeAsync(1500);
      const outcome = await promise;
      expect(killed).toBe(true);
      expect(outcome.timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
