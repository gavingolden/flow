import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AGY_SAFETY_PREAMBLE,
  artifactPathFor,
  buildAgyArgv,
  looksTimedOut,
  looksUnauthenticated,
  parseArgs,
  run,
  stderrTail,
  withSafetyPreamble,
  type Args,
  type Deps,
} from "./flow-delegate";

describe("parseArgs", () => {
  it("requires exactly one prompt source (rejects neither)", () => {
    expect(parseArgs([])).toEqual({
      error: "exactly one of --prompt or --prompt-file is required",
    });
  });

  it("rejects both prompt sources at once", () => {
    expect(parseArgs(["--prompt", "x", "--prompt-file", "/p"])).toEqual({
      error: "exactly one of --prompt or --prompt-file is required",
    });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["--prompt", "x", "--bogus", "y"])).toEqual({
      error: "unknown flag: --bogus",
    });
  });

  it("rejects a value-flag with no value", () => {
    expect(parseArgs(["--prompt"])).toEqual({
      error: "--prompt requires a value",
    });
  });

  it("rejects a value-flag immediately followed by another flag", () => {
    // The second arm of the guard (`value.startsWith("--")`): without it,
    // `--model --prompt` would swallow `--prompt` as the model value.
    expect(parseArgs(["--model", "--prompt"])).toEqual({
      error: "--model requires a value",
    });
  });

  it("parses --prompt with defaults", () => {
    expect(parseArgs(["--prompt", "hello"])).toEqual({
      prompt: "hello",
      promptFile: undefined,
      model: undefined,
      timeout: "5m",
      skipPermissions: false,
      addDirs: [],
      out: undefined,
      task: "default",
    });
  });

  it("parses a full --prompt-file arg set", () => {
    expect(
      parseArgs([
        "--prompt-file",
        "/p.txt",
        "--model",
        "Gemini 3.1 Pro (High)",
        "--timeout",
        "10m",
        "--skip-permissions",
        "--add-dir",
        "/a",
        "--add-dir",
        "/b",
        "--out",
        "/tmp/r.md",
        "--task",
        "plan",
      ]),
    ).toEqual({
      prompt: undefined,
      promptFile: "/p.txt",
      model: "Gemini 3.1 Pro (High)",
      timeout: "10m",
      skipPermissions: true,
      addDirs: ["/a", "/b"],
      out: "/tmp/r.md",
      task: "plan",
    });
  });

  it("treats --skip-permissions as a valueless boolean flag", () => {
    const args = parseArgs(["--skip-permissions", "--prompt", "x"]) as Args;
    expect(args.skipPermissions).toBe(true);
    expect(args.prompt).toBe("x");
  });

  it("parses --output-format, --json-schema, and --structured-fallback", () => {
    const args = parseArgs([
      "--prompt",
      "x",
      "--output-format",
      "json",
      "--json-schema",
      "/schema.json",
    ]) as Args;
    expect(args.outputFormat).toBe("json");
    expect(args.jsonSchema).toBe("/schema.json");
    expect(args.structuredFallback).toBeUndefined();

    const fallbackArgs = parseArgs([
      "--prompt",
      "x",
      "--structured-fallback",
      "/schema.json",
    ]) as Args;
    expect(fallbackArgs.structuredFallback).toBe("/schema.json");
    expect(fallbackArgs.jsonSchema).toBeUndefined();
  });

  it("rejects an --output-format value outside the text|json enum", () => {
    expect(parseArgs(["--prompt", "x", "--output-format", "yaml"])).toEqual({
      error: `--output-format must be "text" or "json"`,
    });
  });

  it("rejects --json-schema together with --structured-fallback", () => {
    expect(
      parseArgs([
        "--prompt",
        "x",
        "--json-schema",
        "/a.json",
        "--structured-fallback",
        "/b.json",
      ]),
    ).toEqual({
      error: "--json-schema and --structured-fallback are mutually exclusive",
    });
  });
});

describe("withSafetyPreamble", () => {
  it("joins the preamble and the caller prompt with exactly '\\n\\n---\\n\\n'", () => {
    expect(withSafetyPreamble("do research")).toBe(
      `${AGY_SAFETY_PREAMBLE}\n\n---\n\ndo research`,
    );
  });
});

