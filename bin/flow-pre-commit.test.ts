/**
 * Tests for flow-pre-commit.ts
 */

import { describe, expect, it, vi } from "vitest";
import {
  checksForScope,
  detectScopesFromFiles,
  filterDefinedChecks,
  formatReport,
  getChangedFilesForPush,
  parsePrePushInput,
  parseScopes,
  type CheckReport,
  type CheckResult,
  type GitOps,
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

  it("should ignore files outside known scopes", () => {
    expect(detectScopesFromFiles(["AGENTS.md", ".claude/skills/tailwind-shadcn/SKILL.md"])).toEqual(
      [],
    );
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
    expect(detectScopesFromFiles(["docs/src/guide.md"])).toEqual([]);
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
});
