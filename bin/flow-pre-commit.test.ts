/**
 * Tests for flow-pre-commit.ts
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFailureExcerpt,
  checkHelperExecutableModes,
  checksForScope,
  computeAllPassedAndReason,
  computeUnmatchedAfterDynamic,
  computeUnmatchedFiles,
  detectScopesFromFiles,
  filterDefinedChecks,
  findNonExecutableHelpers,
  formatJsonReport,
  formatReport,
  getChangedFilesForPush,
  isExecutableLibModule,
  isTestCheck,
  parseLsFilesModes,
  parsePrePushInput,
  parseScopes,
  resolveDefaultScopeFiles,
  resolveTestConcurrency,
  runCheck,
  stripAnsi,
  type CheckReport,
  type CheckResult,
  type GitModeEntry,
  type GitOps,
  type JsonReport,
  type PrePushRef,
  type Runner,
  type Scope,
} from "./flow-pre-commit";
import {
  detectWorkspaceScopes,
  draftConfigEntryForOrphans,
  readMonorepoConfig,
  type DynamicScope,
} from "./lib/monorepo-scopes";
import { type ReadPackageJson } from "./lib/stack-table";
import { isPathBoundHelper } from "./lib/sources";

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
    expect(detectScopesFromFiles(["scripts/fetch-pr-review.ts"])).toEqual([
      "scripts",
    ]);
  });

  it("should detect scripts scope from templates/scripts/ files (flow's legacy script source)", () => {
    expect(detectScopesFromFiles(["templates/scripts/ci-wait.ts"])).toEqual([
      "scripts",
    ]);
  });

  it("should detect scripts scope from bin/ files (flow's canonical helper binary source)", () => {
    expect(detectScopesFromFiles(["bin/flow-pre-commit.ts"])).toEqual([
      "scripts",
    ]);
  });

  it("should detect BOTH scripts and actions scopes from .github/workflows/*.yml files (regression: workflow YAML edits trip the bin/ vitest workflow-shape regression suite AND actionlint coverage — different defect classes)", () => {
    expect(
      detectScopesFromFiles([".github/workflows/cloudflare-pages-prune.yml"]),
    ).toEqual(["scripts", "actions"]);
  });

  it("should detect both scripts and actions for .github/workflows/*.yaml (extension variant)", () => {
    expect(detectScopesFromFiles([".github/workflows/release.yaml"])).toEqual([
      "scripts",
      "actions",
    ]);
  });

  it("should NOT trip actions for .github/workflows-archive/foo.yml (prefix exactness — `.startsWith('.github/workflows/')` is false for `.github/workflows-archive/`, so the file lands in root-fallback)", () => {
    expect(
      detectScopesFromFiles([".github/workflows-archive/foo.yml"]),
    ).toEqual(["root-fallback"]);
  });

  it("should NOT trip actions for .github/workflows/notes.md (extension exactness — .md doesn't match .yml/.yaml; the file still trips scripts via prefix and docs via .md extension)", () => {
    expect(detectScopesFromFiles([".github/workflows/notes.md"])).toEqual([
      "scripts",
      "docs",
    ]);
  });

  it("should detect multiple scopes from mixed files", () => {
    const files = ["src/index.ts", "scripts/build.ts"];
    expect(detectScopesFromFiles(files)).toEqual(["src", "scripts"]);
  });

  it("should fall back to root-fallback when files exist but no specific scope matched", () => {
    expect(
      detectScopesFromFiles(["package-lock.json", "vitest.config.ts"]),
    ).toEqual(["root-fallback"]);
  });

  it("should detect root-fallback from apps/<pkg>/src/ monorepo paths", () => {
    expect(detectScopesFromFiles(["apps/web/src/index.ts"])).toEqual([
      "root-fallback",
    ]);
  });

  it("should detect root-fallback from packages/<pkg>/src/ monorepo paths", () => {
    expect(detectScopesFromFiles(["packages/ui/src/Button.svelte"])).toEqual([
      "root-fallback",
    ]);
  });

  it("should append root-fallback additively for an orphan bundled with a matched specific scope", () => {
    // apps/web/src/b.ts has no dynamic owner here (pure call, no dynamicScopes),
    // so it is an orphan. Under the additive model root-fallback claims it
    // alongside src — it is no longer silently dropped (the bundled-orphan bug).
    expect(detectScopesFromFiles(["src/a.ts", "apps/web/src/b.ts"])).toEqual([
      "src",
      "root-fallback",
    ]);
  });

  it("should NOT append root-fallback when every file is claimed by a specific scope", () => {
    expect(detectScopesFromFiles(["src/a.ts", "AGENTS.md"])).toEqual([
      "src",
      "docs",
    ]);
  });

  it("should append root-fallback for a root-level file bundled with a scoped file (the package.json repro)", () => {
    expect(detectScopesFromFiles(["scripts/foo.ts", "package.json"])).toEqual([
      "scripts",
      "root-fallback",
    ]);
  });

  it("should detect docs scope from a root-level .md file", () => {
    expect(detectScopesFromFiles(["AGENTS.md"])).toEqual(["docs"]);
  });

  it("should detect docs scope from a deeply-nested .md file", () => {
    expect(
      detectScopesFromFiles(["skills/stacks/flow-svelte/SKILL.md"]),
    ).toEqual(["docs"]);
  });

  it("should detect both scripts and docs from a mixed change", () => {
    expect(
      detectScopesFromFiles(["bin/flow-md-validate.ts", "docs/x.md"]),
    ).toEqual(["scripts", "docs"]);
  });

  it("should detect docs scope from a .claude/ skill-reference markdown path", () => {
    expect(detectScopesFromFiles([".claude/skills/foo/reference.md"])).toEqual([
      "docs",
    ]);
  });

  it("should detect both scripts and docs from a mixed .claude/ markdown + bin/ change", () => {
    expect(
      detectScopesFromFiles([".claude/skills/foo/SKILL.md", "bin/x.ts"]),
    ).toEqual(["scripts", "docs"]);
  });

  it("should NOT trip docs for a .claude/ non-markdown file (extension-not-prefix — settings.json lands in root-fallback)", () => {
    expect(detectScopesFromFiles([".claude/settings.json"])).toEqual([
      "root-fallback",
    ]);
  });

  it("should detect docs scope from a .template file so flow's own *.template source is not orphaned", () => {
    expect(detectScopesFromFiles(["templates/AGENTS.md.template"])).toEqual([
      "docs",
    ]);
  });

  it("should deduplicate scopes", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
    expect(detectScopesFromFiles(files)).toEqual(["src"]);
  });

  it("should return empty array for empty file list (regression — root-fallback must not fire on empty input)", () => {
    expect(detectScopesFromFiles([])).toEqual([]);
  });

  it("should handle deeply nested paths", () => {
    expect(detectScopesFromFiles(["src/pipeline/phases/worktree.ts"])).toEqual([
      "src",
    ]);
  });

  it("should ignore files that contain but don't start with scope prefixes", () => {
    // The .md still trips docs scope; the embedded "src/" must not trip src.
    expect(detectScopesFromFiles(["docs/src/guide.md"])).toEqual(["docs"]);
  });

  it("should detect backend scope from a backend/ file", () => {
    expect(detectScopesFromFiles(["backend/foo.go"])).toEqual(["backend"]);
  });

  it("should detect backend scope from a deeply-nested backend/ file", () => {
    expect(detectScopesFromFiles(["backend/cmd/server/main.go"])).toEqual([
      "backend",
    ]);
  });

  it("should detect BOTH src and backend from a mixed diff and NOT fall back to root-fallback", () => {
    expect(detectScopesFromFiles(["backend/handler.go", "src/a.ts"])).toEqual([
      "src",
      "backend",
    ]);
  });

  it("should NOT append root-fallback when backend claims every file (no orphan remains)", () => {
    expect(detectScopesFromFiles(["backend/handler.go"])).toEqual(["backend"]);
  });

  it("should NOT trip backend for backend-archive/foo.go (prefix exactness — `.startsWith('backend/')` is false for `backend-archive/`, so the file lands in root-fallback)", () => {
    expect(detectScopesFromFiles(["backend-archive/foo.go"])).toEqual([
      "root-fallback",
    ]);
  });
});

describe(computeUnmatchedFiles, () => {
  it("returns [] for an empty file list", () => {
    expect(computeUnmatchedFiles([])).toEqual([]);
  });

  it("returns [] when every path matches a specific scope", () => {
    expect(
      computeUnmatchedFiles(["src/a.ts", "scripts/b.ts", "AGENTS.md"]),
    ).toEqual([]);
  });

  it("returns every file when no specific scope matched (root-fallback bucket)", () => {
    const files = ["apps/web/src/x.ts", "vendor/y.js", "package-lock.json"];
    expect(computeUnmatchedFiles(files)).toEqual(files);
  });

  it("returns only orphans in a mixed diff (claimed files excluded, orphans surface)", () => {
    expect(computeUnmatchedFiles(["src/a.ts", "apps/web/src/b.ts"])).toEqual([
      "apps/web/src/b.ts",
    ]);
  });

  it("does NOT include backend/ paths in unmatched when the backend scope is active (the backend prefix claims them)", () => {
    expect(computeUnmatchedFiles(["backend/foo.go", "src/a.ts"])).toEqual([]);
  });
});

describe(computeAllPassedAndReason, () => {
  it("flags reason='no-checks-defined' + allPassed=false on non-empty diff + empty results", () => {
    expect(
      computeAllPassedAndReason(
        [],
        ["apps/web/src/x.ts"],
        ["root-fallback"],
        ["apps/web/src/x.ts"],
      ),
    ).toEqual({
      allPassed: false,
      reason: "no-checks-defined",
    });
  });

  it("returns allPassed=true with no reason on empty diff + empty results", () => {
    expect(computeAllPassedAndReason([], [], [], [])).toEqual({
      allPassed: true,
    });
  });

  it("returns allPassed=true with no reason on undefined changedFiles (--scope path)", () => {
    expect(
      computeAllPassedAndReason([], undefined, ["src"], undefined),
    ).toEqual({
      allPassed: true,
    });
  });

  it("reflects results.every on a mixed pass/fail set", () => {
    const passing = createResult({ passed: true });
    const failing = createResult({ passed: false });
    expect(
      computeAllPassedAndReason([passing, failing], ["src/a.ts"], ["src"], []),
    ).toEqual({
      allPassed: false,
    });
    expect(
      computeAllPassedAndReason([passing, passing], ["src/a.ts"], ["src"], []),
    ).toEqual({
      allPassed: true,
    });
  });

  it("still flags reason='unmatched-files' for a genuinely-unmatched file (root-fallback absent from scopes)", () => {
    // Function-contract safety net: when a caller hands computeAllPassedAndReason
    // a scope list WITHOUT root-fallback plus a non-empty orphan set, the guard
    // still fires. After this PR, detectScopesFromFiles always appends
    // root-fallback when orphans remain, so this exact (scopes, orphans) pair is
    // no longer produced on the integration path — but the guard is retained and
    // tested so the reason code cannot be silently nuked.
    const passing = createResult({ passed: true });
    expect(
      computeAllPassedAndReason(
        [passing],
        ["src/a.ts", "apps/web/src/b.ts"],
        ["src"],
        ["apps/web/src/b.ts"],
      ),
    ).toEqual({ allPassed: false, reason: "unmatched-files" });
  });

  it("does NOT flag unmatched-files when root-fallback is the detected scope", () => {
    const passing = createResult({ passed: true });
    expect(
      computeAllPassedAndReason(
        [passing],
        ["apps/web/src/b.ts"],
        ["root-fallback"],
        ["apps/web/src/b.ts"],
      ),
    ).toEqual({ allPassed: true });
  });

  it("returns allPassed=true when a specific scope matched and there are no orphans", () => {
    const passing = createResult({ passed: true });
    expect(
      computeAllPassedAndReason([passing], ["src/a.ts"], ["src"], []),
    ).toEqual({
      allPassed: true,
    });
  });

  it("does NOT flag unmatched-files on the --scope path (unmatchedFiles undefined)", () => {
    expect(
      computeAllPassedAndReason([], undefined, ["src"], undefined),
    ).toEqual({
      allPassed: true,
    });
  });

  it("no-checks-defined takes precedence over unmatched-files on a zero-check mixed diff", () => {
    expect(
      computeAllPassedAndReason(
        [],
        ["src/a.ts", "apps/web/src/b.ts"],
        ["src"],
        ["apps/web/src/b.ts"],
      ),
    ).toEqual({ allPassed: false, reason: "no-checks-defined" });
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

  it("should accept the actions scope", () => {
    expect(parseScopes("actions")).toEqual(["actions"]);
  });

  it("should round-trip src,scripts,docs", () => {
    expect(parseScopes("docs,scripts,src")).toEqual(["src", "scripts", "docs"]);
  });

  it("should reject the root-fallback pseudo-scope (auto-detect-only sentinel)", () => {
    expect(() => parseScopes("root-fallback")).toThrow(
      'Unknown scope "root-fallback"',
    );
  });

  it("should accept the backend scope", () => {
    expect(parseScopes("backend")).toEqual(["backend"]);
  });

  it("should canonicalise backend,src to the SPECIFIC_SCOPES order (src first, backend last)", () => {
    expect(parseScopes("backend,src")).toEqual(["src", "backend"]);
  });
});

describe(checksForScope, () => {
  it("should return typecheck, test, and lint for src", () => {
    const checks = checksForScope("src");
    expect(checks).toHaveLength(3);
    expect(checks.map((c) => c.name)).toEqual([
      "npm run typecheck",
      "npm run test",
      "npm run lint",
    ]);
  });

  it("should return scripts typecheck, test, and lint for scripts", () => {
    const checks = checksForScope("scripts");
    expect(checks).toHaveLength(3);
    expect(checks.map((c) => c.name)).toEqual([
      "npm run typecheck:scripts",
      "npm run test",
      "npm run lint",
    ]);
  });

  it("should return flow-md-validate, npm run test, and npm run lint for docs", () => {
    const checks = checksForScope("docs");
    expect(checks).toEqual([
      { name: "flow-md-validate .", argv: ["flow-md-validate", "."] },
      { name: "npm run test", argv: ["npm", "run", "test"] },
      { name: "npm run lint", argv: ["npm", "run", "lint"] },
    ]);
  });

  it("should return actionlint .github/workflows/ and lint for actions", () => {
    const checks = checksForScope("actions");
    expect(checks).toEqual([
      {
        name: "actionlint .github/workflows/",
        argv: ["actionlint", ".github/workflows/"],
      },
      { name: "npm run lint", argv: ["npm", "run", "lint"] },
    ]);
  });

  it("should return typecheck, test, and lint for root-fallback", () => {
    const checks = checksForScope("root-fallback");
    expect(checks).toEqual([
      { name: "npm run typecheck", argv: ["npm", "run", "typecheck"] },
      { name: "npm run test", argv: ["npm", "run", "test"] },
      { name: "npm run lint", argv: ["npm", "run", "lint"] },
    ]);
  });

  it("adds the lint check to docs (parity with CI's root prettier --check)", () => {
    expect(checksForScope("docs").map((c) => c.name)).toContain("npm run lint");
  });

  it("adds the lint check to actions (parity with CI's root prettier --check)", () => {
    expect(checksForScope("actions").map((c) => c.name)).toContain(
      "npm run lint",
    );
  });

  it("does NOT add the lint check to backend", () => {
    expect(checksForScope("backend").map((c) => c.name)).not.toContain(
      "npm run lint",
    );
  });

  it("should return go vet and go test for backend in canonical order", () => {
    const checks = checksForScope("backend");
    expect(checks).toEqual([
      {
        name: "go vet -C backend ./...",
        argv: ["go", "vet", "-C", "backend", "./..."],
      },
      {
        name: "go test -C backend ./...",
        argv: ["go", "test", "-C", "backend", "./..."],
      },
    ]);
  });

  it("emits test argv the real isTestCheck predicate matches (semaphore detection key)", () => {
    // main()'s test-check dispatch routes through the exported isTestCheck
    // predicate (argv[1]==="run" && argv[2]==="test") rather than
    // exact-array/join equality so the workspace form
    // ["npm","run","test","-w",<pkg>] also matches. Asserting against the REAL
    // exported helper (not a local copy) means a drift in the predicate — e.g.
    // to argv[2]==="test:unit" — fails this test instead of silently changing
    // production behavior while a private copy keeps passing.
    for (const scope of ["src", "docs", "root-fallback"] as const) {
      const test = checksForScope(scope).find((c) => isTestCheck(c.argv));
      expect(test, `${scope} should emit a test check`).toBeDefined();
    }
    // Non-test checks (typecheck/lint) must NOT match the predicate.
    expect(isTestCheck(["npm", "run", "typecheck"])).toBe(false);
    expect(isTestCheck(["npm", "run", "lint"])).toBe(false);
    // Workspace variant still matches; bare root form matches.
    expect(isTestCheck(["npm", "run", "test", "-w", "pkg"])).toBe(true);
    expect(isTestCheck(["npm", "run", "test"])).toBe(true);
  });
});

describe(resolveTestConcurrency, () => {
  it("falls back to max(1, ceil(cores/9)) when env is unset", () => {
    expect(resolveTestConcurrency({}, 18)).toBe(2);
    expect(resolveTestConcurrency({}, 9)).toBe(1);
    expect(resolveTestConcurrency({}, 1)).toBe(1);
  });

  it("honors a valid positive-integer FLOW_TEST_CONCURRENCY override", () => {
    expect(resolveTestConcurrency({ FLOW_TEST_CONCURRENCY: "4" }, 18)).toBe(4);
    expect(resolveTestConcurrency({ FLOW_TEST_CONCURRENCY: "1" }, 18)).toBe(1);
  });

  it("falls back to the floored default for 0/negative/non-numeric/empty", () => {
    for (const bad of ["0", "-2", "abc", "", "2.5"]) {
      expect(resolveTestConcurrency({ FLOW_TEST_CONCURRENCY: bad }, 18)).toBe(
        2,
      );
    }
  });
});

describe(filterDefinedChecks, () => {
  it("keeps checks whose npm script is defined in package.json", () => {
    const checks = checksForScope("src");
    const defined = new Set(["typecheck", "test", "lint"]);
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

  it("drops the lint check when 'lint' is absent from the defined scripts", () => {
    // flow's own repo has no `lint` script — the new lint check must stay
    // inert there rather than failing the gate with a Missing-script error.
    const checks = checksForScope("src");
    const filtered = filterDefinedChecks(
      checks,
      new Set(["typecheck", "test"]),
    );
    expect(filtered.map((c) => c.name)).toEqual([
      "npm run typecheck",
      "npm run test",
    ]);
  });

  it("keeps the lint check when 'lint' is present in the defined scripts", () => {
    const checks = checksForScope("src");
    const filtered = filterDefinedChecks(
      checks,
      new Set(["typecheck", "test", "lint"]),
    );
    expect(filtered.map((c) => c.name)).toContain("npm run lint");
  });

  it("drops the docs lint check in a repo with no 'lint' script (flow's own repo)", () => {
    // A docs-only diff trips the `docs` scope; flow's own package.json has a
    // `test` script but no `lint`, so the appended lint check must be dropped
    // and the docs gate must behave exactly as before this change.
    const checks = checksForScope("docs");
    const filtered = filterDefinedChecks(checks, new Set(["test"]));
    expect(filtered.map((c) => c.name)).toEqual([
      "flow-md-validate .",
      "npm run test",
    ]);
  });
});

describe(runCheck, () => {
  function ok(): Runner {
    return () => ({ stdout: "all good", stderr: "", exitCode: 0 });
  }

  function exitWith(code: number, stderr = ""): Runner {
    return () => ({ stdout: "", stderr, exitCode: code });
  }

  function throwing(err: unknown): Runner {
    return () => {
      throw err;
    };
  }

  it("returns passed:true with no skipReason when runner returns exit 0", () => {
    const result = runCheck("actionlint", ["actionlint", "."], "actions", ok());
    expect(result.passed).toBe(true);
    expect(result.skipReason).toBeUndefined();
    expect(result.output).toContain("all good");
  });

  it("returns skipReason actionlint-not-installed when runner exits 127 for actionlint", () => {
    const result = runCheck(
      "actionlint .github/workflows/",
      ["actionlint", ".github/workflows/"],
      "actions",
      exitWith(127, "actionlint: command not found"),
    );
    expect(result.passed).toBe(true);
    expect(result.skipReason).toBe("actionlint-not-installed");
    expect(result.output).toContain("actionlint not installed");
  });

  it("returns skipReason when runner throws an ENOENT error for actionlint", () => {
    const enoent = Object.assign(
      new Error("spawn actionlint ENOENT: no such file or directory"),
      {
        code: "ENOENT",
      },
    );
    const result = runCheck(
      "actionlint .github/workflows/",
      ["actionlint", ".github/workflows/"],
      "actions",
      throwing(enoent),
    );
    expect(result.passed).toBe(true);
    expect(result.skipReason).toBe("actionlint-not-installed");
  });

  it("returns skipReason when stderr matches command-not-found and exit is non-zero (e.g. shell wrapper exit 1)", () => {
    const result = runCheck(
      "actionlint .github/workflows/",
      ["actionlint", ".github/workflows/"],
      "actions",
      exitWith(1, "bash: actionlint: command not found"),
    );
    expect(result.passed).toBe(true);
    expect(result.skipReason).toBe("actionlint-not-installed");
  });

  it("does NOT skip for other tools — npm exit 127 still surfaces as failed", () => {
    const result = runCheck(
      "npm run typecheck",
      ["npm", "run", "typecheck"],
      "src",
      exitWith(127, "npm: command not found"),
    );
    expect(result.passed).toBe(false);
    expect(result.skipReason).toBeUndefined();
  });

  it("reports passed:false when the lint check exits non-zero (prettier --check failure)", () => {
    const result = runCheck(
      "npm run lint",
      ["npm", "run", "lint"],
      "src",
      exitWith(
        1,
        "[warn] src/foo.ts\n[warn] Code style issues found in 1 file.",
      ),
    );
    expect(result.passed).toBe(false);
    expect(result.skipReason).toBeUndefined();
  });

  it("does NOT skip a real actionlint lint failure (non-127 exit, stderr without command-not-found markers)", () => {
    const result = runCheck(
      "actionlint .github/workflows/",
      ["actionlint", ".github/workflows/"],
      "actions",
      exitWith(
        1,
        "workflows/foo.yml:42:9: shellcheck reported issue in this script",
      ),
    );
    expect(result.passed).toBe(false);
    expect(result.skipReason).toBeUndefined();
  });

  it("returns skipReason go-not-installed when runner exits 127 for go", () => {
    const result = runCheck(
      "go vet -C backend ./...",
      ["go", "vet", "-C", "backend", "./..."],
      "backend",
      exitWith(127, "go: command not found"),
    );
    expect(result.passed).toBe(true);
    expect(result.skipReason).toBe("go-not-installed");
    expect(result.output).toContain("go not installed");
  });

  it("returns skipReason go-not-installed when runner throws an ENOENT error for go", () => {
    const enoent = Object.assign(
      new Error("spawn go ENOENT: no such file or directory"),
      {
        code: "ENOENT",
      },
    );
    const result = runCheck(
      "go vet -C backend ./...",
      ["go", "vet", "-C", "backend", "./..."],
      "backend",
      throwing(enoent),
    );
    expect(result.passed).toBe(true);
    expect(result.skipReason).toBe("go-not-installed");
  });

  it("returns skipReason go-not-installed when stderr matches command-not-found and exit is non-zero (shell wrapper path)", () => {
    const result = runCheck(
      "go vet -C backend ./...",
      ["go", "vet", "-C", "backend", "./..."],
      "backend",
      exitWith(1, "bash: go: command not found"),
    );
    expect(result.passed).toBe(true);
    expect(result.skipReason).toBe("go-not-installed");
  });

  it("does NOT skip a real go vet failure (non-127 exit, stderr without command-not-found markers)", () => {
    const result = runCheck(
      "go vet -C backend ./...",
      ["go", "vet", "-C", "backend", "./..."],
      "backend",
      exitWith(1, "backend/foo.go:42:9: undeclared name: bar"),
    );
    expect(result.passed).toBe(false);
    expect(result.skipReason).toBeUndefined();
  });
});

describe(findNonExecutableHelpers, () => {
  const entry = (path: string, mode: string): GitModeEntry => ({ path, mode });

  it("returns a top-level bin helper tracked 100644 (non-executable fails)", () => {
    expect(
      findNonExecutableHelpers([entry("bin/flow-foo.ts", "100644")]),
    ).toEqual(["bin/flow-foo.ts"]);
  });

  it("does NOT return the same helper tracked 100755 (executable passes)", () => {
    expect(
      findNonExecutableHelpers([entry("bin/flow-foo.ts", "100755")]),
    ).toEqual([]);
  });

  it("excludes non-helper bin paths even at 100644 (test/lib/subdir/wrapper/maintainer)", () => {
    const excluded = [
      entry("bin/flow-foo.test.ts", "100644"),
      entry("bin/lib/git.ts", "100644"),
      entry("bin/flow-pr-static-analysis/cli.ts", "100644"),
      entry("bin/flow.ts", "100644"),
      entry("bin/flow-release.ts", "100644"),
    ];
    expect(findNonExecutableHelpers(excluded)).toEqual([]);
  });

  it("excludes a non-bin path at 100644", () => {
    expect(findNonExecutableHelpers([entry("src/app.ts", "100644")])).toEqual(
      [],
    );
  });

  it("returns [] for an empty entry list (inert when no helpers)", () => {
    expect(findNonExecutableHelpers([])).toEqual([]);
  });

  it("preserves input order across multiple offenders", () => {
    expect(
      findNonExecutableHelpers([
        entry("bin/flow-b.ts", "100644"),
        entry("bin/flow-a.ts", "100755"),
        entry("bin/flow-c.ts", "100644"),
      ]),
    ).toEqual(["bin/flow-b.ts", "bin/flow-c.ts"]);
  });

  it("flags a bin/lib path in libCandidates tracked 100644", () => {
    expect(
      findNonExecutableHelpers(
        [entry("bin/lib/foo-schema.ts", "100644")],
        new Set(["bin/lib/foo-schema.ts"]),
      ),
    ).toEqual(["bin/lib/foo-schema.ts"]);
  });

  it("does NOT flag a libCandidate tracked 100755", () => {
    expect(
      findNonExecutableHelpers(
        [entry("bin/lib/foo-schema.ts", "100755")],
        new Set(["bin/lib/foo-schema.ts"]),
      ),
    ).toEqual([]);
  });

  it("does NOT flag a bin/lib path absent from libCandidates (pure lib stays exempt)", () => {
    expect(
      findNonExecutableHelpers([entry("bin/lib/git.ts", "100644")]),
    ).toEqual([]);
  });

  it("unions top-level and lib offenders in input order", () => {
    expect(
      findNonExecutableHelpers(
        [
          entry("bin/flow-a.ts", "100644"),
          entry("bin/lib/git.ts", "100644"),
          entry("bin/lib/foo-schema.ts", "100644"),
        ],
        new Set(["bin/lib/foo-schema.ts"]),
      ),
    ).toEqual(["bin/flow-a.ts", "bin/lib/foo-schema.ts"]);
  });
});

describe(isExecutableLibModule, () => {
  const SHEBANG = "#!/usr/bin/env bun";

  it("returns true for a bun shebang + import.meta.main module", () => {
    expect(
      isExecutableLibModule(`${SHEBANG}\nif (import.meta.main) main();\n`),
    ).toBe(true);
  });

  it("returns false for a pure lib module (no shebang, no main)", () => {
    expect(
      isExecutableLibModule("/**\n * lib\n */\nexport const x = 1;\n"),
    ).toBe(false);
  });

  it("returns false when the bun shebang is present but import.meta.main is not", () => {
    expect(isExecutableLibModule(`${SHEBANG}\nexport const x = 1;\n`)).toBe(
      false,
    );
  });

  it("returns false when import.meta.main is present but the shebang is not", () => {
    expect(
      isExecutableLibModule("// import.meta.main mentioned in a comment\n"),
    ).toBe(false);
  });

  it("returns false for a non-bun shebang", () => {
    expect(
      isExecutableLibModule(`#!/usr/bin/env node\nif (import.meta.main) {}\n`),
    ).toBe(false);
  });
});

