import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  VALID_DECORATIONS,
  VALID_LABELS,
  validateAgentFindings,
} from "./lib/agent-finding-schema";
import {
  AGENT_FINDINGS_JSON_SCHEMA,
  buildPrompt,
  isGeminiLensEnabled,
  parseArgs,
  run,
  type DelegateEnvelope,
  type Deps,
} from "./flow-gemini-lens";

const DENIED_FIXTURE = readFileSync(
  path.join(__dirname, "fixtures", "agy", "denied-tools-envelope.json"),
  "utf8",
);

const VALID_FINDING = {
  file: "src/foo.ts",
  line: 42,
  label: "issue",
  decoration: "blocking",
  confidence: 92,
  subject: "off-by-one in the loop bound",
  body: "The loop overshoots by one; use `< n` instead of `<= n`.",
};

describe("isGeminiLensEnabled (config gate)", () => {
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
    expect(isGeminiLensEnabled(raw as string)).toBe(expected);
  });

  it("never throws on garbage input", () => {
    expect(() => isGeminiLensEnabled("\x00\x01")).not.toThrow();
    expect(isGeminiLensEnabled("[]")).toBe(false);
  });
});

// `extractJsonObject` moved to `bin/lib/structured-response.ts` (rung 3 of
// the decode ladder); its own test suite now lives there
// (`bin/lib/structured-response.test.ts`'s `describe("extractJsonObject")`)
// rather than duplicated here — this file no longer imports the function.