describe("buildAgyArgv", () => {
  const argsFor = (extra: string[] = []) =>
    parseArgs(["--prompt", "do research", ...extra]) as Args;

  it("puts the prompt as the FINAL argv token, after -p, prefixed with the safety preamble", () => {
    const argv = buildAgyArgv(
      argsFor(["--model", "Gemini 3.1 Pro (High)"]),
      "do research",
    );
    expect((argv[argv.length - 1] as string).endsWith("do research")).toBe(
      true,
    );
    expect(
      (argv[argv.length - 1] as string).startsWith(AGY_SAFETY_PREAMBLE),
    ).toBe(true);
    expect(argv[argv.length - 2]).toBe("-p");
  });

  it("always includes --sandbox and --print-timeout <timeout>", () => {
    const argv = buildAgyArgv(argsFor(["--timeout", "10m"]), "do research");
    expect(argv).toContain("--sandbox");
    const ti = argv.indexOf("--print-timeout");
    expect(ti).toBeGreaterThanOrEqual(0);
    expect(argv[ti + 1]).toBe("10m");
  });

  it("omits --model when not requested and includes it when given", () => {
    expect(buildAgyArgv(argsFor(), "do research")).not.toContain("--model");
    const argv = buildAgyArgv(
      argsFor(["--model", "Gemini 3.1 Pro (High)"]),
      "do research",
    );
    expect(argv[argv.indexOf("--model") + 1]).toBe("Gemini 3.1 Pro (High)");
  });

  it("omits --dangerously-skip-permissions by default, includes it with --skip-permissions", () => {
    expect(buildAgyArgv(argsFor(), "do research")).not.toContain(
      "--dangerously-skip-permissions",
    );
    expect(
      buildAgyArgv(argsFor(["--skip-permissions"]), "do research"),
    ).toContain("--dangerously-skip-permissions");
  });

  it("forwards each --add-dir", () => {
    const argv = buildAgyArgv(
      argsFor(["--add-dir", "/a", "--add-dir", "/b"]),
      "do research",
    );
    const count = argv.filter((t) => t === "--add-dir").length;
    expect(count).toBe(2);
    expect(argv).toContain("/a");
    expect(argv).toContain("/b");
  });

  it("the agy flags are byte-identical to today's when no new flags are passed, and the prompt is wrapped", () => {
    const argv = buildAgyArgv(
      argsFor(["--model", "Gemini 3.1 Pro (High)", "--timeout", "10m"]),
      "do research",
    );
    // Every flag ahead of the trailing -p is unchanged — no stray flag
    // crept in — while the prompt itself now carries the safety preamble.
    expect(argv.slice(0, -1)).toEqual([
      "--sandbox",
      "--print-timeout",
      "10m",
      "--model",
      "Gemini 3.1 Pro (High)",
      "-p",
    ]);
    expect((argv[argv.length - 1] as string).endsWith("do research")).toBe(
      true,
    );
    expect(
      (argv[argv.length - 1] as string).startsWith(AGY_SAFETY_PREAMBLE),
    ).toBe(true);
  });

  it("appends --output-format before the trailing -p", () => {
    const argv = buildAgyArgv(
      argsFor(["--output-format", "json"]),
      "do research",
    );
    const ofIndex = argv.indexOf("--output-format");
    expect(ofIndex).toBeGreaterThanOrEqual(0);
    expect(argv[ofIndex + 1]).toBe("json");
    expect(argv[argv.length - 2]).toBe("-p");
    expect((argv[argv.length - 1] as string).endsWith("do research")).toBe(
      true,
    );
  });

  it("appends --json-schema before the trailing -p", () => {
    const argv = buildAgyArgv(
      argsFor(["--json-schema", "/schema.json"]),
      "do research",
    );
    const jsIndex = argv.indexOf("--json-schema");
    expect(jsIndex).toBeGreaterThanOrEqual(0);
    expect(argv[jsIndex + 1]).toBe("/schema.json");
    expect(argv[argv.length - 2]).toBe("-p");
    expect((argv[argv.length - 1] as string).endsWith("do research")).toBe(
      true,
    );
  });

  it("--structured-fallback contributes no agy flag", () => {
    const argv = buildAgyArgv(
      argsFor(["--structured-fallback", "/schema.json"]),
      "do research",
    );
    expect(argv).not.toContain("--structured-fallback");
    expect(argv).not.toContain("/schema.json");
  });
});

