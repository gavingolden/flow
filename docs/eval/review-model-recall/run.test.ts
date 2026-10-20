import { describe, expect, it } from "vitest";
import {
  AGY_ARMS,
  AGY_DEFAULT_CONCURRENCY,
  agyCellArgv,
  agyPool,
  envelopeFailureClass,
  nextAgySidecar,
  parseArgs,
  wrapAgyCell,
  isCompletedCellOutput,
} from "./run";

const finding = {
  file: "src/a.ts",
  line: 3,
  label: "issue",
  decoration: "blocking",
  confidence: 90,
  subject: "s",
  body: "b",
};

describe("AGY_ARMS", () => {
  it("maps the agy arm name to the agy display-name variant", () => {
    expect(AGY_ARMS["agy-opus-5-5-high"]).toBe("Claude Opus 5.5 (High)");
  });

  it("carries the Argon High and Medium arms", () => {
    expect(AGY_ARMS["agy-argon-high"]).toBe("Gemini 4 Argon (High)");
    expect(AGY_ARMS["agy-argon-medium"]).toBe("Gemini 4 Argon (Medium)");
  });
});

describe("agy concurrency", () => {
  it("defaults agy cells to 2 workers, narrower than the Claude cells", () => {
    expect(AGY_DEFAULT_CONCURRENCY).toBe(2);
    expect(parseArgs([]).agyConcurrency).toBe(2);
    expect(parseArgs([]).concurrency).toBe(6);
  });

  it("follows an explicit --concurrency, and --agy-concurrency wins over it", () => {
    expect(parseArgs(["--concurrency", "3"]).agyConcurrency).toBe(3);
    expect(
      parseArgs(["--concurrency", "3", "--agy-concurrency", "1"])
        .agyConcurrency,
    ).toBe(1);
  });
});

describe("envelopeFailureClass", () => {
  it("is undefined for a ran:true envelope", () => {
    expect(envelopeFailureClass({ ran: true })).toBeUndefined();
  });

  it("prefers the helper's own class", () => {
    expect(
      envelopeFailureClass({
        ran: false,
        failureClass: "auth",
        skipReason: "agy-error",
      }),
    ).toBe("auth");
  });

  it("classifies a quota refusal from its error text", () => {
    expect(
      envelopeFailureClass({
        ran: false,
        skipReason: "agy-error",
        agyError: "Individual quota reached. Resets in 4h",
      }),
    ).toBe("quota-exhausted");
  });
});

describe("nextAgySidecar", () => {
  it("counts an undecodable ran cell as an unusable attempt", () => {
    expect(
      nextAgySidecar(
        { attempts: 1, unusable_attempts: 0 },
        {
          decodedOk: false,
          ran: true,
          skipReason: undefined,
          failureClass: undefined,
        },
      ),
    ).toMatchObject({ attempts: 2, unusable_attempts: 1, refused_attempts: 0 });
  });

  it("keeps a quota refusal out of unusable_attempts, counting it as a refusal", () => {
    const next = nextAgySidecar(
      { attempts: 0 },
      {
        decodedOk: false,
        ran: false,
        skipReason: "agy-error",
        failureClass: "quota-exhausted",
      },
    );
    expect(next).toMatchObject({
      attempts: 1,
      unusable_attempts: 0,
      refused_attempts: 1,
      last_failure_class: "quota-exhausted",
    });
  });

  it("also keeps a rate-limit refusal out of unusable_attempts", () => {
    expect(
      nextAgySidecar(
        {},
        {
          decodedOk: false,
          ran: false,
          skipReason: "x",
          failureClass: "rate-limited",
        },
      ).unusable_attempts,
    ).toBe(0);
  });

  it("a decoded cell adds no unusable attempt", () => {
    expect(
      nextAgySidecar(
        { attempts: 2, unusable_attempts: 1 },
        {
          decodedOk: true,
          ran: true,
          skipReason: undefined,
          failureClass: undefined,
        },
      ).unusable_attempts,
    ).toBe(1);
  });
});

