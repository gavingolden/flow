import { describe, expect, it } from "vitest";
import {
  DELIBERATE_FRAMING,
  buildDeliberatePrompt,
  isClosedFormAnchor,
  parseDeliberation,
} from "./deliberate-prompt";

const BASE_INPUT = {
  question:
    "Should a one-off maintenance script live under bin/ or under a new scripts/ directory?",
  worktreePath: "/repo",
};

describe("buildDeliberatePrompt", () => {
  it("carries the question verbatim under a '## Question' heading", () => {
    const prompt = buildDeliberatePrompt(BASE_INPUT);
    const headingIdx = prompt.indexOf("## Question");
    expect(headingIdx).toBeGreaterThan(-1);
    expect(prompt.indexOf(BASE_INPUT.question)).toBeGreaterThan(headingIdx);
  });

  it("opens with the DELIBERATE_FRAMING sentence verbatim", () => {
    const prompt = buildDeliberatePrompt(BASE_INPUT);
    expect(prompt.startsWith(DELIBERATE_FRAMING)).toBe(true);
    expect(DELIBERATE_FRAMING).toMatch(
      /you do not know what answer the person asking already leans toward/,
    );
  });

  it("carries the shared read-only rules, including a .flow-tmp denial line", () => {
    const prompt = buildDeliberatePrompt(BASE_INPUT);
    expect(prompt).toMatch(/Reach for it with your file-reading tools ONLY/);
    expect(prompt).toMatch(/Spot-check AT MOST 8 files/);
    expect(prompt).toMatch(
      /Do NOT spawn subagents or delegate this reading to other agents/,
    );
    expect(prompt).toMatch(/Do NOT shell out/);
    expect(prompt).toMatch(/Do NOT read the `\.flow-tmp\/` directory/);
    expect(prompt).toMatch(/Do NOT open `\.env\*` files/);
    expect(prompt).toContain(BASE_INPUT.worktreePath);
  });

  it("states all four method steps in order", () => {
    const prompt = buildDeliberatePrompt(BASE_INPUT);
    const restate = prompt.indexOf("**Restate.**");
    const enumerate = prompt.indexOf("**Enumerate.**");
    const verify = prompt.indexOf("**Verify.**");
    const weigh = prompt.indexOf("**Weigh.**");
    expect(restate).toBeGreaterThan(-1);
    expect(enumerate).toBeGreaterThan(restate);
    expect(verify).toBeGreaterThan(enumerate);
    expect(weigh).toBeGreaterThan(verify);
  });

  it("requires at least three options and names the do-nothing option", () => {
    const prompt = buildDeliberatePrompt(BASE_INPUT);
    expect(prompt).toMatch(/AT LEAST THREE genuinely distinct options/);
    expect(prompt).toMatch(/"Do nothing" and "reject the premise"/);
  });

  it("requires the complementary-vs-exclusive weighing the user asked for", () => {
    const prompt = buildDeliberatePrompt(BASE_INPUT);
    expect(prompt).toMatch(
      /which options are complementary .* and which are mutually exclusive/i,
    );
  });

  it("names the five output headings exactly", () => {
    const prompt = buildDeliberatePrompt(BASE_INPUT);
    for (const heading of [
      "### 1. Question as understood",
      "### 2. Options",
      "### 3. Trade-offs",
      "### 4. Recommendation",
      "### 5. What would change my mind",
    ]) {
      expect(prompt).toContain(heading);
    }
  });

  it("specifies the three trailer lines and the anchor-derived confidence rule", () => {
    const prompt = buildDeliberatePrompt(BASE_INPUT);
    expect(prompt).toContain(
      "Recommendation: <your recommendation in one sentence>",
    );
    expect(prompt).toContain("Confidence: <high|medium|low>");
    expect(prompt).toContain("Anchor: <the evidence your confidence rests on>");
    expect(prompt).toMatch(
      /Choose Confidence by what the Anchor is, NOT by how sure you feel/,
    );
    // An ungrounded preference must self-tag low, so it routes to the
    // caller's escape rather than becoming an adopted default.
    expect(prompt).toMatch(/is `low`\. Do not round `low` up to `medium`/);
  });

  it("omits the product-context block when no brief is supplied", () => {
    expect(buildDeliberatePrompt(BASE_INPUT)).not.toContain(
      "## Product context",
    );
    expect(
      buildDeliberatePrompt({ ...BASE_INPUT, productBrief: null }),
    ).not.toContain("## Product context");
    expect(
      buildDeliberatePrompt({ ...BASE_INPUT, productBrief: "   " }),
    ).not.toContain("## Product context");
  });

  it("carries the product brief above the question when supplied", () => {
    const prompt = buildDeliberatePrompt({
      ...BASE_INPUT,
      productBrief: "The user optimizes for fewer interruptions, then cost.",
    });
    const briefIdx = prompt.indexOf("## Product context");
    expect(briefIdx).toBeGreaterThan(-1);
    expect(prompt).toContain(
      "The user optimizes for fewer interruptions, then cost.",
    );
    expect(prompt.indexOf("## Question")).toBeGreaterThan(briefIdx);
    expect(prompt).toMatch(/it is NOT the question, and it is NOT an answer/);
  });
});