describe("artifactPathFor", () => {
  it("defaults to .flow-tmp/delegate-<task>.md", () => {
    expect(artifactPathFor(parseArgs(["--prompt", "x"]) as Args)).toBe(
      ".flow-tmp/delegate-default.md",
    );
    expect(
      artifactPathFor(parseArgs(["--prompt", "x", "--task", "plan"]) as Args),
    ).toBe(".flow-tmp/delegate-plan.md");
  });

  it("honors an explicit --out", () => {
    expect(
      artifactPathFor(
        parseArgs(["--prompt", "x", "--out", "/tmp/r.md"]) as Args,
      ),
    ).toBe("/tmp/r.md");
  });
});

describe("looksUnauthenticated", () => {
  it.each([
    "Error: not authenticated",
    "Please log in to continue",
    "unauthenticated request",
    "authentication required",
    "Error: not logged in",
    "please sign in to Google",
    "authentication failed",
    "session expired, please reauthenticate",
  ])("flags auth-error text: %s", (text) => {
    expect(looksUnauthenticated(text)).toBe(true);
  });

  it("does not flag a generic runtime error", () => {
    expect(looksUnauthenticated("model run timed out after 5m")).toBe(false);
  });
});

describe("looksTimedOut", () => {
  it("flags agy's verified --print-timeout stderr signature", () => {
    expect(looksTimedOut("Error: timeout waiting for response")).toBe(true);
  });

  it("flags related timeout phrasing", () => {
    expect(looksTimedOut("deadline exceeded")).toBe(true);
    expect(looksTimedOut("context deadline exceeded")).toBe(true);
  });

  it("does not flag an auth-flavored error", () => {
    expect(looksTimedOut("Please log in to continue")).toBe(false);
  });

  it("does not flag a generic error", () => {
    expect(looksTimedOut("something went wrong")).toBe(false);
  });
});

describe("stderrTail", () => {
  it("returns '' for empty or whitespace-only input", () => {
    expect(stderrTail("")).toBe("");
    expect(stderrTail("   \n\t  ")).toBe("");
  });

  it("returns short text unchanged", () => {
    expect(stderrTail("boom")).toBe("boom");
  });

  it("caps at the default 2000 bytes, tail-most", () => {
    // Spaces every few chars keep this below the 32-char opaque-run
    // redaction threshold, so the cap is exercised in isolation.
    const long = Array.from({ length: 700 }, (_, i) => `w${i}`).join(" ");
    const withMarker = `${long} END`;
    const tail = stderrTail(withMarker);
    expect(tail.length).toBe(2000);
    expect(tail.endsWith("END")).toBe(true);
  });

  it("honors an explicit cap override", () => {
    const long = "w1 w2 w3 w4 w5 w6 END";
    expect(stderrTail(long, 10)).toBe(long.slice(long.length - 10));
  });

  it("redacts before capping", () => {
    expect(stderrTail("token: sk-abcdefghijklmnopqrstuvwxyz012345")).toContain(
      "[REDACTED]",
    );
  });
});

function makeDeps(overrides: Partial<Deps> = {}): Deps & {
  calls: {
    agy: Array<{ argv: string[]; outPath: string }>;
    out: string[];
    mkdirp: string[];
  };
} {
  const calls = {
    agy: [] as Array<{ argv: string[]; outPath: string }>,
    out: [] as string[],
    mkdirp: [] as string[],
  };
  return {
    agyOnPath: () => true,
    runAgy: (argv, outPath) => {
      calls.agy.push({ argv, outPath });
      return { exitCode: 0, stderr: "" };
    },
    readFile: (p) => `FILE_CONTENT_OF:${p}`,
    fileExists: () => true,
    mkdirp: (d) => {
      calls.mkdirp.push(d);
    },
    now: () => 0,
    writeOut: (line) => {
      calls.out.push(line);
    },
    calls,
    ...overrides,
  };
}

const envelope = (deps: { calls: { out: string[] } }) =>
  JSON.parse(deps.calls.out[0] as string);

