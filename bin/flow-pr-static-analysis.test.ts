import { describe, expect, it, vi } from "vitest";
import {
  applyConfidenceThreshold,
  applyDiffScope,
  computeChangedLines,
  parseArgs,
  parseBiomeJson,
  parseCoverageJson,
  parseEslintJson,
  parseSemgrepJson,
  parseTscOutput,
  run,
  type Deps,
  type Finding,
} from "./flow-pr-static-analysis";

// --- fixture builders ------------------------------------------------------

function makeSemgrepJson(
  results: Array<{
    file: string;
    line: number;
    end_line?: number;
    rule: string;
    severity: "ERROR" | "WARNING" | "INFO";
    message?: string;
  }>,
): string {
  return JSON.stringify({
    results: results.map((r) => ({
      path: r.file,
      start: { line: r.line },
      end: r.end_line !== undefined ? { line: r.end_line } : undefined,
      check_id: r.rule,
      extra: { severity: r.severity, message: r.message ?? r.rule },
    })),
  });
}

function makeBiomeJsonOldShape(
  diags: Array<{ file: string; line: number; severity: string; category: string; message: string }>,
): string {
  return JSON.stringify({
    diagnostics: diags.map((d) => ({
      location: {
        path: { file: d.file },
        span: { start: { line: d.line } },
      },
      severity: d.severity,
      category: d.category,
      message: { content: d.message },
    })),
  });
}

function makeEslintJson(
  files: Array<{
    file: string;
    messages: Array<{ line: number; ruleId: string; message: string; severity: 1 | 2; endLine?: number }>;
  }>,
): string {
  return JSON.stringify(
    files.map((f) => ({ filePath: f.file, messages: f.messages })),
  );
}

function makeTscOutput(
  errors: Array<{ file: string; line: number; col?: number; code: string; message: string }>,
): string {
  return errors
    .map((e) => `${e.file}(${e.line},${e.col ?? 1}): error ${e.code}: ${e.message}`)
    .join("\n") + "\n";
}

function makeCoverageJson(
  files: Array<{
    file: string;
    statements: Array<{ id: string; line: number; endLine?: number; hits: number }>;
  }>,
): string {
  const obj: Record<string, unknown> = {};
  for (const f of files) {
    const statementMap: Record<string, unknown> = {};
    const s: Record<string, number> = {};
    for (const stmt of f.statements) {
      statementMap[stmt.id] = {
        start: { line: stmt.line },
        end: { line: stmt.endLine ?? stmt.line },
      };
      s[stmt.id] = stmt.hits;
    }
    obj[f.file] = { path: f.file, statementMap, s };
  }
  return JSON.stringify(obj);
}

function makeUnifiedDiff(
  files: Array<{
    path: string;
    hunks: Array<{ oldStart: number; newStart: number; lines: string[] }>;
  }>,
): string {
  const out: string[] = [];
  for (const f of files) {
    out.push(`diff --git a/${f.path} b/${f.path}`);
    out.push("index abc..def 100644");
    out.push(`--- a/${f.path}`);
    out.push(`+++ b/${f.path}`);
    for (const h of f.hunks) {
      const oldCount = h.lines.filter((l) => !l.startsWith("+")).length;
      const newCount = h.lines.filter((l) => !l.startsWith("-")).length;
      out.push(`@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@`);
      out.push(...h.lines);
    }
  }
  return out.join("\n") + "\n";
}

// --- parseSemgrepJson ------------------------------------------------------

