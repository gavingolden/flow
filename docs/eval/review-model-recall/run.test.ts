import { describe, expect, it } from "vitest";
import {
  AGY_ARMS,
  agyCellArgv,
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

describe("parseArgs --effort", () => {
  it("defaults to medium so committed runs stay reproducible", () => {
    expect(parseArgs([]).effort).toBe("medium");
  });

  it("takes an override", () => {
    expect(parseArgs(["--effort", "high"]).effort).toBe("high");
  });
});
