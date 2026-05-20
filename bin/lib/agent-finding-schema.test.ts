import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateAgentFindings,
  validateConsolidatorResult,
} from "./agent-finding-schema";

const SCHEMA_SCRIPT = path.resolve(__dirname, "agent-finding-schema.ts");

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bun", [SCHEMA_SCRIPT, ...args], { encoding: "utf8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function withTmpFile(contents: string, fn: (filePath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-finding-schema-test-"));
  const filePath = path.join(dir, "artifact.json");
  writeFileSync(filePath, contents, "utf8");
  try {
    fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Contract tests for the per-agent finding artifact and the
 * Consolidator-Validator artifact. The Step 3.5 consolidator subagent
 * reads six per-agent JSON files, validates each via
 * `validateAgentFindings`, then writes a merged + filtered + validated
 * artifact at `.flow-tmp/consolidator-result.json` (validated via
 * `validateConsolidatorResult` before the atomic mv). These tests pin
 * the shape of each so a future schema drift can't silently break the
 * consolidator's branch logic.
 */

const VALID_AGENT_FINDINGS: unknown = {
  findings: [
    {
      file: "src/lib/store.ts",
      line: 42,
      end_line: 45,
      label: "issue",
      decoration: "blocking",
      confidence: 92,
      subject: "Null deref on missing state",
      body: "When `$state` is undefined the dereference at line 42 throws...",
    },
    {
      file: "src/lib/util.ts",
      line: 10,
      label: "praise",
      confidence: 95,
      subject: "Pure helper is easy to test",
      body: "The new helper at util.ts:10 has no side effects.",
    },
  ],
};

const VALID_CONSOLIDATOR_RESULT: unknown = {
  consolidated_findings: [
    {
      file: "src/lib/store.ts",
      line: 42,
      end_line: 45,
      label: "issue",
      decoration: "blocking",
      confidence: 92,
      subject: "Null deref on missing state",
      body: "When `$state` is undefined the dereference at line 42 throws...",
    },
  ],
  dropped_by_validation: [
    {
      finding_id: "security:src/test/fixtures.ts:5:issue",
      original_finding: {
        file: "src/test/fixtures.ts",
        line: 5,
        label: "issue",
        decoration: "blocking",
        confidence: 90,
        subject: "Hardcoded API key",
        body: "Looks like an API key on line 5",
      },
      reason: "false-positive: cited line is in test fixture",
    },
  ],
  rejected_alternatives: [
    "Considered dropping all <90-confidence findings; rolled back because that would suppress legitimate praise.",
  ],
  anti_patterns_found: [
    "Two agents flagged the same line with different issue classes; dedup window should cluster them.",
  ],
  summary:
    "Consolidated 17 findings from 6 agents into 14 surfaced + 3 dropped during second-opinion validation; bug-detection contributed the highest-confidence cluster, while one off-pattern dedup observation was logged.",
};

describe("validateAgentFindings — happy paths", () => {
  it("accepts a well-formed per-agent output with one issue and one praise", () => {
    const result = validateAgentFindings(VALID_AGENT_FINDINGS);
    expect(result.ok).toBe(true);
  });

  it("accepts an empty findings array (agent found nothing noteworthy)", () => {
    const result = validateAgentFindings({ findings: [] });
    expect(result.ok).toBe(true);
  });

  it("accepts a finding without end_line (optional field)", () => {
    const result = validateAgentFindings({
      findings: [
        {
          file: "src/x.ts",
          line: 1,
          label: "nitpick",
          decoration: "if-minor",
          confidence: 85,
          subject: "x",
          body: "y",
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a praise finding with the decoration key entirely absent", () => {
    const result = validateAgentFindings({
      findings: [
        {
          file: "src/x.ts",
          line: 1,
          label: "praise",
          confidence: 95,
          subject: "Clean helper",
          body: "The new helper is easy to test.",
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a praise finding with decoration set to null", () => {
    const result = validateAgentFindings({
      findings: [
        {
          file: "src/x.ts",
          line: 1,
          label: "praise",
          decoration: null,
          confidence: 95,
          subject: "Clean helper",
          body: "The new helper is easy to test.",
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateAgentFindings — rejections", () => {
  it("rejects a non-object input", () => {
    expect(validateAgentFindings(null).ok).toBe(false);
    expect(validateAgentFindings([]).ok).toBe(false);
    expect(validateAgentFindings("string").ok).toBe(false);
    expect(validateAgentFindings(42).ok).toBe(false);
  });

  it("rejects an artifact missing the 'findings' top-level key", () => {
    const result = validateAgentFindings({ foo: "bar" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("findings");
  });

  it("rejects when 'findings' is an object instead of an array", () => {
    const result = validateAgentFindings({ findings: { not: "array" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("findings");
  });

  it("rejects a finding where confidence is a string instead of a number", () => {
    const result = validateAgentFindings({
      findings: [
        {
          file: "src/x.ts",
          line: 1,
          label: "issue",
          decoration: "blocking",
          confidence: "92",
          subject: "x",
          body: "y",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("confidence");
  });

  it("rejects a finding with an unknown label", () => {
    const result = validateAgentFindings({
      findings: [
        {
          file: "src/x.ts",
          line: 1,
          label: "warning",
          decoration: "blocking",
          confidence: 92,
          subject: "x",
          body: "y",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("label");
  });

  it("rejects a finding with an unknown decoration", () => {
    const result = validateAgentFindings({
      findings: [
        {
          file: "src/x.ts",
          line: 1,
          label: "issue",
          decoration: "critical",
          confidence: 92,
          subject: "x",
          body: "y",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("decoration");
  });

  it("rejects a praise finding with an invalid enum decoration value", () => {
    const result = validateAgentFindings({
      findings: [
        {
          file: "src/x.ts",
          line: 1,
          label: "praise",
          decoration: "critical",
          confidence: 95,
          subject: "x",
          body: "y",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("decoration");
  });

  it("rejects a non-praise finding with the decoration key absent", () => {
    const result = validateAgentFindings({
      findings: [
        {
          file: "src/x.ts",
          line: 1,
          label: "issue",
          confidence: 92,
          subject: "x",
          body: "y",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("decoration");
  });

  it("rejects a finding missing 'file'", () => {
    const result = validateAgentFindings({
      findings: [
        {
          line: 1,
          label: "issue",
          decoration: "blocking",
          confidence: 92,
          subject: "x",
          body: "y",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("file");
  });
});

describe("validateConsolidatorResult — happy paths", () => {
  it("accepts a well-formed consolidator result", () => {
    const result = validateConsolidatorResult(VALID_CONSOLIDATOR_RESULT);
    expect(result.ok).toBe(true);
  });

  it("accepts a result with empty consolidated_findings (every per-agent file was empty)", () => {
    const fixture = structuredClone(VALID_CONSOLIDATOR_RESULT) as Record<string, unknown>;
    fixture.consolidated_findings = [];
    fixture.dropped_by_validation = [];
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(true);
  });

  it("accepts a result with empty rejected_alternatives and anti_patterns_found", () => {
    const fixture = structuredClone(VALID_CONSOLIDATOR_RESULT) as Record<string, unknown>;
    fixture.rejected_alternatives = [];
    fixture.anti_patterns_found = [];
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(true);
  });

  it("accepts a result whose consolidated_findings holds a praise finding with no decoration", () => {
    const fixture = structuredClone(VALID_CONSOLIDATOR_RESULT) as Record<string, unknown>;
    fixture.consolidated_findings = [
      {
        file: "src/lib/util.ts",
        line: 10,
        label: "praise",
        confidence: 95,
        subject: "Pure helper is easy to test",
        body: "The new helper at util.ts:10 has no side effects.",
      },
    ];
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(true);
  });
});

describe("validateConsolidatorResult — required-key omissions", () => {
  it.each([
    "consolidated_findings",
    "dropped_by_validation",
    "rejected_alternatives",
    "anti_patterns_found",
    "summary",
  ])("rejects a result missing the '%s' top-level key", (key) => {
    const fixture = structuredClone(VALID_CONSOLIDATOR_RESULT) as Record<string, unknown>;
    delete fixture[key];
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(key);
  });
});

describe("validateConsolidatorResult — wrong-type rejections", () => {
  it("rejects a non-object input", () => {
    expect(validateConsolidatorResult(null).ok).toBe(false);
    expect(validateConsolidatorResult([]).ok).toBe(false);
    expect(validateConsolidatorResult("x").ok).toBe(false);
  });

  it("rejects when consolidated_findings is not an array", () => {
    const fixture = structuredClone(VALID_CONSOLIDATOR_RESULT) as Record<string, unknown>;
    fixture.consolidated_findings = { not: "array" };
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("consolidated_findings");
  });

  it("rejects when dropped_by_validation is not an array", () => {
    const fixture = structuredClone(VALID_CONSOLIDATOR_RESULT) as Record<string, unknown>;
    fixture.dropped_by_validation = "not an array";
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("dropped_by_validation");
  });

  it("rejects when a dropped_by_validation entry is missing finding_id", () => {
    const fixture = structuredClone(VALID_CONSOLIDATOR_RESULT) as Record<string, unknown>;
    fixture.dropped_by_validation = [
      {
        original_finding: { foo: "bar" },
        reason: "false-positive",
      },
    ];
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("finding_id");
  });

  it("rejects when a dropped_by_validation entry has a non-object original_finding", () => {
    const fixture = structuredClone(VALID_CONSOLIDATOR_RESULT) as Record<string, unknown>;
    fixture.dropped_by_validation = [
      {
        finding_id: "security:src/x.ts:1:issue",
        original_finding: "not-an-object",
        reason: "false-positive",
      },
    ];
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("original_finding");
  });

  it("rejects when a dropped_by_validation entry has an empty reason", () => {
    const fixture = structuredClone(VALID_CONSOLIDATOR_RESULT) as Record<string, unknown>;
    fixture.dropped_by_validation = [
      {
        finding_id: "security:src/x.ts:1:issue",
        original_finding: { foo: "bar" },
        reason: "",
      },
    ];
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("reason");
  });

  it("rejects when a consolidated_findings entry is not a plain object (null)", () => {
    const fixture = structuredClone(VALID_CONSOLIDATOR_RESULT) as Record<string, unknown>;
    fixture.consolidated_findings = [null];
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("consolidated_findings");
  });

  it("rejects when rejected_alternatives contains a non-string entry", () => {
    const fixture = structuredClone(VALID_CONSOLIDATOR_RESULT) as Record<string, unknown>;
    fixture.rejected_alternatives = [{ obj: true }];
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("rejected_alternatives");
  });

  it("rejects when anti_patterns_found contains a non-string entry", () => {
    const fixture = structuredClone(VALID_CONSOLIDATOR_RESULT) as Record<string, unknown>;
    fixture.anti_patterns_found = [42];
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("anti_patterns_found");
  });

  it("rejects when summary is an empty string", () => {
    const fixture = structuredClone(VALID_CONSOLIDATOR_RESULT) as Record<string, unknown>;
    fixture.summary = "";
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("summary");
  });

  it("rejects when a consolidated finding has malformed shape", () => {
    const fixture = structuredClone(VALID_CONSOLIDATOR_RESULT) as Record<string, unknown>;
    fixture.consolidated_findings = [
      {
        file: "src/x.ts",
        line: 1,
        label: "issue",
        decoration: "blocking",
        confidence: "not-a-number",
        subject: "x",
        body: "y",
      },
    ];
    const result = validateConsolidatorResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("confidence");
  });
});

describe("agent-finding-schema CLI — `--validate <path>`", () => {
  it("exits 2 with usage on stderr when --validate flag is missing", () => {
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
    const missingPath = path.join(
      tmpdir(),
      "agent-finding-missing-" + Date.now() + ".json",
    );
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

  it("exits 0 with {ok: true} on stdout for a well-formed per-agent finding artifact", () => {
    withTmpFile(JSON.stringify(VALID_AGENT_FINDINGS), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(result.stderr).toBe("");
    });
  });

  it("exits 0 with {ok: true} for a per-agent artifact whose praise finding omits decoration", () => {
    const artifact = {
      findings: [
        {
          file: "src/lib/util.ts",
          line: 10,
          label: "praise",
          confidence: 95,
          subject: "Pure helper is easy to test",
          body: "The new helper at util.ts:10 has no side effects.",
        },
      ],
    };
    withTmpFile(JSON.stringify(artifact), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(result.stderr).toBe("");
    });
  });

  it("exits 0 with {ok: true} on stdout for a well-formed consolidator result artifact", () => {
    withTmpFile(JSON.stringify(VALID_CONSOLIDATOR_RESULT), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(result.stderr).toBe("");
    });
  });

  it("exits 1 with schema validation reason on stderr for a shape-invalid per-agent input", () => {
    withTmpFile(JSON.stringify({ findings: "not an array" }), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stderr.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain("findings");
      expect(parsed.path).toBe(filePath);
    });
  });

  it("exits 1 with schema validation reason on stderr for a shape-invalid consolidator input", () => {
    withTmpFile(
      JSON.stringify({ consolidated_findings: [], summary: "" }),
      (filePath) => {
        const result = runCli(["--validate", filePath]);
        expect(result.status).toBe(1);
        const parsed = JSON.parse(result.stderr.trim());
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toBeDefined();
        expect(parsed.path).toBe(filePath);
      },
    );
  });

  it("dispatches by JSON shape — 'consolidated_findings' key picks the consolidator validator", () => {
    // A degenerate input that has 'consolidated_findings' but is otherwise
    // missing required keys must route to the consolidator validator and
    // surface a consolidator-shaped error rather than an agent-findings
    // error.
    withTmpFile(
      JSON.stringify({ consolidated_findings: [] }),
      (filePath) => {
        const result = runCli(["--validate", filePath]);
        expect(result.status).toBe(1);
        const parsed = JSON.parse(result.stderr.trim());
        expect(parsed.ok).toBe(false);
        // The consolidator validator reports the first missing key.
        expect(parsed.reason).toMatch(
          /dropped_by_validation|rejected_alternatives|anti_patterns_found|summary/,
        );
      },
    );
  });
});