describe("parseArgs", () => {
  it("requires --worktree, --diff-file, --out", () => {
    expect(parseArgs([])).toEqual({ error: "--worktree is required" });
    expect(parseArgs(["--worktree", "/wt", "--diff-file", "/d.txt"])).toEqual({
      error: "--out is required",
    });
  });

  it("names the hyphenated flag (--diff-file, not the camelCase key) when missing", () => {
    expect(parseArgs(["--worktree", "/wt", "--out", "/o.json"])).toEqual({
      error: "--diff-file is required",
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
      "/wt/.flow-tmp/agent-output-gemini.json",
    ]);
    expect(args).toMatchObject({
      worktree: "/wt",
      diffFile: "/d.txt",
      out: "/wt/.flow-tmp/agent-output-gemini.json",
      task: "gemini-review",
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
      // Default: a conformant agy run that wrote a valid raw artifact.
      const rawPathIdx = argv.indexOf("--out") + 1;
      const rawPath = argv[rawPathIdx]!;
      files.set(rawPath, JSON.stringify({ findings: [VALID_FINDING] }));
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
  // Seed the diff file the helper reads.
  files.set("/d.txt", "diff --git a/src/foo.ts ...");
  return Object.assign(base, overrides, { calls, files });
}

const BASE_ARGV = [
  "--worktree",
  "/wt",
  "--diff-file",
  "/d.txt",
  "--out",
  "/wt/.flow-tmp/agent-output-gemini.json",
];
const OUT = "/wt/.flow-tmp/agent-output-gemini.json";

const envelope = (deps: { calls: { out: string[] } }) =>
  JSON.parse(deps.calls.out[0] as string);

describe("run — gate", () => {
  it("skips with gemini-lens-disabled when the config gate is off", () => {
    const deps = makeDeps({ readConfig: () => JSON.stringify({}) });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "gemini-lens-disabled",
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
    expect(envelope(deps).skipReason).toBe("gemini-lens-disabled");
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
        // Simulate a dispatched-but-unusable agy call: the raw artifact
        // exists on disk, but the envelope itself reports a failure.
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
    expect(env.skipReason).toBe("gemini-lens-disabled");
    expect(env.partialArtifactPath).toBeUndefined();
  });

  // NOTE: the default resolveDeps().runDelegate's own JSON.parse-catch (the
  // rename target) shells out via `Bun.spawnSync`, unavailable under
  // node-vitest (`npm run test`'s default runner — see
  // flow-pre-commit.test.ts's "silent-pass hole" comment on the same
  // constraint); every other spec in this file injects `runDelegate`
  // directly rather than exercising that fallback, so this spec follows
  // the same convention and asserts the reason string via an injected
  // envelope instead of the real spawn path.
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
  it("finalizes a schema-valid agent-output-gemini.json and reports ran:true", () => {
    const deps = makeDeps();
    expect(run(BASE_ARGV, deps)).toBe(0);
    const env = envelope(deps);
    expect(env).toMatchObject({
      ran: true,
      findingsPath: OUT,
      findingCount: 1,
    });
    // The finalized file passes the shared schema.
    const finalized = JSON.parse(deps.files.get(OUT)!);
    expect(validateAgentFindings(finalized).ok).toBe(true);
  });

  it("recovers a prose-wrapped / fenced conformant payload via the decodeDelegateArtifact ladder", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(
          rawPath,
          "```json\n" +
            JSON.stringify({ findings: [VALID_FINDING] }) +
            "\n```\nThat is my review.",
        );
        return { ran: true, artifactPath: rawPath };
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toMatchObject({
      ran: true,
      findingCount: 1,
      decodedVia: "response-parse",
    });
    expect(validateAgentFindings(JSON.parse(deps.files.get(OUT)!)).ok).toBe(
      true,
    );
  });

  // S1: a `flow-delegate --output-format json` envelope whose `.response`
  // opens with a prose sentence but whose `.structured_output` carries the
  // clean, schema-valid findings object — must decode via rung 1
  // (structured-output), never falling through to the prose rungs.
  it("succeeds via decodedVia:'structured-output' on an envelope with a prose-preamble .response", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(
          rawPath,
          JSON.stringify({
            response:
              "Here is my full review of the diff: " +
              JSON.stringify({ findings: [VALID_FINDING] }),
            structured_output: { findings: [VALID_FINDING] },
          }),
        );
        return { ran: true, artifactPath: rawPath };
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toMatchObject({
      ran: true,
      findingCount: 1,
      decodedVia: "structured-output",
    });
    const finalized = JSON.parse(deps.files.get(OUT)!);
    expect(validateAgentFindings(finalized).ok).toBe(true);
    // MANDATORY re-projection: the finalized file carries only the keys the
    // source actually populated, never leaking a schema-supplied top-level
    // `reasoning` key. Neither negative array was present on the source, so
    // both stay ABSENT here rather than being laundered into `[]`.
    expect(finalized).toEqual({
      findings: [VALID_FINDING],
    });
  });

  // S2: a plain-prose, non-envelope raw artifact (the pre-this-PR, non-json
  // mode shape) must decode byte-identically to before, via rung 2
  // (response-parse).
  it("decodes a plain-prose non-envelope artifact identically to before (S2)", () => {
    const deps = makeDeps();
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toMatchObject({
      ran: true,
      findingCount: 1,
      decodedVia: "response-parse",
    });
    const finalized = JSON.parse(deps.files.get(OUT)!);
    expect(finalized).toEqual({
      findings: [VALID_FINDING],
    });
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

  // S5: flag presence, never exact argv array equality — every stub above
  // resolves the raw path via argv.indexOf('--out') + 1.
  it("passes --output-format json and --json-schema <path> to flow-delegate (S5)", () => {
    const deps = makeDeps();
    run(BASE_ARGV, deps);
    const argv = deps.calls.delegate[0]!;
    expect(argv).toContain("--output-format");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("json");
    expect(argv).toContain("--json-schema");
    expect(argv[argv.indexOf("--json-schema") + 1]).toBe(`${OUT}.schema.json`);
  });

  it("passes --timeout resolveDelegateTimeout('reviewLens') default (8m) to flow-delegate", () => {
    const deps = makeDeps();
    run(BASE_ARGV, deps);
    const argv = deps.calls.delegate[0]!;
    expect(argv).toContain("--timeout");
    expect(argv[argv.indexOf("--timeout") + 1]).toBe("8m");
  });

  it("passes an explicit --timeout flag through to flow-delegate", () => {
    const deps = makeDeps();
    run([...BASE_ARGV, "--timeout", "6m"], deps);
    const argv = deps.calls.delegate[0]!;
    expect(argv[argv.indexOf("--timeout") + 1]).toBe("6m");
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
    expect(argv[argv.indexOf("--timeout") + 1]).toBe("8m");
  });

  it("writes AGENT_FINDINGS_JSON_SCHEMA to the --json-schema scratch path before dispatch", () => {
    const deps = makeDeps();
    run(BASE_ARGV, deps);
    const write = deps.calls.writes.find(
      (w) => w.path === `${OUT}.schema.json`,
    );
    expect(write).toBeDefined();
    expect(JSON.parse(write!.contents)).toEqual(AGENT_FINDINGS_JSON_SCHEMA);
  });

  it("has AGENT_FINDINGS_JSON_SCHEMA on disk at the --json-schema path BEFORE dispatch (asserted from inside the delegate stub, not after run() returns)", () => {
    // `deps.calls.writes` and `deps.calls.delegate` are separate arrays with
    // no interleaved ordering, so asserting on them after `run()` returns
    // only proves the write happened, not that it happened first. Asserting
    // from inside the `runDelegate` stub observes dispatch time directly:
    // if a refactor ever moved the schema write below the delegate call,
    // this assertion (unlike the one above) would go red.
    let schemaOnDiskAtDispatch: string | undefined;
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const schemaPath = argv[argv.indexOf("--json-schema") + 1]!;
        schemaOnDiskAtDispatch = deps.files.get(schemaPath);
        const rawPathIdx = argv.indexOf("--out") + 1;
        const rawPath = argv[rawPathIdx]!;
        deps.files.set(rawPath, JSON.stringify({ findings: [VALID_FINDING] }));
        return { ran: true, artifactPath: rawPath };
      },
    });
    run(BASE_ARGV, deps);
    expect(schemaOnDiskAtDispatch).toBeDefined();
    expect(JSON.parse(schemaOnDiskAtDispatch!)).toEqual(
      AGENT_FINDINGS_JSON_SCHEMA,
    );
  });

  // S6: the schema's label/decoration enums must be SET-EQUAL to the
  // exported validator enums so the two cannot silently drift apart.
  it("keeps AGENT_FINDINGS_JSON_SCHEMA's label/decoration enums in set-equality with VALID_LABELS/VALID_DECORATIONS (S6)", () => {
    const schema = AGENT_FINDINGS_JSON_SCHEMA as {
      properties: {
        findings: {
          items: { properties: Record<string, { enum?: string[] }> };
        };
      };
    };
    const findingProps = schema.properties.findings.items.properties;
    expect(new Set(findingProps.label!.enum)).toEqual(new Set(VALID_LABELS));
    expect(new Set(findingProps.decoration!.enum)).toEqual(
      new Set(VALID_DECORATIONS),
    );
  });

  it("requires both negative-findings arrays on the wire schema so agy cannot structurally omit them", () => {
    const schema = AGENT_FINDINGS_JSON_SCHEMA as { required: string[] };
    expect(schema.required).toEqual(
      expect.arrayContaining(["rejected_alternatives", "anti_patterns_found"]),
    );
  });

  it("finalizes an empty {findings:[]} as valid (Gemini found nothing)", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(rawPath, JSON.stringify({ findings: [] }));
        return { ran: true, artifactPath: rawPath };
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toMatchObject({ ran: true, findingCount: 0 });
    const finalized = JSON.parse(deps.files.get(OUT)!);
    // Source carried neither negative array, so both stay ABSENT rather
    // than being laundered into `[]`.
    expect(finalized).toEqual({
      findings: [],
    });
  });

  it("round-trips valid rejected_alternatives and anti_patterns_found arrays", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(
          rawPath,
          JSON.stringify({
            findings: [VALID_FINDING],
            rejected_alternatives: [
              { considered_approach: "a", why_rejected: "b" },
            ],
            anti_patterns_found: [
              { location: "src/x.ts:1", pattern: "p", recommendation: "r" },
            ],
          }),
        );
        return { ran: true, artifactPath: rawPath };
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    const finalized = JSON.parse(deps.files.get(OUT)!);
    expect(finalized).toEqual({
      findings: [VALID_FINDING],
      rejected_alternatives: [{ considered_approach: "a", why_rejected: "b" }],
      anti_patterns_found: [
        { location: "src/x.ts:1", pattern: "p", recommendation: "r" },
      ],
    });
  });

  it("drops one malformed negative entry and still finalizes successfully (does NOT skip with gemini-output-unparseable)", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(
          rawPath,
          JSON.stringify({
            findings: [VALID_FINDING],
            rejected_alternatives: [
              { considered_approach: "missing why_rejected" },
              { considered_approach: "a", why_rejected: "b" },
            ],
            anti_patterns_found: [],
          }),
        );
        return { ran: true, artifactPath: rawPath };
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toMatchObject({ ran: true });
    const finalized = JSON.parse(deps.files.get(OUT)!);
    expect(finalized.rejected_alternatives).toEqual([
      { considered_approach: "a", why_rejected: "b" },
    ]);
    expect(finalized.findings).toEqual([VALID_FINDING]);
  });

  it("still strips the reasoning scratchpad key when negative arrays are present", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(
          rawPath,
          JSON.stringify({
            reasoning: "scratchpad notes that must never reach --out",
            findings: [VALID_FINDING],
            rejected_alternatives: [],
            anti_patterns_found: [],
          }),
        );
        return { ran: true, artifactPath: rawPath };
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    const finalized = JSON.parse(deps.files.get(OUT)!);
    expect(finalized).toEqual({
      findings: [VALID_FINDING],
      rejected_alternatives: [],
      anti_patterns_found: [],
    });
    expect(finalized).not.toHaveProperty("reasoning");
  });
});

