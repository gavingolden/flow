import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  JUDGE_MODEL,
  JUDGE_EFFORT,
  JUDGE_MAX_BUDGET_USD,
  JUDGE_TEXT_CHAR_CAP,
  JUDGE_RUBRIC,
  parseArgs,
  readJudgeEnabled,
  extractSections,
  capText,
  buildPrompt,
  parseVerdict,
  exitCodeFor,
  run,
  type Deps,
  type JudgeEnvelope,
} from "./explain-judge";

describe("parseArgs", () => {
  it("requires --text-file and --site", () => {
    expect(parseArgs([])).toEqual({ error: "--text-file is required" });
    expect(parseArgs(["--text-file", "/x"])).toEqual({
      error: "--site is required",
    });
  });

  it("applies documented defaults", () => {
    const parsed = parseArgs(["--text-file", "/x", "--site", "s"]);
    expect(parsed).toEqual({
      textFile: "/x",
      site: "s",
      maxBudgetUsd: JUDGE_MAX_BUDGET_USD,
      sections: undefined,
      expect: undefined,
      model: JUDGE_MODEL,
      effort: JUDGE_EFFORT,
    });
  });

  it("parses --sections as a comma-separated list", () => {
    const parsed = parseArgs([
      "--text-file",
      "/x",
      "--site",
      "s",
      "--sections",
      "## Why,## User-facing changes",
    ]);
    expect("error" in parsed).toBe(false);
    expect((parsed as { sections?: string[] }).sections).toEqual([
      "## Why",
      "## User-facing changes",
    ]);
  });

  it("rejects a bad --expect", () => {
    expect(
      parseArgs(["--text-file", "/x", "--site", "s", "--expect", "bogus"]),
    ).toEqual({ error: "--expect must be one of pass|rewrite" });
  });

  it("accepts --expect pass|rewrite", () => {
    const parsed = parseArgs([
      "--text-file",
      "/x",
      "--site",
      "s",
      "--expect",
      "rewrite",
    ]);
    expect("error" in parsed).toBe(false);
    expect((parsed as { expect?: string }).expect).toBe("rewrite");
  });

  it("rejects an unknown flag", () => {
    expect(parseArgs(["--bogus", "1"])).toEqual({
      error: "unknown flag: --bogus",
    });
  });

  it("rejects a non-numeric --max-budget-usd", () => {
    expect(
      parseArgs([
        "--text-file",
        "/x",
        "--site",
        "s",
        "--max-budget-usd",
        "nope",
      ]),
    ).toEqual({ error: "--max-budget-usd must be a number, got nope" });
  });
});

describe("readJudgeEnabled", () => {
  it("is enabled when the file is missing", () => {
    expect(readJudgeEnabled(() => null, "/nope")).toBe(true);
  });

  it("is enabled on malformed JSON", () => {
    expect(readJudgeEnabled(() => "{not json", "/x")).toBe(true);
  });

  it("is enabled when product is null", () => {
    expect(
      readJudgeEnabled(() => JSON.stringify({ product: null }), "/x"),
    ).toBe(true);
  });

  it("is enabled when the key is absent", () => {
    expect(readJudgeEnabled(() => JSON.stringify({ product: {} }), "/x")).toBe(
      true,
    );
  });

  it("is disabled only on a strict false", () => {
    expect(
      readJudgeEnabled(
        () => JSON.stringify({ product: { judge: false } }),
        "/x",
      ),
    ).toBe(false);
  });
});

describe("extractSections", () => {
  const text = [
    "# Title",
    "",
    "## Why",
    "first why",
    "",
    "### User-facing changes",
    "first ufc",
    "",
    "## Why",
    "second why (last occurrence)",
    "",
    "## User-facing changes",
    "second ufc (last occurrence)",
    "",
    "## Next section",
    "unrelated",
  ].join("\n");

  it("takes the LAST occurrence, case-insensitively, across ## and ### depth", () => {
    const result = extractSections(text, ["## why", "## User-facing changes"]);
    expect(result).toContain("second why (last occurrence)");
    expect(result).not.toContain("first why");
    expect(result).toContain("second ufc (last occurrence)");
    expect(result).not.toContain("first ufc");
  });

  it("returns null when ANY heading is absent — no full-body fallback", () => {
    expect(extractSections(text, ["## Why", "## Nonexistent"])).toBeNull();
  });

  it("stops a section at the next ##/### heading", () => {
    const result = extractSections(text, ["## User-facing changes"]);
    expect(result).not.toContain("unrelated");
  });
});

describe("capText", () => {
  it("returns text unchanged under the cap", () => {
    expect(capText("short", 100)).toBe("short");
  });

  it("truncates over-cap text and stays at or under the cap length", () => {
    const long = "x".repeat(JUDGE_TEXT_CHAR_CAP + 5000);
    const capped = capText(long, JUDGE_TEXT_CHAR_CAP);
    expect(capped.length).toBeLessThanOrEqual(JUDGE_TEXT_CHAR_CAP);
    expect(capped).toContain("truncated");
  });
});

