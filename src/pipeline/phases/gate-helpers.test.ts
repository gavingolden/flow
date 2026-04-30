import { describe, expect, it } from "vitest";
import {
  decideManualValidation,
  extractManualValidationSection,
  isManualValidationEmpty,
  stripHtmlComments,
} from "./gate-helpers.js";

describe("extractManualValidationSection", () => {
  it("returns the section body without the heading line", () => {
    const body = [
      "## Why",
      "",
      "intro",
      "",
      "## Manual validation",
      "",
      "<!-- nothing to do -->",
      "",
      "## How to test",
      "",
      "later",
    ].join("\n");
    const section = extractManualValidationSection(body);
    expect(section).toContain("<!-- nothing to do -->");
    expect(section).not.toContain("## Manual validation");
    expect(section).not.toContain("## How to test");
  });

  it("returns null when the section is missing entirely", () => {
    const body = ["## Why", "", "intro", "", "## How to test", "", "later"].join("\n");
    expect(extractManualValidationSection(body)).toBeNull();
  });

  it("captures section body when it is the last section in the body", () => {
    const body = [
      "## Why",
      "",
      "intro",
      "",
      "## Manual validation",
      "",
      "- step one",
      "- step two",
    ].join("\n");
    const section = extractManualValidationSection(body);
    expect(section).toContain("- step one");
    expect(section).toContain("- step two");
  });
});

describe("stripHtmlComments", () => {
  it("strips a single-line HTML comment", () => {
    expect(stripHtmlComments("a <!-- b --> c")).toBe("a  c");
  });

  it("strips multi-line HTML comments", () => {
    const input = "before\n<!--\n  multi\n  line\n-->\nafter";
    expect(stripHtmlComments(input)).toBe("before\n\nafter");
  });

  it("strips multiple comments interleaved with content non-greedily", () => {
    // Non-greedy matching: each `<!-- ... -->` should match only its own
    // open/close pair, not collapse two comments into one match swallowing
    // the content between them.
    const input = "<!-- a -->keep<!-- b -->";
    expect(stripHtmlComments(input)).toBe("keep");
  });

  it("leaves --> appearing outside an HTML comment alone", () => {
    // The closing-arrow sequence inside an attribute value or prose is
    // not a comment terminator on its own — there must be a matching
    // `<!--` preceding it.
    const input = "this --> arrow is not a comment terminator";
    expect(stripHtmlComments(input)).toBe(input);
  });
});

describe("isManualValidationEmpty", () => {
  it("returns true for HTML-comment-only content", () => {
    expect(isManualValidationEmpty("<!-- nothing to do -->")).toBe(true);
  });

  it("returns true for whitespace surrounding an HTML comment", () => {
    expect(isManualValidationEmpty("\n\n  <!-- placeholder -->  \n\n")).toBe(true);
  });

  it("returns true for whitespace-only content", () => {
    expect(isManualValidationEmpty("\n\n   \n")).toBe(true);
  });

  it("returns false for a bullet list", () => {
    expect(isManualValidationEmpty("- step one\n- step two")).toBe(false);
  });

  it("returns false for prose alongside an HTML comment", () => {
    expect(
      isManualValidationEmpty("<!-- placeholder -->\n\nrun the migration"),
    ).toBe(false);
  });
});

describe("decideManualValidation", () => {
  it("returns 'empty' when the section contains only an HTML comment", () => {
    const body =
      "## Manual validation\n\n<!-- No manual validation required: pure-internal-logic change. -->\n";
    expect(decideManualValidation(body)).toBe("empty");
  });

  it("returns 'non-empty' when the section contains concrete steps", () => {
    const body = [
      "## Manual validation",
      "",
      "1. Run `npm run migrate`",
      "2. Confirm the new column exists",
    ].join("\n");
    expect(decideManualValidation(body)).toBe("non-empty");
  });

  it("returns 'section-missing' when the heading is absent", () => {
    const body = "## Why\n\nbecause\n";
    expect(decideManualValidation(body)).toBe("section-missing");
  });

  it("returns 'non-empty' for the verify-failure CAUTION block (defensive fallthrough)", () => {
    // verify-gate.ts's surfaceVerifyFailureOnPr writes a `> [!CAUTION]` block
    // into Manual validation on exhaustion. Under normal flow the verify
    // failure escalates to needs-human before gate runs — but on a stale
    // resume gate could see this content. Routing to gated is a safe
    // outcome (the user investigates) so the helper must classify it as
    // non-empty.
    const body = [
      "## Manual validation",
      "",
      "> [!CAUTION]",
      "> Pre-PR verify failed against pushed SHA — needs human review",
      "",
      "```text",
      "typecheck error in foo.ts",
      "```",
    ].join("\n");
    expect(decideManualValidation(body)).toBe("non-empty");
  });
});
