import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  mergeScopeFields,
  validatePrReviewResult,
  type PrReviewResult,
} from "./pr-review-result-schema";

const SCHEMA_SCRIPT = path.resolve(__dirname, "pr-review-result-schema.ts");

function runCli(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("bun", [SCHEMA_SCRIPT, ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function withTmpFile(contents: string, fn: (filePath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-review-schema-test-"));
  const filePath = path.join(dir, "artifact.json");
  writeFileSync(filePath, contents, "utf8");
  try {
    fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withScopeAndResult(
  scopeContents: string,
  resultContents: string,
  fn: (scopePath: string, resultPath: string) => void,
): void {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-review-schema-merge-test-"));
  const scopePath = path.join(dir, "review-scope.json");
  const resultPath = path.join(dir, "pr-review-result.json");
  writeFileSync(scopePath, scopeContents, "utf8");
  writeFileSync(resultPath, resultContents, "utf8");
  try {
    fn(scopePath, resultPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Contract tests for the `/flow-pr-review` wrapper-level result artifact at
 * `<worktree>/.flow-tmp/pr-review-result.json`.
 *
 * The artifact is the single signal `/flow-pipeline` step 8 reads to
 * decide whether to continue (`status: "clean"`), branch into the
 * partial-retry path (`status: "partial"`), or propagate an escalation
 * tag verbatim (`status: "escalated"`). These tests pin the shape of
 * each status so a future schema drift can't silently break the
 * supervisor's branch logic.
 */

const VALID_CLEAN: unknown = {
  status: "clean",
  completed_steps: [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "7.5",
    "8",
    "8c",
    "9",
    "10",
    "11",
    "12",
    "13",
  ],
  missed_steps: [],
  escalation_tag: null,
  summary:
    "All 13 steps completed (3 findings auto-fixed, 1 deferred); multi-agent review surfaced 4 findings above the 80-confidence bar; PR description quality check passed.",
};

const VALID_PARTIAL: unknown = {
  status: "partial",
  completed_steps: ["1", "2", "3", "4", "5", "6", "7", "7.5"],
  missed_steps: ["8", "8c", "9", "10", "11", "12", "13"],
  escalation_tag: null,
  summary:
    "Multi-agent review completed but the wrapper terminated before Step 8's Fix-Applier spawn due to a user redirect; 4 findings recorded but never addressed.",
};

const VALID_ESCALATED: unknown = {
  status: "escalated",
  completed_steps: ["1", "2"],
  missed_steps: [
    "3",
    "4",
    "5",
    "6",
    "7",
    "7.5",
    "8",
    "8c",
    "9",
    "10",
    "11",
    "12",
    "13",
  ],
  escalation_tag: "task-tool-unavailable: pr-review-fix-applier",
  summary:
    "Bailed at the Fix-Applier spawn-site preamble — neither Task nor Agent surfaced top-level in this session; supervisor must restart in a session where the alias is available.",
};

describe("validatePrReviewResult — happy paths", () => {
  it("accepts a fully-populated clean artifact", () => {
    const result = validatePrReviewResult(VALID_CLEAN);
    expect(result.ok).toBe(true);
  });

  it("accepts a partial artifact with non-empty missed_steps and null escalation_tag", () => {
    const result = validatePrReviewResult(VALID_PARTIAL);
    expect(result.ok).toBe(true);
  });

  it("accepts an escalated artifact with non-null escalation_tag", () => {
    const result = validatePrReviewResult(VALID_ESCALATED);
    expect(result.ok).toBe(true);
  });

  it("accepts an artifact with empty completed_steps (extreme escalation early in Step 1)", () => {
    const fixture = structuredClone(VALID_ESCALATED) as Record<string, unknown>;
    fixture.completed_steps = [];
    const result = validatePrReviewResult(fixture);
    expect(result.ok).toBe(true);
  });
});

describe("validatePrReviewResult — required-key omissions", () => {
  it.each([
    "status",
    "completed_steps",
    "missed_steps",
    "escalation_tag",
    "summary",
  ])("rejects an artifact missing the '%s' top-level key", (key) => {
    const fixture = structuredClone(VALID_CLEAN) as Record<string, unknown>;
    delete fixture[key];
    const result = validatePrReviewResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(key);
    }
  });
});

describe("validatePrReviewResult — wrong-type rejections", () => {
  it("rejects a non-object input", () => {
    expect(validatePrReviewResult(null).ok).toBe(false);
    expect(validatePrReviewResult([]).ok).toBe(false);
    expect(validatePrReviewResult("string").ok).toBe(false);
    expect(validatePrReviewResult(42).ok).toBe(false);
  });

  it("rejects an artifact where summary is empty string", () => {
    const fixture = structuredClone(VALID_CLEAN) as Record<string, unknown>;
    fixture.summary = "";
    const result = validatePrReviewResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("summary");
    }
  });

  it("rejects an artifact where status is not one of clean/partial/escalated", () => {
    const fixture = structuredClone(VALID_CLEAN) as Record<string, unknown>;
    fixture.status = "in-progress";
    const result = validatePrReviewResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("status");
    }
  });

  it("rejects an artifact where status is not a string", () => {
    const fixture = structuredClone(VALID_CLEAN) as Record<string, unknown>;
    fixture.status = 1;
    const result = validatePrReviewResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("status");
    }
  });

  it.each(["completed_steps", "missed_steps"])(
    "rejects an artifact where '%s' is not an array",
    (key) => {
      const fixture = structuredClone(VALID_CLEAN) as Record<string, unknown>;
      fixture[key] = "not an array";
      const result = validatePrReviewResult(fixture);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(key);
      }
    },
  );

  it.each(["completed_steps", "missed_steps"])(
    "rejects an artifact where '%s' contains non-string entries",
    (key) => {
      const fixture = structuredClone(VALID_CLEAN) as Record<string, unknown>;
      fixture[key] = [1, 2, 3];
      const result = validatePrReviewResult(fixture);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(key);
      }
    },
  );

  it("rejects an artifact where escalation_tag is a non-string non-null value", () => {
    const fixture = structuredClone(VALID_CLEAN) as Record<string, unknown>;
    fixture.escalation_tag = 42;
    const result = validatePrReviewResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("escalation_tag");
    }
  });
});

describe("validatePrReviewResult — design-choice pins (cross-field rules deliberately NOT enforced)", () => {
  it("accepts escalation_tag as empty string (permissive on content; prose contract enforces non-empty)", () => {
    const fixture = structuredClone(VALID_CLEAN) as Record<string, unknown>;
    fixture.escalation_tag = "";
    const result = validatePrReviewResult(fixture);
    expect(result.ok).toBe(true);
  });

  it("accepts escalation_tag set when status is 'clean' (no cross-field IFF rule)", () => {
    const fixture = structuredClone(VALID_CLEAN) as Record<string, unknown>;
    fixture.escalation_tag = "some-tag";
    const result = validatePrReviewResult(fixture);
    expect(result.ok).toBe(true);
  });

  it("accepts escalation_tag null when status is 'escalated' (no cross-field IFF rule)", () => {
    const fixture = structuredClone(VALID_ESCALATED) as Record<string, unknown>;
    fixture.escalation_tag = null;
    const result = validatePrReviewResult(fixture);
    expect(result.ok).toBe(true);
  });
});

describe("pr-review-result-schema CLI — `--validate <path>`", () => {
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
    const missingPath = path.join(
      tmpdir(),
      "definitely-does-not-exist-" + Date.now() + ".json",
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

  it("exits 1 with schema validation reason on stderr when the JSON is shape-invalid", () => {
    withTmpFile(JSON.stringify({ status: "in-progress" }), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stderr.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBeDefined();
    });
  });

  it("exits 0 with {ok: true} on stdout for a well-formed clean artifact", () => {
    withTmpFile(JSON.stringify(VALID_CLEAN), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(result.stderr).toBe("");
    });
  });

  it("exits 0 for a well-formed escalated artifact (covers all three status values)", () => {
    withTmpFile(JSON.stringify(VALID_ESCALATED), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(true);
    });
  });
});