describe(parseSemgrepJson, () => {
  it("returns empty array for empty input", () => {
    expect(parseSemgrepJson("")).toEqual([]);
    expect(parseSemgrepJson("   \n  ")).toEqual([]);
  });

  it("returns empty array for malformed JSON", () => {
    expect(parseSemgrepJson("{not json")).toEqual([]);
    expect(parseSemgrepJson("[]")).toEqual([]); // missing results key
    expect(parseSemgrepJson('{"results": "not-array"}')).toEqual([]);
  });

  it("maps ERROR severity to confidence 95", () => {
    const json = makeSemgrepJson([
      { file: "src/a.ts", line: 10, rule: "rule.injection", severity: "ERROR", message: "SQL injection" },
    ]);
    const findings = parseSemgrepJson(json);
    expect(findings).toHaveLength(1);
    expect(findings[0].confidence).toBe(95);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].source).toBe("semgrep");
    expect(findings[0].rule_id).toBe("rule.injection");
    expect(findings[0].message).toBe("SQL injection");
  });

  it("maps WARNING to 80 and INFO to 60", () => {
    const json = makeSemgrepJson([
      { file: "a", line: 1, rule: "w", severity: "WARNING" },
      { file: "b", line: 2, rule: "i", severity: "INFO" },
    ]);
    const findings = parseSemgrepJson(json);
    expect(findings.map((f) => f.confidence)).toEqual([80, 60]);
    expect(findings.map((f) => f.severity)).toEqual(["warning", "info"]);
  });

  it("captures end_line when greater than start", () => {
    const json = makeSemgrepJson([
      { file: "a", line: 5, end_line: 10, rule: "r", severity: "ERROR" },
      { file: "a", line: 5, end_line: 5, rule: "r", severity: "ERROR" }, // same → omit
    ]);
    const findings = parseSemgrepJson(json);
    expect(findings[0].end_line).toBe(10);
    expect(findings[1].end_line).toBeUndefined();
  });

  it("skips entries missing path / start.line / check_id", () => {
    const partial = JSON.stringify({
      results: [
        { start: { line: 1 }, check_id: "r", extra: { severity: "ERROR" } }, // no path
        { path: "a", check_id: "r", extra: { severity: "ERROR" } }, // no start.line
        { path: "a", start: { line: 1 }, extra: { severity: "ERROR" } }, // no check_id
      ],
    });
    expect(parseSemgrepJson(partial)).toEqual([]);
  });
});

// --- parseBiomeJson --------------------------------------------------------

describe(parseBiomeJson, () => {
  it("returns empty array for empty / malformed input", () => {
    expect(parseBiomeJson("", "/cwd")).toEqual([]);
    expect(parseBiomeJson("not json", "/cwd")).toEqual([]);
    expect(parseBiomeJson("[]", "/cwd")).toEqual([]);
  });

  it("parses old shape (span.start.line) and maps severities", () => {
    const json = makeBiomeJsonOldShape([
      { file: "/cwd/a.ts", line: 7, severity: "error", category: "lint/suspicious/noFoo", message: "bad foo" },
      { file: "/cwd/a.ts", line: 8, severity: "warning", category: "lint/style/noBar", message: "bar" },
    ]);
    const findings = parseBiomeJson(json, "/cwd");
    expect(findings.map((f) => f.confidence)).toEqual([90, 75]);
    expect(findings.map((f) => f.severity)).toEqual(["error", "warning"]);
    expect(findings.map((f) => f.file)).toEqual(["a.ts", "a.ts"]); // relativised
    expect(findings[0].rule_id).toBe("lint/suspicious/noFoo");
    expect(findings[0].source).toBe("biome");
  });

  it("parses modern shape (byte span + sourceCode)", () => {
    const sourceCode = "line one\nline two\nline three\nline four\n";
    // byte 9 is the start of "line two" (index after "line one\n" which is 9 chars)
    const byteOffset = "line one\n".length;
    const json = JSON.stringify({
      diagnostics: [
        {
          location: {
            path: { file: "/cwd/file.ts" },
            span: [byteOffset, byteOffset + 8],
            sourceCode,
          },
          severity: "error",
          category: "lint/foo",
          message: { content: "bad on line 2" },
        },
      ],
    });
    const findings = parseBiomeJson(json, "/cwd");
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });

  it("skips diagnostics with no resolvable line", () => {
    const json = JSON.stringify({
      diagnostics: [
        { location: { path: { file: "/cwd/a.ts" } }, severity: "error", category: "lint/foo", message: { content: "x" } },
      ],
    });
    expect(parseBiomeJson(json, "/cwd")).toEqual([]);
  });
});

// --- parseEslintJson -------------------------------------------------------

