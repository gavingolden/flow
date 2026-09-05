import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  INTENT_GUESS_JSON_SCHEMA,
  buildPrompt,
  isGeminiIntentGuessEnabled,
  parseArgs,
  run,
  validateIntentGuess,
  type DelegateEnvelope,
  type Deps,
} from "./flow-gemini-intent-guess";
import { parseStructured } from "./lib/structured-response";

const DENIED_FIXTURE = readFileSync(
  path.join(__dirname, "fixtures", "agy", "denied-tools-envelope.json"),
  "utf8",
);

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

describe("parseStructured (schema=undefined, shape-only) — extraction tolerance", () => {
  it("returns the object verbatim when there is no wrapper", () => {
    expect(parseStructured('{"guessed_purpose":"x"}', undefined)).toEqual({
      ok: true,
      value: { guessed_purpose: "x" },
    });
  });

  it("recovers an object wrapped in leading/trailing prose", () => {
    const wrapped = 'Here is my guess:\n{"guessed_purpose":"x"}\nDone.';
    expect(parseStructured(wrapped, undefined)).toEqual({
      ok: true,
      value: { guessed_purpose: "x" },
    });
  });

  it("recovers an object inside a ```json fence", () => {
    const fenced = '```json\n{"guessed_purpose":"x"}\n```';
    expect(parseStructured(fenced, undefined)).toEqual({
      ok: true,
      value: { guessed_purpose: "x" },
    });
  });

  it("returns ok:false when there is no brace pair", () => {
    expect(parseStructured("no json here at all", undefined).ok).toBe(false);
    expect(parseStructured("", undefined).ok).toBe(false);
  });

  // The two cases below pin why `parseStructured` (rung 2 of the
  // `decodeDelegateArtifact` ladder `run()` now calls) sits AHEAD of the
  // naive first-`{`-to-last-`}` `extractJsonObject` (rung 3, last-resort
  // salvage): both were traced empirically against the naive extractor
  // alone (which returned an over-wide slice that failed JSON.parse, i.e. a
  // dropped `-output-unparseable` skip) to confirm parseStructured recovers
  // genuinely more cases, not just theoretically more.
  //
  // SCOPE HONESTY: this is NOT a strict-superset claim over the WHOLE
  // ladder. `parseStructured` and the naive rung still fail alike on `Here
  // is {a} guess: {"k":1}` (a brace in LEADING prose before the object) —
  // findBalancedObjectSpan locks onto the FIRST `{` in the whole text and
  // does not retry from a later one, so that shape is out of scope for
  // either rung.
  it("recovers an object whose string value contains an unbalanced brace, even with trailing commentary that itself contains a brace", () => {
    const raw =
      '{"justification":"a note with an extra } inside"}\n\nSee also the {appendix}.';
    expect(parseStructured(raw, undefined)).toEqual({
      ok: true,
      value: { justification: "a note with an extra } inside" },
    });
  });

  it("recovers an object followed by trailing commentary that itself contains a brace", () => {
    const raw =
      '{"guessed_purpose":"x"}\n\nNote: this looks similar to the {baseline} case.';
    expect(parseStructured(raw, undefined)).toEqual({
      ok: true,
      value: { guessed_purpose: "x" },
    });
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
    fileExists: (p) => files.has(p),
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
      skipClass: "environment",
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
      skipClass: "environment",
    });
    expect(deps.files.has(OUT)).toBe(false);
  });

  it("falls back to a generic skipReason when none is provided", () => {
    const deps = makeDeps({
      runDelegate: () => ({ ran: false }),
    });
    run(BASE_ARGV, deps);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "agy-skip",
      skipClass: "ran-unusable",
    });
  });

  it("forwards exitCode/agyStatus/agyError diagnostics from the delegate envelope on skip", () => {
    const deps = makeDeps({
      runDelegate: () => ({
        ran: false,
        skipReason: "agy-timeout",
        exitCode: 1,
        agyStatus: "ERROR",
        agyError: "timeout waiting for response",
      }),
    });
    run(BASE_ARGV, deps);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "agy-timeout",
      skipClass: "ran-unusable",
      exitCode: 1,
      agyStatus: "ERROR",
      agyError: "timeout waiting for response",
    });
  });

  it("retains .agy-raw as partialArtifactPath on a ran-unusable skip whose raw artifact exists", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPathIdx = argv.indexOf("--out") + 1;
        const rawPath = argv[rawPathIdx]!;
        deps.files.set(rawPath, "not valid json");
        return { ran: false, skipReason: "agy-timeout", exitCode: 1 };
      },
    });
    run(BASE_ARGV, deps);
    expect(envelope(deps)).toMatchObject({
      ran: false,
      skipReason: "agy-timeout",
      skipClass: "ran-unusable",
      partialArtifactPath: `${OUT}.agy-raw`,
    });
    expect(deps.files.has(`${OUT}.agy-raw`)).toBe(true);
    // removeFile(rawPath) is called exactly once — the unconditional
    // pre-clean at the top of the run, before the raw artifact exists —
    // and NOT again by cleanScratch's retention, which is what would
    // delete the file this test asserts survives.
    expect(deps.calls.removed.filter((p) => p === `${OUT}.agy-raw`)).toEqual([
      `${OUT}.agy-raw`,
    ]);
  });

  it("does not retain .agy-raw (or emit partialArtifactPath) on an environment-class skip", () => {
    const deps = makeDeps({
      readConfig: () => JSON.stringify({}),
    });
    run(BASE_ARGV, deps);
    const env = envelope(deps);
    expect(env.skipReason).toBe("gemini-intent-guess-disabled");
    expect(env.partialArtifactPath).toBeUndefined();
  });

  it("emits skipReason delegate-envelope-unparseable when the delegate call's own envelope reports it", () => {
    const deps = makeDeps({
      runDelegate: () => ({
        ran: false,
        skipReason: "delegate-envelope-unparseable",
      }),
    });
    run(BASE_ARGV, deps);
    expect(envelope(deps)).toMatchObject({
      ran: false,
      skipReason: "delegate-envelope-unparseable",
      // classifyDelegateSkip's unrecognised-reason fallthrough defaults to
      // ran-unusable (report the safer way) rather than environment — pin
      // it so a later edit that lists this reason under
      // ENVIRONMENT_SKIP_REASONS (silently dropping partialArtifactPath
      // retention for it) is a visible test change, not a silent one.
      skipClass: "ran-unusable",
    });
  });

  it("pre-cleans a stale .agy-raw so a ran-unusable skip that never dispatches cannot report a prior run's file as its own evidence", () => {
    const deps = makeDeps({
      runDelegate: () => ({
        ran: false,
        skipReason: "delegate-envelope-unparseable",
      }),
    });
    // Seed a .agy-raw left over from a hypothetical prior run's ran-unusable
    // skip — this run's runDelegate stub never writes rawPath.
    deps.files.set(`${OUT}.agy-raw`, "stale evidence from a previous run");
    run(BASE_ARGV, deps);
    const env = envelope(deps);
    expect(env).toMatchObject({
      ran: false,
      skipReason: "delegate-envelope-unparseable",
    });
    expect(env.partialArtifactPath).toBeUndefined();
    expect(deps.files.has(`${OUT}.agy-raw`)).toBe(false);
  });
});