describe("buildPrompt", () => {
  it("is byte-identical to the fixed generic rubric when no brief resolved", () => {
    const a = buildPrompt("hello world", { found: false });
    const b = buildPrompt("hello world", { found: false });
    expect(a).toBe(b);
    expect(a).toContain(JUDGE_RUBRIC);
    expect(a).not.toContain("<PRODUCT_BRIEF>");
    expect(a).not.toContain("ranked priorities");
    expect(a).toContain("<TEXT_TO_JUDGE>");
    expect(a).toContain("hello world");
  });

  it("includes a <PRODUCT_BRIEF> fence and 'ranked priorities' when a brief resolved", () => {
    const prompt = buildPrompt("hello", {
      found: true,
      scope: "repo",
      path: "/repo/.flow/product.md",
      text: "## Ranked priorities\n1. Speed",
    });
    expect(prompt).toContain("<PRODUCT_BRIEF>");
    expect(prompt).toContain("## Ranked priorities");
    expect(prompt).toContain("ranked priorities");
  });
});

describe("parseVerdict", () => {
  it("parses a clean JSON object", () => {
    expect(parseVerdict('{"verdict":"pass","reasons":["ok"]}')).toEqual({
      verdict: "pass",
      reasons: ["ok"],
    });
  });

  it("is tolerant of a ```json fence", () => {
    const text = '```json\n{"verdict":"rewrite","reasons":["a","b"]}\n```';
    expect(parseVerdict(text)).toEqual({
      verdict: "rewrite",
      reasons: ["a", "b"],
    });
  });

  it("is tolerant of surrounding prose", () => {
    const text =
      'Sure, here is my verdict:\n{"verdict":"pass","reasons":[]}\nHope that helps!';
    expect(parseVerdict(text)).toEqual({ verdict: "pass", reasons: [] });
  });

  it("returns null on an unparseable string", () => {
    expect(parseVerdict("not json at all")).toBeNull();
  });

  it("returns null on a missing/invalid verdict field", () => {
    expect(parseVerdict('{"verdict":"maybe"}')).toBeNull();
  });
});

describe("exitCodeFor", () => {
  const pass: JudgeEnvelope = {
    ran: true,
    verdict: "pass",
    reasons: [],
    site: "s",
    model: JUDGE_MODEL,
    effort: JUDGE_EFFORT,
    total_cost_usd: 0.01,
    brief: "none",
  };
  const skipped: JudgeEnvelope = {
    ran: false,
    site: "s",
    skipReason: "judge-disabled",
  };

  it("always returns 0 with no --expect", () => {
    expect(exitCodeFor(pass, undefined)).toBe(0);
    expect(exitCodeFor(skipped, undefined)).toBe(0);
  });

  it("returns 0 on a matching verdict", () => {
    expect(exitCodeFor(pass, "pass")).toBe(0);
  });

  it("returns 1 on a mismatched verdict", () => {
    expect(exitCodeFor(pass, "rewrite")).toBe(1);
  });

  it("returns 3 when ran is false", () => {
    expect(exitCodeFor(skipped, "pass")).toBe(3);
  });
});

function baseDeps(overrides: Partial<Deps> = {}): Deps {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "explain-judge-test-"));
  return {
    readFile: () => null,
    fileExists: () => false,
    readConfig: () => null,
    resolveBrief: () => ({ found: false }),
    runHeadless: async () => ({ exitCode: 1, stdout: "" }),
    mkdtemp: () => tmp,
    env: {},
    writeOut: () => {},
    record: () => {},
    ...overrides,
  };
}