describe("run", () => {
  it("returns 2 (usage error) when no prompt source is given", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(run([], makeDeps())).toBe(2);
    errSpy.mockRestore();
  });

  it("returns 2 when --prompt-file does not exist", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      run(
        ["--prompt-file", "/nope.txt"],
        makeDeps({ fileExists: () => false }),
      ),
    ).toBe(2);
    errSpy.mockRestore();
  });

  it("gracefully skips (exit 0) without spawning when agy is not on PATH", () => {
    const deps = makeDeps({ agyOnPath: () => false });
    expect(run(["--prompt", "hi"], deps)).toBe(0);
    expect(envelope(deps)).toMatchObject({
      ran: false,
      skipReason: "agy-not-found",
    });
    expect(deps.calls.agy).toHaveLength(0);
  });

  it("gracefully skips with skipReason agy-error on a nonzero agy exit", () => {
    const deps = makeDeps({ runAgy: () => ({ exitCode: 1, stderr: "boom" }) });
    expect(run(["--prompt", "hi"], deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "agy-error",
      task: "default",
      exitCode: 1,
      stderrTail: "boom",
    });
  });

  it("maps a --print-timeout kill's stderr signature to agy-timeout, not agy-error", () => {
    const deps = makeDeps({
      runAgy: () => ({
        exitCode: 1,
        stderr: "Error: timeout waiting for response",
      }),
    });
    expect(run(["--prompt", "hi"], deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "agy-timeout",
      task: "default",
      exitCode: 1,
      stderrTail: "Error: timeout waiting for response",
    });
  });

  it("omits stderrTail entirely when agy's stderr is empty", () => {
    const deps = makeDeps({ runAgy: () => ({ exitCode: 1, stderr: "" }) });
    run(["--prompt", "hi"], deps);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "agy-error",
      task: "default",
      exitCode: 1,
    });
  });

  it("caps stderrTail at 2000 bytes, keeping the tail-most (not head-most) slice", () => {
    // Spaces every few chars keep this below the 32-char opaque-run
    // redaction threshold, so the cap is exercised in isolation.
    const head = Array.from({ length: 700 }, (_, i) => `A${i}`).join(" ");
    const long = `${head} TAIL-MARKER`;
    const deps = makeDeps({ runAgy: () => ({ exitCode: 1, stderr: long }) });
    run(["--prompt", "hi"], deps);
    const env = envelope(deps);
    expect(env.stderrTail.length).toBe(2000);
    expect(env.stderrTail.endsWith("TAIL-MARKER")).toBe(true);
    expect(env.stderrTail.startsWith("A0")).toBe(false);
  });

  it("redacts token-shaped substrings in stderrTail", () => {
    const deps = makeDeps({
      runAgy: () => ({
        exitCode: 1,
        stderr: "auth failed: api_key=sk-abcdefghijklmnopqrstuvwxyz012345",
      }),
    });
    run(["--prompt", "hi"], deps);
    expect(envelope(deps).stderrTail).not.toContain(
      "sk-abcdefghijklmnopqrstuvwxyz012345",
    );
    expect(envelope(deps).stderrTail).toContain("[REDACTED]");
  });

  it("keeps stdout a single JSON.parse-able line even when stderr carries newlines", () => {
    const deps = makeDeps({
      runAgy: () => ({ exitCode: 1, stderr: "line one\nline two\nboom" }),
    });
    run(["--prompt", "hi"], deps);
    expect(deps.calls.out).toHaveLength(1);
    expect(() => JSON.parse(deps.calls.out[0] as string)).not.toThrow();
  });

  it("returns 2 (usage error) when reading --prompt-file throws (EACCES/EISDIR)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps({
      readFile: () => {
        throw new Error("EISDIR: illegal operation on a directory");
      },
    });
    expect(run(["--prompt-file", "/some/dir"], deps)).toBe(2);
    expect(deps.calls.agy).toHaveLength(0);
    errSpy.mockRestore();
  });

  it("returns 2 (usage error) when mkdirp on the output dir throws", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps({
      mkdirp: () => {
        throw new Error("EACCES: permission denied, mkdir");
      },
    });
    expect(run(["--prompt", "hi", "--out", "/nope/out.md"], deps)).toBe(2);
    expect(deps.calls.agy).toHaveLength(0);
    errSpy.mockRestore();
  });

  it("gracefully skips (exit 0, agy-error) when runAgy throws a spawn failure", () => {
    const deps = makeDeps({
      runAgy: () => {
        throw new Error("spawn agy ENOMEM");
      },
    });
    expect(run(["--prompt", "hi"], deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "agy-error",
      task: "default",
      stderrTail: "spawn agy ENOMEM",
    });
  });

  it("maps an auth-flavored agy failure to agy-not-authenticated", () => {
    const deps = makeDeps({
      runAgy: () => ({ exitCode: 1, stderr: "Please log in" }),
    });
    run(["--prompt", "hi"], deps);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "agy-not-authenticated",
      task: "default",
      exitCode: 1,
      stderrTail: "Please log in",
    });
  });

  it("runs agy with the prompt LAST and reports ran:true on success", () => {
    const deps = makeDeps();
    expect(
      run(
        ["--prompt", "do research", "--model", "Gemini 3.1 Pro (High)"],
        deps,
      ),
    ).toBe(0);
    expect(envelope(deps)).toMatchObject({
      ran: true,
      exitCode: 0,
      model: "Gemini 3.1 Pro (High)",
      artifactPath: ".flow-tmp/delegate-default.md",
    });
    expect(deps.calls.agy).toHaveLength(1);
    const argv = deps.calls.agy[0]!.argv;
    expect((argv[argv.length - 1] as string).endsWith("do research")).toBe(
      true,
    );
    expect(deps.calls.mkdirp).toEqual([".flow-tmp"]);
  });

  it("reports model:null in the envelope when --model is omitted", () => {
    const deps = makeDeps();
    run(["--prompt", "hi"], deps);
    expect(envelope(deps).model).toBeNull();
  });

  it("reads --prompt-file and passes its content as the prompt", () => {
    const deps = makeDeps();
    run(["--prompt-file", "/p.txt"], deps);
    const argv = deps.calls.agy[0]!.argv;
    expect(
      (argv[argv.length - 1] as string).endsWith("FILE_CONTENT_OF:/p.txt"),
    ).toBe(true);
  });

  it("honors --out for both the envelope artifactPath and the agy redirect target", () => {
    const deps = makeDeps();
    run(["--prompt", "hi", "--out", "/tmp/out.md"], deps);
    expect(envelope(deps).artifactPath).toBe("/tmp/out.md");
    expect(deps.calls.agy[0]!.outPath).toBe("/tmp/out.md");
  });
});