describe("run — malformed payloads drop the lens, never throw, leave no valid file", () => {
  // All five shapes collapse into the SAME skipReason now:
  // decodeDelegateArtifact folds parse and validate into one ladder, so a
  // payload that parses but fails validation is no longer distinguishable
  // from one that never parsed at all — this is a rewrite of the former,
  // since-removed `-output-schema-invalid` cases, not a deletion of their
  // coverage.
  it.each([
    ["non-JSON prose", "I reviewed the diff and found nothing."],
    ["JSON array, not {findings}", JSON.stringify([VALID_FINDING])],
    ["JSON object without findings", JSON.stringify({ foo: 1 })],
    [
      "findings with an unrecoverable bad label",
      JSON.stringify({ findings: [{ ...VALID_FINDING, label: "xyzzy" }] }),
    ],
    [
      "findings missing a required field",
      JSON.stringify({ findings: [{ subject: "no file/line" }] }),
    ],
  ])("drops %s with skipReason gemini-output-unparseable", (_name, raw) => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(rawPath, raw as string);
        return { ran: true, artifactPath: rawPath };
      },
    });
    expect(() => run(BASE_ARGV, deps)).not.toThrow();
    // A ran-unusable skip whose raw artifact exists on disk (it does here —
    // runDelegate wrote it above) retains it as partialArtifactPath.
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "gemini-output-unparseable",
      skipClass: "ran-unusable",
      partialArtifactPath: `${OUT}.agy-raw`,
    });
    // CRITICAL: no consolidator-valid agent-output-gemini.json left behind.
    expect(deps.files.has(OUT)).toBe(false);
  });

  it("passes bad-but-coercible findings that normalizeParsedFindings recovers", () => {
    // A finding keyed `title` instead of `subject` is coerced, not dropped.
    const coercible = {
      file: "src/foo.ts",
      line: 7,
      label: "issue",
      decoration: "(blocking)",
      confidence: 90,
      title: "coercible: title->subject and paren-stripped decoration",
      body: "details",
    };
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(rawPath, JSON.stringify({ findings: [coercible] }));
        return { ran: true, artifactPath: rawPath };
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toMatchObject({ ran: true, findingCount: 1 });
    expect(validateAgentFindings(JSON.parse(deps.files.get(OUT)!)).ok).toBe(
      true,
    );
  });

  // Same coercion, but fed through `structured_output` (rung 1) instead of
  // `.response` prose (rung 2). The module header claims normalization
  // applies to EVERY rung, including structured_output — this pins it: a
  // rewrite that drops normalizeParsedFindings from the structured-rung path
  // (e.g. `validateAgentFindings(candidate)` with no normalize call) would
  // hard-drop this payload and turn this test red, where the rung-2-only
  // coercible test above would stay green.
  it("normalizes bad-but-coercible findings arriving via structured_output too (rung 1)", () => {
    const coercibleViaStructured = {
      file: "src/foo.ts",
      line: 7,
      label: "issue",
      decoration: "(blocking)",
      confidence: 90,
      title:
        "coercible via structured_output: title->subject and paren-stripped decoration",
      body: "details",
    };
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(
          rawPath,
          JSON.stringify({
            response: "irrelevant prose the structured channel bypasses",
            structured_output: { findings: [coercibleViaStructured] },
          }),
        );
        return { ran: true, artifactPath: rawPath };
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toMatchObject({
      ran: true,
      findingCount: 1,
      decodedVia: "structured-output",
    });
    expect(validateAgentFindings(JSON.parse(deps.files.get(OUT)!)).ok).toBe(
      true,
    );
  });

  // MANDATORY re-projection: validateAgentFindings tolerates extra
  // top-level keys and returns the input unmodified, so a schema-supplied
  // `reasoning` key must never survive into the finalized file.
  it("never lets a schema-supplied top-level reasoning key leak into the finalized file", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(
          rawPath,
          JSON.stringify({
            reasoning: "scratchpad notes that must never reach --out",
            findings: [VALID_FINDING],
          }),
        );
        return { ran: true, artifactPath: rawPath };
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    const finalized = JSON.parse(deps.files.get(OUT)!);
    expect(finalized).toEqual({
      findings: [VALID_FINDING],
    });
    expect(finalized).not.toHaveProperty("reasoning");
  });
});

