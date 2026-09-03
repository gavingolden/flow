import { describe, expect, it } from "vitest";
import {
  buildChildArgv,
  buildChildEnv,
  CHILD_ENV_ALLOW,
  ENV_NEVER,
  FIXED_DENY_LIST,
  HEADLESS_PREAMBLE,
  artifactPathFor,
  parseArgs,
  run,
  type Args,
  type Deps,
} from "./lib/claude-headless";

describe("buildChildEnv", () => {
  it("copies only allowlisted keys plus ANTHROPIC_*/LC_* prefixes", () => {
    const base: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      ANTHROPIC_API_KEY: "sk-x",
      LC_ALL: "en_US.UTF-8",
      RANDOM_VAR: "nope",
    };
    const env = buildChildEnv(base, []);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-x");
    expect(env.LC_ALL).toBe("en_US.UTF-8");
    expect(env.RANDOM_VAR).toBeUndefined();
  });

  it("excludes ENV_NEVER keys even when passed via extra", () => {
    const base: NodeJS.ProcessEnv = {
      FLOW_SLUG: "my-slug",
      TMUX_PANE: "%1",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_EFFORT: "medium",
      CLAUDE_CODE_EFFORT_LEVEL: "medium",
    };
    const env = buildChildEnv(base, [
      "FLOW_SLUG",
      "TMUX_PANE",
      "CLAUDECODE",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_EFFORT",
      "CLAUDE_CODE_EFFORT_LEVEL",
    ]);
    for (const k of ENV_NEVER) {
      expect(env[k]).toBeUndefined();
    }
  });

  it("sets FLOW_PIPELINE and FLOW_HEADLESS_DEPTH", () => {
    const env = buildChildEnv({}, []);
    expect(env.FLOW_PIPELINE).toBe("1");
    expect(env.FLOW_HEADLESS_DEPTH).toBe("1");
  });

  it("allows an explicit --env key not otherwise on the allowlist", () => {
    const env = buildChildEnv({ MY_CUSTOM_VAR: "x" }, ["MY_CUSTOM_VAR"]);
    expect(env.MY_CUSTOM_VAR).toBe("x");
  });

  it("CHILD_ENV_ALLOW carries the documented base names", () => {
    expect(CHILD_ENV_ALLOW).toContain("PATH");
    expect(CHILD_ENV_ALLOW).toContain("CLAUDE_CONFIG_DIR");
  });
});

describe("parseArgs", () => {
  it("rejects missing --model", () => {
    expect(parseArgs(["--prompt", "hi", "--effort", "low"])).toEqual({
      error: "--model is required",
    });
  });

  it("rejects a bad --effort", () => {
    expect(
      parseArgs(["--prompt", "hi", "--model", "haiku", "--effort", "bogus"]),
    ).toEqual({ error: "--effort must be one of low|medium|high|xhigh|max" });
  });

  it("rejects both prompt forms", () => {
    expect(
      parseArgs([
        "--prompt",
        "hi",
        "--prompt-file",
        "/p",
        "--model",
        "haiku",
        "--effort",
        "low",
      ]),
    ).toEqual({
      error: "exactly one of --prompt or --prompt-file is required",
    });
  });

  it("rejects neither prompt form", () => {
    expect(parseArgs(["--model", "haiku", "--effort", "low"])).toEqual({
      error: "exactly one of --prompt or --prompt-file is required",
    });
  });

  it("rejects a prompt beginning with --", () => {
    expect(
      parseArgs([
        "--prompt",
        "--not-a-prompt",
        "--model",
        "haiku",
        "--effort",
        "low",
      ]),
    ).toEqual({ error: "--prompt value must not begin with --" });
  });

  it("rejects an inline prompt over 200 chars with a use --prompt-file message", () => {
    const result = parseArgs([
      "--prompt",
      "x".repeat(201),
      "--model",
      "haiku",
      "--effort",
      "low",
    ]);
    expect("error" in result && result.error).toContain("use --prompt-file");
  });

  it("applies documented defaults", () => {
    const parsed = parseArgs([
      "--prompt",
      "hi",
      "--model",
      "haiku",
      "--effort",
      "low",
    ]);
    expect("error" in parsed).toBe(false);
    const a = parsed as Args;
    expect(a.maxBudgetUsd).toBe(5);
    expect(a.maxTurns).toBe(25);
    expect(a.allowedTools).toBe("Read,Grep,Glob");
    expect(a.bare).toBe(false);
    expect(a.timeoutSec).toBe(600);
    expect(a.task).toBe("headless");
  });

  it("supports --prompt-file, --env (repeatable), and --bare", () => {
    const parsed = parseArgs([
      "--prompt-file",
      "/tmp/p.txt",
      "--model",
      "sonnet",
      "--effort",
      "high",
      "--env",
      "MY_VAR",
      "--env",
      "OTHER_VAR",
      "--bare",
    ]);
    expect("error" in parsed).toBe(false);
    const a = parsed as Args;
    expect(a.promptFile).toBe("/tmp/p.txt");
    expect(a.env).toEqual(["MY_VAR", "OTHER_VAR"]);
    expect(a.bare).toBe(true);
  });
});

