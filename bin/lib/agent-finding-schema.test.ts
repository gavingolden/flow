import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { validateAgentFindings } from "./agent-finding-schema";

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
  const filePath = path.join(dir, "agent-output.json");
  writeFileSync(filePath, contents, "utf8");
  try {
    fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Contract tests for the per-review-agent JSON output array shape, sourced
 * verbatim from `skills/pipeline/pr-review/references/agent-prompts.md`'s
 * Output Format section. The Consolidator + Validator Subagent runs this
 * validator against each of the four agent JSON outputs before merging.
 */

const VALID_FULL: unknown = [
  {
    file: "src/lib/store.ts",
    line: 42,
    end_line: 45,
    label: "praise",
    decoration: "non-blocking",
    confidence: 90,
    subject: "the new pure helper is straightforward to test",
    body: "Specific positive observation about the pure helper at foo.ts:42.",
  },
  {
    file: "src/lib/store.ts",
    line: 50,
    label: "nitpick",
    decoration: "if-minor",
    confidence: 80,
    subject: "rename `tmp` to a descriptive identifier",
    body: "Minor naming nit.",
  },
  {
    file: "src/lib/store.ts",
    line: 60,
    label: "suggestion",
    decoration: "non-blocking",
    confidence: 82,
    subject: "extract this branch into a helper",
    body: "The branch repeats logic elsewhere in the module.",
  },
  {
    file: "src/lib/store.ts",
    line: 70,
    label: "issue",
    decoration: "blocking",
    confidence: 95,
    subject: "null deref on empty input",
    body: "Calling .length on a possibly-undefined value throws at runtime.",
  },
  {
    file: "src/lib/store.ts",
    line: 80,
    label: "todo",
    decoration: "non-blocking",
    confidence: 85,
    subject: "remove the TODO comment now that the fix landed",
    body: "Stale TODO from before the fix.",
  },
  {
    file: "src/lib/store.ts",
    line: 90,
    label: "question",
    decoration: "non-blocking",
    confidence: 80,
    subject: "is this branch reachable?",
    body: "I cannot see a caller that satisfies the guard.",
  },
];

const VALID_EMPTY: unknown = [];

describe("validateAgentFindings — happy paths", () => {
  it("accepts a fully-populated valid array (one finding per label)", () => {
    const result = validateAgentFindings(VALID_FULL);
    expect(result.ok).toBe(true);
  });

  it("accepts an empty array (no findings)", () => {
    const result = validateAgentFindings(VALID_EMPTY);
    expect(result.ok).toBe(true);
  });

  it("accepts a finding with body as empty string", () => {
    const fixture = [
      {
        file: "x.ts",
        line: 1,
        label: "issue" as const,
        decoration: "blocking" as const,
        confidence: 100,
        subject: "x",
        body: "",
      },
    ];
    const result = validateAgentFindings(fixture);
    expect(result.ok).toBe(true);
  });

  it("accepts a finding with end_line omitted", () => {
    const fixture = [
      {
        file: "x.ts",
        line: 1,
        label: "issue" as const,
        decoration: "blocking" as const,
        confidence: 85,
        subject: "x",
        body: "y",
      },
    ];
    const result = validateAgentFindings(fixture);
    expect(result.ok).toBe(true);
  });
});

describe("validateAgentFindings — top-level shape rejections", () => {
  it("rejects a non-array top-level input (object)", () => {
    const result = validateAgentFindings({ foo: "bar" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("array");
    }
  });

  it("rejects a non-array top-level input (null)", () => {
    expect(validateAgentFindings(null).ok).toBe(false);
  });

  it("rejects a non-array top-level input (string)", () => {
    expect(validateAgentFindings("[]").ok).toBe(false);
  });
});

describe("validateAgentFindings — per-finding rejections", () => {
  function base(overrides: Partial<Record<string, unknown>> = {}): unknown {
    return [
      {
        file: "x.ts",
        line: 1,
        label: "issue",
        decoration: "blocking",
        confidence: 85,
        subject: "x",
        body: "y",
        ...overrides,
      },
    ];
  }

  function deleteKey(key: string): unknown {
    const fixture = base();
    delete (fixture as Array<Record<string, unknown>>)[0][key];
    return fixture;
  }

  it("rejects a finding missing 'file'", () => {
    const result = validateAgentFindings(deleteKey("file"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("file");
      expect(result.path).toBe("[0]");
    }
  });

  it("rejects a finding missing 'line'", () => {
    const result = validateAgentFindings(deleteKey("line"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("line");
  });

  it("rejects a finding where 'line' is not a positive integer (zero)", () => {
    const result = validateAgentFindings(base({ line: 0 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("line");
  });

  it("rejects a finding where 'line' is not a positive integer (float)", () => {
    const result = validateAgentFindings(base({ line: 3.5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("line");
  });

  it("rejects a finding where 'line' is negative", () => {
    const result = validateAgentFindings(base({ line: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("line");
  });

  it("rejects a finding missing 'label'", () => {
    const result = validateAgentFindings(deleteKey("label"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("label");
  });

  it("rejects a finding where 'label' is not in the enum", () => {
    const result = validateAgentFindings(base({ label: "blocker" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("label");
  });

  it("rejects a finding missing 'decoration'", () => {
    const result = validateAgentFindings(deleteKey("decoration"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("decoration");
  });

  it("rejects a finding where 'decoration' is not in the enum", () => {
    const result = validateAgentFindings(base({ decoration: "urgent" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("decoration");
  });

  it("rejects a finding missing 'confidence'", () => {
    const result = validateAgentFindings(deleteKey("confidence"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("confidence");
  });

  it("rejects a finding where 'confidence' is not a number", () => {
    const result = validateAgentFindings(base({ confidence: "85" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("confidence");
  });

  it("rejects a finding where 'confidence' is < 0", () => {
    const result = validateAgentFindings(base({ confidence: -5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("confidence");
  });

  it("rejects a finding where 'confidence' is > 100", () => {
    const result = validateAgentFindings(base({ confidence: 101 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("confidence");
  });

  it("rejects a finding missing 'subject'", () => {
    const result = validateAgentFindings(deleteKey("subject"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("subject");
  });

  it("rejects a finding where 'subject' is an empty string", () => {
    const result = validateAgentFindings(base({ subject: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("subject");
  });

  it("rejects a finding where 'file' is an empty string", () => {
    const result = validateAgentFindings(base({ file: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("file");
  });

  it("rejects a finding missing 'body'", () => {
    const result = validateAgentFindings(deleteKey("body"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("body");
  });

  it("rejects a finding where 'end_line' is present but not a number", () => {
    const result = validateAgentFindings(base({ end_line: "45" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("end_line");
  });

  it("rejects a finding where 'end_line' is present and negative", () => {
    const result = validateAgentFindings(base({ end_line: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("end_line");
  });
});

describe("agent-finding-schema CLI — `--validate <path>`", () => {
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
    withTmpFile(JSON.stringify({ not: "an array" }), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stderr.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBeDefined();
    });
  });

  it("exits 0 with {ok: true} on stdout for a well-formed agent output", () => {
    withTmpFile(JSON.stringify(VALID_FULL), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(result.stderr).toBe("");
    });
  });

  it("exits 0 for a well-formed empty-array agent output (zero findings)", () => {
    withTmpFile(JSON.stringify(VALID_EMPTY), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(true);
    });
  });
});