describe("run — conformant output", () => {
  it("finalizes a schema-valid intent-guess-gemini.json and reports ran:true", () => {
    const deps = makeDeps();
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: true,
      findingsPath: OUT,
      decodedVia: "response-parse",
    });
    expect(JSON.parse(deps.files.get(OUT)!)).toEqual(VALID_GUESS);
  });

  it("recovers a prose-wrapped / fenced conformant payload via parseStructured", () => {
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
    expect(envelope(deps)).toEqual({
      ran: true,
      findingsPath: OUT,
      decodedVia: "response-parse",
    });
  });

  // Regression guard for the parseStructured swap: a fenced JSON block
  // followed by trailing commentary that itself contains a `}` is
  // recoverable ONLY by parseStructured's fenced-block-first extraction
  // strategy. The former naive first-`{`-to-last-`}` slice would span from
  // the fenced block's opening brace all the way to the trailing brace in
  // the commentary, produce an invalid (over-wide) JSON.parse candidate,
  // and fall through to `gemini-intent-guess-output-unparseable` — this
  // test would have been RED against that old behaviour.
  it("recovers a fenced payload followed by trailing commentary containing a brace", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(
          rawPath,
          "```json\n" +
            JSON.stringify(VALID_GUESS) +
            "\n```\nSee also {issue tracking this}.",
        );
        return { ran: true, artifactPath: rawPath };
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: true,
      findingsPath: OUT,
      decodedVia: "response-parse",
    });
    expect(JSON.parse(deps.files.get(OUT)!)).toEqual(VALID_GUESS);
  });

  // S1-equivalent: a `flow-delegate --output-format json` envelope whose
  // `.response` opens with a prose sentence but whose `.structured_output`
  // carries the clean, schema-conformant guess — this must decode via rung
  // 1 (structured-output), never falling through to the prose rungs.
  it("succeeds via decodedVia:'structured-output' on an envelope with a prose-preamble .response", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(
          rawPath,
          JSON.stringify({
            response:
              "Sure, here is my analysis of the diff: " +
              JSON.stringify(VALID_GUESS),
            structured_output: VALID_GUESS,
          }),
        );
        return { ran: true, artifactPath: rawPath };
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: true,
      findingsPath: OUT,
      decodedVia: "structured-output",
    });
    expect(JSON.parse(deps.files.get(OUT)!)).toEqual(VALID_GUESS);
  });

  // S2: a plain-prose, non-envelope raw artifact (the pre-this-PR, non-json
  // mode shape) must decode byte-identically to before — via rung 2
  // (response-parse), same skipReason vocabulary on the failure path.
  it("decodes a plain-prose non-envelope artifact identically to before (S2)", () => {
    const deps = makeDeps();
    expect(run(BASE_ARGV, deps)).toBe(0);
    const finalized = JSON.parse(deps.files.get(OUT)!);
    expect(finalized).toEqual(VALID_GUESS);
    expect(envelope(deps).decodedVia).toBe("response-parse");
  });

  // S5: the wire-schema scratch file must never survive either exit path.
  it("removes the .schema.json scratch file after a success exit (S5)", () => {
    const deps = makeDeps();
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(deps.files.has(`${OUT}.schema.json`)).toBe(false);
  });

  it("removes the .schema.json scratch file after a skip exit (S5)", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        return { ran: false, skipReason: "agy-not-found" };
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(deps.files.has(`${OUT}.schema.json`)).toBe(false);
  });

  // S5: the delegate argv assertion is flag-presence, never exact array
  // equality — every stub above resolves paths via
  // argv.indexOf('--out') + 1, so a flag addition must stay non-breaking.
  it("passes --output-format json and --json-schema <path> to flow-delegate (S5)", () => {
    const deps = makeDeps();
    run(BASE_ARGV, deps);
    const argv = deps.calls.delegate[0]!;
    expect(argv).toContain("--output-format");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("json");
    expect(argv).toContain("--json-schema");
    expect(argv[argv.indexOf("--json-schema") + 1]).toBe(`${OUT}.schema.json`);
  });

  it("passes --timeout resolveDelegateTimeout('intentGuess') default (5m) to flow-delegate", () => {
    const deps = makeDeps();
    run(BASE_ARGV, deps);
    const argv = deps.calls.delegate[0]!;
    expect(argv).toContain("--timeout");
    expect(argv[argv.indexOf("--timeout") + 1]).toBe("5m");
  });

  it("passes an explicit --timeout flag through to flow-delegate", () => {
    const deps = makeDeps();
    run([...BASE_ARGV, "--timeout", "3m"], deps);
    const argv = deps.calls.delegate[0]!;
    expect(argv[argv.indexOf("--timeout") + 1]).toBe("3m");
  });

  it("clamps an explicit --timeout flag above the 9m sync ceiling", () => {
    const deps = makeDeps();
    run([...BASE_ARGV, "--timeout", "15m"], deps);
    const argv = deps.calls.delegate[0]!;
    expect(argv[argv.indexOf("--timeout") + 1]).toBe("9m");
  });

  it("falls back to the default when an explicit --timeout flag is not a valid Go duration", () => {
    const deps = makeDeps();
    run([...BASE_ARGV, "--timeout", "not-a-duration"], deps);
    const argv = deps.calls.delegate[0]!;
    expect(argv[argv.indexOf("--timeout") + 1]).toBe("5m");
  });

  it("writes INTENT_GUESS_JSON_SCHEMA to the --json-schema scratch path before dispatch", () => {
    const deps = makeDeps();
    run(BASE_ARGV, deps);
    const write = deps.calls.writes.find(
      (w) => w.path === `${OUT}.schema.json`,
    );
    expect(write).toBeDefined();
    expect(JSON.parse(write!.contents)).toEqual(INTENT_GUESS_JSON_SCHEMA);
  });

  it("has INTENT_GUESS_JSON_SCHEMA on disk at the --json-schema path BEFORE dispatch (asserted from inside the delegate stub, not after run() returns)", () => {
    // Same rationale as bin/flow-gemini-lens.test.ts's sibling test:
    // `deps.calls.writes` and `deps.calls.delegate` are separate arrays with
    // no interleaved ordering, so asserting after `run()` returns only
    // proves the write happened, not that it happened first.
    let schemaOnDiskAtDispatch: string | undefined;
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const schemaPath = argv[argv.indexOf("--json-schema") + 1]!;
        schemaOnDiskAtDispatch = deps.files.get(schemaPath);
        const rawPathIdx = argv.indexOf("--out") + 1;
        const rawPath = argv[rawPathIdx]!;
        deps.files.set(rawPath, JSON.stringify(VALID_GUESS));
        return { ran: true, artifactPath: rawPath };
      },
    });
    run(BASE_ARGV, deps);
    expect(schemaOnDiskAtDispatch).toBeDefined();
    expect(JSON.parse(schemaOnDiskAtDispatch!)).toEqual(
      INTENT_GUESS_JSON_SCHEMA,
    );
  });
});