describe("buildChildArgv", () => {
  it("builds the exact argv order with the preamble prefix, dontAsk, and FIXED_DENY_LIST", () => {
    const a = parseArgs([
      "--prompt",
      "hi",
      "--model",
      "haiku",
      "--effort",
      "low",
    ]) as Args;
    const argv = buildChildArgv(a, "hi");
    expect(argv).toEqual([
      "claude",
      "-p",
      HEADLESS_PREAMBLE + "hi",
      "--output-format",
      "json",
      "--model",
      "haiku",
      "--effort",
      "low",
      "--max-budget-usd",
      "5",
      "--max-turns",
      "25",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Read,Grep,Glob",
      "--disallowedTools",
      FIXED_DENY_LIST,
      "--no-session-persistence",
    ]);
  });

  it("appends --bare only when set", () => {
    const a = parseArgs([
      "--prompt",
      "hi",
      "--model",
      "haiku",
      "--effort",
      "low",
      "--bare",
    ]) as Args;
    const argv = buildChildArgv(a, "hi");
    expect(argv[argv.length - 1]).toBe("--bare");
  });
});

describe("artifactPathFor", () => {
  it("defaults to a task+pid path under .flow-tmp", () => {
    const a = parseArgs([
      "--prompt",
      "hi",
      "--model",
      "haiku",
      "--effort",
      "low",
      "--task",
      "mytask",
    ]) as Args;
    const p = artifactPathFor(a);
    expect(p).toContain("mytask");
    expect(p).toContain(String(process.pid));
    expect(p.startsWith(".flow-tmp/headless-")).toBe(true);
  });
});

function baseDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    claudeOnPath: () => true,
    runClaude: async () => ({ exitCode: 0, stderr: "", timedOut: false }),
    readFile: () => "",
    fileExists: () => false,
    mkdirp: () => {},
    writeOut: () => {},
    env: {},
    pid: 1234,
    ...overrides,
  };
}

describe("run", () => {
  it("returns bad-args on parse error, exit 2", async () => {
    let out = "";
    const code = await run([], {
      writeOut: (line) => {
        out = line;
      },
    });
    expect(code).toBe(2);
    expect(JSON.parse(out).skipReason).toBe("bad-args");
  });

  it("returns headless-depth-exceeded, exit 2, without spawning", async () => {
    let out = "";
    let spawned = false;
    const code = await run(
      ["--prompt", "hi", "--model", "haiku", "--effort", "low"],
      baseDeps({
        env: { FLOW_HEADLESS_DEPTH: "1" },
        writeOut: (line) => {
          out = line;
        },
        runClaude: async () => {
          spawned = true;
          return { exitCode: 0, stderr: "", timedOut: false };
        },
      }),
    );
    expect(code).toBe(2);
    expect(JSON.parse(out).skipReason).toBe("headless-depth-exceeded");
    expect(spawned).toBe(false);
  });

  it("returns claude-not-found when claudeOnPath is false", async () => {
    let out = "";
    const code = await run(
      ["--prompt", "hi", "--model", "haiku", "--effort", "low"],
      baseDeps({
        claudeOnPath: () => false,
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out).skipReason).toBe("claude-not-found");
  });

  it("returns claude-not-logged-in on an is_error result mentioning not logged in", async () => {
    let out = "";
    const code = await run(
      ["--prompt", "hi", "--model", "haiku", "--effort", "low"],
      baseDeps({
        fileExists: () => true,
        readFile: () =>
          JSON.stringify({ is_error: true, result: "Not logged in" }),
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out).skipReason).toBe("claude-not-logged-in");
  });

  it("returns claude-timeout when runClaude reports timedOut", async () => {
    let out = "";
    const code = await run(
      ["--prompt", "hi", "--model", "haiku", "--effort", "low"],
      baseDeps({
        runClaude: async () => ({
          exitCode: 1,
          stderr: "killed",
          timedOut: true,
        }),
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out).skipReason).toBe("claude-timeout");
  });

  it("returns incomplete-result on is_error true without a login message", async () => {
    let out = "";
    const code = await run(
      ["--prompt", "hi", "--model", "haiku", "--effort", "low"],
      baseDeps({
        fileExists: () => true,
        readFile: () =>
          JSON.stringify({ is_error: true, result: "budget exceeded" }),
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out).skipReason).toBe("incomplete-result");
  });

  it("returns incomplete-result when the result file is missing required fields", async () => {
    let out = "";
    const code = await run(
      ["--prompt", "hi", "--model", "haiku", "--effort", "low"],
      baseDeps({
        fileExists: () => true,
        readFile: () => JSON.stringify({ is_error: false }),
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out).skipReason).toBe("incomplete-result");
  });

  it("lifts the success envelope's fields", async () => {
    let out = "";
    const code = await run(
      ["--prompt", "hi", "--model", "haiku", "--effort", "low"],
      baseDeps({
        fileExists: () => true,
        readFile: () =>
          JSON.stringify({
            is_error: false,
            session_id: "sess-1",
            model: "claude-haiku",
            effort: "low",
            total_cost_usd: 0.0123,
            num_turns: 3,
            duration_ms: 4500,
            terminal_reason: "done",
            permission_denials: [],
          }),
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(out);
    expect(envelope.ran).toBe(true);
    expect(envelope.session_id).toBe("sess-1");
    expect(envelope.total_cost_usd).toBe(0.0123);
    expect(envelope.num_turns).toBe(3);
  });
});
