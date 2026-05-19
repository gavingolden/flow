import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { validateConsolidatorResult } from "./consolidator-result-schema";

const SCHEMA_SCRIPT = path.resolve(__dirname, "consolidator-result-schema.ts");

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bun", [SCHEMA_SCRIPT, ...args], { encoding: "utf8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function withTmpFile(contents: string, fn: (filePath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "consolidator-result-schema-test-"));
  const filePath = path.join(dir, "consolidator-result.json");
  writeFileSync(filePath, contents, "utf8");
  try {
    fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Contract tests for the Consolidator + Validator Subagent's artifact at
 * `<worktree>/.flow-tmp/consolidator-result.json`. Mirrors
 * `fix-applier-schema.test.ts` in structure: a fully-populated happy-path
 * fixture and a minimal "empty negatives" happy-path fixture, then a battery
 * of per-key omission + per-key wrong-type rejections.
 */

const FINDING_A = {
  file: "src/lib/store.ts",
  line: 42,
  end_line: 45,
  label: "issue" as const,
  decoration: "blocking" as const,
  confidence: 92,
  subject: "null deref on empty input",
  body: "Calling .length on undefined throws.",
};

const FINDING_B = {
  file: "src/lib/auth.ts",
  line: 17,
  label: "suggestion" as const,
  decoration: "non-blocking" as const,
  confidence: 85,
  subject: "extract the duplicated guard",
  body: "Same guard appears in three other handlers.",
};

const FINDING_DROPPED = {
  file: "src/lib/legacy.ts",
  line: 1,
  label: "nitpick" as const,
  decoration: "if-minor" as const,
  confidence: 82,
  subject: "rename variable",
  body: "Validator dropped this on second-opinion pass.",
};

const VALID_FULL: unknown = {
  consolidated_findings: [FINDING_A, FINDING_B],
  dropped_by_validation: [
    {
      finding: FINDING_DROPPED,
      reason: "Second-opinion read at src/lib/legacy.ts:1 showed the variable is intentionally short — false positive.",
    },
  ],
  rejected_alternatives: [
    "Considered weighting Bug-Detection findings 1.5x but the threshold of 80 already filters noise.",
  ],
  anti_patterns_found: [
    "Two agents flagged the same line with different issue classes — kept both per dedup rule (b).",
  ],
  summary:
    "Consolidated 2 findings across 4 agent outputs; dropped 1 false positive on second-opinion validation. One alternative weighting strategy was considered and rolled back.",
};

const VALID_EMPTY_NEGATIVES: unknown = {
  consolidated_findings: [FINDING_A],
  dropped_by_validation: [],
  rejected_alternatives: [],
  anti_patterns_found: [],
  summary:
    "One finding survived consolidation; no alternatives considered, no surrounding anti-patterns observed.",
};

describe("validateConsolidatorResult — happy paths", () => {
  it("accepts a fully-populated valid artifact", () => {
    const result = validateConsolidatorResult(VALID_FULL);
    expect(result.ok).toBe(true);
  });

  it("accepts an artifact with empty negative-findings arrays", () => {
    const result = validateConsolidatorResult(VALID_EMPTY_NEGATIVES);
    expect(result.ok).toBe(true);
  });

  it("accepts an artifact with empty consolidated_findings (clean PR)", () => {
    const fixture = {
      consolidated_findings: [],
      dropped_by_validation: [],
      rejected_alternatives: [],
      anti_patterns_found: [],
      summary: "Clean run; zero findings survived the threshold.",
    };
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(true);
  });
});

describe("validateConsolidatorResult — top-level shape rejections", () => {
  it("rejects a non-object input (null)", () => {
    expect(validateConsolidatorResult(null).ok).toBe(false);
  });

  it("rejects a non-object input (array)", () => {
    expect(validateConsolidatorResult([]).ok).toBe(false);
  });

  it("rejects a non-object input (string)", () => {
    expect(validateConsolidatorResult("{}").ok).toBe(false);
  });
});

describe("validateConsolidatorResult — required-key omissions", () => {
  it.each([
    "consolidated_findings",
    "dropped_by_validation",
    "rejected_alternatives",
    "anti_patterns_found",
    "summary",
  ])("rejects an artifact missing the '%s' top-level key", (key) => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete fixture[key];
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(key);
    }
  });
});

