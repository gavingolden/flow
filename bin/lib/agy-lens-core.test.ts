import { describe, expect, it } from "vitest";
import {
  AGENT_FINDINGS_JSON_SCHEMA,
  classifyUnusableLensRun,
  decodeLensArtifact,
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