const TRAILER = [
  "Recommendation: Put it under bin/ alongside the other Bun helpers.",
  "Confidence: high",
  "Anchor: bin/flow-blind-survey.ts:549",
].join("\n");

describe("parseDeliberation", () => {
  it("extracts the three trailer fields and the rationale above them", () => {
    const result = parseDeliberation(
      `### 4. Recommendation\n\nUse bin/.\n\n${TRAILER}`,
    );
    expect(result).not.toBeNull();
    expect(result?.recommendation).toBe(
      "Put it under bin/ alongside the other Bun helpers.",
    );
    expect(result?.confidence).toBe("high");
    expect(result?.anchor).toBe("bin/flow-blind-survey.ts:549");
    expect(result?.rationale).toContain("### 4. Recommendation");
    expect(result?.rationale).not.toContain("Confidence:");
  });

  it("accepts each of the three confidence literals", () => {
    for (const level of ["high", "medium", "low"] as const) {
      const result = parseDeliberation(
        `Recommendation: do it\nConfidence: ${level}\nAnchor: inference`,
      );
      expect(result?.confidence).toBe(level);
    }
  });

  it("tolerates bold, bullet, and trailing-period trailer formatting", () => {
    const result = parseDeliberation(
      "- **Recommendation:** Use bin/.\n- **Confidence:** High.\n- **Anchor:** `adjacent: bin/lib/state.ts`",
    );
    expect(result?.recommendation).toBe("Use bin/.");
    expect(result?.confidence).toBe("high");
    expect(result?.anchor).toBe("`adjacent: bin/lib/state.ts`");
  });

  it("returns null when any trailer key is missing", () => {
    expect(
      parseDeliberation("Recommendation: do it\nConfidence: high"),
    ).toBeNull();
    expect(parseDeliberation("Confidence: high\nAnchor: inference")).toBeNull();
    expect(
      parseDeliberation("Recommendation: do it\nAnchor: inference"),
    ).toBeNull();
    expect(parseDeliberation("no trailer at all")).toBeNull();
  });

  it("returns null when confidence is not one of the three literals", () => {
    expect(
      parseDeliberation(
        "Recommendation: do it\nConfidence: pretty sure\nAnchor: inference",
      ),
    ).toBeNull();
  });

  it("returns null when a trailer key has an empty value", () => {
    expect(
      parseDeliberation(
        "Recommendation:\nConfidence: high\nAnchor: bin/foo.ts:1",
      ),
    ).toBeNull();
  });

  it("prefers the last occurrence, so a quoted format example cannot shadow the real answer", () => {
    const result = parseDeliberation(
      [
        "I will end with a trailer like:",
        "Confidence: low",
        "",
        "### 4. Recommendation",
        "",
        TRAILER,
      ].join("\n"),
    );
    expect(result?.confidence).toBe("high");
  });
});

describe("isClosedFormAnchor", () => {
  it("accepts a file path, with or without a line number", () => {
    expect(isClosedFormAnchor("bin/flow-deliberate.ts")).toBe(true);
    expect(isClosedFormAnchor("bin/flow-deliberate.ts:42")).toBe(true);
    expect(isClosedFormAnchor("`docs/configuration.md`")).toBe(true);
  });

  it("accepts an adjacent: precedent and a user: quotation", () => {
    expect(isClosedFormAnchor("adjacent: bin/lib/state.ts")).toBe(true);
    expect(isClosedFormAnchor('user: "wire ONE site"')).toBe(true);
  });

  it("rejects weighing: and inference — free text no caller can re-verify", () => {
    expect(isClosedFormAnchor("inference")).toBe(false);
    expect(isClosedFormAnchor("weighing: convention")).toBe(false);
    expect(
      isClosedFormAnchor("weighing: risk — a wrong call costs a pass"),
    ).toBe(false);
  });

  it("rejects prose and an empty anchor", () => {
    expect(isClosedFormAnchor("")).toBe(false);
    expect(isClosedFormAnchor("   ")).toBe(false);
    expect(
      isClosedFormAnchor("the existing helpers are all named after verbs"),
    ).toBe(false);
  });
});