describe("run — malformed payloads drop the guess, never throw, leave no valid file", () => {
  // Both cases collapse into the SAME skipReason now: decodeDelegateArtifact
  // folds parse and validate into one ladder, so a payload that parses but
  // fails validation is no longer distinguishable from one that never
  // parsed at all — this is a rewrite of the former, since-removed
  // `-output-schema-invalid` case, not a deletion of its coverage.
  it.each([
    ["non-JSON prose", "I reviewed the diff and found nothing."],
    [
      "JSON object missing required key",
      JSON.stringify({ guessed_purpose: "x" }),
    ],
  ])(
    "drops %s with skipReason gemini-intent-guess-output-unparseable",
    (_name, raw) => {
      const deps = makeDeps({
        runDelegate: (argv) => {
          deps.calls.delegate.push(argv);
          const rawPath = argv[argv.indexOf("--out") + 1]!;
          deps.files.set(rawPath, raw as string);
          return { ran: true, artifactPath: rawPath };
        },
      });
      expect(() => run(BASE_ARGV, deps)).not.toThrow();
      // A ran-unusable skip whose raw artifact exists on disk (it does
      // here — runDelegate wrote it above) retains it as partialArtifactPath.
      expect(envelope(deps)).toEqual({
        ran: false,
        skipReason: "gemini-intent-guess-output-unparseable",
        skipClass: "ran-unusable",
        partialArtifactPath: `${OUT}.agy-raw`,
      });
      expect(deps.files.has(OUT)).toBe(false);
    },
  );
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
      skipClass: "environment",
    });
    expect(deps.calls.delegate).toHaveLength(0);
  });

  it("gemini-intent-guess-prep-failed when writing the prompt scratch file throws", () => {
    const deps = makeDeps({
      writeFile: (p) => {
        throw new Error(`EACCES: ${p}`);
      },
    });
    expect(() => run(BASE_ARGV, deps)).not.toThrow();
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "gemini-intent-guess-prep-failed",
      skipClass: "environment",
    });
    expect(deps.calls.delegate).toHaveLength(0);
    expect(deps.files.has(OUT)).toBe(false);
  });

  it("gemini-intent-guess-output-unreadable when the raw agy artifact readFile throws", () => {
    const deps = makeDeps({
      readFile: (p) => {
        if (p === "/d.txt") return deps.files.get(p)!;
        throw new Error(`EIO: ${p}`);
      },
    });
    expect(() => run(BASE_ARGV, deps)).not.toThrow();
    // The default runDelegate stub still wrote the raw artifact to disk
    // before this override's readFile started throwing, so it is retained.
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "gemini-intent-guess-output-unreadable",
      skipClass: "ran-unusable",
      partialArtifactPath: `${OUT}.agy-raw`,
    });
    expect(deps.files.has(OUT)).toBe(false);
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
      skipClass: "ran-unusable",
      partialArtifactPath: `${OUT}.agy-raw`,
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
      skipClass: "ran-unusable",
      partialArtifactPath: `${OUT}.agy-raw`,
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

