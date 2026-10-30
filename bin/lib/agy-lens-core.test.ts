import { describe, expect, it } from "vitest";
import {
  AGENT_FINDINGS_JSON_SCHEMA,
  CLAUDE_LENS_JSON_SCHEMA,
  classifyUnusableLensRun,
  decodeLensArtifact,
  lensSchemaFor,
  projectLensFindings,
} from "./agy-lens-core";

const finding = {
  file: "src/a.ts",
  line: 3,
  label: "issue",
  decoration: "blocking",
  confidence: 90,
  subject: "s",
  body: "b",
};

const envelopeOf = (payload: unknown) =>
  JSON.stringify({ response: JSON.stringify(payload) });

describe("decodeLensArtifact", () => {
  it("decodes a valid payload through the response-parse rung", () => {
    const out = decodeLensArtifact(
      envelopeOf({
        findings: [finding],
        rejected_alternatives: [],
        anti_patterns_found: [],
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.via).toBe("response-parse");
      expect(out.value.findings).toHaveLength(1);
    }
  });

  it("prefers the structured_output channel", () => {
    const raw = JSON.stringify({
      response: "",
      structured_output: {
        findings: [finding],
        rejected_alternatives: [],
        anti_patterns_found: [],
      },
    });
    const out = decodeLensArtifact(raw);
    expect(out.ok && out.via).toBe("structured-output");
  });

  it.each(["", "not json at all", JSON.stringify({ response: "" })])(
    "returns ok:false for empty or garbage input %j",
    (raw) => {
      expect(decodeLensArtifact(raw)).toEqual({ ok: false });
    },
  );

  it("returns ok:false for a schema-invalid payload", () => {
    expect(
      decodeLensArtifact(envelopeOf({ findings: [{ file: "x" }] })),
    ).toEqual({ ok: false });
  });
});

describe("projectLensFindings", () => {
  it("projects to exactly the three keys and drops reasoning", () => {
    const projected = projectLensFindings({
      reasoning: "scratch",
      findings: [finding],
      rejected_alternatives: [],
      anti_patterns_found: [],
    } as never);
    expect(Object.keys(projected).sort()).toEqual([
      "anti_patterns_found",
      "findings",
      "rejected_alternatives",
    ]);
  });

  it("keeps an absent negatives key absent rather than laundering it into []", () => {
    const projected = projectLensFindings({ findings: [finding] } as never);
    expect(projected).not.toHaveProperty("rejected_alternatives");
    expect(projected).not.toHaveProperty("anti_patterns_found");
  });
});

describe("classifyUnusableLensRun", () => {
  it("names a denial first", () => {
    expect(
      classifyUnusableLensRun("", {
        deniedActions: ["run_command"],
        usage: { thinking_tokens: 100, output_tokens: 100 },
      }),
    ).toBe("tools-denied");
  });

  it("names a thinking-dominated empty response token-exhausted", () => {
    expect(
      classifyUnusableLensRun(JSON.stringify({ response: "" }), {
        usage: { thinking_tokens: 950, output_tokens: 1000 },
      }),
    ).toBe("token-exhausted");
  });

  it("falls back to output-unparseable", () => {
    expect(classifyUnusableLensRun("garbage", {})).toBe("output-unparseable");
    expect(
      classifyUnusableLensRun("some prose", {
        usage: { thinking_tokens: 950, output_tokens: 1000 },
      }),
    ).toBe("output-unparseable");
  });
});

describe("AGENT_FINDINGS_JSON_SCHEMA", () => {
  it("requires the four wire keys", () => {
    expect(AGENT_FINDINGS_JSON_SCHEMA.required).toEqual([
      "reasoning",
      "findings",
      "rejected_alternatives",
      "anti_patterns_found",
    ]);
  });
});

type SchemaProps = {
  properties: Record<string, unknown>;
  required: string[];
};

describe("CLAUDE_LENS_JSON_SCHEMA", () => {
  const claude = CLAUDE_LENS_JSON_SCHEMA as unknown as SchemaProps;
  const gemini = AGENT_FINDINGS_JSON_SCHEMA as unknown as SchemaProps;

  it("drops reasoning from properties and required", () => {
    expect(claude.properties).not.toHaveProperty("reasoning");
    expect(claude.required).not.toContain("reasoning");
    expect(claude.required).toEqual([
      "findings",
      "rejected_alternatives",
      "anti_patterns_found",
    ]);
  });

  it("keeps the label and decoration enums identical to the Gemini schema", () => {
    const itemProps = (s: SchemaProps) =>
      (
        s.properties.findings as {
          items: { properties: Record<string, unknown> };
        }
      ).items.properties;
    expect(itemProps(claude).label).toEqual(itemProps(gemini).label);
    expect(itemProps(claude).decoration).toEqual(itemProps(gemini).decoration);
  });

  it("does not mutate the Gemini schema", () => {
    expect(gemini.properties).toHaveProperty("reasoning");
    expect(gemini.required).toContain("reasoning");
  });
});

describe("lensSchemaFor", () => {
  it("returns the reasoning-free schema for a Claude model", () => {
    expect(lensSchemaFor("Claude Opus 5.5 (High)")).toEqual({
      schema: CLAUDE_LENS_JSON_SCHEMA,
      scratchpadField: false,
    });
  });

  it("returns the full schema for any non-Claude model", () => {
    expect(lensSchemaFor("Gemini 4 Argon (High)")).toEqual({
      schema: AGENT_FINDINGS_JSON_SCHEMA,
      scratchpadField: true,
    });
  });
});