describe("run — skip paths never spawn", () => {
  it("skips on bad-args without spawning", async () => {
    let spawned = false;
    let out = "";
    let recorded: Record<string, unknown> | undefined;
    const code = await run(
      [],
      baseDeps({
        runHeadless: async () => {
          spawned = true;
          return { exitCode: 0, stdout: "" };
        },
        writeOut: (line) => {
          out = line;
        },
        record: (attrs) => {
          recorded = attrs;
        },
      }),
    );
    expect(spawned).toBe(false);
    expect(JSON.parse(out).skipReason).toBe("bad-args");
    expect(recorded?.skipReason).toBe("bad-args");
    expect(code).toBe(0);
  });

  it("skips on judge-disabled without spawning", async () => {
    let spawned = false;
    let out = "";
    const code = await run(
      ["--text-file", "/x", "--site", "s"],
      baseDeps({
        readConfig: () => JSON.stringify({ product: { judge: false } }),
        runHeadless: async () => {
          spawned = true;
          return { exitCode: 0, stdout: "" };
        },
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(spawned).toBe(false);
    expect(JSON.parse(out).skipReason).toBe("judge-disabled");
    expect(code).toBe(0);
  });

  it("skips on headless-depth-exceeded, pre-checked before any spawn", async () => {
    let spawned = false;
    let out = "";
    const code = await run(
      ["--text-file", "/x", "--site", "s"],
      baseDeps({
        env: { FLOW_HEADLESS_DEPTH: "1" },
        fileExists: () => true,
        readFile: () => "some pr body text",
        runHeadless: async () => {
          spawned = true;
          return { exitCode: 0, stdout: "" };
        },
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(spawned).toBe(false);
    expect(JSON.parse(out).skipReason).toBe("headless-depth-exceeded");
    expect(code).toBe(0);
  });

  it("skips on text-empty when the text file does not exist", async () => {
    let out = "";
    const code = await run(
      ["--text-file", "/nope", "--site", "s"],
      baseDeps({
        fileExists: () => false,
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(JSON.parse(out).skipReason).toBe("text-empty");
    expect(code).toBe(0);
  });

  it("skips on sections-not-found when a requested heading is absent", async () => {
    let out = "";
    const code = await run(
      ["--text-file", "/x", "--site", "s", "--sections", "## Nonexistent"],
      baseDeps({
        fileExists: () => true,
        readFile: () => "## Something else\nbody",
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(JSON.parse(out).skipReason).toBe("sections-not-found");
    expect(code).toBe(0);
  });
});

describe("run — successful judge path", () => {
  it("reads the child artifact's result string and returns a pass verdict", async () => {
    let out = "";
    let recorded: Record<string, unknown> | undefined;
    const artifactPath = "/tmp/fake-artifact.json";
    const code = await run(
      ["--text-file", "/x", "--site", "pr-body", "--expect", "pass"],
      baseDeps({
        fileExists: () => true,
        readFile: (p) => {
          if (p === "/x") return "## Why\nusers get faster checkout\n";
          if (p === artifactPath)
            return JSON.stringify({
              result: '{"verdict":"pass","reasons":["clear"]}',
            });
          return null;
        },
        runHeadless: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            ran: true,
            artifact: artifactPath,
            total_cost_usd: 0.01,
          }),
        }),
        writeOut: (line) => {
          out = line;
        },
        record: (attrs) => {
          recorded = attrs;
        },
      }),
    );
    const envelope = JSON.parse(out);
    expect(envelope.ran).toBe(true);
    expect(envelope.verdict).toBe("pass");
    expect(recorded?.verdict).toBe("pass");
    expect(code).toBe(0);
  });

  it("retries exactly once, dropping --tools, on a bad-args skipReason", async () => {
    const artifactPath = "/tmp/fake-artifact2.json";
    let calls = 0;
    const code = await run(
      ["--text-file", "/x", "--site", "s"],
      baseDeps({
        fileExists: () => true,
        readFile: (p) => {
          if (p === "/x") return "## Why\nbody\n";
          if (p === artifactPath)
            return JSON.stringify({
              result: '{"verdict":"pass","reasons":[]}',
            });
          return null;
        },
        runHeadless: async (argv) => {
          calls += 1;
          if (calls === 1) {
            expect(argv).toContain("--tools");
            return {
              exitCode: 2,
              stdout: JSON.stringify({ ran: false, skipReason: "bad-args" }),
            };
          }
          expect(argv).not.toContain("--tools");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ran: true,
              artifact: artifactPath,
              total_cost_usd: 0.02,
            }),
          };
        },
      }),
    );
    expect(calls).toBe(2);
    expect(code).toBe(0);
  });

  it("never retries more than once on a persistent bad-args", async () => {
    let calls = 0;
    await run(
      ["--text-file", "/x", "--site", "s"],
      baseDeps({
        fileExists: () => true,
        readFile: () => "## Why\nbody\n",
        runHeadless: async () => {
          calls += 1;
          return {
            exitCode: 2,
            stdout: JSON.stringify({ ran: false, skipReason: "bad-args" }),
          };
        },
      }),
    );
    expect(calls).toBe(2);
  });

  it("skips on unparseable-verdict when the child's result text isn't valid JSON", async () => {
    const artifactPath = "/tmp/fake-artifact3.json";
    let out = "";
    const code = await run(
      ["--text-file", "/x", "--site", "s"],
      baseDeps({
        fileExists: () => true,
        readFile: (p) => {
          if (p === "/x") return "## Why\nbody\n";
          if (p === artifactPath)
            return JSON.stringify({ result: "not valid json" });
          return null;
        },
        runHeadless: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ ran: true, artifact: artifactPath }),
        }),
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(JSON.parse(out).skipReason).toBe("unparseable-verdict");
    expect(code).toBe(0);
  });

  it("passes every child-reported skipReason through verbatim", async () => {
    let out = "";
    await run(
      ["--text-file", "/x", "--site", "s"],
      baseDeps({
        fileExists: () => true,
        readFile: () => "## Why\nbody\n",
        runHeadless: async () => ({
          exitCode: 2,
          stdout: JSON.stringify({
            ran: false,
            skipReason: "claude-not-logged-in",
          }),
        }),
        writeOut: (line) => {
          out = line;
        },
      }),
    );
    expect(JSON.parse(out).skipReason).toBe("claude-not-logged-in");
  });
});
