import { describe, expect, it } from "vitest";
import { validateCoderResult } from "./coder-schema";

/**
 * Contract tests for the Edit-Applier Subagent's artifact at
 * `<worktree>/.flow-tmp/coder-result.json`.
 *
 * These tests subsume the schema-shape half of the manual end-to-end smoke
 * documented in this PR's Test Steps: "the artifact at
 * `$WORKTREE/.flow-tmp/coder-result.json` parses and includes all five
 * top-level keys (`edits`, `verify_status`, `rejected_alternatives`,
 * `anti_patterns_found`, `summary`)". The runtime parts of the smoke that
 * cannot be unit-tested (supervisor scrollback inspection, subagent
 * isolation verification) remain in the dogfood test plan.
 */

const VALID_FULL: unknown = {
  edits: [
    {
      file: "src/foo.ts",
      intent: "Add null-guard for empty input",
      expected_outcome: "foo() returns undefined instead of throwing on []",
      applied: true,
      tool_error: "",
    },
  ],
  verify_status: "pass",
  rejected_alternatives: [
    {
      file: "src/foo.ts",
      considered_approach: "throw on empty input",
      why_rejected:
        "callers expect undefined, throwing would break two consumers",
    },
  ],
  anti_patterns_found: [
    {
      location: "src/bar.ts:42",
      pattern: "untyped any in public function signature",
      recommendation: "tighten the param type when this module is next touched",
    },
  ],
  summary:
    "Applied 1 edit (null-guard added in src/foo.ts), verify clean. Rolled back the throw-on-empty alternative because two consumers expect undefined.",
};

const VALID_EMPTY_NEGATIVES: unknown = {
  edits: [
    {
      file: "src/x.ts",
      intent: "Trivial typo fix",
      expected_outcome: "compile passes",
      applied: true,
      tool_error: "",
    },
  ],
  verify_status: "pass",
  rejected_alternatives: [],
  anti_patterns_found: [],
  summary:
    "One trivial typo landed; verify clean. No alternatives considered, no surrounding anti-patterns observed in the touched module.",
};

describe("validateCoderResult — happy paths", () => {
  it("accepts a fully-populated valid artifact", () => {
    const result = validateCoderResult(VALID_FULL);
    expect(result.ok).toBe(true);
  });

  it("accepts an artifact with empty negative-findings arrays", () => {
    const result = validateCoderResult(VALID_EMPTY_NEGATIVES);
    expect(result.ok).toBe(true);
  });

  it("accepts an edits[].tool_error as empty string when no Edit/Write error blocked the edit", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    (fixture.edits as Array<Record<string, unknown>>)[0].tool_error = "";
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(true);
  });

  it("accepts an edits[].applied=false with a tool_error excerpt", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    const edit = (fixture.edits as Array<Record<string, unknown>>)[0];
    edit.applied = false;
    edit.tool_error = "Edit tool returned: file not found";
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(true);
  });

  it("accepts a verify_status containing a failure excerpt rather than 'pass'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture.verify_status =
      "FAIL src/foo.test.ts > should bar\nExpected: 1\nReceived: 0";
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(true);
  });
});

describe("validateCoderResult — required-key omissions", () => {
  it.each([
    "edits",
    "verify_status",
    "rejected_alternatives",
    "anti_patterns_found",
    "summary",
  ])("rejects an artifact missing the '%s' top-level key", (key) => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete fixture[key];
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(key);
    }
  });
});

describe("validateCoderResult — wrong-type rejections", () => {
  it("rejects a non-object input", () => {
    expect(validateCoderResult(null).ok).toBe(false);
    expect(validateCoderResult([]).ok).toBe(false);
    expect(validateCoderResult("string").ok).toBe(false);
    expect(validateCoderResult(42).ok).toBe(false);
  });

  it("rejects an artifact where summary is empty string", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture.summary = "";
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("summary");
    }
  });

  it("rejects an artifact where verify_status is empty string", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture.verify_status = "";
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("verify_status");
    }
  });

  it.each(["edits", "rejected_alternatives", "anti_patterns_found"])(
    "rejects an artifact where '%s' is not an array",
    (key) => {
      const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
      fixture[key] = "not an array";
      const result = validateCoderResult(fixture);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(key);
      }
    },
  );

  it("rejects an edits[] entry missing 'file'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.edits as Array<Record<string, unknown>>)[0].file;
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("file");
      expect(result.path).toBe("edits[0]");
    }
  });

  it("rejects an edits[] entry missing 'intent'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.edits as Array<Record<string, unknown>>)[0].intent;
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("intent");
    }
  });

  it("rejects an edits[] entry missing 'expected_outcome'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.edits as Array<Record<string, unknown>>)[0]
      .expected_outcome;
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("expected_outcome");
    }
  });

  it("rejects an edits[] entry where 'applied' is not a boolean", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    (fixture.edits as Array<Record<string, unknown>>)[0].applied = "true";
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("applied");
    }
  });

  it("rejects an edits[] entry where 'tool_error' is null", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    (fixture.edits as Array<Record<string, unknown>>)[0].tool_error = null;
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("tool_error");
    }
  });

  it("rejects an edits[] entry missing 'tool_error' entirely", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.edits as Array<Record<string, unknown>>)[0].tool_error;
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("tool_error");
    }
  });

  it("rejects a rejected_alternatives[] entry missing 'considered_approach'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.rejected_alternatives as Array<Record<string, unknown>>)[0]
      .considered_approach;
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("considered_approach");
    }
  });

  it("rejects a rejected_alternatives[] entry missing 'file'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.rejected_alternatives as Array<Record<string, unknown>>)[0]
      .file;
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("file");
      expect(result.path).toBe("rejected_alternatives[0]");
    }
  });

  it("rejects an anti_patterns_found[] entry missing 'location'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.anti_patterns_found as Array<Record<string, unknown>>)[0]
      .location;
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("location");
    }
  });

  it("rejects an anti_patterns_found[] entry missing 'pattern'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.anti_patterns_found as Array<Record<string, unknown>>)[0]
      .pattern;
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("pattern");
    }
  });

  it("rejects a rejected_alternatives[] entry missing 'why_rejected'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.rejected_alternatives as Array<Record<string, unknown>>)[0]
      .why_rejected;
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("why_rejected");
    }
  });

  it("rejects an anti_patterns_found[] entry missing 'recommendation'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.anti_patterns_found as Array<Record<string, unknown>>)[0]
      .recommendation;
    const result = validateCoderResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("recommendation");
    }
  });
});