describe("validatePrReviewResult — tier / tier_reasons (optional pass-through)", () => {
  it("accepts an artifact WITHOUT tier/tier_reasons (back-compat guard for the installed validator)", () => {
    const result = validatePrReviewResult(VALID_CLEAN);
    expect(result.ok).toBe(true);
  });

  it("accepts an artifact WITH valid tier and tier_reasons", () => {
    const fixture = {
      ...(VALID_CLEAN as Record<string, unknown>),
      tier: "light",
      tier_reasons: ["every signal low"],
    };
    const result = validatePrReviewResult(fixture);
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid tier string, naming the field", () => {
    const fixture = {
      ...(VALID_CLEAN as Record<string, unknown>),
      tier: "extreme",
    };
    const result = validatePrReviewResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("tier");
    }
  });

  it("rejects a non-string-array tier_reasons, naming the field", () => {
    const fixture = {
      ...(VALID_CLEAN as Record<string, unknown>),
      tier_reasons: "not an array",
    };
    const result = validatePrReviewResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("tier_reasons");
    }

    const fixture2 = {
      ...(VALID_CLEAN as Record<string, unknown>),
      tier_reasons: [1, 2],
    };
    const result2 = validatePrReviewResult(fixture2);
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.reason).toContain("tier_reasons");
    }
  });
});

