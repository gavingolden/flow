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

  it("CHILD_ENV_ALLOW carries the auth/network passthrough", () => {
    for (const key of [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
      "SSL_CERT_FILE",
      "NODE_EXTRA_CA_CERTS",
    ]) {
      expect(CHILD_ENV_ALLOW).toContain(key);
    }
    const base: NodeJS.ProcessEnv = { HTTPS_PROXY: "http://proxy:8080" };
    const env = buildChildEnv(base, []);
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
  });

  // Derived from the ENV_NEVER constant itself (not a hardcoded list) so
  // this test stays true for any future addition to ENV_NEVER without
  // being edited by hand — the failure mode a hand-typed list invites.
  it("strips every current ENV_NEVER entry, derived from the constant", () => {
    const base: NodeJS.ProcessEnv = Object.fromEntries(
      ENV_NEVER.map((k) => [k, "leaked"]),
    );
    const env = buildChildEnv(base, [...ENV_NEVER]);
    for (const k of ENV_NEVER) {
      expect(env[k]).toBeUndefined();
    }
  });

  it("ENV_NEVER names all 7 documented entries", () => {
    expect([...ENV_NEVER].sort()).toEqual(
      [
        "FLOW_SLUG",
        "TMUX_PANE",
        "FLOW_NOTIFY",
        "CLAUDECODE",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_EFFORT",
        "CLAUDE_CODE_EFFORT_LEVEL",
      ].sort(),
    );
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

  it("rejects a trailing flag with no value", () => {
    expect(
      parseArgs([
        "--prompt",
        "hi",
        "--model",
        "haiku",
        "--effort",
        "low",
        "--max-turns",
      ]),
    ).toEqual({ error: "missing value for --max-turns" });
  });

  it("--bare as the last token needs no value and does not error", () => {
    const parsed = parseArgs([
      "--prompt",
      "hi",
      "--model",
      "haiku",
      "--effort",
      "low",
      "--bare",
    ]);
    expect("error" in parsed).toBe(false);
    expect((parsed as Args).bare).toBe(true);
  });

  it("rejects a non-numeric --max-budget-usd", () => {
    expect(
      parseArgs([
        "--prompt",
        "hi",
        "--model",
        "haiku",
        "--effort",
        "low",
        "--max-budget-usd",
        "not-a-number",
      ]),
    ).toEqual({
      error: "--max-budget-usd must be a number, got not-a-number",
    });
  });

  it("rejects a non-numeric --max-turns", () => {
    expect(
      parseArgs([
        "--prompt",
        "hi",
        "--model",
        "haiku",
        "--effort",
        "low",
        "--max-turns",
        "NaN",
      ]),
    ).toEqual({ error: "--max-turns must be a number, got NaN" });
  });

  it("rejects a non-numeric --timeout-sec", () => {
    expect(
      parseArgs([
        "--prompt",
        "hi",
        "--model",
        "haiku",
        "--effort",
        "low",
        "--timeout-sec",
        "soon",
      ]),
    ).toEqual({ error: "--timeout-sec must be a number, got soon" });
  });
});

