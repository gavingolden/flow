import { describe, expect, it } from "vitest";
import { validateFixApplierResult } from "./fix-applier-schema";

/**
 * Contract tests for the Fix-Applier Subagent's artifact at
 * `<worktree>/.flow-tmp/fix-applier-result.json`.
 *
 * These tests subsume the schema-shape half of the manual end-to-end smoke
 * documented in PR #100's Test Steps: "the artifact at
 * `$WORKTREE/.flow-tmp/fix-applier-result.json` parses and includes all
 * five top-level keys (`commits`, `deferred`, `rejected_alternatives`,
 * `anti_patterns_found`, `summary`)". The runtime parts of the smoke that
 * cannot be unit-tested (supervisor scrollback inspection, commit-from-
 * subagent attribution) remain in the dogfood test plan; this file
 * removes the schema-validation portion from that plan.
 */

const VALID_FULL: unknown = {
  commits: [
    {
      sha: "a1b2c3d",
      files: ["src/foo.ts", "src/foo.test.ts"],
      finding_id: "f-7",
      reasoning: "Bug-Detection: null deref on empty input — added guard",
      verify_status: "pass",
      comment_ids: ["c-42"],
    },
  ],
  deferred: [
    {
      finding_id: "f-9",
      tracker_entry_url: "",
      reason: "Pattern-Consistency: cross-cutting refactor; >3 files; bar criterion 2",
    },
  ],
  rejected_alternatives: [
    {
      finding_id: "f-7",
      considered_approach: "throw on empty input",
      why_rejected: "callers expect undefined, throwing would break two consumers",
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
    "Addressed 1 finding (null-guard added in src/foo.ts), deferred 1 cross-cutting refactor; verify clean. Rolled back the throw-on-empty alternative because two consumers expect undefined.",
};

const VALID_EMPTY_NEGATIVES: unknown = {
  commits: [
    {
      sha: "deadbef",
      files: ["src/x.ts"],
      finding_id: "f-1",
      reasoning: "trivial fix",
      verify_status: "pass",
    },
  ],
  deferred: [],
  rejected_alternatives: [],
  anti_patterns_found: [],
  summary:
    "One trivial fix landed; verify clean. No alternatives considered, no surrounding anti-patterns observed in the touched module.",
};

describe("validateFixApplierResult — happy paths", () => {
  it("accepts a fully-populated valid artifact", () => {
    const result = validateFixApplierResult(VALID_FULL);
    expect(result.ok).toBe(true);
  });

  it("accepts an artifact with empty negative-findings arrays", () => {
    const result = validateFixApplierResult(VALID_EMPTY_NEGATIVES);
    expect(result.ok).toBe(true);
  });

  it("accepts deferred[].tracker_entry_url as empty string when no in-repo tracker exists", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    (fixture.deferred as Array<Record<string, unknown>>)[0].tracker_entry_url = "";
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(true);
  });

  it("accepts a verify_status containing a failure excerpt rather than 'pass'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    (fixture.commits as Array<Record<string, unknown>>)[0].verify_status =
      "FAIL src/foo.test.ts > should bar\nExpected: 1\nReceived: 0";
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(true);
  });

  it("accepts an artifact with optional commits[].tool_error present", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    (fixture.commits as Array<Record<string, unknown>>)[0].tool_error =
      "Edit tool returned: file not found";
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(true);
  });

  it("accepts an artifact with optional commits[].comment_ids omitted", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.commits as Array<Record<string, unknown>>)[0].comment_ids;
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(true);
  });
});

describe("validateFixApplierResult — required-key omissions", () => {
  it.each([
    "commits",
    "deferred",
    "rejected_alternatives",
    "anti_patterns_found",
    "summary",
  ])("rejects an artifact missing the '%s' top-level key", (key) => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete fixture[key];
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(key);
    }
  });
});

describe("validateFixApplierResult — wrong-type rejections", () => {
  it("rejects a non-object input", () => {
    expect(validateFixApplierResult(null).ok).toBe(false);
    expect(validateFixApplierResult([]).ok).toBe(false);
    expect(validateFixApplierResult("string").ok).toBe(false);
    expect(validateFixApplierResult(42).ok).toBe(false);
  });

  it("rejects an artifact where summary is empty string", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture.summary = "";
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("summary");
    }
  });

  it.each([
    "commits",
    "deferred",
    "rejected_alternatives",
    "anti_patterns_found",
  ])("rejects an artifact where '%s' is not an array", (key) => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture[key] = "not an array";
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(key);
    }
  });

  it("rejects a commits[] entry missing 'sha'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.commits as Array<Record<string, unknown>>)[0].sha;
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("sha");
      expect(result.path).toBe("commits[0]");
    }
  });

  it("rejects a commits[] entry missing 'verify_status'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.commits as Array<Record<string, unknown>>)[0].verify_status;
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("verify_status");
    }
  });

  it("rejects a deferred[] entry where tracker_entry_url is null", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    (fixture.deferred as Array<Record<string, unknown>>)[0].tracker_entry_url = null;
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("tracker_entry_url");
    }
  });

  it("rejects a rejected_alternatives[] entry missing 'why_rejected'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.rejected_alternatives as Array<Record<string, unknown>>)[0]
      .why_rejected;
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("why_rejected");
    }
  });

  it("rejects an anti_patterns_found[] entry missing 'recommendation'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.anti_patterns_found as Array<Record<string, unknown>>)[0]
      .recommendation;
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("recommendation");
    }
  });
});