describe("run — IO-throw catch branches each map to a graceful skip, never throw, leave no valid file", () => {
  it("gemini-diff-unreadable when the diff readFile throws", () => {
    const deps = makeDeps({
      readFile: (p) => {
        if (p === "/d.txt") throw new Error("EIO");
        throw new Error(`ENOENT: ${p}`);
      },
    });
    expect(() => run(BASE_ARGV, deps)).not.toThrow();
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "gemini-diff-unreadable",
      skipClass: "environment",
    });
    expect(deps.files.has(OUT)).toBe(false);
    expect(deps.calls.delegate).toHaveLength(0);
  });

  it("gemini-prep-failed when writing the prompt scratch file throws", () => {
    const deps = makeDeps({
      writeFile: (p) => {
        throw new Error(`EACCES: ${p}`);
      },
    });
    expect(() => run(BASE_ARGV, deps)).not.toThrow();
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "gemini-prep-failed",
      skipClass: "environment",
    });
    expect(deps.files.has(OUT)).toBe(false);
    expect(deps.calls.delegate).toHaveLength(0);
  });

  it("gemini-output-unreadable when the raw agy artifact readFile throws", () => {
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
      skipReason: "gemini-output-unreadable",
      skipClass: "ran-unusable",
      partialArtifactPath: `${OUT}.agy-raw`,
    });
    expect(deps.files.has(OUT)).toBe(false);
  });

  // The one drop path that ATTEMPTS the --out write and fails partway — exactly
  // where a half-written consolidator-valid file could leak. Assert none does.
  it("gemini-finalize-failed when the --out write throws, leaving no file", () => {
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
      skipReason: "gemini-finalize-failed",
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
        // Run 2 returns prose (malformed) → drops the lens.
        deps.files.set(rawPath, "I reviewed the diff and found nothing.");
        return { ran: true, artifactPath: rawPath };
      },
    });
    // Seed a schema-valid file from a hypothetical prior run.
    deps.files.set(OUT, JSON.stringify({ findings: [VALID_FINDING] }, null, 2));
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "gemini-output-unparseable",
      skipClass: "ran-unusable",
      partialArtifactPath: `${OUT}.agy-raw`,
    });
    // CRITICAL: the stale run-1 file is gone — the consolidator can't consume it.
    expect(deps.files.has(OUT)).toBe(false);
    expect(deps.calls.removed).toContain(OUT);
  });

  it("cleans up both scratch files (.prompt, .agy-raw) on a conformant success", () => {
    const deps = makeDeps();
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toMatchObject({ ran: true });
    expect(deps.files.has(`${OUT}.prompt`)).toBe(false);
    expect(deps.files.has(`${OUT}.agy-raw`)).toBe(false);
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
  it("composes the shared read-rules block and omits the old shell-inviting sentence", () => {
    const diff = "diff --git a/x.ts b/x.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
    const prompt = buildPrompt(diff, "/repo");
    expect(prompt).toContain("Reach for it with your file-reading tools ONLY");
    expect(prompt).not.toContain("the working tree is your current directory");
  });

  it("derives fileCap from the diff's 'diff --git ' count, capped at 10 with a floor of 1", () => {
    const manyFiles = Array.from(
      { length: 15 },
      (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n`,
    ).join("");
    expect(buildPrompt(manyFiles, "/repo")).toContain(
      "Spot-check AT MOST 10 files",
    );
    const oneFile = "diff --git a/f.ts b/f.ts\n";
    expect(buildPrompt(oneFile, "/repo")).toContain(
      "Spot-check AT MOST 1 files",
    );
    const noHeader = "not a real diff";
    expect(buildPrompt(noHeader, "/repo")).toContain(
      "Spot-check AT MOST 1 files",
    );
  });

  it("omits the read-rules block entirely and substitutes a no-filesystem clause when worktreePath is null", () => {
    const prompt = buildPrompt("diff --git a/x.ts b/x.ts\n", null);
    expect(prompt).not.toContain(
      "Reach for it with your file-reading tools ONLY",
    );
    expect(prompt).toContain("no filesystem access");
  });
});

describe("run — self-diagnosing skip reasons (denied tools / token exhaustion)", () => {
  it("classifies a denied tool call as gemini-tools-denied and, when the fallback retry also fails, returns the ORIGINAL skip envelope with fallbackAttempted:true", () => {
    let callCount = 0;
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        callCount++;
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        if (callCount === 1) {
          deps.files.set(rawPath, DENIED_FIXTURE);
          return {
            ran: true,
            artifactPath: rawPath,
            deniedActions: ["RunCommand"],
            usage: { thinking_tokens: 3601, output_tokens: 3704 },
          } as DelegateEnvelope;
        }
        deps.files.set(rawPath, "I could not produce JSON.");
        return { ran: true, artifactPath: rawPath } as DelegateEnvelope;
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toMatchObject({
      ran: false,
      skipReason: "gemini-tools-denied",
      fallbackAttempted: true,
    });
    expect(deps.calls.delegate).toHaveLength(2);
    expect(deps.calls.delegate[1]).not.toContain("--add-dir");
    expect(deps.files.has(OUT)).toBe(false);
  });

  it("retries exactly once without --add-dir on denial and returns ran:true with degraded:'diff-only' when the retry succeeds", () => {
    let callCount = 0;
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        callCount++;
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        if (callCount === 1) {
          deps.files.set(rawPath, DENIED_FIXTURE);
          return {
            ran: true,
            artifactPath: rawPath,
            deniedActions: ["RunCommand"],
            usage: { thinking_tokens: 3601, output_tokens: 3704 },
          } as DelegateEnvelope;
        }
        deps.files.set(rawPath, JSON.stringify({ findings: [VALID_FINDING] }));
        return { ran: true, artifactPath: rawPath } as DelegateEnvelope;
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toMatchObject({
      ran: true,
      degraded: "diff-only",
      degradedReason: "gemini-tools-denied",
      findingCount: 1,
    });
    expect(deps.calls.delegate).toHaveLength(2);
    expect(deps.calls.delegate[1]).not.toContain("--add-dir");
  });

  it("classifies a thinking-dominated empty response with NO denials as gemini-token-exhausted", () => {
    let callCount = 0;
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        callCount++;
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        if (callCount === 1) {
          deps.files.set(
            rawPath,
            JSON.stringify({ status: "SUCCESS", response: "" }),
          );
          return {
            ran: true,
            artifactPath: rawPath,
            usage: { thinking_tokens: 5000, output_tokens: 100 },
          } as DelegateEnvelope;
        }
        deps.files.set(rawPath, "still nothing usable");
        return { ran: true, artifactPath: rawPath } as DelegateEnvelope;
      },
    });
    run(BASE_ARGV, deps);
    expect(envelope(deps)).toMatchObject({
      ran: false,
      skipReason: "gemini-token-exhausted",
      fallbackAttempted: true,
    });
    expect(deps.calls.delegate).toHaveLength(2);
  });

  it("still yields gemini-output-unparseable, with no retry, when neither denial nor exhaustion signals are present", () => {
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
      skipReason: "gemini-output-unparseable",
    });
    expect(deps.calls.delegate).toHaveLength(1);
  });

  it("classifies as denied, not exhausted, when both signals are present (the archived fixture has 3601 thinking of 3704 output AND denied_actions)", () => {
    let callCount = 0;
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        callCount++;
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(rawPath, DENIED_FIXTURE);
        return callCount === 1
          ? ({
              ran: true,
              artifactPath: rawPath,
              deniedActions: ["RunCommand"],
              usage: { thinking_tokens: 3601, output_tokens: 3704 },
            } as DelegateEnvelope)
          : ({ ran: true, artifactPath: rawPath } as DelegateEnvelope);
      },
    });
    run(BASE_ARGV, deps);
    expect(envelope(deps)).toMatchObject({ skipReason: "gemini-tools-denied" });
  });

  it("promotes a ran:false envelope carrying deniedActions to gemini-tools-denied, even under a raw skipReason of agy-canceled", () => {
    let callCount = 0;
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        callCount++;
        if (callCount === 1) {
          return {
            ran: false,
            skipReason: "agy-canceled",
            deniedActions: ["RunCommand"],
          } as DelegateEnvelope;
        }
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(rawPath, "still nothing usable");
        return { ran: true, artifactPath: rawPath } as DelegateEnvelope;
      },
    });
    run(BASE_ARGV, deps);
    expect(envelope(deps)).toMatchObject({
      skipReason: "gemini-tools-denied",
      fallbackAttempted: true,
    });
    expect(deps.calls.delegate).toHaveLength(2);
  });
});