describe(parseLsFilesModes, () => {
  it("parses two git ls-files -s lines into {path, mode} entries", () => {
    const stdout = "100755 abc 0\tbin/flow-a.ts\n100644 def 0\tbin/flow-b.ts";
    expect(parseLsFilesModes(stdout)).toEqual([
      { mode: "100755", path: "bin/flow-a.ts" },
      { mode: "100644", path: "bin/flow-b.ts" },
    ]);
  });

  it("drops blank and trailing lines", () => {
    const stdout = "\n100755 abc 0\tbin/flow-a.ts\n\n";
    expect(parseLsFilesModes(stdout)).toEqual([
      { mode: "100755", path: "bin/flow-a.ts" },
    ]);
  });
});

describe(isPathBoundHelper, () => {
  // Pins the shared selection rule at its source module (bin/lib/sources.ts),
  // so a future MAINTAINER_ONLY or wrapper-name edit fails here rather than
  // only in a downstream caller's transitive assertion.
  it("returns true for a normal top-level helper basename", () => {
    expect(isPathBoundHelper("flow-foo.ts")).toBe(true);
  });

  it("excludes test files (*.test.ts)", () => {
    expect(isPathBoundHelper("flow-foo.test.ts")).toBe(false);
  });

  it("excludes the flow.ts wrapper", () => {
    expect(isPathBoundHelper("flow.ts")).toBe(false);
  });

  it("excludes the maintainer-only flow-release.ts", () => {
    expect(isPathBoundHelper("flow-release.ts")).toBe(false);
  });

  it("excludes a non-.ts name", () => {
    expect(isPathBoundHelper("flow-foo.sh")).toBe(false);
  });
});

