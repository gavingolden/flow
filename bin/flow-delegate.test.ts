import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  artifactPathFor,
  buildAgyArgv,
  looksUnauthenticated,
  parseArgs,
  run,
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
});

describe("buildAgyArgv", () => {
  const argsFor = (extra: string[] = []) =>
    parseArgs(["--prompt", "do research", ...extra]) as Args;

  it("puts the prompt as the FINAL argv token, after -p", () => {
    const argv = buildAgyArgv(
      argsFor(["--model", "Gemini 3.1 Pro (High)"]),
      "do research",
    );
    expect(argv[argv.length - 1]).toBe("do research");
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
    expect(envelope(deps)).toMatchObject({
      ran: false,
      skipReason: "agy-error",
      exitCode: 1,
    });
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
    expect(envelope(deps)).toMatchObject({
      ran: false,
      skipReason: "agy-error",
    });
  });

  it("maps an auth-flavored agy failure to agy-not-authenticated", () => {
    const deps = makeDeps({
      runAgy: () => ({ exitCode: 1, stderr: "Please log in" }),
    });
    run(["--prompt", "hi"], deps);
    expect(envelope(deps)).toMatchObject({
      ran: false,
      skipReason: "agy-not-authenticated",
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
    expect(argv[argv.length - 1]).toBe("do research");
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
    expect(argv[argv.length - 1]).toBe("FILE_CONTENT_OF:/p.txt");
  });

  it("honors --out for both the envelope artifactPath and the agy redirect target", () => {
    const deps = makeDeps();
    run(["--prompt", "hi", "--out", "/tmp/out.md"], deps);
    expect(envelope(deps).artifactPath).toBe("/tmp/out.md");
    expect(deps.calls.agy[0]!.outPath).toBe("/tmp/out.md");
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