describe("mergeScopeFields", () => {
  const baseResult = VALID_CLEAN as PrReviewResult;

  it("copies both tier and tier_reasons off a well-formed scope", () => {
    const merged = mergeScopeFields(baseResult, {
      tier: "deep",
      tier_reasons: ["security-sensitive path"],
    });
    expect(merged.tier).toBe("deep");
    expect(merged.tier_reasons).toEqual(["security-sensitive path"]);
  });

  it("is idempotent — re-running against the same scope produces the same fields", () => {
    const once = mergeScopeFields(baseResult, {
      tier: "standard",
      tier_reasons: ["default tier"],
    });
    const twice = mergeScopeFields(once, {
      tier: "standard",
      tier_reasons: ["default tier"],
    });
    expect(twice).toEqual(once);
  });

  it("returns the result unchanged for an absent scope", () => {
    const merged = mergeScopeFields(baseResult, undefined);
    expect(merged).toEqual(baseResult);
  });

  it("returns the result unchanged for a malformed scope (non-object, or bad-shaped fields)", () => {
    expect(mergeScopeFields(baseResult, "not an object")).toEqual(baseResult);
    expect(mergeScopeFields(baseResult, null)).toEqual(baseResult);
    expect(
      mergeScopeFields(baseResult, {
        tier: "extreme",
        tier_reasons: "not an array",
      }),
    ).toEqual(baseResult);
  });
});

describe("pr-review-result-schema CLI — `--merge-scope <scope> <result>`", () => {
  it("rewrites the result file in place with tier/tier_reasons copied from the scope", () => {
    withScopeAndResult(
      JSON.stringify({ tier: "light", tier_reasons: ["low risk"] }),
      JSON.stringify(VALID_CLEAN),
      (scopePath, resultPath) => {
        const result = runCli(["--merge-scope", scopePath, resultPath]);
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout.trim());
        expect(parsed).toEqual({ ok: true, tier: "light" });

        const rewritten = JSON.parse(readFileSync(resultPath, "utf8"));
        expect(rewritten.tier).toBe("light");
        expect(rewritten.tier_reasons).toEqual(["low risk"]);
        expect(rewritten.status).toBe("clean");
      },
    );
  });

  it("is idempotent — running twice produces the same file contents", () => {
    withScopeAndResult(
      JSON.stringify({ tier: "deep", tier_reasons: ["dependency change"] }),
      JSON.stringify(VALID_CLEAN),
      (scopePath, resultPath) => {
        runCli(["--merge-scope", scopePath, resultPath]);
        const first = readFileSync(resultPath, "utf8");
        runCli(["--merge-scope", scopePath, resultPath]);
        const second = readFileSync(resultPath, "utf8");
        expect(second).toBe(first);
      },
    );
  });

  it("tolerates a missing/malformed scope, leaving the result otherwise unchanged", () => {
    withScopeAndResult(
      "{ not valid json",
      JSON.stringify(VALID_CLEAN),
      (scopePath, resultPath) => {
        const result = runCli(["--merge-scope", scopePath, resultPath]);
        expect(result.status).toBe(0);
        const rewritten = JSON.parse(readFileSync(resultPath, "utf8"));
        expect(rewritten.tier).toBeUndefined();
        expect(rewritten.status).toBe("clean");
      },
    );
  });

  it("exits 2 with usage on stderr when --merge-scope is missing an argument", () => {
    const result = runCli(["--merge-scope", "/tmp/only-one-path.json"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
  });

  it("does not disturb --validate behaviour", () => {
    withTmpFile(JSON.stringify(VALID_CLEAN), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ ok: true });
    });
  });
});
