/**
 * Tests for flow-pre-commit.ts
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildFailureExcerpt,
  checksForScope,
  detectScopesFromFiles,
  filterDefinedChecks,
  formatJsonReport,
  formatReport,
  getChangedFilesForPush,
  parsePrePushInput,
  parseScopes,
  stripAnsi,
  type CheckReport,
  type CheckResult,
  type GitOps,
  type JsonReport,
  type PrePushRef,
  type Scope,
} from "./flow-pre-commit";

// --- Factories ---

function createResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    name: "npm run typecheck",
    scope: "src",
    passed: true,
    durationMs: 1234,
    output: "",
    ...overrides,
  };
}

function createReport(overrides: Partial<CheckReport> = {}): CheckReport {
  return {
    scopes: ["src"] as Scope[],
    results: [createResult()],
    allPassed: true,
    ...overrides,
  };
}

// --- Tests ---

describe(detectScopesFromFiles, () => {
  it("should detect src scope from src/ files", () => {
    expect(detectScopesFromFiles(["src/cli.ts"])).toEqual(["src"]);
  });

  it("should detect scripts scope from scripts/ files", () => {
    expect(detectScopesFromFiles(["scripts/fetch-pr-review.ts"])).toEqual(["scripts"]);
  });

  it("should detect scripts scope from templates/scripts/ files (flow's legacy script source)", () => {
    expect(detectScopesFromFiles(["templates/scripts/ci-wait.ts"])).toEqual(["scripts"]);
  });

  it("should detect scripts scope from bin/ files (flow's canonical helper binary source)", () => {
    expect(detectScopesFromFiles(["bin/flow-pre-commit.ts"])).toEqual(["scripts"]);
  });

  it("should detect multiple scopes from mixed files", () => {
    const files = ["src/index.ts", "scripts/build.ts"];
    expect(detectScopesFromFiles(files)).toEqual(["src", "scripts"]);
  });

  it("should fall back to root-fallback when files exist but no specific scope matched", () => {
    expect(detectScopesFromFiles(["package-lock.json", "vitest.config.ts"])).toEqual([
      "root-fallback",
    ]);
  });

  it("should detect root-fallback from apps/<pkg>/src/ monorepo paths", () => {
    expect(detectScopesFromFiles(["apps/web/src/index.ts"])).toEqual(["root-fallback"]);
  });

  it("should detect root-fallback from packages/<pkg>/src/ monorepo paths", () => {
    expect(detectScopesFromFiles(["packages/ui/src/Button.svelte"])).toEqual(["root-fallback"]);
  });

  it("should NOT fall back when at least one specific scope matched in a mixed diff", () => {
    expect(detectScopesFromFiles(["src/a.ts", "apps/web/src/b.ts"])).toEqual(["src"]);
  });

  it("should keep returning [] for an empty file list (regression-safe)", () => {
    expect(detectScopesFromFiles([])).toEqual([]);
  });

  it("should detect docs scope from a root-level .md file", () => {
    expect(detectScopesFromFiles(["AGENTS.md"])).toEqual(["docs"]);
  });

  it("should detect docs scope from a deeply-nested .md file", () => {
    expect(detectScopesFromFiles(["skills/stacks/svelte/SKILL.md"])).toEqual(["docs"]);
  });

  it("should detect both scripts and docs from a mixed change", () => {
    expect(detectScopesFromFiles(["bin/flow-md-validate.ts", "docs/x.md"])).toEqual([
      "scripts",
      "docs",
    ]);
  });

  it("should deduplicate scopes", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
    expect(detectScopesFromFiles(files)).toEqual(["src"]);
  });

  it("should return empty array for empty file list", () => {
    expect(detectScopesFromFiles([])).toEqual([]);
  });

  it("should handle deeply nested paths", () => {
    expect(detectScopesFromFiles(["src/pipeline/phases/worktree.ts"])).toEqual(["src"]);
  });

  it("should ignore files that contain but don't start with scope prefixes", () => {
    // The .md still trips docs scope; the embedded "src/" must not trip src.
    expect(detectScopesFromFiles(["docs/src/guide.md"])).toEqual(["docs"]);
  });
});

describe(parseScopes, () => {
  it("should parse a single scope", () => {
    expect(parseScopes("src")).toEqual(["src"]);
  });

  it("should parse comma-separated scopes", () => {
    expect(parseScopes("src,scripts")).toEqual(["src", "scripts"]);
  });

  it("should handle whitespace around commas", () => {
    expect(parseScopes("src , scripts")).toEqual(["src", "scripts"]);
  });

  it("should deduplicate repeated scopes", () => {
    expect(parseScopes("src,src")).toEqual(["src"]);
  });

  it("should throw on unknown scope", () => {
    expect(() => parseScopes("invalid")).toThrow('Unknown scope "invalid"');
  });

  it("should maintain canonical order regardless of input order", () => {
    expect(parseScopes("scripts,src")).toEqual(["src", "scripts"]);
  });

  it("should accept the docs scope", () => {
    expect(parseScopes("docs")).toEqual(["docs"]);
  });

  it("should round-trip src,scripts,docs", () => {
    expect(parseScopes("docs,scripts,src")).toEqual(["src", "scripts", "docs"]);
  });

  it("should accept the root-fallback pseudo-scope", () => {
    expect(parseScopes("root-fallback")).toEqual(["root-fallback"]);
  });
});

describe(checksForScope, () => {
  it("should return typecheck and test for src", () => {
    const checks = checksForScope("src");
    expect(checks).toHaveLength(2);
    expect(checks.map((c) => c.name)).toEqual(["npm run typecheck", "npm run test"]);
  });

  it("should return scripts typecheck and test for scripts", () => {
    const checks = checksForScope("scripts");
    expect(checks).toHaveLength(2);
    expect(checks.map((c) => c.name)).toEqual(["npm run typecheck:scripts", "npm run test"]);
  });

  it("should return flow-md-validate for docs", () => {
    const checks = checksForScope("docs");
    expect(checks).toEqual([{ name: "flow-md-validate .", argv: ["flow-md-validate", "."] }]);
  });

  it("should return typecheck and test for root-fallback", () => {
    const checks = checksForScope("root-fallback");
    expect(checks).toEqual([
      { name: "npm run typecheck", argv: ["npm", "run", "typecheck"] },
      { name: "npm run test", argv: ["npm", "run", "test"] },
    ]);
  });
});

describe(filterDefinedChecks, () => {
  it("keeps checks whose npm script is defined in package.json", () => {
    const checks = checksForScope("src");
    const defined = new Set(["typecheck", "test"]);
    expect(filterDefinedChecks(checks, defined)).toEqual(checks);
  });

  it("drops checks whose npm script is missing", () => {
    const checks = checksForScope("scripts");
    const defined = new Set(["test"]);
    const filtered = filterDefinedChecks(checks, defined);
    expect(filtered.map((c) => c.name)).toEqual(["npm run test"]);
  });

  it("drops everything when no relevant npm scripts are defined", () => {
    const checks = checksForScope("scripts");
    const defined = new Set<string>();
    expect(filterDefinedChecks(checks, defined)).toEqual([]);
  });

  it("passes through non-npm checks untouched", () => {
    const custom = [{ name: "eslint", argv: ["eslint", "."] }];
    expect(filterDefinedChecks(custom, new Set())).toEqual(custom);
  });
});

// --- Factories for pre-push ---

const ZERO_SHA = "0000000000000000000000000000000000000000";

function createRef(overrides: Partial<PrePushRef> = {}): PrePushRef {
  return {
    localRef: "refs/heads/my-branch",
    localSha: "abc1234",
    remoteRef: "refs/heads/my-branch",
    remoteSha: "def5678",
    ...overrides,
  };
}

function createMockGit(
  overrides: Partial<GitOps> & { files?: Record<string, string[]> } = {},
): GitOps {
  const files = overrides.files ?? {};
  return {
    mergeBase: overrides.mergeBase ?? (() => "base000"),
    diffFiles: overrides.diffFiles ?? ((range: string) => files[range] ?? []),
    defaultBranch: overrides.defaultBranch ?? (() => "main"),
  };
}

// --- Pre-Push Tests ---

describe(parsePrePushInput, () => {
  it("should parse a single ref line into a PrePushRef", () => {
    const input = "refs/heads/main abc123 refs/heads/main def456\n";
    expect(parsePrePushInput(input)).toEqual([
      {
        localRef: "refs/heads/main",
        localSha: "abc123",
        remoteRef: "refs/heads/main",
        remoteSha: "def456",
      },
    ]);
  });

  it("should parse multiple ref lines", () => {
    const input =
      "refs/heads/a aaa111 refs/heads/a bbb222\nrefs/heads/b ccc333 refs/heads/b ddd444\n";
    const result = parsePrePushInput(input);
    expect(result).toHaveLength(2);
    expect(result[0].localSha).toBe("aaa111");
    expect(result[1].localSha).toBe("ccc333");
  });

  it("should ignore empty lines and trailing newlines", () => {
    const input = "\nrefs/heads/main abc123 refs/heads/main def456\n\n\n";
    expect(parsePrePushInput(input)).toHaveLength(1);
  });

  it("should return empty array for empty input", () => {
    expect(parsePrePushInput("")).toEqual([]);
    expect(parsePrePushInput("\n\n")).toEqual([]);
  });

  it("should throw on malformed line with fewer than 4 tokens", () => {
    expect(() => parsePrePushInput("refs/heads/main abc123")).toThrow("Malformed pre-push input");
  });
});

describe(getChangedFilesForPush, () => {
  it("should return changed files for a normal ref update", () => {
    const refs = [createRef({ remoteSha: "old111", localSha: "new222" })];
    const git = createMockGit({ files: { "old111..new222": ["src/a.ts", "src/b.ts"] } });
    expect(getChangedFilesForPush(refs, git)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("should use merge-base with the detected default branch for new branches", () => {
    const refs = [createRef({ remoteSha: ZERO_SHA, localSha: "new222" })];
    const mergeBase = vi.fn().mockReturnValue("base000");
    const git = createMockGit({
      mergeBase,
      files: { "base000..new222": ["src/new-file.ts"] },
    });

    expect(getChangedFilesForPush(refs, git)).toEqual(["src/new-file.ts"]);
    expect(mergeBase).toHaveBeenCalledWith("main", "new222");
  });

  it("should honor a non-main default branch when computing new-branch diffs", () => {
    const refs = [createRef({ remoteSha: ZERO_SHA, localSha: "new222" })];
    const mergeBase = vi.fn().mockReturnValue("base000");
    const defaultBranch = vi.fn().mockReturnValue("master");
    const git = createMockGit({
      mergeBase,
      defaultBranch,
      files: { "base000..new222": ["src/new-file.ts"] },
    });

    expect(getChangedFilesForPush(refs, git)).toEqual(["src/new-file.ts"]);
    expect(defaultBranch).toHaveBeenCalled();
    expect(mergeBase).toHaveBeenCalledWith("master", "new222");
  });

  it("should skip delete refs where local sha is all zeros", () => {
    const refs = [createRef({ localSha: ZERO_SHA })];
    const diffFiles = vi.fn();
    const git = createMockGit({ diffFiles });

    expect(getChangedFilesForPush(refs, git)).toEqual([]);
    expect(diffFiles).not.toHaveBeenCalled();
  });

  it("should deduplicate files across multiple refs", () => {
    const refs = [
      createRef({ remoteSha: "a1", localSha: "a2", localRef: "refs/heads/branch-a" }),
      createRef({ remoteSha: "b1", localSha: "b2", localRef: "refs/heads/branch-b" }),
    ];
    const git = createMockGit({
      files: {
        "a1..a2": ["src/shared.ts", "src/a-only.ts"],
        "b1..b2": ["src/shared.ts", "src/b-only.ts"],
      },
    });

    const result = getChangedFilesForPush(refs, git);
    expect(result).toHaveLength(3);
    expect(result).toContain("src/shared.ts");
    expect(result).toContain("src/a-only.ts");
    expect(result).toContain("src/b-only.ts");
  });

  it("should return empty array for empty refs", () => {
    expect(getChangedFilesForPush([])).toEqual([]);
  });
});

describe(formatReport, () => {
  it("should show pass markers for all-passing report", () => {
    const report = createReport({
      results: [createResult({ passed: true }), createResult({ name: "npm run test", passed: true })],
    });
    const output = formatReport(report);
    expect(output).toContain("PASS");
    expect(output).not.toContain("FAIL");
    expect(output).toContain("All 2 checks passed.");
  });

  it("should show fail markers and output for failed checks", () => {
    const report = createReport({
      allPassed: false,
      results: [createResult({ passed: false, output: "Error: type mismatch on line 42" })],
    });
    const output = formatReport(report);
    expect(output).toContain("FAIL");
    expect(output).toContain("Error: type mismatch on line 42");
    expect(output).toContain("0/1 checks passed.");
  });

  it("should show mixed results correctly", () => {
    const report = createReport({
      allPassed: false,
      results: [
        createResult({ name: "npm run typecheck", passed: true }),
        createResult({ name: "npm run test", passed: false, output: "test error" }),
      ],
    });
    const output = formatReport(report);
    expect(output).toContain("1/2 checks passed.");
  });

  it("should handle empty scopes with nothing-to-check message", () => {
    const report = createReport({ scopes: [], results: [] });
    const output = formatReport(report);
    expect(output).toContain("No relevant scopes detected — nothing to check.");
    expect(output).toContain("No checks ran.");
  });

  it("should show duration in milliseconds for short checks", () => {
    const report = createReport({ results: [createResult({ durationMs: 500 })] });
    const output = formatReport(report);
    expect(output).toContain("500ms");
  });

  it("should show duration in seconds for long checks", () => {
    const report = createReport({ results: [createResult({ durationMs: 12500 })] });
    const output = formatReport(report);
    expect(output).toContain("12.5s");
  });

  it("should list detected scopes", () => {
    const report = createReport({ scopes: ["src", "scripts"] as Scope[] });
    const output = formatReport(report);
    expect(output).toContain("Scopes: src, scripts");
  });

  it("enumerates considered scopes with skip reasons on a no-op", () => {
    const report = createReport({
      scopes: [],
      results: [],
      changedFiles: ["docs/foo.md", "README.md", "package.json"],
    });
    const output = formatReport(report);
    expect(output).toContain("3 changed files; checking scopes…");
    expect(output).toContain("src");
    expect(output).toContain("scripts");
    expect(output).toContain("no changes under src/");
    expect(output).toContain("no changes under scripts/");
    expect(output).toContain("No relevant scopes detected — nothing to check.");
  });

  it("uses singular 'changed file' when exactly one file changed", () => {
    const report = createReport({
      scopes: [],
      results: [],
      changedFiles: ["docs/only.md"],
    });
    expect(formatReport(report)).toContain("1 changed file;");
  });

  it("annotates matched scopes with → matched on the success path", () => {
    const report = createReport({
      scopes: ["src", "scripts"] as Scope[],
      results: [createResult({ scope: "src", passed: true })],
      changedFiles: ["src/index.ts", "scripts/x.ts"],
    });
    const output = formatReport(report);
    expect(output).toContain("src      → matched");
    expect(output).toContain("scripts  → matched");
  });

  it("annotates only the matched scopes when others were unchanged", () => {
    const report = createReport({
      scopes: ["src"] as Scope[],
      results: [createResult({ scope: "src", passed: true })],
      changedFiles: ["src/index.ts"],
    });
    const output = formatReport(report);
    expect(output).toContain("src      → matched");
    expect(output).toContain("scripts  — no changes under scripts/");
  });

  it("falls back to the explicit-scopes preamble when no diff is available", () => {
    const report = createReport({
      scopes: ["src"] as Scope[],
      results: [createResult({ scope: "src", passed: true })],
      // no changedFiles — exercising the --scope path
    });
    const output = formatReport(report);
    expect(output).toContain("checking explicitly-requested scopes…");
    expect(output).not.toContain("changed file");
  });

  it("shows an Unmatched files section listing unclaimed paths", () => {
    const report = createReport({
      scopes: ["root-fallback"] as Scope[],
      results: [],
      allPassed: false,
      changedFiles: ["apps/web/src/x.ts", "vendor/y.js"],
      unmatchedFiles: ["apps/web/src/x.ts", "vendor/y.js"],
      reason: "no-checks-defined",
    });
    const output = formatReport(report);
    expect(output).toContain("Unmatched files (2):");
    expect(output).toContain("apps/web/src/x.ts");
    expect(output).toContain("vendor/y.js");
  });

  it("shows root-fallback line in preamble only when fallback fires", () => {
    const withFallback = formatReport(
      createReport({
        scopes: ["root-fallback"] as Scope[],
        results: [],
        allPassed: false,
        changedFiles: ["apps/web/src/x.ts"],
        unmatchedFiles: ["apps/web/src/x.ts"],
        reason: "no-checks-defined",
      }),
    );
    expect(withFallback).toContain("root-fallback → matched");

    const withoutFallback = formatReport(
      createReport({
        scopes: ["src"] as Scope[],
        results: [createResult({ scope: "src", passed: true })],
        changedFiles: ["src/index.ts"],
      }),
    );
    expect(withoutFallback).not.toContain("root-fallback → matched");
  });

  it("shows distinct no-checks-ran message when reason is no-checks-defined", () => {
    const noChecksDefined = formatReport(
      createReport({
        scopes: ["root-fallback"] as Scope[],
        results: [],
        allPassed: false,
        changedFiles: ["apps/web/src/x.ts"],
        reason: "no-checks-defined",
      }),
    );
    expect(noChecksDefined).toContain(
      "No checks ran (no matching npm scripts defined in package.json).",
    );

    // Empty-diff no-op (no reason set) keeps the original message
    const emptyDiffNoOp = formatReport(
      createReport({
        scopes: [],
        results: [],
        changedFiles: [],
      }),
    );
    expect(emptyDiffNoOp).toContain("No checks ran.");
    expect(emptyDiffNoOp).not.toContain("no matching npm scripts");
  });
});

describe(stripAnsi, () => {
  it("removes a simple ANSI color sequence", () => {
    expect(stripAnsi("\x1b[31mFAIL\x1b[0m foo")).toBe("FAIL foo");
  });

  it("preserves non-ANSI text untouched", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });

  it("removes cursor-movement and erase sequences", () => {
    expect(stripAnsi("\x1b[2K\x1b[1Aretry")).toBe("retry");
  });

  it("replaces non-printable control bytes with replacement char", () => {
    // \x00 (NUL) and \x07 (BEL) are control bytes; \n and \t are preserved.
    const cleaned = stripAnsi("a\x00b\nc\td\x07e");
    expect(cleaned).toBe("a�b\nc\td�e");
  });
});

describe(buildFailureExcerpt, () => {
  it("returns the full output when total lines fit head+tail budget", () => {
    const output = "line 1\nline 2\nERROR: kaboom";
    const excerpt = buildFailureExcerpt(output);
    expect(excerpt.totalLines).toBe(3);
    expect(excerpt.headExcerpt).toBe("line 1\nline 2\nERROR: kaboom");
    expect(excerpt.tailExcerpt).toBe("");
  });

  it("caps head and tail at HEAD_LINES + TAIL_LINES on long output", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`);
    const excerpt = buildFailureExcerpt(lines.join("\n"));
    expect(excerpt.totalLines).toBe(5000);
    // Head 100 lines, tail 100 lines.
    expect(excerpt.headExcerpt.split("\n")).toHaveLength(100);
    expect(excerpt.tailExcerpt.split("\n")).toHaveLength(100);
    expect(excerpt.headExcerpt.split("\n")[0]).toBe("line 1");
    expect(excerpt.headExcerpt.split("\n")[99]).toBe("line 100");
    expect(excerpt.tailExcerpt.split("\n")[0]).toBe("line 4901");
    expect(excerpt.tailExcerpt.split("\n")[99]).toBe("line 5000");
  });

  it("locates the first error line by 1-based index", () => {
    const output = "compiling…\ndone\n\nFAIL  src/foo.test.ts > should bar\n  details";
    const excerpt = buildFailureExcerpt(output);
    expect(excerpt.firstErrorLine).toBe(4);
    expect(excerpt.firstErrorText).toBe("FAIL  src/foo.test.ts > should bar");
  });

  it("matches the ✗ failure marker even though it has no word boundary", () => {
    const output = "ok\n✗ should foo\n";
    const excerpt = buildFailureExcerpt(output);
    expect(excerpt.firstErrorLine).toBe(2);
    expect(excerpt.firstErrorText).toBe("✗ should foo");
  });

  it("strips ANSI color sequences before excerpting and matching", () => {
    const output = "\x1b[31mFAIL\x1b[0m boom\nrest";
    const excerpt = buildFailureExcerpt(output);
    expect(excerpt.firstErrorText).toBe("FAIL boom");
    expect(excerpt.headExcerpt).not.toContain("\x1b[");
  });

  it("trims firstErrorText to 500 chars", () => {
    const long = "FAIL " + "x".repeat(2000);
    const excerpt = buildFailureExcerpt(long);
    expect(excerpt.firstErrorText.length).toBe(500);
    expect(excerpt.firstErrorText.startsWith("FAIL ")).toBe(true);
  });

  it("returns null firstErrorLine when no error marker is present", () => {
    const excerpt = buildFailureExcerpt("just\ntwo\nlines");
    expect(excerpt.firstErrorLine).toBeNull();
    expect(excerpt.firstErrorText).toBe("");
  });

  it("does not count a trailing newline as an extra empty line", () => {
    const excerpt = buildFailureExcerpt("a\nb\nc\n");
    expect(excerpt.totalLines).toBe(3);
  });
});

describe(formatJsonReport, () => {
  it("emits a parseable JSON object for an all-passing report", () => {
    const report = createReport({
      results: [createResult({ passed: true })],
    });
    const parsed = JSON.parse(formatJsonReport(report)) as JsonReport;
    expect(parsed.allPassed).toBe(true);
    expect(parsed.results[0].passed).toBe(true);
    expect(parsed.results[0].failure).toBeUndefined();
  });

  it("includes a bounded failure excerpt on failed checks", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
    const report = createReport({
      allPassed: false,
      results: [createResult({ passed: false, output: `${huge}\nFAIL  src/foo.test.ts` })],
    });
    const parsed = JSON.parse(formatJsonReport(report)) as JsonReport;
    expect(parsed.results[0].passed).toBe(false);
    const failure = parsed.results[0].failure;
    expect(failure).toBeDefined();
    expect(failure!.totalLines).toBe(5001);
    // head + tail capped at 100 each.
    expect(failure!.headExcerpt.split("\n")).toHaveLength(100);
    expect(failure!.tailExcerpt.split("\n")).toHaveLength(100);
    expect(failure!.firstErrorText).toBe("FAIL  src/foo.test.ts");
  });

  it("omits the failure field for passing checks even on a mixed report", () => {
    const report = createReport({
      allPassed: false,
      results: [
        createResult({ name: "npm run typecheck", passed: true }),
        createResult({ name: "npm run test", passed: false, output: "FAIL boom" }),
      ],
    });
    const parsed = JSON.parse(formatJsonReport(report)) as JsonReport;
    expect(parsed.results[0].failure).toBeUndefined();
    expect(parsed.results[1].failure).toBeDefined();
  });

  it("preserves changedFiles when present", () => {
    const report = createReport({
      changedFiles: ["src/a.ts", "src/b.ts"],
    });
    const parsed = JSON.parse(formatJsonReport(report)) as JsonReport;
    expect(parsed.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("omits changedFiles entirely when undefined (the --scope path)", () => {
    const report = createReport({}); // changedFiles defaults to undefined
    const parsed = JSON.parse(formatJsonReport(report)) as JsonReport;
    expect(parsed).not.toHaveProperty("changedFiles");
  });

  it("includes unmatchedFiles when populated", () => {
    const report = createReport({
      unmatchedFiles: ["apps/web/src/x.ts", "vendor/y.js"],
    });
    const parsed = JSON.parse(formatJsonReport(report)) as JsonReport;
    expect(parsed.unmatchedFiles).toEqual(["apps/web/src/x.ts", "vendor/y.js"]);
  });

  it("omits unmatchedFiles when undefined or an empty array", () => {
    const parsedUndef = JSON.parse(formatJsonReport(createReport({}))) as JsonReport;
    expect(parsedUndef).not.toHaveProperty("unmatchedFiles");

    const parsedEmpty = JSON.parse(
      formatJsonReport(createReport({ unmatchedFiles: [] })),
    ) as JsonReport;
    expect(parsedEmpty).not.toHaveProperty("unmatchedFiles");
  });

  it("emits the reason field when set to no-checks-defined and omits it otherwise", () => {
    const withReason = JSON.parse(
      formatJsonReport(
        createReport({
          scopes: ["root-fallback"] as Scope[],
          results: [],
          allPassed: false,
          changedFiles: ["apps/web/src/x.ts"],
          reason: "no-checks-defined",
        }),
      ),
    ) as JsonReport;
    expect(withReason.reason).toBe("no-checks-defined");

    const withoutReason = JSON.parse(formatJsonReport(createReport({}))) as JsonReport;
    expect(withoutReason).not.toHaveProperty("reason");
  });
});