describe(checkHelperExecutableModes, () => {
  const okRunner: Runner = () => ({ stdout: "", stderr: "", exitCode: 0 });

  it("returns null (inert) when no changed file is a candidate helper", () => {
    expect(checkHelperExecutableModes(["src/app.ts"], okRunner)).toBeNull();
    expect(checkHelperExecutableModes(undefined, okRunner)).toBeNull();
  });

  it("fails with the git-failure message when git ls-files -s exits non-zero", () => {
    const failingRunner: Runner = () => ({
      stdout: "",
      stderr: "fatal: not a git repository",
      exitCode: 128,
    });
    const result = checkHelperExecutableModes(
      ["bin/flow-foo.ts"],
      failingRunner,
    );
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
    expect(result!.output).toBe(
      "git ls-files -s failed (exit 128) while checking bin helper modes",
    );
  });

  it("passes when every candidate helper is tracked executable (100755)", () => {
    const runner: Runner = () => ({
      stdout: "100755 abc 0\tbin/flow-foo.ts",
      stderr: "",
      exitCode: 0,
    });
    const result = checkHelperExecutableModes(["bin/flow-foo.ts"], runner);
    expect(result!.passed).toBe(true);
    expect(result!.output).toContain("tracked executable (100755)");
  });

  it("fails with a chmod +x remediation line for a single offender", () => {
    const runner: Runner = () => ({
      stdout: "100644 abc 0\tbin/flow-foo.ts",
      stderr: "",
      exitCode: 0,
    });
    const result = checkHelperExecutableModes(["bin/flow-foo.ts"], runner);
    expect(result!.passed).toBe(false);
    expect(result!.output).toContain("permission denied");
    expect(result!.output).toContain("chmod +x bin/flow-foo.ts");
  });

  it("lists every offender's chmod +x line when multiple helpers are non-executable", () => {
    const runner: Runner = () => ({
      stdout:
        "100644 a 0\tbin/flow-a.ts\n100755 b 0\tbin/flow-b.ts\n100644 c 0\tbin/flow-c.ts",
      stderr: "",
      exitCode: 0,
    });
    const result = checkHelperExecutableModes(
      ["bin/flow-a.ts", "bin/flow-b.ts", "bin/flow-c.ts"],
      runner,
    );
    expect(result!.passed).toBe(false);
    expect(result!.output).toContain("chmod +x bin/flow-a.ts");
    expect(result!.output).toContain("chmod +x bin/flow-c.ts");
    // The executable helper (flow-b) is not an offender, so it gets no hint.
    expect(result!.output).not.toContain("chmod +x bin/flow-b.ts");
  });

  const SHEBANG = "#!/usr/bin/env bun";
  const execLib = `${SHEBANG}\nif (import.meta.main) main();\n`;
  const pureLib = "/**\n * lib\n */\nexport const x = 1;\n";

  it("fails for a bun-executable bin/lib module tracked 100644", () => {
    const runner: Runner = () => ({
      stdout: "100644 abc 0\tbin/lib/foo-schema.ts",
      stderr: "",
      exitCode: 0,
    });
    const result = checkHelperExecutableModes(
      ["bin/lib/foo-schema.ts"],
      runner,
      () => execLib,
    );
    expect(result!.passed).toBe(false);
    expect(result!.output).toContain("permission denied");
    expect(result!.output).toContain("chmod +x bin/lib/foo-schema.ts");
  });

  it("passes for the same bin/lib module tracked 100755", () => {
    const runner: Runner = () => ({
      stdout: "100755 abc 0\tbin/lib/foo-schema.ts",
      stderr: "",
      exitCode: 0,
    });
    const result = checkHelperExecutableModes(
      ["bin/lib/foo-schema.ts"],
      runner,
      () => execLib,
    );
    expect(result!.passed).toBe(true);
  });

  it("is inert (null) for a pure bin/lib module — no shebang/main, never a candidate", () => {
    // No runner call expected: a non-executable lib module is filtered out
    // before git ls-files runs, so the change set has zero candidates.
    const result = checkHelperExecutableModes(
      ["bin/lib/git.ts"],
      () => {
        throw new Error("git ls-files should not run with zero candidates");
      },
      () => pureLib,
    );
    expect(result).toBeNull();
  });

  it("drops an unreadable bin/lib candidate (readFile throws) → inert (null)", () => {
    // A bin/lib/*.ts path that matches the regex and passes isPathBoundHelper
    // but throws on read (e.g. deleted in the diff) is the only path into the
    // readFile catch. The candidate is dropped, leaving zero candidates, so the
    // gate is inert — and the throw does not bubble out of checkHelperExecutableModes.
    let result: CheckResult | null = null;
    expect(() => {
      result = checkHelperExecutableModes(
        ["bin/lib/foo-schema.ts"],
        () => {
          throw new Error("git ls-files should not run with zero candidates");
        },
        () => {
          throw new Error("ENOENT");
        },
      );
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it("exempts a maintainer-only bin/lib module even with the executable signal", () => {
    // isPathBoundHelper excludes MAINTAINER_ONLY names, so a bin/lib/flow-release.ts
    // is never a candidate — readFile is never consulted for it.
    const result = checkHelperExecutableModes(
      ["bin/lib/flow-release.ts"],
      () => {
        throw new Error("git ls-files should not run with zero candidates");
      },
      () => execLib,
    );
    expect(result).toBeNull();
  });

  it("unions a top-level offender and a lib offender in one remediation block", () => {
    const runner: Runner = () => ({
      stdout: "100644 a 0\tbin/flow-a.ts\n100644 b 0\tbin/lib/foo-schema.ts",
      stderr: "",
      exitCode: 0,
    });
    const result = checkHelperExecutableModes(
      ["bin/flow-a.ts", "bin/lib/foo-schema.ts", "bin/lib/git.ts"],
      runner,
      (p) => (p === "bin/lib/git.ts" ? pureLib : execLib),
    );
    expect(result!.passed).toBe(false);
    expect(result!.output).toContain("chmod +x bin/flow-a.ts");
    expect(result!.output).toContain("chmod +x bin/lib/foo-schema.ts");
    // Pure lib (git.ts) was never a candidate, so it gets no hint.
    expect(result!.output).not.toContain("chmod +x bin/lib/git.ts");
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
    expect(() => parsePrePushInput("refs/heads/main abc123")).toThrow(
      "Malformed pre-push input",
    );
  });
});

describe(getChangedFilesForPush, () => {
  it("should return changed files for a normal ref update", () => {
    const refs = [createRef({ remoteSha: "old111", localSha: "new222" })];
    const git = createMockGit({
      files: { "old111..new222": ["src/a.ts", "src/b.ts"] },
    });
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
    expect(mergeBase).toHaveBeenCalledWith("origin/main", "new222");
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
    expect(mergeBase).toHaveBeenCalledWith("origin/master", "new222");
  });

  it("should base the new-branch diff on origin/<default> so a stale local ref cannot inject phantom files", () => {
    // Same stale-local-ref exposure as the auto-detect path: in a shared-.git
    // worktree the local `main` ref is graph-stale, so a local merge-base
    // sweeps already-merged files into the new-branch diff. Keying the mock off
    // the ref proves the helper queries origin/main, not local main.
    const refs = [createRef({ remoteSha: ZERO_SHA, localSha: "new222" })];
    const mergeBase = vi.fn((ref: string) =>
      ref === "origin/main" ? "remotebase" : "stalebase",
    );
    const git = createMockGit({
      mergeBase,
      files: {
        "remotebase..new222": ["src/new-file.ts"],
        "stalebase..new222": ["src/new-file.ts", "apps/web/search.ts"],
      },
    });

    expect(getChangedFilesForPush(refs, git)).toEqual(["src/new-file.ts"]);
    expect(mergeBase).toHaveBeenCalledWith("origin/main", "new222");
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
      createRef({
        remoteSha: "a1",
        localSha: "a2",
        localRef: "refs/heads/branch-a",
      }),
      createRef({
        remoteSha: "b1",
        localSha: "b2",
        localRef: "refs/heads/branch-b",
      }),
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

describe(resolveDefaultScopeFiles, () => {
  it("should return the working-tree diff verbatim without consulting merge-base when it is non-empty", () => {
    const mergeBase = vi.fn();
    const diffFiles = vi.fn();
    const defaultBranch = vi.fn();
    const git = createMockGit({ mergeBase, diffFiles, defaultBranch });

    expect(resolveDefaultScopeFiles(["src/a.ts", "src/b.ts"], git)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(mergeBase).not.toHaveBeenCalled();
    expect(diffFiles).not.toHaveBeenCalled();
    expect(defaultBranch).not.toHaveBeenCalled();
  });

  it("should fall back to the merge-base diff when the tree is clean but HEAD is ahead of the default branch", () => {
    const mergeBase = vi.fn().mockReturnValue("base000");
    const defaultBranch = vi.fn().mockReturnValue("main");
    const git = createMockGit({
      mergeBase,
      defaultBranch,
      files: { "base000..HEAD": ["bin/flow-pre-commit.ts"] },
    });

    expect(resolveDefaultScopeFiles([], git)).toEqual([
      "bin/flow-pre-commit.ts",
    ]);
    expect(defaultBranch).toHaveBeenCalled();
    expect(mergeBase).toHaveBeenCalledWith("origin/main", "HEAD");
  });

  it("should honor a non-main default branch in the clean-tree fallback", () => {
    const mergeBase = vi.fn().mockReturnValue("base000");
    const defaultBranch = vi.fn().mockReturnValue("master");
    const git = createMockGit({
      mergeBase,
      defaultBranch,
      files: { "base000..HEAD": ["src/x.ts"] },
    });

    expect(resolveDefaultScopeFiles([], git)).toEqual(["src/x.ts"]);
    expect(mergeBase).toHaveBeenCalledWith("origin/master", "HEAD");
  });

  it("should exclude already-merged phantom files by basing the diff on origin/<default>, not the stale local ref", () => {
    // PR #179 repro: in a shared-.git worktree the local `main` ref is
    // graph-stale, so a local merge-base lands on the wrong commit and the
    // `<base>..HEAD` diff sweeps in already-merged, unrelated files. Keying the
    // mock off the ref proves the helper queries the remote-tracking namespace:
    // origin/main → the true base (build.yml only); local main → a stale base
    // whose diff also includes phantom apps/web files.
    const mergeBase = vi.fn((ref: string) =>
      ref === "origin/main" ? "remotebase" : "stalebase",
    );
    const defaultBranch = vi.fn().mockReturnValue("main");
    const git = createMockGit({
      mergeBase,
      defaultBranch,
      files: {
        "remotebase..HEAD": ["build.yml"],
        "stalebase..HEAD": ["build.yml", "apps/web/search.ts"],
      },
    });

    expect(resolveDefaultScopeFiles([], git)).toEqual(["build.yml"]);
    expect(mergeBase).toHaveBeenCalledWith("origin/main", "HEAD");
  });

  it("should return empty when the tree is clean and HEAD is not ahead of the default branch", () => {
    // merge-base resolves to HEAD itself, so the `<base>..HEAD` range is empty
    // — the fallback self-cancels to a no-op, matching pre-change behavior.
    const git = createMockGit({
      mergeBase: () => "headsha",
      files: { "headsha..HEAD": [] },
    });

    expect(resolveDefaultScopeFiles([], git)).toEqual([]);
  });

  it("should return empty without throwing when the merge-base cannot be resolved", () => {
    const diffFiles = vi.fn();
    const git = createMockGit({ mergeBase: () => null, diffFiles });

    expect(resolveDefaultScopeFiles([], git)).toEqual([]);
    expect(diffFiles).not.toHaveBeenCalled();
  });
});

describe(formatReport, () => {
  it("should show pass markers for all-passing report", () => {
    const report = createReport({
      results: [
        createResult({ passed: true }),
        createResult({ name: "npm run test", passed: true }),
      ],
    });
    const output = formatReport(report);
    expect(output).toContain("PASS");
    expect(output).not.toContain("FAIL");
    expect(output).toContain("All 2 checks passed.");
  });

  it("should show fail markers and output for failed checks", () => {
    const report = createReport({
      allPassed: false,
      results: [
        createResult({
          passed: false,
          output: "Error: type mismatch on line 42",
        }),
      ],
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
        createResult({
          name: "npm run test",
          passed: false,
          output: "test error",
        }),
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
    const report = createReport({
      results: [createResult({ durationMs: 500 })],
    });
    const output = formatReport(report);
    expect(output).toContain("500ms");
  });

  it("should show duration in seconds for long checks", () => {
    const report = createReport({
      results: [createResult({ durationMs: 12500 })],
    });
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

  it("renders a SKIP marker when a result has skipReason and does not emit FAIL", () => {
    const report = createReport({
      scopes: ["actions"] as Scope[],
      results: [
        createResult({
          name: "actionlint .github/workflows/",
          scope: "actions",
          passed: true,
          output: "actionlint not installed — skipped",
          skipReason: "actionlint-not-installed",
        }),
      ],
      allPassed: true,
    });
    const output = formatReport(report);
    expect(output).toContain("SKIP");
    expect(output).toContain("actionlint not installed");
    expect(output).not.toContain("FAIL");
  });

  it("renders a SKIP marker for a backend result with skipReason go-not-installed", () => {
    const report = createReport({
      scopes: ["backend"] as Scope[],
      results: [
        createResult({
          name: "go vet -C backend ./...",
          scope: "backend",
          passed: true,
          output: "go not installed — skipped",
          skipReason: "go-not-installed",
        }),
      ],
      allPassed: true,
    });
    const output = formatReport(report);
    expect(output).toContain("SKIP");
    expect(output).toContain("go not installed");
    expect(output).not.toContain("FAIL");
  });

  it("shows skipped count alongside passed count in the summary line", () => {
    const allSkipped = createReport({
      scopes: ["actions"] as Scope[],
      results: [
        createResult({
          name: "actionlint .github/workflows/",
          scope: "actions",
          passed: true,
          skipReason: "actionlint-not-installed",
          output: "actionlint not installed — skipped",
        }),
      ],
      allPassed: true,
    });
    expect(formatReport(allSkipped)).toContain("(1 skipped)");

    const mixed = createReport({
      scopes: ["src", "actions"] as Scope[],
      results: [
        createResult({ name: "npm run typecheck", scope: "src", passed: true }),
        createResult({
          name: "actionlint .github/workflows/",
          scope: "actions",
          passed: true,
          skipReason: "actionlint-not-installed",
        }),
      ],
      allPassed: true,
    });
    expect(formatReport(mixed)).toContain("All 1 checks passed (1 skipped).");
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

  it("renders the distinct 'Gate failed:' line and lists orphans when reason is unmatched-files", () => {
    const output = formatReport(
      createReport({
        scopes: ["src"] as Scope[],
        results: [createResult({ scope: "src", passed: true })],
        allPassed: false,
        changedFiles: ["src/a.ts", "apps/web/src/b.ts"],
        unmatchedFiles: ["apps/web/src/b.ts"],
        reason: "unmatched-files",
      }),
    );
    expect(output).toContain("Gate failed:");
    expect(output).toContain("matched no checked scope");
    expect(output).toContain("Unmatched files (1):");
    expect(output).toContain("apps/web/src/b.ts");
  });

  it("renders 'Gate failed:' when all checks were skipped and orphans remain", () => {
    // A specific scope matched (backend) leaving an orphan, but every check
    // it spawned was skipped (go not on PATH), so ran-checks total is 0 while
    // skipped > 0. The line-659 `total === 0 && skipped === 0` guard is false,
    // so formatReport falls through to the skip-summary + Gate-failed arm.
    const output = formatReport(
      createReport({
        scopes: ["backend"] as Scope[],
        results: [
          createResult({
            name: "go vet -C backend ./...",
            scope: "backend",
            passed: true,
            skipReason: "go-not-installed",
          }),
        ],
        allPassed: false,
        changedFiles: ["backend/x.go", "root-config.txt"],
        unmatchedFiles: ["root-config.txt"],
        reason: "unmatched-files",
      }),
    );
    expect(output).toContain("0/0 checks passed (1 skipped).");
    expect(output).toContain("Gate failed:");
    expect(output).toContain("matched no checked scope");
    expect(output).toContain("Unmatched files (1):");
    expect(output).toContain("root-config.txt");
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
    const output =
      "compiling…\ndone\n\nFAIL  src/foo.test.ts > should bar\n  details";
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
    const huge = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const report = createReport({
      allPassed: false,
      results: [
        createResult({
          passed: false,
          output: `${huge}\nFAIL  src/foo.test.ts`,
        }),
      ],
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
        createResult({
          name: "npm run test",
          passed: false,
          output: "FAIL boom",
        }),
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
    const parsedUndef = JSON.parse(
      formatJsonReport(createReport({})),
    ) as JsonReport;
    expect(parsedUndef).not.toHaveProperty("unmatchedFiles");

    const parsedEmpty = JSON.parse(
      formatJsonReport(createReport({ unmatchedFiles: [] })),
    ) as JsonReport;
    expect(parsedEmpty).not.toHaveProperty("unmatchedFiles");
  });

  it("emits skipReason on a per-result entry when it is set", () => {
    const report = createReport({
      scopes: ["actions"] as Scope[],
      results: [
        createResult({
          name: "actionlint .github/workflows/",
          scope: "actions",
          passed: true,
          skipReason: "actionlint-not-installed",
        }),
      ],
      allPassed: true,
    });
    const parsed = JSON.parse(formatJsonReport(report)) as JsonReport;
    expect(parsed.results[0].skipReason).toBe("actionlint-not-installed");
  });

  it("emits skipReason go-not-installed on a per-result backend entry when it is set", () => {
    const report = createReport({
      scopes: ["backend"] as Scope[],
      results: [
        createResult({
          name: "go vet -C backend ./...",
          scope: "backend",
          passed: true,
          skipReason: "go-not-installed",
        }),
      ],
      allPassed: true,
    });
    const parsed = JSON.parse(formatJsonReport(report)) as JsonReport;
    expect(parsed.results[0].skipReason).toBe("go-not-installed");
  });

  it("omits skipReason on per-result entries when undefined", () => {
    const report = createReport({
      results: [createResult({ passed: true })],
    });
    const parsed = JSON.parse(formatJsonReport(report)) as JsonReport;
    expect(parsed.results[0]).not.toHaveProperty("skipReason");
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

    const withoutReason = JSON.parse(
      formatJsonReport(createReport({})),
    ) as JsonReport;
    expect(withoutReason).not.toHaveProperty("reason");
  });

  it("emits the reason field when set to unmatched-files", () => {
    const parsed = JSON.parse(
      formatJsonReport(
        createReport({
          scopes: ["src"] as Scope[],
          results: [createResult({ scope: "src", passed: true })],
          allPassed: false,
          changedFiles: ["src/a.ts", "apps/web/src/b.ts"],
          unmatchedFiles: ["apps/web/src/b.ts"],
          reason: "unmatched-files",
        }),
      ),
    ) as JsonReport;
    expect(parsed.reason).toBe("unmatched-files");
  });
});

describe("integration: root-fallback + no-checks-defined silent-pass hole", () => {
  // End-to-end regression test against the silent-pass hole closed in
  // computeAllPassedAndReason: a non-empty diff that produces zero checks
  // (no matching npm scripts) must emit allPassed:false + reason:
  // "no-checks-defined", not a silent allPassed:true. Uses node:child_process
  // (cross-runtime) to spawn `bun bin/flow-pre-commit.ts` so the test runs
  // under both node-vitest (default `npm run test`) and bun-vitest. A
  // Bun.spawnSync-based variant would silently skip under node-vitest,
  // defeating the entire point of automating issue #150's manual Test Step 5.
  let tmpDir: string;
  const bunOnPath = spawnSync("bun", ["--version"]).status === 0;

  beforeAll(() => {
    if (!bunOnPath) return;
    tmpDir = mkdtempSync(join(tmpdir(), "flow-pre-commit-"));
    mkdirSync(join(tmpDir, "apps", "web", "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "fixture", version: "0.0.1" }, null, 2),
    );
    // Initialise an empty git repo on `main` and seed an empty commit so HEAD
    // exists; then write the test file AFTER the commit and `git add` it so
    // it surfaces as a staged change in `git diff --name-only HEAD` (the
    // command flow-pre-commit uses internally — it sees tracked changes, not
    // untracked files).
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: tmpDir });
    spawnSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "--allow-empty",
        "-q",
        "-m",
        "init",
      ],
      { cwd: tmpDir },
    );
    writeFileSync(
      join(tmpDir, "apps", "web", "src", "x.ts"),
      "export const x = 1;\n",
    );
    spawnSync("git", ["add", "apps/web/src/x.ts"], { cwd: tmpDir });
  });

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!bunOnPath)(
    "flow-pre-commit --json against a tmpdir fixture reports allPassed:false reason:no-checks-defined scopes:[root-fallback]",
    () => {
      const here =
        import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
      const scriptPath = resolve(here, "flow-pre-commit.ts");
      const result = spawnSync("bun", [scriptPath, "--json"], {
        cwd: tmpDir,
        encoding: "utf8",
      });
      const report = JSON.parse(result.stdout) as JsonReport;
      expect(report.allPassed).toBe(false);
      expect(report.reason).toBe("no-checks-defined");
      expect(report.scopes).toContain("root-fallback");
    },
  );
});

describe("integration: a .md-only diff detects the docs scope and runs npm run test", () => {
  // End-to-end regression test for the gap this PR closes: a markdown-only
  // diff must flow detectScopesFromFiles(["x.md"]) -> ["docs"] through main()
  // so the report carries an actual `npm run test` result. The checksForScope
  // unit specs above assert the pure function in isolation; this spec covers
  // the real path — scope detection + filterDefinedChecks + report assembly —
  // that a future main()-level regression (scope-detection drift, a
  // filterDefinedChecks change) could silently break without any unit test
  // catching it. Same node:child_process cross-runtime spawn as the block
  // above so it runs under both node-vitest and bun-vitest.
  let tmpDir: string;
  const bunOnPath = spawnSync("bun", ["--version"]).status === 0;

  beforeAll(() => {
    if (!bunOnPath) return;
    tmpDir = mkdtempSync(join(tmpdir(), "flow-pre-commit-docs-"));
    // package.json defines a `test` script so filterDefinedChecks keeps the
    // `npm run test` check; `test` is a no-op exit-0 so the spawn stays fast
    // and deterministic regardless of host environment.
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify(
        { name: "fixture", version: "0.0.1", scripts: { test: "true" } },
        null,
        2,
      ),
    );
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: tmpDir });
    spawnSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "--allow-empty",
        "-q",
        "-m",
        "init",
      ],
      { cwd: tmpDir },
    );
    writeFileSync(join(tmpDir, "README.md"), "# fixture\n");
    spawnSync("git", ["add", "README.md"], { cwd: tmpDir });
  });

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!bunOnPath)(
    "flow-pre-commit --json on a .md-only diff detects docs and includes npm run test in results",
    () => {
      const here =
        import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
      const scriptPath = resolve(here, "flow-pre-commit.ts");
      const result = spawnSync("bun", [scriptPath, "--json"], {
        cwd: tmpDir,
        encoding: "utf8",
      });
      const report = JSON.parse(result.stdout) as JsonReport;
      expect(report.scopes).toContain("docs");
      expect(report.results.map((r) => r.name)).toContain("npm run test");
    },
  );
});

describe("integration: auto-detect positive path runs apps/web's declared checks through main()", () => {
  // The negative auto-detect branch (no owner → root-fallback) is covered by
  // the block at line ~1326, but the PR's flagship scenario — a real
  // apps/web/package.json on disk producing a dynamic scope whose checks
  // actually execute via the run loop — had zero integration coverage: every
  // Story 1/2/5/6 unit test injects the readPkgJson seam (ownerSeam), so the
  // readPackageJsonAt → detectWorkspaceScopes → dynamicByName → run-loop wiring
  // was never exercised on the real filesystem. A regression in any of those
  // unexported functions would pass every unit test. Same cross-runtime
  // node:child_process spawn as the blocks above. The root package.json
  // declares `workspaces` so `npm run test -w apps/web` resolves the workspace;
  // `test: "true"` keeps the spawned gate fast and deterministic.
  let tmpDir: string;
  const bunOnPath = spawnSync("bun", ["--version"]).status === 0;

  beforeAll(() => {
    if (!bunOnPath) return;
    tmpDir = mkdtempSync(join(tmpdir(), "flow-pre-commit-autodetect-"));
    mkdirSync(join(tmpDir, "apps", "web", "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          version: "0.0.1",
          private: true,
          workspaces: ["apps/*"],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(tmpDir, "apps", "web", "package.json"),
      JSON.stringify(
        { name: "web", version: "0.0.1", scripts: { test: "true" } },
        null,
        2,
      ),
    );
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: tmpDir });
    spawnSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "--allow-empty",
        "-q",
        "-m",
        "init",
      ],
      { cwd: tmpDir },
    );
    writeFileSync(
      join(tmpDir, "apps", "web", "src", "a.ts"),
      "export const a = 1;\n",
    );
    spawnSync("git", ["add", "apps/web/src/a.ts"], { cwd: tmpDir });
  });

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!bunOnPath)(
    "detects apps/web, runs npm run test -w apps/web, and passes with no unmatched files",
    () => {
      const here =
        import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
      const scriptPath = resolve(here, "flow-pre-commit.ts");
      const result = spawnSync("bun", [scriptPath, "--json"], {
        cwd: tmpDir,
        encoding: "utf8",
      });
      const report = JSON.parse(result.stdout) as JsonReport;
      expect(report.scopes).toContain("apps/web");
      expect(report.results.map((r) => r.name)).toContain(
        "npm run test -w apps/web",
      );
      expect(report.allPassed).toBe(true);
      expect(report).not.toHaveProperty("unmatchedFiles");
    },
  );
});

describe("integration: --scope apps/web selects the dynamic scope through main()", () => {
  // parseScopes('apps/web', dyn) is unit-tested with an INJECTED Set (Story 8),
  // but main() builds that Set from the live diff (getChangedFiles →
  // loadDynamicScopes → new Set(d.name) at flow-pre-commit.ts:957-959). That
  // wiring — the only thing that makes `--scope apps/web` selectable for a user
  // — was never exercised end-to-end, so a break in how the dynamic registry
  // is assembled for the --scope path would not be caught. Also pins the
  // negative `--scope apps/nope` → non-zero exit + 'Unknown scope' contract.
  let tmpDir: string;
  const bunOnPath = spawnSync("bun", ["--version"]).status === 0;

  beforeAll(() => {
    if (!bunOnPath) return;
    tmpDir = mkdtempSync(join(tmpdir(), "flow-pre-commit-scope-"));
    mkdirSync(join(tmpDir, "apps", "web", "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          version: "0.0.1",
          private: true,
          workspaces: ["apps/*"],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(tmpDir, "apps", "web", "package.json"),
      JSON.stringify(
        { name: "web", version: "0.0.1", scripts: { test: "true" } },
        null,
        2,
      ),
    );
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: tmpDir });
    spawnSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "--allow-empty",
        "-q",
        "-m",
        "init",
      ],
      { cwd: tmpDir },
    );
    writeFileSync(
      join(tmpDir, "apps", "web", "src", "a.ts"),
      "export const a = 1;\n",
    );
    spawnSync("git", ["add", "apps/web/src/a.ts"], { cwd: tmpDir });
  });

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!bunOnPath)(
    "--scope apps/web runs the dynamic scope's checks",
    () => {
      const here =
        import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
      const scriptPath = resolve(here, "flow-pre-commit.ts");
      const result = spawnSync(
        "bun",
        [scriptPath, "--scope", "apps/web", "--json"],
        {
          cwd: tmpDir,
          encoding: "utf8",
        },
      );
      const report = JSON.parse(result.stdout) as JsonReport;
      expect(report.scopes).toEqual(["apps/web"]);
      expect(report.results.map((r) => r.name)).toContain(
        "npm run test -w apps/web",
      );
      expect(report.allPassed).toBe(true);
    },
  );

  it.skipIf(!bunOnPath)(
    "--scope apps/nope exits non-zero with 'Unknown scope'",
    () => {
      const here =
        import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
      const scriptPath = resolve(here, "flow-pre-commit.ts");
      const result = spawnSync(
        "bun",
        [scriptPath, "--scope", "apps/nope", "--json"],
        {
          cwd: tmpDir,
          encoding: "utf8",
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Unknown scope "apps/nope"');
    },
  );
});

// --- Stories 1–9: monorepo auto-detect + stack-aware resolution + config ---

// Owner seam: every listed package.json path resolves to its object; anything
// else is an absent owner (undefined). Mirrors copilot-config.test.ts's seam.
const ownerSeam =
  (map: Record<string, unknown>): ReadPackageJson =>
  (p: string) =>
    p in map ? map[p] : undefined;

describe("Story 1/2: auto-detect resolves apps/web through declared scripts", () => {
  const readPkg = ownerSeam({
    "apps/web/package.json": {
      scripts: { check: "svelte-check", lint: "eslint", test: "vitest" },
    },
  });

  it("detects an apps/web dynamic scope and keeps apps/web/src out of unmatchedFiles (Story 1)", () => {
    const files = ["apps/web/src/foo.ts"];
    const dyn = detectWorkspaceScopes(computeUnmatchedFiles(files), readPkg);
    expect(detectScopesFromFiles(files, dyn)).toEqual(["apps/web"]);
    expect(computeUnmatchedAfterDynamic(files, dyn)).toEqual([]);
  });

  it("Layer-1 probes check (not an invented typecheck) in table order (Story 2)", () => {
    const dyn = detectWorkspaceScopes(["apps/web/src/a.ts"], readPkg);
    expect(dyn).toHaveLength(1);
    expect(dyn[0].checks.map((c) => c.name)).toEqual([
      "npm run check -w apps/web",
      "npm run lint -w apps/web",
      "npm run test -w apps/web",
    ]);
    expect(dyn[0].checks.map((c) => c.name)).not.toContain(
      "npm run typecheck -w apps/web",
    );
  });
});

describe("Story 5: zero-config mixed diff covers apps/web AND backend", () => {
  const readPkg = ownerSeam({
    "apps/web/package.json": { scripts: { test: "vitest" } },
  });

  it("detects both backend and apps/web with no orphans", () => {
    const files = ["apps/web/src/a.ts", "backend/x.go"];
    const dyn = detectWorkspaceScopes(computeUnmatchedFiles(files), readPkg);
    expect(detectScopesFromFiles(files, dyn)).toEqual(["backend", "apps/web"]);
    expect(computeUnmatchedAfterDynamic(files, dyn)).toEqual([]);
    const { reason } = computeAllPassedAndReason(
      [createResult({ scope: "backend", passed: true })],
      files,
      ["backend", "apps/web"],
      computeUnmatchedAfterDynamic(files, dyn),
    );
    expect(reason).toBeUndefined();
  });
});

describe("Story 6: an orphan bundled with a matched scope is covered by root-fallback", () => {
  const readPkg = ownerSeam({
    "apps/web/package.json": { scripts: { test: "vitest" } },
  });

  it("claims apps/web AND appends root-fallback for vendor/legacy/z.js (no unmatched-files)", () => {
    // Pre-additive (#192) this asserted reason='unmatched-files' + allPassed=false.
    // That encoded the bundled-orphan bug: vendor/legacy/z.js passes when committed
    // alone (→ root-fallback) but failed when bundled with the matched apps/web
    // scope — structurally identical to the package.json repro this PR fixes. Under
    // the additive model the orphan is claimed by root-fallback's repo-wide checks
    // whether bundled or alone, so unmatched-files no longer fires.
    const files = ["apps/web/src/a.ts", "vendor/legacy/z.js"];
    const dyn = detectWorkspaceScopes(computeUnmatchedFiles(files), readPkg);
    const orphans = computeUnmatchedAfterDynamic(files, dyn);
    expect(orphans).toEqual(["vendor/legacy/z.js"]);
    expect(detectScopesFromFiles(files, dyn)).toEqual([
      "apps/web",
      "root-fallback",
    ]);
    const { allPassed, reason } = computeAllPassedAndReason(
      [createResult({ scope: "apps/web", passed: true })],
      files,
      detectScopesFromFiles(files, dyn),
      orphans,
    );
    expect(allPassed).toBe(true);
    expect(reason).toBeUndefined();
  });

  it("a bare apps/web/src/x.ts with NO package.json owner stays an orphan (no auto-detect)", () => {
    const readNone = ownerSeam({});
    const files = ["apps/web/src/x.ts"];
    const dyn = detectWorkspaceScopes(computeUnmatchedFiles(files), readNone);
    expect(dyn).toEqual([]);
    // No dynamic scope, no built-in match → root-fallback (unchanged behavior).
    expect(detectScopesFromFiles(files, dyn)).toEqual(["root-fallback"]);
  });

  it("claims apps/web dynamically AND appends root-fallback for a bundled root package.json", () => {
    // Dynamic scope claims its file; the root file lands in root-fallback. Both
    // fire; no unmatched-files (Story 5 of the plan: dynamic + root coexist).
    const files = ["apps/web/src/a.ts", "package.json"];
    const dyn = detectWorkspaceScopes(computeUnmatchedFiles(files), readPkg);
    const orphans = computeUnmatchedAfterDynamic(files, dyn);
    expect(orphans).toEqual(["package.json"]);
    expect(detectScopesFromFiles(files, dyn)).toEqual([
      "apps/web",
      "root-fallback",
    ]);
    const { allPassed, reason } = computeAllPassedAndReason(
      [createResult({ scope: "apps/web", passed: true })],
      files,
      detectScopesFromFiles(files, dyn),
      orphans,
    );
    expect(allPassed).toBe(true);
    expect(reason).toBeUndefined();
  });
});

describe("Story 7: draftConfigEntryForOrphans (pure Layer-3 helper)", () => {
  it("drafts an entry for a recognizable check-command package the auto-detect missed", () => {
    const readPkg = ownerSeam({
      "services/api/package.json": {
        scripts: { check: "tsc", test: "vitest" },
      },
    });
    // services/ is not an auto-detect root, but workspacePrefixOf only knows
    // apps/ + packages/; a services/ orphan returns null (genuine orphan to
    // auto-detect) — the draft helper agrees here since services/ isn't a
    // workspace root either. Use an apps/ orphan to exercise the entry path.
    expect(
      draftConfigEntryForOrphans(["services/api/src/a.ts"], readPkg),
    ).toBeNull();
  });

  it("drafts an apps/<pkg> entry whose checks come from the package's declared scripts", () => {
    const readPkg = ownerSeam({
      "apps/admin/package.json": { scripts: { check: "tsc", test: "vitest" } },
    });
    const entry = draftConfigEntryForOrphans(["apps/admin/src/a.ts"], readPkg);
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe("apps/admin");
    expect(entry!.checks.map((c) => c.name)).toEqual([
      "npm run check -w apps/admin",
      "npm run test -w apps/admin",
    ]);
  });

  it("returns null for a genuine orphan (no owner)", () => {
    expect(
      draftConfigEntryForOrphans(["vendor/legacy/z.js"], ownerSeam({})),
    ).toBeNull();
  });
});

describe("Story 8: explicit config overrides/extends auto-detect", () => {
  const configReader = (raw: unknown) => () => raw;

  it("a configured web scope's checks win over the auto-detected default for the same prefix", () => {
    const configured = readMonorepoConfig(
      configReader([
        {
          name: "web",
          prefixes: ["apps/web/"],
          checks: ["npm run lint -w apps/web"],
        },
      ]),
    );
    expect(configured?.[0].checks.map((c) => c.name)).toEqual([
      "npm run lint -w apps/web",
    ]);
  });

  it("parseScopes accepts a known dynamic name and still throws Unknown scope for an unknown one", () => {
    const dyn = new Set(["apps/web", "web"]);
    expect(parseScopes("apps/web", dyn)).toEqual(["apps/web"]);
    expect(parseScopes("src,web", dyn)).toEqual(["src", "web"]);
    expect(() => parseScopes("nope", dyn)).toThrow('Unknown scope "nope"');
  });

  it("parseScopes with no dynamic names preserves the legacy built-in-only behavior", () => {
    expect(parseScopes("src,scripts")).toEqual(["src", "scripts"]);
    expect(() => parseScopes("apps/web")).toThrow('Unknown scope "apps/web"');
  });
});

describe("Story 9: malformed or absent config degrades safely", () => {
  const configReader = (raw: unknown) => () => raw;

  it("absent config → undefined (no additional scopes, no throw)", () => {
    expect(readMonorepoConfig(configReader(undefined))).toBeUndefined();
  });

  it("a name colliding with a built-in is dropped, well-formed siblings survive", () => {
    const scopes = readMonorepoConfig(
      configReader([
        { name: "src", prefixes: ["apps/web/"], checks: ["x"] },
        {
          name: "ok",
          prefixes: ["apps/api/"],
          checks: ["npm run test -w apps/api"],
        },
      ]),
    );
    expect(scopes?.map((s) => s.name)).toEqual(["ok"]);
  });

  it("checks not a string[] → entry dropped without throwing", () => {
    expect(
      readMonorepoConfig(
        configReader([{ name: "bad", prefixes: ["apps/web/"], checks: [1] }]),
      ),
    ).toEqual([]);
  });
});

describe("Story 4 regression: dynamic scopes never disturb pure built-in detection", () => {
  it("detectScopesFromFiles with no dynamic arg is byte-for-byte unchanged for apps/web/src", () => {
    // The existing pure spec (line ~109) asserts root-fallback with no owner;
    // this re-pins it from the Story-4 angle: the default empty dynamicScopes
    // arg means no filesystem touch and no behavior change.
    expect(detectScopesFromFiles(["apps/web/src/index.ts"])).toEqual([
      "root-fallback",
    ]);
  });

  it("a dynamic scope claiming every file leaves no orphan, so root-fallback is not appended", () => {
    const dyn: DynamicScope[] = [
      {
        name: "apps/web",
        prefixes: ["apps/web/"],
        checks: [{ name: "x", argv: ["x"] }],
      },
    ];
    expect(detectScopesFromFiles(["apps/web/src/index.ts"], dyn)).toEqual([
      "apps/web",
    ]);
  });
});

describe("integration: bin/*.ts executable-mode gate against a git fixture", () => {
  // End-to-end coverage for checkHelperExecutableModes wired into main(): a
  // top-level bin helper staged at mode 100644 must fail the gate with a
  // `bin/*.ts executable mode` result; the same helper at 100755 must pass.
  // Same cross-runtime node:child_process spawn as the blocks above so it runs
  // under both node-vitest and bun-vitest. Each case uses its own fixture repo
  // so the two staged modes don't interfere.
  const bunOnPath = spawnSync("bun", ["--version"]).status === 0;
  let nonExecDir: string;
  let execDir: string;

  function seedRepo(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "0.0.1" }, null, 2),
    );
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    spawnSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "--allow-empty",
        "-q",
        "-m",
        "init",
      ],
      { cwd: dir },
    );
    return dir;
  }

  beforeAll(() => {
    if (!bunOnPath) return;

    // Case 1: helper staged at 100644 (non-executable) → gate fails.
    nonExecDir = seedRepo("flow-pre-commit-mode-bad-");
    writeFileSync(
      join(nonExecDir, "bin", "flow-fixturehelper.ts"),
      "export const x = 1;\n",
    );
    spawnSync("git", ["add", "bin/flow-fixturehelper.ts"], { cwd: nonExecDir });

    // Case 2: same helper chmod 0o755 before staging (executable) → gate passes.
    execDir = seedRepo("flow-pre-commit-mode-ok-");
    const execFile = join(execDir, "bin", "flow-fixturehelper.ts");
    writeFileSync(execFile, "export const x = 1;\n");
    chmodSync(execFile, 0o755);
    spawnSync("git", ["add", "bin/flow-fixturehelper.ts"], { cwd: execDir });
  });

  afterAll(() => {
    if (nonExecDir) rmSync(nonExecDir, { recursive: true, force: true });
    if (execDir) rmSync(execDir, { recursive: true, force: true });
  });

  it.skipIf(!bunOnPath)(
    "fails when a staged bin helper is tracked 100644",
    () => {
      const here =
        import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
      const scriptPath = resolve(here, "flow-pre-commit.ts");
      const result = spawnSync("bun", [scriptPath, "--json"], {
        cwd: nonExecDir,
        encoding: "utf8",
      });
      const report = JSON.parse(result.stdout) as JsonReport;
      expect(report.allPassed).toBe(false);
      const modeResult = report.results.find(
        (r) => r.name === "bin/*.ts executable mode",
      );
      expect(modeResult).toBeDefined();
      expect(modeResult!.passed).toBe(false);
    },
  );

  it.skipIf(!bunOnPath)(
    "passes when the staged bin helper is tracked 100755",
    () => {
      const here =
        import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
      const scriptPath = resolve(here, "flow-pre-commit.ts");
      const result = spawnSync("bun", [scriptPath, "--json"], {
        cwd: execDir,
        encoding: "utf8",
      });
      const report = JSON.parse(result.stdout) as JsonReport;
      const modeResult = report.results.find(
        (r) => r.name === "bin/*.ts executable mode",
      );
      expect(modeResult).toBeDefined();
      expect(modeResult!.passed).toBe(true);
    },
  );
});