describe("buildChildArgv", () => {
  it("builds the exact argv order with the preamble prefix, dontAsk, FIXED_DENY_LIST, and --setting-sources project", () => {
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
      `${FIXED_DENY_LIST},Bash`,
      "--setting-sources",
      "project",
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

  // The security-blocking finding: --allowedTools is a floor, not a
  // ceiling, since a dontAsk child still inherits the user's
  // ~/.claude/settings.json Bash(...) allow rules. When the caller's
  // --allowed-tools set names no Bash entry, --disallowedTools gets a
  // bare `Bash` deny appended — deny beats allow.
  it("appends a bare Bash deny when the caller's allowedTools has no Bash entry", () => {
    const a = parseArgs([
      "--prompt",
      "hi",
      "--model",
      "haiku",
      "--effort",
      "low",
      "--allowed-tools",
      "Read,Grep,Glob",
    ]) as Args;
    const argv = buildChildArgv(a, "hi");
    const idx = argv.indexOf("--disallowedTools");
    expect(argv[idx + 1]).toBe(`${FIXED_DENY_LIST},Bash`);
  });

  it("does not double-append Bash when the caller's allowedTools already names it", () => {
    const a = parseArgs([
      "--prompt",
      "hi",
      "--model",
      "haiku",
      "--effort",
      "low",
      "--allowed-tools",
      "Read,Bash(npm test:*)",
    ]) as Args;
    const argv = buildChildArgv(a, "hi");
    const idx = argv.indexOf("--disallowedTools");
    expect(argv[idx + 1]).toBe(FIXED_DENY_LIST);
  });

  it("always includes --setting-sources project", () => {
    const a = parseArgs([
      "--prompt",
      "hi",
      "--model",
      "haiku",
      "--effort",
      "low",
    ]) as Args;
    const argv = buildChildArgv(a, "hi");
    const idx = argv.indexOf("--setting-sources");
    expect(argv[idx + 1]).toBe("project");
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

  it("captures exactly what reaches runClaude: argv, env, outPath, timeoutSec", async () => {
    let captured:
      | {
          argv: string[];
          env: Record<string, string>;
          outPath: string;
          timeoutSec: number;
        }
      | undefined;
    await run(
      [
        "--prompt",
        "hi",
        "--model",
        "haiku",
        "--effort",
        "low",
        "--timeout-sec",
        "42",
        "--out",
        ".flow-tmp/captured.json",
      ],
      baseDeps({
        env: { PATH: "/usr/bin", FLOW_SLUG: "should-be-stripped" },
        fileExists: () => true,
        readFile: () =>
          JSON.stringify({
            is_error: false,
            session_id: "s",
            total_cost_usd: 0,
          }),
        runClaude: async (argv, env, outPath, timeoutSec) => {
          captured = { argv, env, outPath, timeoutSec };
          return { exitCode: 0, stderr: "", timedOut: false };
        },
      }),
    );
    expect(captured).toBeDefined();
    expect(captured?.argv[0]).toBe("claude");
    expect(captured?.env.FLOW_SLUG).toBeUndefined();
    expect(captured?.env.PATH).toBe("/usr/bin");
    expect(captured?.outPath).toBe(".flow-tmp/captured.json");
    expect(captured?.timeoutSec).toBe(42);
  });

  it("reads the prompt from --prompt-file through run()", async () => {
    let seenPrompt = "";
    await run(
      [
        "--prompt-file",
        "/tmp/brief.txt",
        "--model",
        "haiku",
        "--effort",
        "low",
      ],
      baseDeps({
        fileExists: () => true,
        readFile: (p) => {
          if (p === "/tmp/brief.txt") return "the actual prompt body";
          return JSON.stringify({
            is_error: false,
            session_id: "s",
            total_cost_usd: 0,
          });
        },
        runClaude: async (argv) => {
          seenPrompt = argv[2];
          return { exitCode: 0, stderr: "", timedOut: false };
        },
      }),
    );
    expect(seenPrompt).toBe(HEADLESS_PREAMBLE + "the actual prompt body");
  });

  it("returns claude-error, exit 0, with a redacted stderrTail when --prompt-file is missing", async () => {
    let out = "";
    const code = await run(
      [
        "--prompt-file",
        "/tmp/missing.txt",
        "--model",
        "haiku",
        "--effort",
        "low",
      ],
      baseDeps({
        fileExists: () => false,
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out).skipReason).toBe("claude-error");
  });

  it("returns claude-error, exit 0, when mkdirp throws instead of an unhandled rejection", async () => {
    let out = "";
    const code = await run(
      ["--prompt", "hi", "--model", "haiku", "--effort", "low"],
      baseDeps({
        mkdirp: () => {
          throw new Error("EACCES: permission denied");
        },
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(out);
    expect(envelope.skipReason).toBe("claude-error");
    expect(envelope.stderrTail).toBe("EACCES: permission denied");
  });

  it("returns claude-error, exit 0, when readFile throws synchronously (was an unhandled rejection)", async () => {
    let out = "";
    const code = await run(
      ["--prompt-file", "/tmp/p.txt", "--model", "haiku", "--effort", "low"],
      baseDeps({
        fileExists: () => true,
        readFile: () => {
          throw new Error("EIO: i/o error");
        },
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(out);
    expect(envelope.skipReason).toBe("claude-error");
  });

  it("omits stderrTail entirely when the underlying stderr is empty", async () => {
    let out = "";
    const code = await run(
      ["--prompt", "hi", "--model", "haiku", "--effort", "low"],
      baseDeps({
        runClaude: async () => ({ exitCode: 1, stderr: "", timedOut: false }),
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(out);
    expect(envelope.skipReason).toBe("claude-error");
    expect("stderrTail" in envelope).toBe(false);
  });

  it("redacts secrets in stderrTail", async () => {
    let out = "";
    const code = await run(
      ["--prompt", "hi", "--model", "haiku", "--effort", "low"],
      baseDeps({
        runClaude: async () => ({
          exitCode: 1,
          stderr: "Authorization: Bearer abc123XYZ",
          timedOut: false,
        }),
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(out);
    expect(envelope.stderrTail).not.toContain("abc123XYZ");
  });

  it("returns incomplete-result when the result JSON is unparsable", async () => {
    let out = "";
    const code = await run(
      ["--prompt", "hi", "--model", "haiku", "--effort", "low"],
      baseDeps({
        fileExists: () => true,
        readFile: () => "{not valid json",
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out).skipReason).toBe("incomplete-result");
  });

  it("returns incomplete-result when a nonzero exit code has no result file", async () => {
    let out = "";
    const code = await run(
      ["--prompt", "hi", "--model", "haiku", "--effort", "low"],
      baseDeps({
        runClaude: async () => ({
          exitCode: 1,
          stderr: "boom",
          timedOut: false,
        }),
        fileExists: () => false,
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out).skipReason).toBe("claude-error");
  });
});
