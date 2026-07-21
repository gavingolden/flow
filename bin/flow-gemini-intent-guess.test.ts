import { describe, expect, it, vi } from "vitest";
import {
  extractJsonObject,
  isGeminiIntentGuessEnabled,
  parseArgs,
  run,
  validateIntentGuess,
  type DelegateEnvelope,
  type Deps,
} from "./flow-gemini-intent-guess";

const VALID_GUESS = {
  guessed_purpose: "Adds a diff-only intent-guess check to catch scope drift.",
  key_changes: ["bin/flow-gemini-intent-guess.ts: new helper"],
  justification:
    "New file bin/flow-gemini-intent-guess.ts implements a blind guess.",
  confidence: 70,
};

describe("isGeminiIntentGuessEnabled (config gate)", () => {
  it.each([
    ["absent file (empty read)", "", false],
    ["malformed JSON", "{not json", false],
    ["missing review key", JSON.stringify({ other: 1 }), false],
    [
      "review present but gemini missing",
      JSON.stringify({ review: { foo: 1 } }),
      false,
    ],
    [
      "gemini as 'true' string",
      JSON.stringify({ review: { gemini: "true" } }),
      false,
    ],
    ["gemini false", JSON.stringify({ review: { gemini: false } }), false],
    ["review not an object", JSON.stringify({ review: true }), false],
    ["gemini true", JSON.stringify({ review: { gemini: true } }), true],
  ])("enables only on strict boolean true: %s", (_name, raw, expected) => {
    expect(isGeminiIntentGuessEnabled(raw as string)).toBe(expected);
  });

  it("never throws on garbage input", () => {
    expect(() => isGeminiIntentGuessEnabled("\x00\x01")).not.toThrow();
    expect(isGeminiIntentGuessEnabled("[]")).toBe(false);
  });
});

describe("extractJsonObject", () => {
  it("returns the object verbatim when there is no wrapper", () => {
    expect(extractJsonObject('{"guessed_purpose":"x"}')).toBe(
      '{"guessed_purpose":"x"}',
    );
  });

  it("recovers an object wrapped in leading/trailing prose", () => {
    const wrapped = 'Here is my guess:\n{"guessed_purpose":"x"}\nDone.';
    expect(extractJsonObject(wrapped)).toBe('{"guessed_purpose":"x"}');
  });

  it("recovers an object inside a ```json fence", () => {
    const fenced = '```json\n{"guessed_purpose":"x"}\n```';
    expect(extractJsonObject(fenced)).toBe('{"guessed_purpose":"x"}');
  });

  it("returns null when there is no brace pair", () => {
    expect(extractJsonObject("no json here at all")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
  });
});

describe("validateIntentGuess", () => {
  it("accepts a well-shaped guess", () => {
    expect(validateIntentGuess(VALID_GUESS)).toEqual({
      ok: true,
      value: VALID_GUESS,
    });
  });

  it.each([
    ["not an object", "a string"],
    ["missing guessed_purpose", { ...omit(VALID_GUESS, "guessed_purpose") }],
    ["key_changes not an array", { ...VALID_GUESS, key_changes: "x" }],
    [
      "key_changes with a non-string element",
      { ...VALID_GUESS, key_changes: [1] },
    ],
    ["missing justification", { ...omit(VALID_GUESS, "justification") }],
    ["confidence not a number", { ...VALID_GUESS, confidence: "70" }],
  ])("rejects %s", (_name, bad) => {
    expect(validateIntentGuess(bad).ok).toBe(false);
  });
});

function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const clone = { ...obj };
  delete clone[key];
  return clone;
}

describe("parseArgs", () => {
  it("requires --worktree, --diff-file, --out", () => {
    expect(parseArgs([])).toEqual({ error: "--worktree is required" });
    expect(parseArgs(["--worktree", "/wt", "--diff-file", "/d.txt"])).toEqual({
      error: "--out is required",
    });
  });

  it("rejects a value-flag with no value", () => {
    expect(parseArgs(["--worktree"])).toEqual({
      error: "--worktree requires a value",
    });
  });

  it("parses a full arg set with defaults", () => {
    const args = parseArgs([
      "--worktree",
      "/wt",
      "--diff-file",
      "/d.txt",
      "--out",
      "/wt/.flow-tmp/intent-guess-gemini.json",
    ]);
    expect(args).toMatchObject({
      worktree: "/wt",
      diffFile: "/d.txt",
      out: "/wt/.flow-tmp/intent-guess-gemini.json",
      task: "gemini-intent-guess",
    });
  });
});

const ENABLED = JSON.stringify({ review: { gemini: true } });

function makeDeps(overrides: Partial<Deps> = {}): Deps & {
  calls: {
    delegate: string[][];
    writes: Array<{ path: string; contents: string }>;
    removed: string[];
    out: string[];
  };
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  const calls = {
    delegate: [] as string[][],
    writes: [] as Array<{ path: string; contents: string }>,
    removed: [] as string[],
    out: [] as string[],
  };
  const base: Deps = {
    readConfig: () => ENABLED,
    runDelegate: (argv) => {
      calls.delegate.push(argv);
      const rawPathIdx = argv.indexOf("--out") + 1;
      const rawPath = argv[rawPathIdx]!;
      files.set(rawPath, JSON.stringify(VALID_GUESS));
      return { ran: true, artifactPath: rawPath } as DelegateEnvelope;
    },
    readFile: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p)!;
    },
    writeFile: (p, c) => {
      calls.writes.push({ path: p, contents: c });
      files.set(p, c);
    },
    removeFile: (p) => {
      calls.removed.push(p);
      files.delete(p);
    },
    mkdirp: () => {},
    writeOut: (line) => calls.out.push(line),
  };
  files.set(
    "/d.txt",
    "diff --git a/src/foo.ts b/src/foo.ts\n+++ b/src/foo.ts\n",
  );
  return Object.assign(base, overrides, { calls, files });
}