describe("buildPrompt", () => {
  const diff = "diff --git a/x.ts b/x.ts\n+1\n";

  it("composes the shared read-rules block and drops the bare read-access invitation", () => {
    const prompt = buildPrompt(diff, "x.ts\n", "/repo");
    expect(prompt).toContain("Reach for it with your file-reading tools ONLY");
    expect(prompt).not.toContain(
      "You have read access to the working directory for surrounding source context",
    );
  });

  it("still carries the unblinding exclusion list", () => {
    const prompt = buildPrompt(diff, "x.ts\n", "/repo");
    expect(prompt).toContain("`.flow-tmp/pr-body.md`");
    expect(prompt).toContain("`.flow-tmp/plan.md`");
    expect(prompt).toContain("or the git log — doing so unblinds you");
  });

  it("derives fileCap from the fileList's line count, capped at 10 with a floor of 1", () => {
    const manyFiles = Array.from({ length: 15 }, (_, i) => `f${i}.ts`).join(
      "\n",
    );
    expect(buildPrompt(diff, manyFiles, "/repo")).toContain(
      "Spot-check AT MOST 10 files",
    );
    expect(buildPrompt(diff, "f.ts", "/repo")).toContain(
      "Spot-check AT MOST 1 files",
    );
    expect(
      buildPrompt(diff, "(unable to derive file list from diff)", "/repo"),
    ).toContain("Spot-check AT MOST 1 files");
  });
});

