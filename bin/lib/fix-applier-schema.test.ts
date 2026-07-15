import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { validateFixApplierResult } from "./fix-applier-schema";
import { collectFixApplierTolerant } from "./fix-applier-tolerant";

const SCHEMA_SCRIPT = path.resolve(__dirname, "fix-applier-schema.ts");

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
  const dir = mkdtempSync(path.join(tmpdir(), "fix-applier-schema-test-"));
  const filePath = path.join(dir, "artifact.json");
  writeFileSync(filePath, contents, "utf8");
  try {
    fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
      reason:
        "Pattern-Consistency: cross-cutting refactor; >3 files; bar criterion 2",
    },
  ],
  rejected_alternatives: [
    {
      finding_id: "f-7",
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
      introduced_by_this_pr: false,
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
    (fixture.deferred as Array<Record<string, unknown>>)[0].tracker_entry_url =
      "";
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

  it("accepts an artifact WITH a top-level ui_screenshots string array", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture.ui_screenshots = ["/abs/1.png", "/abs/2.png"];
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(true);
  });

  it("accepts an artifact WITHOUT ui_screenshots (field absent)", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    expect("ui_screenshots" in fixture).toBe(false);
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
    (fixture.deferred as Array<Record<string, unknown>>)[0].tracker_entry_url =
      null;
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

  it("rejects an anti_patterns_found[] entry missing 'location'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.anti_patterns_found as Array<Record<string, unknown>>)[0]
      .location;
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("location");
    }
  });

  it("rejects an anti_patterns_found[] entry missing 'pattern'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.anti_patterns_found as Array<Record<string, unknown>>)[0]
      .pattern;
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("pattern");
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

  it("rejects an anti_patterns_found[] entry missing 'introduced_by_this_pr'", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.anti_patterns_found as Array<Record<string, unknown>>)[0]
      .introduced_by_this_pr;
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("introduced_by_this_pr");
    }
  });

  it("rejects an anti_patterns_found[] entry where 'introduced_by_this_pr' is not a boolean", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    (
      fixture.anti_patterns_found as Array<Record<string, unknown>>
    )[0].introduced_by_this_pr = "true";
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("introduced_by_this_pr");
    }
  });

  it("rejects an artifact where ui_screenshots is not an array", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture.ui_screenshots = "not-an-array";
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("ui_screenshots");
    }
  });

  it("rejects an artifact where ui_screenshots contains a non-string/empty-string element", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture.ui_screenshots = ["/abs/1.png", ""];
    const result = validateFixApplierResult(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("ui_screenshots");
    }
  });
});