const BASE_ARGV = [
  "--worktree",
  "/wt",
  "--diff-file",
  "/d.txt",
  "--out",
  "/wt/.flow-tmp/intent-guess-gemini.json",
];
const OUT = "/wt/.flow-tmp/intent-guess-gemini.json";

const envelope = (deps: { calls: { out: string[] } }) =>
  JSON.parse(deps.calls.out[0] as string);

describe("run — gate", () => {
  it("skips with gemini-intent-guess-disabled when the config gate is off", () => {
    const deps = makeDeps({ readConfig: () => JSON.stringify({}) });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "gemini-intent-guess-disabled",
    });
    expect(deps.calls.delegate).toHaveLength(0);
    expect(deps.files.has(OUT)).toBe(false);
  });

  it("treats an unreadable config (throw) as disabled, not a crash", () => {
    const deps = makeDeps({
      readConfig: () => {
        throw new Error("EACCES");
      },
    });
    expect(() => run(BASE_ARGV, deps)).not.toThrow();
    expect(envelope(deps).skipReason).toBe("gemini-intent-guess-disabled");
  });
});

describe("run — flow-delegate ran:false skip (branch on ran, not exit code)", () => {
  it("skips on {ran:false} and propagates skipReason, finalizing nothing", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        return { ran: false, skipReason: "agy-not-found" };
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "agy-not-found",
    });
    expect(deps.files.has(OUT)).toBe(false);
  });

  it("falls back to a generic skipReason when none is provided", () => {
    const deps = makeDeps({
      runDelegate: () => ({ ran: false }),
    });
    run(BASE_ARGV, deps);
    expect(envelope(deps)).toEqual({ ran: false, skipReason: "agy-skip" });
  });
});

describe("run — conformant output", () => {
  it("finalizes a schema-valid intent-guess-gemini.json and reports ran:true", () => {
    const deps = makeDeps();
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({ ran: true, findingsPath: OUT });
    expect(JSON.parse(deps.files.get(OUT)!)).toEqual(VALID_GUESS);
  });

  it("recovers a prose-wrapped / fenced conformant payload via extractJsonObject", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(
          rawPath,
          "```json\n" +
            JSON.stringify(VALID_GUESS) +
            "\n```\nThat is my guess.",
        );
        return { ran: true, artifactPath: rawPath };
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({ ran: true, findingsPath: OUT });
  });
});

describe("run — malformed payloads drop the guess, never throw, leave no valid file", () => {
  it.each([
    [
      "non-JSON prose",
      "I reviewed the diff and found nothing.",
      "gemini-intent-guess-output-unparseable",
    ],
    [
      "JSON object missing required key",
      JSON.stringify({ guessed_purpose: "x" }),
      "gemini-intent-guess-output-schema-invalid",
    ],
  ])("drops %s with skipReason %s", (_name, raw, expectedReason) => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(rawPath, raw as string);
        return { ran: true, artifactPath: rawPath };
      },
    });
    expect(() => run(BASE_ARGV, deps)).not.toThrow();
    expect(envelope(deps)).toEqual({ ran: false, skipReason: expectedReason });
    expect(deps.files.has(OUT)).toBe(false);
  });
});

describe("run — IO-throw catch branches each map to a graceful skip, never throw", () => {
  it("gemini-intent-guess-diff-unreadable when the diff readFile throws", () => {
    const deps = makeDeps({
      readFile: (p) => {
        if (p === "/d.txt") throw new Error("EIO");
        throw new Error(`ENOENT: ${p}`);
      },
    });
    expect(() => run(BASE_ARGV, deps)).not.toThrow();
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "gemini-intent-guess-diff-unreadable",
    });
    expect(deps.calls.delegate).toHaveLength(0);
  });

  it("gemini-intent-guess-finalize-failed when the --out write throws, leaving no file", () => {
    const deps = makeDeps({
      writeFile: (p, c) => {
        if (p === OUT) throw new Error("ENOSPC");
        deps.calls.writes.push({ path: p, contents: c });
        deps.files.set(p, c);
      },
    });
    expect(() => run(BASE_ARGV, deps)).not.toThrow();
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "gemini-intent-guess-finalize-failed",
    });
    expect(deps.files.has(OUT)).toBe(false);
  });
});

describe("run — cross-run staleness: a prior --out is cleared before any skip can leak it", () => {
  it("removes a seeded stale --out so a second-run malformed skip leaves no file", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(rawPath, "I reviewed the diff and found nothing.");
        return { ran: true, artifactPath: rawPath };
      },
    });
    deps.files.set(OUT, JSON.stringify(VALID_GUESS, null, 2));
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "gemini-intent-guess-output-unparseable",
    });
    expect(deps.files.has(OUT)).toBe(false);
    expect(deps.calls.removed).toContain(OUT);
  });
});

describe("run — usage errors", () => {
  it("returns 2 on a missing required flag", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(run(["--worktree", "/wt"], makeDeps())).toBe(2);
    errSpy.mockRestore();
  });
});