describe("validateConsolidatorResult — wrong-type rejections", () => {
  it("rejects an artifact where 'summary' is an empty string", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture.summary = "";
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("summary");
    }
  });

  it("rejects an artifact where 'consolidated_findings' is not an array", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture.consolidated_findings = "not an array";
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("consolidated_findings");
    }
  });

  it("rejects a consolidated_findings entry that fails AgentFinding validation", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    // Drop the required `label` key from the first finding.
    delete (fixture.consolidated_findings as Array<Record<string, unknown>>)[0]
      .label;
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("label");
      // The path-reformatting branch prepends `consolidated_findings`
      // to the inner AgentFinding path so the error surfaces as
      // `consolidated_findings[0]` rather than the bare `[0]`. Without
      // this assertion, a regression that drops the prefix would leave
      // the test passing but the error message misleading.
      expect(result.path).toContain("consolidated_findings");
    }
  });

  it("rejects a dropped_by_validation entry missing 'finding'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.dropped_by_validation as Array<Record<string, unknown>>)[0]
      .finding;
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("finding");
    }
  });

  it("rejects a dropped_by_validation entry missing 'reason'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.dropped_by_validation as Array<Record<string, unknown>>)[0]
      .reason;
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("reason");
    }
  });

  it("rejects a dropped_by_validation entry where 'reason' is an empty string", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    (fixture.dropped_by_validation as Array<Record<string, unknown>>)[0].reason = "";
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("reason");
    }
  });

  it("rejects 'rejected_alternatives' not an array of strings", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture.rejected_alternatives = [1, 2, 3];
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("rejected_alternatives");
    }
  });

  it("rejects 'rejected_alternatives' that is not an array at all", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture.rejected_alternatives = "not an array";
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("rejected_alternatives");
    }
  });

  it("rejects 'anti_patterns_found' not an array of strings", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture.anti_patterns_found = [{ pattern: "x" }];
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("anti_patterns_found");
    }
  });

  it("rejects 'anti_patterns_found' that is not an array at all", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture.anti_patterns_found = null;
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("anti_patterns_found");
    }
  });
});

describe("consolidator-result-schema CLI — `--validate <path>`", () => {
  it("exits 2 with usage on stderr when --validate flag is missing entirely", () => {
    const result = runCli([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
    expect(result.stdout).toBe("");
  });

  it("exits 2 with usage on stderr when --validate is given without a path argument", () => {
    const result = runCli(["--validate"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
    expect(result.stdout).toBe("");
  });

  it("exits 1 with read failure on stderr when the target path does not exist", () => {
    const missingPath = path.join(tmpdir(), "definitely-does-not-exist-" + Date.now() + ".json");
    const result = runCli(["--validate", missingPath]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain("read failed");
    expect(parsed.path).toBe(missingPath);
  });

  it("exits 1 with JSON parse failure on stderr when the file contains malformed JSON", () => {
    withTmpFile("{ not valid json", (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stderr.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain("JSON parse failed");
      expect(parsed.path).toBe(filePath);
    });
  });

  it("exits 1 with schema validation reason on stderr when the JSON is shape-invalid", () => {
    withTmpFile(JSON.stringify({ summary: "missing other keys" }), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stderr.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBeDefined();
    });
  });

  it("exits 0 with {ok: true} on stdout for a well-formed artifact", () => {
    withTmpFile(JSON.stringify(VALID_FULL), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(result.stderr).toBe("");
    });
  });

  it("exits 0 for a well-formed artifact with empty negative-findings arrays", () => {
    withTmpFile(JSON.stringify(VALID_EMPTY_NEGATIVES), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(true);
    });
  });
});