describe("agyPool", () => {
  it("stops dequeuing cells once any cell reports a quota halt", async () => {
    const started: number[] = [];
    const result = await agyPool([1, 2, 3, 4, 5, 6], 1, async (n) => {
      started.push(n);
      return { quotaHalt: n === 2 };
    });
    expect(started).toEqual([1, 2]);
    expect(result).toEqual({ halted: true, notRun: 4 });
  });

  it("with concurrent workers, no new cell starts after the halting cell reports", async () => {
    const started: number[] = [];
    const result = await agyPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      started.push(n);
      await new Promise((r) => setTimeout(r, n === 1 ? 5 : 1));
      return { quotaHalt: n === 2 };
    });
    expect(result.halted).toBe(true);
    // 1 and 2 started together; 2 halted before 1 finished, so nothing after 3
    // can have started beyond what was already in flight.
    expect(started.length).toBeLessThan(6);
  });

  it("runs every cell when nothing halts", async () => {
    const started: number[] = [];
    const result = await agyPool([1, 2, 3], 2, async (n) => {
      started.push(n);
      return { quotaHalt: false };
    });
    expect(started.sort()).toEqual([1, 2, 3]);
    expect(result).toEqual({ halted: false, notRun: 0 });
  });
});

describe("agyCellArgv", () => {
  const argv = agyCellArgv({
    promptFile: "/d/runs/c.agy-prompt.txt",
    schemaFile: "/d/agy-findings-schema.json",
    out: "/d/runs/c.agy-raw.json",
    model: "Claude Opus 5.5 (High)",
    addDir: "/repo",
    task: "recall-c",
  });
  const after = (flag: string) => argv[argv.indexOf(flag) + 1];

  it("sends json output, the shared schema, the model, the repo root and a 15m timeout", () => {
    expect(after("--output-format")).toBe("json");
    expect(after("--json-schema")).toBe("/d/agy-findings-schema.json");
    expect(after("--prompt-file")).toBe("/d/runs/c.agy-prompt.txt");
    expect(after("--model")).toBe("Claude Opus 5.5 (High)");
    expect(after("--add-dir")).toBe("/repo");
    expect(after("--out")).toBe("/d/runs/c.agy-raw.json");
    expect(after("--task")).toBe("recall-c");
    expect(after("--timeout")).toBe("15m");
  });

  it("never passes --skip-permissions", () => {
    expect(argv).not.toContain("--skip-permissions");
  });
});

describe("wrapAgyCell", () => {
  it("wraps a decoded cell claude-shaped so the resume predicate and the judge read it unchanged", () => {
    const cell = wrapAgyCell(
      {
        ok: true,
        value: {
          findings: [finding],
          rejected_alternatives: [],
          anti_patterns_found: [],
        } as never,
      },
      { durationMs: 91000, usage: { output_tokens: 12 } },
    );
    expect(cell).toMatchObject({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 91000,
      usage: { output_tokens: 12 },
    });
    expect(JSON.parse(cell.result as string).findings).toHaveLength(1);
    expect(isCompletedCellOutput(JSON.stringify(cell))).toBe(true);
  });

  it("marks an unusable cell is_error so a resume retries it", () => {
    const cell = wrapAgyCell({ ok: false }, { durationMs: 5 });
    expect(cell).toMatchObject({ type: "result", is_error: true, result: "" });
    expect(cell).not.toHaveProperty("usage");
    expect(isCompletedCellOutput(JSON.stringify(cell))).toBe(false);
  });
});

describe("isCompletedCellOutput — delegate envelopes", () => {
  it("is false for a ran:false delegate envelope, so a refused cell is re-run on resume", () => {
    expect(
      isCompletedCellOutput(
        JSON.stringify({
          ran: false,
          skipReason: "agy-error",
          failureClass: "quota-exhausted",
        }),
      ),
    ).toBe(false);
  });

  it("is still true for a successful claude-shaped result", () => {
    expect(
      isCompletedCellOutput(
        JSON.stringify({ subtype: "success", is_error: false }),
      ),
    ).toBe(true);
  });
});

describe("parseArgs --effort", () => {
  it("defaults to medium so committed runs stay reproducible", () => {
    expect(parseArgs([]).effort).toBe("medium");
  });

  it("takes an override", () => {
    expect(parseArgs(["--effort", "high"]).effort).toBe("high");
  });
});