describe("collectFixApplierTolerant — per-entry resilience", () => {
  it("returns every entry with skipped=0 for a well-formed artifact", () => {
    const out = collectFixApplierTolerant(VALID_FULL);
    expect(out).not.toBeNull();
    expect(out!.skipped).toBe(0);
    expect(out!.commits).toHaveLength(1);
    expect(out!.deferred).toHaveLength(1);
    expect(out!.rejected_alternatives).toHaveLength(1);
    expect(out!.anti_patterns_found).toHaveLength(1);
    expect(out!.summary).toBe((VALID_FULL as Record<string, unknown>).summary);
  });

  it("drops one off-shape anti_patterns_found entry with skipped=1 and does NOT invent the missing field", () => {
    // One anti_patterns_found entry is missing `introduced_by_this_pr`; the
    // valid commits/deferred/rejected_alternatives must all survive intact.
    const full = VALID_FULL as Record<string, unknown>;
    const fixture = {
      commits: full.commits,
      deferred: full.deferred,
      rejected_alternatives: full.rejected_alternatives,
      anti_patterns_found: [
        {
          location: "src/bar.ts:42",
          pattern: "untyped any in public function signature",
          recommendation: "tighten the param type",
          // introduced_by_this_pr intentionally absent.
        },
        {
          location: "src/baz.ts:7",
          pattern: "magic number",
          recommendation: "extract a named constant",
          introduced_by_this_pr: true,
        },
      ],
      summary: "one bad anti-pattern entry, the rest valid",
    };
    const out = collectFixApplierTolerant(fixture);
    expect(out).not.toBeNull();
    expect(out!.skipped).toBe(1);
    expect(out!.commits).toHaveLength(1);
    expect(out!.deferred).toHaveLength(1);
    expect(out!.rejected_alternatives).toHaveLength(1);
    // Only the well-formed anti-pattern survives; the missing field is never
    // fabricated onto the dropped entry.
    expect(out!.anti_patterns_found).toHaveLength(1);
    expect(out!.anti_patterns_found[0].location).toBe("src/baz.ts:7");
    for (const a of out!.anti_patterns_found) {
      expect(typeof a.introduced_by_this_pr).toBe("boolean");
    }

    // The strict validator still REJECTS the same artifact (proving the strict
    // path is byte-for-byte unchanged).
    const strict = validateFixApplierResult(fixture);
    expect(strict.ok).toBe(false);
    if (!strict.ok) {
      expect(strict.reason).toContain("introduced_by_this_pr");
    }
  });

  it("drops an off-shape entry from a NON-anti_patterns_found array (commits) and keeps siblings", () => {
    // A bad `commits[]` entry (missing `sha`) exercises the `validateCommitEntry`
    // branch of `collectValid` — proving the four per-entry validators are
    // wired to the right arrays, not all pointed at anti_patterns_found.
    const fixture = {
      commits: [
        {
          // sha intentionally absent — off-shape.
          files: ["src/x.ts"],
          finding_id: "f-bad",
          reasoning: "missing sha",
          verify_status: "pass",
        },
        {
          sha: "abc1234",
          files: ["src/y.ts"],
          finding_id: "f-good",
          reasoning: "well-formed commit",
          verify_status: "pass",
        },
      ],
      deferred: [],
      rejected_alternatives: [],
      anti_patterns_found: [],
      summary: "one bad commit entry, the rest valid",
    };
    const out = collectFixApplierTolerant(fixture);
    expect(out).not.toBeNull();
    expect(out!.skipped).toBe(1);
    expect(out!.commits).toHaveLength(1);
    expect(out!.commits[0].sha).toBe("abc1234");
    // The off-shape entry's count came from the commits branch, while the
    // sibling arrays stayed empty — so the validators are array-correct.
    expect(out!.deferred).toHaveLength(0);
    expect(out!.rejected_alternatives).toHaveLength(0);
    expect(out!.anti_patterns_found).toHaveLength(0);
  });

  it("accumulates skipped across MULTIPLE arrays (deferred + rejected_alternatives) into a cumulative count", () => {
    // One bad `deferred[]` entry AND one bad `rejected_alternatives[]` entry:
    // the count must be cumulative (2), not per-array (1), pinning the
    // multi-drop / multi-array math the (N unreadable) marker interpolates.
    const fixture = {
      commits: [],
      deferred: [
        {
          finding_id: "d-bad",
          // tracker_entry_url intentionally absent — off-shape.
          reason: "missing tracker_entry_url",
        },
        {
          finding_id: "d-good",
          tracker_entry_url: "",
          reason: "well-formed deferral",
        },
      ],
      rejected_alternatives: [
        {
          finding_id: "r-bad",
          considered_approach: "tried X",
          // why_rejected intentionally absent — off-shape.
        },
      ],
      anti_patterns_found: [],
      summary: "two bad entries across two arrays",
    };
    const out = collectFixApplierTolerant(fixture);
    expect(out).not.toBeNull();
    expect(out!.skipped).toBe(2);
    expect(out!.deferred).toHaveLength(1);
    expect(out!.deferred[0].finding_id).toBe("d-good");
    expect(out!.rejected_alternatives).toHaveLength(0);
  });

  it("returns empty arrays + skipped>0 (NOT null) when EVERY array entry is off-shape but top-level keys are present", () => {
    // The seam between genuinely-broken (-> null -> whole-source unreadable)
    // and partial (-> empty arrays + marker). All top-level keys present and
    // well-typed, but every array entry is off-shape.
    const fixture = {
      commits: [
        { files: [], finding_id: "c", reasoning: "r", verify_status: "pass" },
      ],
      deferred: [{ finding_id: "d", reason: "no url" }],
      rejected_alternatives: [{ finding_id: "r", considered_approach: "a" }],
      anti_patterns_found: [
        { location: "x.ts:1", pattern: "p", recommendation: "fix" },
      ],
      summary: "every entry off-shape, all top-level keys present",
    };
    const out = collectFixApplierTolerant(fixture);
    // NOT null: the artifact is partial, not genuinely broken.
    expect(out).not.toBeNull();
    expect(out!.skipped).toBe(4);
    expect(out!.commits).toHaveLength(0);
    expect(out!.deferred).toHaveLength(0);
    expect(out!.rejected_alternatives).toHaveLength(0);
    expect(out!.anti_patterns_found).toHaveLength(0);
  });

  it("returns null for a genuinely-broken artifact (non-object)", () => {
    expect(collectFixApplierTolerant(null)).toBeNull();
    expect(collectFixApplierTolerant([])).toBeNull();
    expect(collectFixApplierTolerant("string")).toBeNull();
    expect(collectFixApplierTolerant(42)).toBeNull();
  });

  it.each([
    "commits",
    "deferred",
    "rejected_alternatives",
    "anti_patterns_found",
    "summary",
  ])("returns null when the required top-level key '%s' is absent", (key) => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete fixture[key];
    expect(collectFixApplierTolerant(fixture)).toBeNull();
  });

  it("returns null when a required array key is the wrong container type", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture.commits = "not an array";
    expect(collectFixApplierTolerant(fixture)).toBeNull();
  });
});

describe("fix-applier-schema CLI — `--validate <path>`", () => {
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
      "fix-applier-missing-" + Date.now() + ".json",
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

  it("exits 0 with {ok: true} on stdout for a well-formed fix-applier artifact", () => {
    withTmpFile(JSON.stringify(VALID_FULL), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(result.stderr).toBe("");
    });
  });

  it("exits 1 on the canonical drift — an anti_patterns_found entry missing introduced_by_this_pr", () => {
    // Derive the off-shape fixture by deleting `introduced_by_this_pr` from a
    // valid anti_patterns_found entry — the most common Fix-Applier drift.
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete (fixture.anti_patterns_found as Array<Record<string, unknown>>)[0]
      .introduced_by_this_pr;
    withTmpFile(JSON.stringify(fixture), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stderr.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain("introduced_by_this_pr");
      expect(parsed.path).toBe(filePath);
    });
  });
});