describe("guard: shipped bin/lib executable modules are tracked 100755", () => {
  // Live regression guard reproducing the PR #313 incident (ui-validation-schema.ts
  // committed 100644). Dynamically discovers the real bin/lib/*.ts modules that
  // carry the executable signal (bun shebang + import.meta.main) — rather than
  // hardcoding a list that rots when a fifth is added — and asserts each is
  // tracked executable in the git index. chmod 644 on any of them makes this fail.
  const here =
    import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
  const libDir = resolve(here, "lib");
  const repoRoot = resolve(here, "..");

  const executableLibModules = readdirSync(libDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .filter((name) =>
      isExecutableLibModule(readFileSync(join(libDir, name), "utf8")),
    )
    .map((name) => `bin/lib/${name}`);

  it("discovers at least the four known executable lib modules", () => {
    // Sanity check that the dynamic scan actually found modules; a regex/path
    // bug that silently matched nothing would make the per-file guard vacuous.
    expect(executableLibModules).toEqual(
      expect.arrayContaining([
        "bin/lib/agent-finding-schema.ts",
        "bin/lib/fix-applier-schema.ts",
        "bin/lib/pr-review-result-schema.ts",
        "bin/lib/ui-validation-schema.ts",
      ]),
    );
  });

  it.each(executableLibModules)("%s is tracked 100755", (path) => {
    const result = spawnSync("git", ["ls-files", "-s", "--", path], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const mode = result.stdout.slice(0, result.stdout.indexOf(" "));
    expect(mode).toBe("100755");
  });
});
