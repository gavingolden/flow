import { describe, expect, it } from "vitest";
import { parseIntent, type TaskIntent } from "./triage.js";

function bodyWithTriage(triageBody: string): string {
  return [
    "## User prompt",
    "",
    "do the thing",
    "",
    "## Triage",
    "",
    triageBody,
    "",
    "## Phase log",
    "",
  ].join("\n");
}

describe("parseIntent", () => {
  it.each<TaskIntent>(["feature", "bug", "refactor", "docs", "infra", "chore"])(
    "recognises canonical intent %s",
    (intent) => {
      const body = bodyWithTriage(`- intent: ${intent}\n- summary: x`);
      expect(parseIntent(body)).toBe(intent);
    },
  );

  it("returns null when the ## Triage section is missing", () => {
    const body = [
      "## User prompt",
      "",
      "do the thing",
      "",
      "## Phase log",
      "",
    ].join("\n");
    expect(parseIntent(body)).toBeNull();
  });

  it("returns null when the intent line is missing inside ## Triage", () => {
    const body = bodyWithTriage("- summary: nothing about intent here");
    expect(parseIntent(body)).toBeNull();
  });

  it("returns null when the intent value is unrecognised", () => {
    const body = bodyWithTriage("- intent: maintenance\n- summary: x");
    expect(parseIntent(body)).toBeNull();
  });

  it("trims surrounding whitespace from the value", () => {
    const body = bodyWithTriage("- intent:    feature   \n- summary: x");
    expect(parseIntent(body)).toBe("feature");
  });

  it("lowercases mixed-case values", () => {
    const body = bodyWithTriage("- intent: Feature\n- summary: x");
    expect(parseIntent(body)).toBe("feature");
  });

  it("matches even without the leading `- ` bullet", () => {
    const body = bodyWithTriage("intent: bug\nsummary: x");
    expect(parseIntent(body)).toBe("bug");
  });

  it("ignores intent lines outside the ## Triage section", () => {
    // A stray "intent: feature" elsewhere in the body must not satisfy the
    // parser — only the ## Triage block is authoritative.
    const body = [
      "## User prompt",
      "",
      "intent: feature",
      "",
      "## Triage",
      "",
      "- summary: no intent here",
      "",
      "## Phase log",
      "",
    ].join("\n");
    expect(parseIntent(body)).toBeNull();
  });

  it("returns null on an empty intent value", () => {
    const body = bodyWithTriage("- intent:\n- summary: x");
    expect(parseIntent(body)).toBeNull();
  });
});