describe("run — self-diagnosing skip reasons (denied tools / token exhaustion), no fallback retry", () => {
  it("classifies a denied tool call as gemini-tools-denied via the decode-failure ladder, with exactly one delegate call", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(rawPath, DENIED_FIXTURE);
        return {
          ran: true,
          artifactPath: rawPath,
          deniedActions: ["RunCommand"],
          usage: { thinking_tokens: 3601, output_tokens: 3704 },
        } as DelegateEnvelope;
      },
    });
    run(BASE_ARGV, deps);
    expect(envelope(deps)).toMatchObject({
      ran: false,
      skipReason: "gemini-tools-denied",
    });
    expect(deps.calls.delegate).toHaveLength(1);
  });

  it("classifies a thinking-dominated empty response with NO denials as gemini-token-exhausted", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(
          rawPath,
          JSON.stringify({ status: "SUCCESS", response: "" }),
        );
        return {
          ran: true,
          artifactPath: rawPath,
          usage: { thinking_tokens: 5000, output_tokens: 100 },
        } as DelegateEnvelope;
      },
    });
    run(BASE_ARGV, deps);
    expect(envelope(deps)).toMatchObject({
      ran: false,
      skipReason: "gemini-token-exhausted",
    });
    expect(deps.calls.delegate).toHaveLength(1);
  });

  it("still yields gemini-intent-guess-output-unparseable when neither signal is present", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(rawPath, "not json at all");
        return { ran: true, artifactPath: rawPath } as DelegateEnvelope;
      },
    });
    run(BASE_ARGV, deps);
    expect(envelope(deps)).toMatchObject({
      ran: false,
      skipReason: "gemini-intent-guess-output-unparseable",
    });
    expect(deps.calls.delegate).toHaveLength(1);
  });

  it("promotes a ran:false envelope carrying deniedActions to gemini-tools-denied, even under a raw skipReason of agy-canceled", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        return {
          ran: false,
          skipReason: "agy-canceled",
          deniedActions: ["RunCommand"],
        } as DelegateEnvelope;
      },
    });
    run(BASE_ARGV, deps);
    expect(envelope(deps)).toMatchObject({ skipReason: "gemini-tools-denied" });
    expect(deps.calls.delegate).toHaveLength(1);
  });
});