describe(parseEslintJson, () => {
  it("returns empty array for empty / malformed input", () => {
    expect(parseEslintJson("", "/cwd")).toEqual([]);
    expect(parseEslintJson("not json", "/cwd")).toEqual([]);
    expect(parseEslintJson("{}", "/cwd")).toEqual([]); // not an array
  });

  it("maps severity 2 → 90 and severity 1 → 75", () => {
    const json = makeEslintJson([
      {
        file: "/cwd/src/a.ts",
        messages: [
          { line: 10, ruleId: "no-unused-vars", message: "unused", severity: 2 },
          { line: 12, ruleId: "prefer-const", message: "const", severity: 1, endLine: 15 },
        ],
      },
    ]);
    const findings = parseEslintJson(json, "/cwd");
    expect(findings.map((f) => f.confidence)).toEqual([90, 75]);
    expect(findings.map((f) => f.severity)).toEqual(["error", "warning"]);
    expect(findings[0].file).toBe("src/a.ts"); // relativised
    expect(findings[1].end_line).toBe(15);
    expect(findings[0].source).toBe("eslint");
  });

  it("uses 'eslint/unknown' rule_id when ruleId is null", () => {
    const json = JSON.stringify([
      { filePath: "/cwd/a.ts", messages: [{ line: 1, ruleId: null, message: "parser error", severity: 2 }] },
    ]);
    const findings = parseEslintJson(json, "/cwd");
    expect(findings[0].rule_id).toBe("eslint/unknown");
  });
});

// --- parseTscOutput --------------------------------------------------------

describe(parseTscOutput, () => {
  it("returns empty array for empty / no-error input", () => {
    expect(parseTscOutput("", "/cwd")).toEqual([]);
    expect(parseTscOutput("nothing matches the regex", "/cwd")).toEqual([]);
  });

  it("parses path(line,col): error TSnnnn: msg lines and assigns confidence 100", () => {
    const stdout = makeTscOutput([
      { file: "src/a.ts", line: 5, col: 3, code: "TS2322", message: "Type 'string' is not assignable to type 'number'." },
      { file: "src/b.ts", line: 9, code: "TS2304", message: "Cannot find name 'foo'." },
    ]);
    const findings = parseTscOutput(stdout, "/cwd");
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      file: "src/a.ts",
      line: 5,
      rule_id: "TS2322",
      confidence: 100,
      severity: "error",
      source: "tsc",
    });
    expect(findings[0].message).toContain("not assignable");
  });

  it("relativises absolute file paths against the worktree", () => {
    const stdout = "/cwd/src/a.ts(1,1): error TS1: msg\n";
    const findings = parseTscOutput(stdout, "/cwd");
    expect(findings[0].file).toBe("src/a.ts");
  });
});

// --- parseCoverageJson -----------------------------------------------------

describe(parseCoverageJson, () => {
  it("returns empty array for empty / malformed input", () => {
    expect(parseCoverageJson("", "/cwd")).toEqual([]);
    expect(parseCoverageJson("not json", "/cwd")).toEqual([]);
  });

  it("emits one finding per uncovered statement, skipping covered ones", () => {
    const json = makeCoverageJson([
      {
        file: "/cwd/src/a.ts",
        statements: [
          { id: "0", line: 1, hits: 5 }, // covered
          { id: "1", line: 7, hits: 0 }, // uncovered
          { id: "2", line: 12, endLine: 15, hits: 0 }, // uncovered with end_line
        ],
      },
    ]);
    const findings = parseCoverageJson(json, "/cwd");
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.line)).toEqual([7, 12]);
    expect(findings[1].end_line).toBe(15);
    expect(findings[0]).toMatchObject({
      confidence: 85,
      rule_id: "coverage/uncovered-statement",
      source: "coverage",
      severity: "warning",
      file: "src/a.ts",
    });
  });
});

// --- computeChangedLines ---------------------------------------------------