describe("run — --output-format json envelope lift", () => {
  it("lifts durationSeconds and usage from the agy JSON artifact", () => {
    const deps = makeDeps({
      readFile: () =>
        JSON.stringify({
          duration_seconds: 12.5,
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
    });
    run(["--prompt", "hi", "--output-format", "json"], deps);
    expect(envelope(deps)).toMatchObject({
      ran: true,
      durationSeconds: 12.5,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  });

  it("leaves durationSeconds/usage absent and still reports ran:true on an unparseable artifact", () => {
    const deps = makeDeps({
      readFile: () => "not json at all",
    });
    const code = run(["--prompt", "hi", "--output-format", "json"], deps);
    expect(code).toBe(0);
    const env = envelope(deps);
    expect(env.ran).toBe(true);
    expect(env.durationSeconds).toBeUndefined();
    expect(env.usage).toBeUndefined();
  });

  it("does not attempt an envelope lift when --output-format is omitted", () => {
    const deps = makeDeps();
    run(["--prompt", "hi"], deps);
    const env = envelope(deps);
    expect(env.durationSeconds).toBeUndefined();
    expect(env.usage).toBeUndefined();
  });
});

describe("run — --structured-fallback parse-validate-retry-once", () => {
  const SCHEMA_PATH = "/schema.json";
  const schemaText = JSON.stringify({
    required: ["ok"],
    properties: { ok: { type: "boolean" } },
  });

  it("reports structuredParse:'ok' with parseRetries:1 when the retry succeeds", () => {
    let artifactReads = 0;
    const deps = makeDeps({
      readFile: (p) => {
        if (p === SCHEMA_PATH) return schemaText;
        artifactReads++;
        return artifactReads === 1 ? "not json at all" : '{"ok":true}';
      },
    });
    const code = run(
      ["--prompt", "hi", "--structured-fallback", SCHEMA_PATH],
      deps,
    );
    expect(code).toBe(0);
    expect(envelope(deps)).toMatchObject({
      ran: true,
      structuredParse: "ok",
      parseRetries: 1,
    });
    // Initial call + exactly one retry.
    expect(deps.calls.agy).toHaveLength(2);
  });

  it("reports ran:true structuredParse:'failed' with parseRetries:1 when both parses fail", () => {
    const deps = makeDeps({
      readFile: (p) => (p === SCHEMA_PATH ? schemaText : "still not json"),
    });
    const code = run(
      ["--prompt", "hi", "--structured-fallback", SCHEMA_PATH],
      deps,
    );
    expect(code).toBe(0);
    expect(envelope(deps)).toMatchObject({
      ran: true,
      structuredParse: "failed",
      parseRetries: 1,
    });
    expect(deps.calls.agy).toHaveLength(2);
  });

  it("reports structuredParse:'ok' with parseRetries:0 when the first parse succeeds", () => {
    const deps = makeDeps({
      readFile: (p) => (p === SCHEMA_PATH ? schemaText : '{"ok":true}'),
    });
    run(["--prompt", "hi", "--structured-fallback", SCHEMA_PATH], deps);
    expect(envelope(deps)).toMatchObject({
      ran: true,
      structuredParse: "ok",
      parseRetries: 0,
    });
    expect(deps.calls.agy).toHaveLength(1);
  });

  it("inlines the schema into the prompt sent to agy, never as a --json-schema flag", () => {
    const deps = makeDeps({
      readFile: (p) => (p === SCHEMA_PATH ? schemaText : '{"ok":true}'),
    });
    run(["--prompt", "hi", "--structured-fallback", SCHEMA_PATH], deps);
    const argv = deps.calls.agy[0]!.argv;
    expect(argv).not.toContain("--json-schema");
    expect(argv[argv.length - 1]).toContain(schemaText.trim());
  });

  // Regression for the envelope-as-output bug: with --output-format json,
  // outPath holds the agy JSON envelope (`.response` / `.structured_output`),
  // not model prose. Before the fix, feeding the raw envelope to
  // parseStructured always failed validation, forcing a retry on every call.
  it("unwraps the agy envelope from the raw artifact in --output-format json mode", () => {
    const deps = makeDeps({
      readFile: (p) =>
        p === SCHEMA_PATH
          ? schemaText
          : JSON.stringify({ response: '{"ok":true}' }),
    });
    const code = run(
      [
        "--prompt",
        "hi",
        "--output-format",
        "json",
        "--structured-fallback",
        SCHEMA_PATH,
      ],
      deps,
    );
    expect(code).toBe(0);
    expect(envelope(deps)).toMatchObject({
      ran: true,
      structuredParse: "ok",
      parseRetries: 0,
    });
    expect(deps.calls.agy).toHaveLength(1);
  });

  it("prefers the envelope's structured_output over .response in json mode", () => {
    const deps = makeDeps({
      readFile: (p) =>
        p === SCHEMA_PATH
          ? schemaText
          : JSON.stringify({
              response: "not the structured payload",
              structured_output: { ok: true },
            }),
    });
    run(
      [
        "--prompt",
        "hi",
        "--output-format",
        "json",
        "--structured-fallback",
        SCHEMA_PATH,
      ],
      deps,
    );
    expect(envelope(deps)).toMatchObject({
      structuredParse: "ok",
      parseRetries: 0,
    });
  });
});

// Real-subprocess spec for the graceful-skip-on-absent-agy path. Unlike the
// unit test above (which stubs `agyOnPath: () => false`), this spawns the built
// helper as an actual process so it exercises the un-injected `defaultAgyOnPath`
// (`which agy`) — the one seam the dependency injection never covers. Replaces
// the former manual Test Step #3.
describe("flow-delegate (subprocess, agy absent from PATH)", () => {
  const HELPER = path.resolve(__dirname, "flow-delegate.ts");
  // A PATH that contains `which`/`bun` (resolve bun absolutely below) but not
  // the dir holding `agy` on a dev machine (~/.local/bin), so `which agy`
  // misses and the helper takes the agy-not-found skip.
  const SKIP_PATH = "/usr/local/bin:/usr/bin:/bin";

  // Resolve bun absolutely from the inherited PATH; vitest itself runs on node.
  const bunPath =
    spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim() || "bun";

  // Guard against the (unlikely) case where this machine has `agy` inside one
  // of SKIP_PATH's dirs — then the assertion below would be unsound, so skip.
  const agyInSkipPath =
    spawnSync("sh", ["-c", "which agy"], {
      encoding: "utf8",
      env: { PATH: SKIP_PATH },
    }).status === 0;

  it.skipIf(agyInSkipPath)(
    "exits 0 with {ran:false,skipReason:'agy-not-found'} when agy is off PATH",
    () => {
      const r = spawnSync(bunPath, ["run", HELPER, "--prompt", "x"], {
        encoding: "utf8",
        env: { PATH: SKIP_PATH },
      });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({
        ran: false,
        skipReason: "agy-not-found",
      });
    },
  );
});

// Committed single-chokepoint invariant: the safety preamble in
// buildAgyArgv is only load-bearing if there is exactly one prompt-bearing
// `agy` spawn site in bin/ to prefix. Modeled on the same
// readdirSync -> filter -> readFileSync -> content-predicate mechanism as
// bin/flow-pre-commit.test.ts's "guard: shipped bin/lib executable modules
// are tracked 100755" — deliberately NOT a `grep -r` shell-out. grep
// behaviour on NUL-bearing files (bin/flow-plan-review.ts and
// bin/flow-candidate-issues.test.ts both contain a deliberate raw NUL byte,
// see bin/flow-plan-review.ts's computeDecisionHash) is
// environment-dependent: a skip-binary grep (e.g. `ugrep`, or any grep
// invoked with `-I`) drops matches in those files silently, while BSD
// `grep -l` (verified: /usr/bin/grep, BSD grep 2.6.0-FreeBSD) DOES report
// them — binary classification there only suppresses the printed matching
// line, not the file-level match — and GNU grep can differ again. An
// invariant guard committed to CI must not depend on which grep happens to
// be on PATH. readFileSync(path, "utf8") decodes both files correctly (the
// NUL is valid UTF-8) regardless of environment.
describe("guard: exactly one prompt-bearing agy spawn site in bin/", () => {
  const binDir = __dirname;
  // bin/, bin/lib/, and bin/flow-pr-static-analysis/ are scanned — the real
  // shipped source dirs under bin/. bin/fixtures/ is deliberately EXCLUDED:
  // bin/fixtures/model-bench/*/src/ holds deliberately-fake .ts fixture
  // source that must never count toward this invariant.
  // .test.ts files are EXCLUDED from the scan — this file itself contains
  // the matched literal inside a string below, which would otherwise make
  // the count 2 and this guard permanently red.
  const scanDirs = [
    binDir,
    path.join(binDir, "lib"),
    path.join(binDir, "flow-pr-static-analysis"),
  ];
  const sourceFiles = scanDirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => path.relative(binDir, path.join(dir, name))),
  );
  // A regex, not an exact-string literal: it must match both the sync
  // `Bun.spawnSync(` and the async `Bun.spawn(` forms (bin/flow-delegate-fanout.ts:465
  // already uses the async form in this same delegation subsystem, so the
  // async spelling is not hypothetical), any spread identifier
  // (`...argv`, `...agyArgv`, ...), and tolerate prettier-style
  // whitespace/newline reflow inside the call — while still EXCLUDING
  // flow-model-bench.ts's promptless `Bun.spawnSync(["agy", "--version"]`
  // version probe (a string literal, not a spread, in second position) and
  // flow-delegate.ts's own `Bun.spawnSync(["which", "agy"]` PATH check
  // (first arg is "which", not "agy").
  const AGY_SPAWN_PATTERN =
    /Bun\.spawn(?:Sync)?\(\s*\[\s*"agy"\s*,\s*\.\.\.\w+/;
  const promptBearingAgySpawnSites = sourceFiles.filter((name) =>
    AGY_SPAWN_PATTERN.test(readFileSync(path.join(binDir, name), "utf8")),
  );

  it("discovers a plausible non-zero number of bin/ source files to scan", () => {
    // Sanity check that the scan actually found files; a regex/path bug
    // that silently matched nothing would make the guard below vacuous.
    // Asserted per-directory, not just on the total. bin/flow-pr-static-analysis/
    // legitimately has only 4 source files (cli.ts, lenses.ts, parsers.ts,
    // types.ts), so it gets its own low-but-nonzero threshold rather than
    // the blanket >20 the other two dirs can clear — a blanket >20 would be
    // wrong for it, but asserting nothing at all would let a scan that
    // silently matches zero files there go unnoticed.
    expect(
      sourceFiles.filter((f) => !f.includes(path.sep)).length,
    ).toBeGreaterThan(20);
    expect(
      sourceFiles.filter((f) => f.startsWith(`lib${path.sep}`)).length,
    ).toBeGreaterThan(20);
    expect(
      sourceFiles.filter((f) =>
        f.startsWith(`flow-pr-static-analysis${path.sep}`),
      ).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("matches the prompt-bearing agy spawn pattern exactly once, in flow-delegate.ts", () => {
    expect(promptBearingAgySpawnSites).toEqual(["flow-delegate.ts"]);
  });
});