describe(computeChangedLines, () => {
  it("returns an empty map for empty diff", () => {
    expect(computeChangedLines("")).toEqual(new Map());
  });

  it("collects only + lines, advancing past unchanged context", () => {
    const diff = makeUnifiedDiff([
      {
        path: "src/a.ts",
        hunks: [
          {
            oldStart: 10,
            newStart: 10,
            lines: [" ctx1", "+added1", "+added2", " ctx2", "-removed", " ctx3"],
          },
        ],
      },
    ]);
    const map = computeChangedLines(diff);
    expect(map.get("src/a.ts")).toEqual(new Set([11, 12]));
  });

  it("handles multiple hunks in the same file", () => {
    const diff = makeUnifiedDiff([
      {
        path: "src/a.ts",
        hunks: [
          { oldStart: 1, newStart: 1, lines: ["+first", " ctx"] },
          { oldStart: 50, newStart: 50, lines: [" ctx", "+at-fifty-one"] },
        ],
      },
    ]);
    const map = computeChangedLines(diff);
    expect(map.get("src/a.ts")).toEqual(new Set([1, 51]));
  });

  it("handles multiple files in one diff", () => {
    const diff = makeUnifiedDiff([
      { path: "a.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
      { path: "b.ts", hunks: [{ oldStart: 5, newStart: 5, lines: ["+y", "+z"] }] },
    ]);
    const map = computeChangedLines(diff);
    expect(map.get("a.ts")).toEqual(new Set([1]));
    expect(map.get("b.ts")).toEqual(new Set([5, 6]));
  });

  it("does not include - removed lines", () => {
    const diff = makeUnifiedDiff([
      {
        path: "src/a.ts",
        hunks: [
          { oldStart: 1, newStart: 1, lines: ["-only-removed"] },
        ],
      },
    ]);
    // After the rename: file with no + lines is dropped from the map.
    const map = computeChangedLines(diff);
    expect(map.has("src/a.ts")).toBe(false);
  });
});

// --- applyDiffScope --------------------------------------------------------

describe(applyDiffScope, () => {
  const finding = (file: string, line: number, end_line?: number): Finding => ({
    file,
    line,
    rule_id: "r",
    message: "m",
    confidence: 90,
    source: "semgrep",
    ...(end_line !== undefined ? { end_line } : {}),
  });

  it("returns empty when changed-lines map is empty", () => {
    expect(applyDiffScope([finding("a", 1)], new Map())).toEqual([]);
  });

  it("keeps findings on changed lines", () => {
    const map = new Map([["a", new Set([10, 11, 12])]]);
    const out = applyDiffScope(
      [finding("a", 10), finding("a", 11), finding("a", 99)],
      map,
    );
    expect(out.map((f) => f.line)).toEqual([10, 11]);
  });

  it("drops findings on files not in the changed-lines map", () => {
    const map = new Map([["a", new Set([10])]]);
    expect(applyDiffScope([finding("b", 10)], map)).toEqual([]);
  });

  it("keeps multi-line findings whose range overlaps any changed line", () => {
    const map = new Map([["a", new Set([20])]]);
    expect(applyDiffScope([finding("a", 18, 22)], map)).toHaveLength(1);
    expect(applyDiffScope([finding("a", 25, 30)], map)).toEqual([]);
  });
});

// --- applyConfidenceThreshold ---------------------------------------------

describe(applyConfidenceThreshold, () => {
  const at = (c: number): Finding => ({
    file: "a",
    line: 1,
    rule_id: "r",
    message: "m",
    confidence: c,
    source: "semgrep",
  });

  it("returns input unchanged when threshold is 0", () => {
    expect(applyConfidenceThreshold([at(50), at(80)], 0)).toHaveLength(2);
  });

  it("filters at the boundary (>=)", () => {
    const findings = [at(60), at(80), at(90), at(100)];
    expect(applyConfidenceThreshold(findings, 80).map((f) => f.confidence)).toEqual([80, 90, 100]);
    expect(applyConfidenceThreshold(findings, 90).map((f) => f.confidence)).toEqual([90, 100]);
    expect(applyConfidenceThreshold(findings, 100).map((f) => f.confidence)).toEqual([100]);
  });
});

// --- parseArgs -------------------------------------------------------------

describe(parseArgs, () => {
  it("returns help marker on --help / -h", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(parseArgs(["-h"])).toEqual({ help: true });
  });

  it("rejects empty argv with a clear error", () => {
    expect(parseArgs([])).toEqual({ error: "PR number is required" });
  });

  it("rejects flags before the PR number", () => {
    const r = parseArgs(["--min-confidence", "80"]);
    expect("error" in r && r.error).toMatch(/PR number must be the first/);
  });

  it("rejects non-numeric PR", () => {
    const r = parseArgs(["foo"]);
    expect("error" in r && r.error).toMatch(/positive integer/);
  });

  it("parses bare PR with defaults", () => {
    expect(parseArgs(["42"])).toEqual({
      pr: 42,
      minConfidence: 80,
      maxToolTimeoutSec: 60,
    });
  });

  it("parses --min-confidence override", () => {
    expect(parseArgs(["7", "--min-confidence", "90"])).toMatchObject({
      pr: 7,
      minConfidence: 90,
    });
    expect(parseArgs(["7", "--min-confidence", "0"])).toMatchObject({ minConfidence: 0 });
  });

  it("rejects --min-confidence values out of 0-100", () => {
    expect("error" in parseArgs(["7", "--min-confidence", "200"])).toBe(true);
    expect("error" in parseArgs(["7", "--min-confidence", "-1"])).toBe(true);
    expect("error" in parseArgs(["7", "--min-confidence", "foo"])).toBe(true);
  });

  it("parses --max-tool-timeout and --coverage-file", () => {
    const r = parseArgs(["7", "--max-tool-timeout", "30", "--coverage-file", "cov.json"]);
    expect(r).toMatchObject({ pr: 7, maxToolTimeoutSec: 30, coverageFile: "cov.json" });
  });

  it("rejects unknown flags", () => {
    const r = parseArgs(["7", "--bogus"]);
    expect("error" in r && r.error).toMatch(/unknown flag/);
  });
});

// --- run integration -------------------------------------------------------

function makeMockDeps(overrides: Partial<Deps> = {}): {
  deps: Deps;
  outs: string[];
  errs: string[];
} {
  const outs: string[] = [];
  const errs: string[] = [];
  const deps: Deps = {
    cwd: "/cwd",
    now: () => 0,
    spawn: vi.fn().mockReturnValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    gh: vi.fn().mockReturnValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    which: vi.fn().mockReturnValue(null), // every tool missing by default
    readFile: vi.fn().mockReturnValue(null),
    fileExists: vi.fn().mockReturnValue(false),
    writeOut: (s) => outs.push(s),
    writeErr: (s) => errs.push(s),
    ...overrides,
  };
  return { deps, outs, errs };
}

describe(run, () => {
  it("exits 2 with usage on stderr when args missing", async () => {
    const { deps, outs, errs } = makeMockDeps();
    const code = await run([], deps);
    expect(code).toBe(2);
    expect(outs).toEqual([]);
    expect(errs.join("")).toMatch(/PR number is required/);
  });

  it("exits 2 on unknown flag", async () => {
    const { deps } = makeMockDeps();
    const code = await run(["7", "--nope"], deps);
    expect(code).toBe(2);
  });

  it("exits 0 with help text on --help", async () => {
    const { deps, outs } = makeMockDeps();
    const code = await run(["--help"], deps);
    expect(code).toBe(0);
    expect(outs.join("")).toMatch(/flow-pr-static-analysis/);
  });

  it("emits all-skipped envelope when no tools are detected", async () => {
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockReturnValue({
        stdout: makeUnifiedDiff([
          { path: "a.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
    });
    const code = await run(["42"], deps);
    expect(code).toBe(0);
    const result = JSON.parse(outs.join(""));
    expect(result.security).toEqual([]);
    expect(result.types).toEqual([]);
    expect(result.coverage).toEqual([]);
    expect(result.lint).toEqual([]);
    expect(result.meta.security.ran).toBe(false);
    expect(result.meta.security.skipped_reason).toBe("semgrep-not-on-path");
    expect(result.meta.types.skipped_reason).toBe("no-tsconfig");
    expect(result.meta.lint.skipped_reason).toBe("no-lint-config");
    expect(result.meta.coverage.skipped_reason).toBe("no-coverage-output");
    expect(result.meta.pr).toBe(42);
    expect(result.meta.min_confidence).toBe(80);
  });

  it("emits gh-pr-diff-failed across all lenses when gh diff exits non-zero", async () => {
    const { deps, outs, errs } = makeMockDeps({
      gh: vi.fn().mockReturnValue({ stdout: "", stderr: "boom", exitCode: 1, timedOut: false }),
    });
    const code = await run(["7"], deps);
    expect(code).toBe(0);
    const result = JSON.parse(outs.join(""));
    for (const lens of ["security", "types", "coverage", "lint"] as const) {
      expect(result.meta[lens].skipped_reason).toBe("gh-pr-diff-failed");
    }
    expect(errs.join("")).toMatch(/gh pr diff 7 failed/);
  });

  it("runs semgrep when on PATH and surfaces ERROR findings on changed lines", async () => {
    const semgrepStdout = makeSemgrepJson([
      { file: "a.ts", line: 5, rule: "rule.x", severity: "ERROR", message: "bad" },
      { file: "a.ts", line: 99, rule: "rule.y", severity: "ERROR", message: "out of scope" },
    ]);
    const spawn = vi.fn().mockReturnValue({
      stdout: semgrepStdout,
      stderr: "",
      exitCode: 1, // semgrep convention: 1 = findings emitted
      timedOut: false,
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockReturnValue({
        stdout: makeUnifiedDiff([
          { path: "a.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+l1", "+l2", "+l3", "+l4", "+l5"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which: vi.fn().mockImplementation((cmd: string) => (cmd === "semgrep" ? "/usr/local/bin/semgrep" : null)),
      spawn,
    });
    const code = await run(["7"], deps);
    expect(code).toBe(0);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.security.ran).toBe(true);
    // Only the line-5 finding survives the diff scope (lines 1-5 changed).
    expect(result.security).toHaveLength(1);
    expect(result.security[0]).toMatchObject({ file: "a.ts", line: 5, confidence: 95 });
    expect(spawn).toHaveBeenCalledWith(
      "semgrep",
      expect.arrayContaining(["--json", "--severity", "ERROR", "--config", "p/security-audit"]),
      expect.any(Object),
    );
  });

  it("marks a lens timed-out when the spawn returns timedOut=true", async () => {
    const spawn = vi.fn().mockReturnValue({ stdout: "", stderr: "", exitCode: -1, timedOut: true });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockReturnValue({
        stdout: makeUnifiedDiff([
          { path: "a.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which: vi.fn().mockImplementation((cmd: string) => (cmd === "semgrep" ? "/bin/semgrep" : null)),
      spawn,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.security.ran).toBe(false);
    expect(result.meta.security.skipped_reason).toBe("timeout");
  });

  it("filters findings below --min-confidence", async () => {
    const semgrepStdout = makeSemgrepJson([
      { file: "a.ts", line: 1, rule: "r1", severity: "INFO" }, // 60
      { file: "a.ts", line: 2, rule: "r2", severity: "WARNING" }, // 80
      { file: "a.ts", line: 3, rule: "r3", severity: "ERROR" }, // 95
    ]);
    const spawn = vi.fn().mockReturnValue({
      stdout: semgrepStdout,
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockReturnValue({
        stdout: makeUnifiedDiff([
          { path: "a.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+a", "+b", "+c"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which: vi.fn().mockImplementation((cmd: string) => (cmd === "semgrep" ? "/bin/semgrep" : null)),
      spawn,
    });
    await run(["7", "--min-confidence", "90"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.security.map((f: Finding) => f.confidence)).toEqual([95]);
  });

  it("prefers biome over eslint when biome.json exists", async () => {
    const fileExists = vi.fn().mockImplementation((p: string) => {
      if (p.endsWith("biome.json")) return true;
      if (p.endsWith("node_modules/.bin/biome")) return false;
      if (p.endsWith("node_modules/.bin/eslint")) return false;
      if (p.endsWith("node_modules/.bin/tsc")) return false;
      if (p.endsWith("tsconfig.json")) return false;
      if (p.endsWith("coverage/coverage-final.json")) return false;
      return false;
    });
    const which = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "biome") return "/usr/bin/biome";
      if (cmd === "eslint") return "/usr/bin/eslint";
      return null;
    });
    const spawn = vi.fn().mockReturnValue({
      stdout: makeBiomeJsonOldShape([
        { file: "/cwd/a.ts", line: 1, severity: "error", category: "lint/x", message: "bad" },
      ]),
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockReturnValue({
        stdout: makeUnifiedDiff([
          { path: "a.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which,
      spawn,
      fileExists,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.lint.ran).toBe(true);
    expect(result.lint[0].source).toBe("biome");
    // Verify eslint was never spawned.
    const calls = spawn.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain("/usr/bin/biome");
    expect(calls).not.toContain("/usr/bin/eslint");
  });

  it("falls back to eslint when biome.json exists but the biome binary is missing", async () => {
    // Regression: hasBiomeConfig + no-biome-binary used to fall through to
    // eslint detection only when eslint *also* had a config; this exercises
    // the documented fall-through path.
    const fileExists = vi.fn().mockImplementation((p: string) => {
      if (p.endsWith("biome.json")) return true;
      if (p.endsWith("eslint.config.js")) return true;
      if (p.includes("node_modules/.bin/")) return false;
      return false;
    });
    const which = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "biome") return null; // biome binary missing
      if (cmd === "eslint") return "/usr/bin/eslint";
      return null;
    });
    const spawn = vi.fn().mockReturnValue({
      stdout: JSON.stringify([
        { filePath: "/cwd/a.ts", messages: [{ line: 1, ruleId: "no-x", message: "bad", severity: 2 }] },
      ]),
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockReturnValue({
        stdout: makeUnifiedDiff([
          { path: "a.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which,
      spawn,
      fileExists,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.lint.ran).toBe(true);
    expect(result.lint[0].source).toBe("eslint");
  });

  it("skips the lint lens with eslint-exit-2 reason when eslint reports a fatal config error", async () => {
    // Without this guard, the parser sees empty stdout, returns [], and we'd
    // emit ran=true with zero findings — masking a real config crash.
    const fileExists = vi.fn().mockImplementation((p: string) => {
      if (p.endsWith("eslint.config.js")) return true;
      return false;
    });
    const which = vi.fn().mockImplementation((cmd: string) => (cmd === "eslint" ? "/usr/bin/eslint" : null));
    const spawn = vi.fn().mockReturnValue({ stdout: "", stderr: "boom", exitCode: 2, timedOut: false });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockReturnValue({
        stdout: makeUnifiedDiff([
          { path: "a.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which,
      spawn,
      fileExists,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.lint.ran).toBe(false);
    expect(result.meta.lint.skipped_reason).toBe("eslint-exit-2");
  });

  it("skips the types lens with tsc-exit-N reason when tsc fails catastrophically", async () => {
    // tsc exit 0 = clean, 1 = type errors. Anything else (2 = bad CLI args,
    // 3 = no files) means stdout is empty and parsing would silently report
    // ran=true with [] findings.
    const fileExists = vi.fn().mockImplementation((p: string) => p.endsWith("tsconfig.json"));
    const which = vi.fn().mockImplementation((cmd: string) => (cmd === "tsc" ? "/usr/bin/tsc" : null));
    const spawn = vi.fn().mockReturnValue({ stdout: "", stderr: "no input files", exitCode: 3, timedOut: false });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockReturnValue({
        stdout: makeUnifiedDiff([
          { path: "a.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which,
      spawn,
      fileExists,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.types.ran).toBe(false);
    expect(result.meta.types.skipped_reason).toBe("tsc-exit-3");
  });

  it("runs tsc against a project-specific tsconfig (e.g. tsconfig.scripts.json) when no plain tsconfig.json exists", async () => {
    // Regression: hard-coding the tsconfig.json check silently skipped the
    // types lens on flow's own repo, which uses tsconfig.scripts.json. The
    // skip is doubly bad because the PR description claims tsc is supported.
    const fileExists = vi.fn().mockImplementation((p: string) => {
      if (p.endsWith("tsconfig.json")) return false;
      if (p.endsWith("tsconfig.scripts.json")) return true;
      if (p.endsWith("node_modules/.bin/tsc")) return false;
      return false;
    });
    const which = vi.fn().mockImplementation((cmd: string) => (cmd === "tsc" ? "/usr/bin/tsc" : null));
    const spawn = vi.fn().mockReturnValue({
      stdout: "src/a.ts(2,1): error TS2304: Cannot find name 'foo'.\n",
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockReturnValue({
        stdout: makeUnifiedDiff([
          { path: "src/a.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x", "+y"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which,
      spawn,
      fileExists,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.types.ran).toBe(true);
    expect(result.types).toHaveLength(1);
    expect(result.types[0].rule_id).toBe("TS2304");
    // Verify tsc was invoked with -p tsconfig.scripts.json.
    const tscCall = spawn.mock.calls.find((c: unknown[]) => c[0] === "/usr/bin/tsc");
    expect(tscCall).toBeDefined();
    expect(tscCall![1]).toEqual(["-p", "tsconfig.scripts.json", "--noEmit", "--pretty", "false"]);
  });
});
