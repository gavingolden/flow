import { describe, expect, it, vi } from "vitest";
import {
  applyConfidenceThreshold,
  applyDiffScope,
  computeChangedLines,
  parseArgs,
  parseBiomeJson,
  parseCoverageJson,
  parseEslintJson,
  parseNpmAuditJson,
  parseSemgrepJson,
  parseSvelteCheckOutput,
  parseTscOutput,
  run,
  spawnAsync,
  type CmdResult,
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

function makeNpmAuditJson(
  specs: Array<{
    pkg: string;
    severity: "low" | "moderate" | "high" | "critical";
    isDirect?: boolean;
    ghsaId?: string;
    title?: string;
    viaIncludesSiblingString?: string;
  }>,
): string {
  const vulnerabilities: Record<string, unknown> = {};
  for (const s of specs) {
    const via: unknown[] = [
      {
        source: 1234,
        name: s.pkg,
        dependency: s.pkg,
        title: s.title ?? `Vulnerability in ${s.pkg}`,
        url: `https://github.com/advisories/${s.ghsaId ?? "GHSA-xxxx-xxxx-xxxx"}`,
        severity: s.severity,
        cwe: ["CWE-79"],
        cvss: { score: 7.5, vectorString: "CVSS:3.1/AV:N" },
        range: "<1.0.0",
      },
    ];
    if (s.viaIncludesSiblingString) via.push(s.viaIncludesSiblingString);
    vulnerabilities[s.pkg] = {
      name: s.pkg,
      severity: s.severity,
      isDirect: s.isDirect ?? true,
      via,
      effects: [],
      range: "<1.0.0",
      nodes: [`node_modules/${s.pkg}`],
      fixAvailable: true,
    };
  }
  return JSON.stringify({ auditReportVersion: 2, vulnerabilities });
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

function makeSvelteCheckOutput(
  diags: Array<{ file: string; line: number; col?: number; severity?: "ERROR" | "WARNING"; message: string }>,
): string {
  const lines = [
    "START",
    ...diags.map(
      (d) => `${d.line} ${d.col ?? 1} ${d.severity ?? "ERROR"} "${d.file}" ${d.message}`,
    ),
    `COMPLETED ${diags.length} ERRORS 0 WARNINGS`,
  ];
  return lines.join("\n") + "\n";
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

// --- parseSvelteCheckOutput ------------------------------------------------

describe(parseSvelteCheckOutput, () => {
  it("returns empty array for empty / framing-only input", () => {
    expect(parseSvelteCheckOutput("", "/cwd")).toEqual([]);
    expect(parseSvelteCheckOutput("START\nCOMPLETED 0 ERRORS 0 WARNINGS\n", "/cwd")).toEqual([]);
  });

  it("parses ROW COL SEVERITY \"file\" message lines and skips framing lines", () => {
    const stdout = makeSvelteCheckOutput([
      { file: "src/App.svelte", line: 12, col: 5, severity: "ERROR", message: "Cannot find name 'document'." },
      { file: "src/lib/x.svelte.ts", line: 3, col: 1, severity: "WARNING", message: "Unused export." },
    ]);
    const findings = parseSvelteCheckOutput(stdout, "/cwd");
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      file: "src/App.svelte",
      line: 12,
      rule_id: "svelte-check",
      confidence: 100,
      severity: "error",
      source: "svelte-check",
    });
    expect(findings[0].message).toContain("document");
    expect(findings[1]).toMatchObject({ line: 3, severity: "warning", source: "svelte-check" });
  });

  it("relativises absolute file paths against the worktree", () => {
    const stdout = '12 5 ERROR "/cwd/src/App.svelte" Cannot find name \'document\'.\n';
    const findings = parseSvelteCheckOutput(stdout, "/cwd");
    expect(findings[0].file).toBe("src/App.svelte");
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

// --- parseNpmAuditJson -----------------------------------------------------

describe(parseNpmAuditJson, () => {
  const samplePackageJson = '{\n  "dependencies": {\n    "lodash": "4.17.20"\n  }\n}';

  it("parses one high-severity finding into a Finding with file=package.json and resolved line", () => {
    const json = makeNpmAuditJson([
      { pkg: "lodash", severity: "high", ghsaId: "GHSA-jf85-cpcp-j695", title: "Prototype Pollution in lodash" },
    ]);
    const findings = parseNpmAuditJson(json, samplePackageJson);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "package.json",
      line: 3, // "lodash" appears on line 3 of samplePackageJson
      rule_id: "GHSA-jf85-cpcp-j695",
      source: "npm-audit",
      severity: "error",
      confidence: 90,
      message: "Prototype Pollution in lodash",
    });
  });

  it("returns [] on empty vulnerabilities object", () => {
    expect(parseNpmAuditJson(JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }), samplePackageJson)).toEqual([]);
  });

  it("returns [] on malformed JSON input", () => {
    expect(parseNpmAuditJson("{not json", samplePackageJson)).toEqual([]);
  });

  it("returns [] when top-level vulnerabilities key is missing", () => {
    expect(parseNpmAuditJson(JSON.stringify({ auditReportVersion: 2 }), samplePackageJson)).toEqual([]);
  });

  it("filters out transitive (isDirect=false) entries", () => {
    const json = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        lodash: {
          name: "lodash",
          severity: "high",
          isDirect: true,
          via: [{ source: 1, title: "direct vuln", url: "https://github.com/advisories/GHSA-aaaa-aaaa-aaaa", severity: "high" }],
        },
        "some-transitive": {
          name: "some-transitive",
          severity: "critical",
          isDirect: false,
          via: [{ source: 2, title: "transitive vuln", url: "https://github.com/advisories/GHSA-bbbb-bbbb-bbbb", severity: "critical" }],
        },
      },
    });
    const findings = parseNpmAuditJson(json, samplePackageJson);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe("direct vuln");
  });

  it("skips string via entries to avoid double-counting sibling CVEs", () => {
    const json = makeNpmAuditJson([
      { pkg: "lodash", severity: "high", ghsaId: "GHSA-xxxx-xxxx-xxxx", viaIncludesSiblingString: "lodash.merge" },
    ]);
    const findings = parseNpmAuditJson(json, samplePackageJson);
    // Even though via has [object, "lodash.merge"], only the object should produce a finding.
    expect(findings).toHaveLength(1);
  });

  it("extracts GHSA ID from via.url", () => {
    const json = makeNpmAuditJson([
      { pkg: "lodash", severity: "high", ghsaId: "GHSA-67mh-4wv8-2f99" },
    ]);
    const findings = parseNpmAuditJson(json, samplePackageJson);
    expect(findings[0].rule_id).toBe("GHSA-67mh-4wv8-2f99");
  });

  it("falls back to String(via.source) when via.url is absent", () => {
    const json = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        lodash: {
          name: "lodash",
          severity: "high",
          isDirect: true,
          via: [{ source: 9876, title: "no-url vuln", severity: "high" }],
        },
      },
    });
    const findings = parseNpmAuditJson(json, samplePackageJson);
    expect(findings[0].rule_id).toBe("9876");
  });

  it("resolves the line number against packageJsonContent", () => {
    const longPackageJson = '{\n  "name": "x",\n  "version": "1.0.0",\n  "dependencies": {\n    "axios": "0.21.0"\n  }\n}';
    const json = makeNpmAuditJson([
      { pkg: "axios", severity: "moderate", ghsaId: "GHSA-test-test-test" },
    ]);
    const findings = parseNpmAuditJson(json, longPackageJson);
    expect(findings[0].line).toBe(5); // "axios" on line 5
  });

  it("falls back to line 1 when packageJsonContent is null", () => {
    const json = makeNpmAuditJson([
      { pkg: "lodash", severity: "high" },
    ]);
    expect(parseNpmAuditJson(json, null)[0].line).toBe(1);
  });

  it("falls back to line 1 when package name doesn't match anything in packageJsonContent", () => {
    const json = makeNpmAuditJson([
      { pkg: "not-in-package-json", severity: "high" },
    ]);
    expect(parseNpmAuditJson(json, samplePackageJson)[0].line).toBe(1);
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
    spawn: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    gh: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
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
      gh: vi.fn().mockResolvedValue({
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
    expect(Array.isArray(result.dependencies)).toBe(true);
    expect(result.dependencies).toEqual([]);
    // Default mockDeps has fileExists=false and which=null; the dependencies
    // lens skips at the first guard (no package.json).
    expect(["no-package-json", "npm-not-on-path"]).toContain(result.meta.dependencies.skipped_reason);
    expect(result.meta.pr).toBe(42);
    expect(result.meta.min_confidence).toBe(80);
  });

  it("emits gh-pr-diff-failed across all lenses when gh diff exits non-zero", async () => {
    const { deps, outs, errs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({ stdout: "", stderr: "boom", exitCode: 1, timedOut: false }),
    });
    const code = await run(["7"], deps);
    expect(code).toBe(0);
    const result = JSON.parse(outs.join(""));
    for (const lens of ["security", "types", "coverage", "lint", "dependencies"] as const) {
      expect(result.meta[lens].skipped_reason).toBe("gh-pr-diff-failed");
    }
    expect(errs.join("")).toMatch(/gh pr diff 7 failed/);
  });

  it("runs semgrep when on PATH and surfaces ERROR findings on changed lines", async () => {
    const semgrepStdout = makeSemgrepJson([
      { file: "a.ts", line: 5, rule: "rule.x", severity: "ERROR", message: "bad" },
      { file: "a.ts", line: 99, rule: "rule.y", severity: "ERROR", message: "out of scope" },
    ]);
    const spawn = vi.fn().mockResolvedValue({
      stdout: semgrepStdout,
      stderr: "",
      exitCode: 1, // semgrep convention: 1 = findings emitted
      timedOut: false,
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
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
    const spawn = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: -1, timedOut: true });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
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
    const spawn = vi.fn().mockResolvedValue({
      stdout: semgrepStdout,
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
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
    const spawn = vi.fn().mockResolvedValue({
      stdout: makeBiomeJsonOldShape([
        { file: "/cwd/a.ts", line: 1, severity: "error", category: "lint/x", message: "bad" },
      ]),
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
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
    const spawn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        { filePath: "/cwd/a.ts", messages: [{ line: 1, ruleId: "no-x", message: "bad", severity: 2 }] },
      ]),
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
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
    const spawn = vi.fn().mockResolvedValue({ stdout: "", stderr: "boom", exitCode: 2, timedOut: false });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
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
    // tsc exit semantics: 0 = clean, 2 = type errors emitted on stdout (the
    // normal "found findings" path). Anything else (1 = command-line error,
    // 3 = no files) is catastrophic — stdout is empty and parsing would
    // silently report ran=true with [] findings.
    const fileExists = vi.fn().mockImplementation((p: string) => p.endsWith("tsconfig.json"));
    const which = vi.fn().mockImplementation((cmd: string) => (cmd === "tsc" ? "/usr/bin/tsc" : null));
    const spawn = vi.fn().mockResolvedValue({ stdout: "", stderr: "no input files", exitCode: 3, timedOut: false });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
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

  it("treats tsc exit 2 as the normal 'found type errors' path, not a catastrophic skip", async () => {
    // Regression for the bug surfaced by the gavingolden/econ-data#194 smoke
    // test: every consumer repo with type errors had its types lens silently
    // skipped because the runner rejected anything other than exit 0/1. Per
    // the TypeScript wiki, exit 2 = type errors emitted on stdout, which is
    // exactly the path agents need to consume.
    const fileExists = vi.fn().mockImplementation((p: string) => p.endsWith("tsconfig.json"));
    const which = vi.fn().mockImplementation((cmd: string) => (cmd === "tsc" ? "/usr/bin/tsc" : null));
    const tscOut = makeTscOutput([
      { file: "a.ts", line: 1, code: "TS2322", message: "Type 'string' is not assignable to 'number'." },
    ]);
    const spawn = vi.fn().mockResolvedValue({ stdout: tscOut, stderr: "", exitCode: 2, timedOut: false });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
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
    expect(result.meta.types.ran).toBe(true);
    expect(result.meta.types.skipped_reason).toBeUndefined();
    expect(result.types).toHaveLength(1);
    expect(result.types[0]).toMatchObject({ rule_id: "TS2322", confidence: 100 });
  });

  it("skips the types lens when tsc exits 1 (command-line / configuration error)", async () => {
    // Exit 1 was historically miscategorized as "found errors" — it's
    // actually the bad-flag / bad-config path, where stdout is empty and a
    // ran=true zero-finding result would mask a real failure. Skip with
    // an explicit reason instead.
    const fileExists = vi.fn().mockImplementation((p: string) => p.endsWith("tsconfig.json"));
    const which = vi.fn().mockImplementation((cmd: string) => (cmd === "tsc" ? "/usr/bin/tsc" : null));
    const spawn = vi.fn().mockResolvedValue({ stdout: "", stderr: "error TS5023: Unknown compiler option 'foo'.", exitCode: 1, timedOut: false });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
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
    expect(result.meta.types.skipped_reason).toBe("tsc-exit-1");
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
    const spawn = vi.fn().mockResolvedValue({
      stdout: "src/a.ts(2,1): error TS2304: Cannot find name 'foo'.\n",
      stderr: "",
      exitCode: 2, // tsc emits 2 when type errors are present (per the wiki)
      timedOut: false,
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
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

  it("runs svelte-check (and svelte-kit sync) on a SvelteKit repo and never spawns tsc", async () => {
    const fileExists = vi.fn().mockImplementation((p: string) => {
      if (p.endsWith("svelte.config.js")) return true;
      if (p.endsWith("tsconfig.json")) return true;
      if (p.endsWith("node_modules/.bin/svelte-check")) return true;
      if (p.endsWith("node_modules/.bin/svelte-kit")) return true;
      return false;
    });
    const which = vi.fn().mockReturnValue(null);
    const readFile = vi.fn().mockImplementation((p: string) =>
      p.endsWith("package.json")
        ? JSON.stringify({ devDependencies: { "@sveltejs/kit": "^2.0.0" } })
        : null,
    );
    const svelteCheckOut = makeSvelteCheckOutput([
      { file: "src/App.svelte", line: 12, col: 5, severity: "ERROR", message: "Cannot find name 'document'." },
    ]);
    const spawn = vi.fn().mockImplementation((cmd: string, cmdArgs: string[]) => {
      if (cmd.endsWith("svelte-kit") && cmdArgs[0] === "sync") {
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
      }
      if (cmd.endsWith("svelte-check")) {
        return Promise.resolve({ stdout: svelteCheckOut, stderr: "", exitCode: 1, timedOut: false });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        stdout: makeUnifiedDiff([
          { path: "src/App.svelte", hunks: [{ oldStart: 1, newStart: 10, lines: ["+a", "+b", "+c"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which,
      spawn,
      fileExists,
      readFile,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.types.ran).toBe(true);
    const calls = spawn.mock.calls as Array<[string, string[]]>;
    const syncCall = calls.find((c) => c[0].endsWith("svelte-kit") && c[1][0] === "sync");
    expect(syncCall).toBeDefined();
    const checkCall = calls.find((c) => c[0].endsWith("svelte-check"));
    expect(checkCall).toBeDefined();
    expect(checkCall![1]).toEqual(["--output", "machine", "--threshold", "error"]);
    expect(calls.some((c) => c[0] === "tsc" || c[0].endsWith("/tsc"))).toBe(false);
    expect(result.types).toHaveLength(1);
    expect(result.types[0]).toMatchObject({ line: 12, source: "svelte-check", severity: "error" });
  });

  it("softens to svelte-check-unavailable when svelte-check is not resolvable and never spawns tsc", async () => {
    const fileExists = vi.fn().mockImplementation((p: string) => {
      if (p.endsWith("svelte.config.js")) return true;
      if (p.endsWith("tsconfig.json")) return true;
      return false; // no node_modules/.bin/svelte-check
    });
    const which = vi.fn().mockReturnValue(null);
    const readFile = vi.fn().mockImplementation((p: string) =>
      p.endsWith("package.json")
        ? JSON.stringify({ devDependencies: { "@sveltejs/kit": "^2.0.0" } })
        : null,
    );
    const spawn = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        stdout: makeUnifiedDiff([
          { path: "src/App.svelte", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which,
      spawn,
      fileExists,
      readFile,
    });
    const code = await run(["7"], deps);
    expect(code).toBe(0);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.types.ran).toBe(false);
    expect(result.meta.types.skipped_reason).toBe("svelte-check-unavailable");
    expect(result.types).toEqual([]);
    const calls = spawn.mock.calls as Array<[string, string[]]>;
    expect(calls.some((c) => c[0] === "tsc" || c[0].endsWith("/tsc"))).toBe(false);
    expect(calls.some((c) => c[0].endsWith("svelte-check"))).toBe(false);
  });

  it("softens to svelte-kit-sync-failed when svelte-kit sync exits non-zero and never spawns svelte-check or tsc", async () => {
    const fileExists = vi.fn().mockImplementation((p: string) => {
      if (p.endsWith("svelte.config.js")) return true;
      if (p.endsWith("tsconfig.json")) return true;
      if (p.endsWith("node_modules/.bin/svelte-check")) return true;
      if (p.endsWith("node_modules/.bin/svelte-kit")) return true;
      return false;
    });
    const which = vi.fn().mockReturnValue(null);
    const readFile = vi.fn().mockImplementation((p: string) =>
      p.endsWith("package.json")
        ? JSON.stringify({ devDependencies: { "@sveltejs/kit": "^2.0.0" } })
        : null,
    );
    const spawn = vi.fn().mockImplementation((cmd: string, cmdArgs: string[]) => {
      if (cmd.endsWith("svelte-kit") && cmdArgs[0] === "sync") {
        return Promise.resolve({ stdout: "", stderr: "boom", exitCode: 1, timedOut: false });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        stdout: makeUnifiedDiff([
          { path: "src/App.svelte", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which,
      spawn,
      fileExists,
      readFile,
    });
    const code = await run(["7"], deps);
    expect(code).toBe(0);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.types.ran).toBe(false);
    expect(result.meta.types.skipped_reason).toBe("svelte-kit-sync-failed");
    const calls = spawn.mock.calls as Array<[string, string[]]>;
    expect(calls.some((c) => c[0].endsWith("svelte-check"))).toBe(false);
    expect(calls.some((c) => c[0] === "tsc" || c[0].endsWith("/tsc"))).toBe(false);
  });

  it("runs tsc (not svelte-check) on a non-Svelte repo", async () => {
    const fileExists = vi.fn().mockImplementation((p: string) => p.endsWith("tsconfig.json"));
    const which = vi.fn().mockImplementation((cmd: string) => (cmd === "tsc" ? "/usr/bin/tsc" : null));
    const tscOut = makeTscOutput([
      { file: "a.ts", line: 1, code: "TS2322", message: "Type error." },
    ]);
    const spawn = vi.fn().mockResolvedValue({ stdout: tscOut, stderr: "", exitCode: 2, timedOut: false });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
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
    expect(result.meta.types.ran).toBe(true);
    expect(result.types[0]).toMatchObject({ rule_id: "TS2322", source: "tsc" });
    const calls = spawn.mock.calls as Array<[string, string[]]>;
    expect(calls.some((c) => c[0] === "/usr/bin/tsc")).toBe(true);
    expect(calls.some((c) => c[0].endsWith("svelte-check") || c[0].endsWith("svelte-kit"))).toBe(false);
  });

  it("runs svelte-check WITHOUT svelte-kit sync on a plain-svelte (non-Kit) repo", async () => {
    // detectSvelte returns "svelte" (not "sveltekit") when a plain `svelte`
    // dep is present with NO svelte.config.* and NO @sveltejs/kit. That path
    // must run svelte-check but must NOT spawn `svelte-kit sync` first.
    const fileExists = vi.fn().mockImplementation((p: string) => {
      if (p.endsWith("svelte.config.js")) return false;
      if (p.endsWith("svelte.config.ts")) return false;
      if (p.endsWith("svelte.config.mjs")) return false;
      if (p.endsWith("tsconfig.json")) return true;
      if (p.endsWith("node_modules/.bin/svelte-check")) return true;
      return false;
    });
    const which = vi.fn().mockReturnValue(null);
    const readFile = vi.fn().mockImplementation((p: string) =>
      p.endsWith("package.json")
        ? JSON.stringify({ devDependencies: { svelte: "^5.0.0" } })
        : null,
    );
    const svelteCheckOut = makeSvelteCheckOutput([
      { file: "src/App.svelte", line: 7, col: 3, severity: "ERROR", message: "Cannot find name 'window'." },
    ]);
    const spawn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.endsWith("svelte-check")) {
        return Promise.resolve({ stdout: svelteCheckOut, stderr: "", exitCode: 1, timedOut: false });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        stdout: makeUnifiedDiff([
          { path: "src/App.svelte", hunks: [{ oldStart: 1, newStart: 5, lines: ["+a", "+b", "+c", "+d"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which,
      spawn,
      fileExists,
      readFile,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.types.ran).toBe(true);
    const calls = spawn.mock.calls as Array<[string, string[]]>;
    expect(calls.some((c) => c[0].endsWith("svelte-check"))).toBe(true);
    expect(calls.some((c) => c[0].endsWith("svelte-kit") && c[1][0] === "sync")).toBe(false);
    expect(calls.some((c) => c[0] === "tsc" || c[0].endsWith("/tsc"))).toBe(false);
    expect(result.types).toHaveLength(1);
    expect(result.types[0]).toMatchObject({ line: 7, source: "svelte-check", severity: "error" });
  });

  it("softens to timeout when svelte-check times out and never spawns tsc", async () => {
    const fileExists = vi.fn().mockImplementation((p: string) => {
      if (p.endsWith("svelte.config.js")) return true;
      if (p.endsWith("tsconfig.json")) return true;
      if (p.endsWith("node_modules/.bin/svelte-check")) return true;
      if (p.endsWith("node_modules/.bin/svelte-kit")) return true;
      return false;
    });
    const which = vi.fn().mockReturnValue(null);
    const readFile = vi.fn().mockImplementation((p: string) =>
      p.endsWith("package.json")
        ? JSON.stringify({ devDependencies: { "@sveltejs/kit": "^2.0.0" } })
        : null,
    );
    const spawn = vi.fn().mockImplementation((cmd: string, cmdArgs: string[]) => {
      if (cmd.endsWith("svelte-kit") && cmdArgs[0] === "sync") {
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
      }
      if (cmd.endsWith("svelte-check")) {
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: true });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        stdout: makeUnifiedDiff([
          { path: "src/App.svelte", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which,
      spawn,
      fileExists,
      readFile,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.types.ran).toBe(false);
    expect(result.meta.types.skipped_reason).toBe("timeout");
    const calls = spawn.mock.calls as Array<[string, string[]]>;
    expect(calls.some((c) => c[0] === "tsc" || c[0].endsWith("/tsc"))).toBe(false);
  });

  it("softens to svelte-check-exit-<n> when svelte-check fails catastrophically and never spawns tsc", async () => {
    // svelte-check exit 0 = no errors, 1 = errors found (both "ran"). Anything
    // else (here 2) is a tooling failure that must skip with an explicit
    // reason rather than a silent zero-finding pass.
    const fileExists = vi.fn().mockImplementation((p: string) => {
      if (p.endsWith("svelte.config.js")) return true;
      if (p.endsWith("tsconfig.json")) return true;
      if (p.endsWith("node_modules/.bin/svelte-check")) return true;
      if (p.endsWith("node_modules/.bin/svelte-kit")) return true;
      return false;
    });
    const which = vi.fn().mockReturnValue(null);
    const readFile = vi.fn().mockImplementation((p: string) =>
      p.endsWith("package.json")
        ? JSON.stringify({ devDependencies: { "@sveltejs/kit": "^2.0.0" } })
        : null,
    );
    const spawn = vi.fn().mockImplementation((cmd: string, cmdArgs: string[]) => {
      if (cmd.endsWith("svelte-kit") && cmdArgs[0] === "sync") {
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
      }
      if (cmd.endsWith("svelte-check")) {
        return Promise.resolve({ stdout: "", stderr: "internal error", exitCode: 2, timedOut: false });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        stdout: makeUnifiedDiff([
          { path: "src/App.svelte", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which,
      spawn,
      fileExists,
      readFile,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.types.ran).toBe(false);
    expect(result.meta.types.skipped_reason).toBe("svelte-check-exit-2");
    const calls = spawn.mock.calls as Array<[string, string[]]>;
    expect(calls.some((c) => c[0] === "tsc" || c[0].endsWith("/tsc"))).toBe(false);
  });

  it("softens to svelte-kit-sync-failed when svelte-kit sync times out and never spawns svelte-check or tsc", async () => {
    // The svelte-kit-sync-failed guard fires on EITHER a non-zero exit (tested
    // above) OR sync.timedOut — this exercises the timeout half.
    const fileExists = vi.fn().mockImplementation((p: string) => {
      if (p.endsWith("svelte.config.js")) return true;
      if (p.endsWith("tsconfig.json")) return true;
      if (p.endsWith("node_modules/.bin/svelte-check")) return true;
      if (p.endsWith("node_modules/.bin/svelte-kit")) return true;
      return false;
    });
    const which = vi.fn().mockReturnValue(null);
    const readFile = vi.fn().mockImplementation((p: string) =>
      p.endsWith("package.json")
        ? JSON.stringify({ devDependencies: { "@sveltejs/kit": "^2.0.0" } })
        : null,
    );
    const spawn = vi.fn().mockImplementation((cmd: string, cmdArgs: string[]) => {
      if (cmd.endsWith("svelte-kit") && cmdArgs[0] === "sync") {
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: true });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        stdout: makeUnifiedDiff([
          { path: "src/App.svelte", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which,
      spawn,
      fileExists,
      readFile,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.types.ran).toBe(false);
    expect(result.meta.types.skipped_reason).toBe("svelte-kit-sync-failed");
    const calls = spawn.mock.calls as Array<[string, string[]]>;
    expect(calls.some((c) => c[0].endsWith("svelte-check"))).toBe(false);
    expect(calls.some((c) => c[0] === "tsc" || c[0].endsWith("/tsc"))).toBe(false);
  });

  it("appends --tsconfig to svelte-check when a non-default tsconfig is resolved", async () => {
    // When resolveTsconfig falls back to a project-specific tsconfig (e.g.
    // tsconfig.app.json), the svelte-check invocation must thread it through
    // as `--tsconfig <path>`; the plain-tsconfig.json happy path omits it.
    const fileExists = vi.fn().mockImplementation((p: string) => {
      if (p.endsWith("svelte.config.js")) return true;
      if (p.endsWith("tsconfig.json")) return false;
      if (p.endsWith("tsconfig.app.json")) return true;
      if (p.endsWith("node_modules/.bin/svelte-check")) return true;
      if (p.endsWith("node_modules/.bin/svelte-kit")) return true;
      return false;
    });
    const which = vi.fn().mockReturnValue(null);
    const readFile = vi.fn().mockImplementation((p: string) =>
      p.endsWith("package.json")
        ? JSON.stringify({ devDependencies: { "@sveltejs/kit": "^2.0.0" } })
        : null,
    );
    const spawn = vi.fn().mockImplementation((cmd: string, cmdArgs: string[]) => {
      if (cmd.endsWith("svelte-kit") && cmdArgs[0] === "sync") {
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
      }
      if (cmd.endsWith("svelte-check")) {
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        stdout: makeUnifiedDiff([
          { path: "src/App.svelte", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which,
      spawn,
      fileExists,
      readFile,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.types.ran).toBe(true);
    const calls = spawn.mock.calls as Array<[string, string[]]>;
    const checkCall = calls.find((c) => c[0].endsWith("svelte-check"));
    expect(checkCall).toBeDefined();
    expect(checkCall![1]).toEqual([
      "--output",
      "machine",
      "--threshold",
      "error",
      "--tsconfig",
      "tsconfig.app.json",
    ]);
  });

  it("detectSvelte swallows a malformed package.json and falls back to svelte.config.* detection", async () => {
    // An unparseable package.json must not throw — detection falls through to
    // config-file presence (svelte.config.js → "sveltekit") rather than
    // crashing the run.
    const fileExists = vi.fn().mockImplementation((p: string) => {
      if (p.endsWith("svelte.config.js")) return true;
      if (p.endsWith("tsconfig.json")) return true;
      if (p.endsWith("node_modules/.bin/svelte-check")) return true;
      if (p.endsWith("node_modules/.bin/svelte-kit")) return true;
      return false;
    });
    const which = vi.fn().mockReturnValue(null);
    const readFile = vi.fn().mockImplementation((p: string) =>
      p.endsWith("package.json") ? "{not json" : null,
    );
    const spawn = vi.fn().mockImplementation((cmd: string, cmdArgs: string[]) => {
      if (cmd.endsWith("svelte-kit") && cmdArgs[0] === "sync") {
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
      }
      if (cmd.endsWith("svelte-check")) {
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        stdout: makeUnifiedDiff([
          { path: "src/App.svelte", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which,
      spawn,
      fileExists,
      readFile,
    });
    const code = await run(["7"], deps);
    expect(code).toBe(0);
    const result = JSON.parse(outs.join(""));
    // Resolves to "sveltekit" via svelte.config.js despite the bad JSON: the
    // SvelteKit path runs svelte-kit sync then svelte-check, never tsc.
    expect(result.meta.types.ran).toBe(true);
    const calls = spawn.mock.calls as Array<[string, string[]]>;
    expect(calls.some((c) => c[0].endsWith("svelte-kit") && c[1][0] === "sync")).toBe(true);
    expect(calls.some((c) => c[0].endsWith("svelte-check"))).toBe(true);
    expect(calls.some((c) => c[0] === "tsc" || c[0].endsWith("/tsc"))).toBe(false);
  });

  it("should issue all lens spawns before any resolves", async () => {
    // Regression guardrail: if Promise.all is converted to sequential await,
    // the second lens cannot enter the registry until the first one has
    // resolved — this assertion catches that serialisation directly, without
    // wall-clock dependency.
    const resolverRegistry = new Map<
      string,
      { resolve: (r: CmdResult) => void; resolved: boolean }
    >();
    const spawn = vi.fn().mockImplementation((cmd: string) => {
      const key =
        cmd.endsWith("semgrep") || cmd === "semgrep"
          ? "semgrep"
          : cmd.endsWith("tsc") || cmd === "tsc"
            ? "tsc"
            : cmd.endsWith("biome") || cmd === "biome"
              ? "biome"
              : null;
      if (!key) return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
      return new Promise<CmdResult>((resolve) => {
        const entry = {
          resolve: (r: CmdResult) => {
            entry.resolved = true;
            resolve(r);
          },
          resolved: false,
        };
        resolverRegistry.set(key, entry);
      });
    });
    const which = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "semgrep") return "/usr/bin/semgrep";
      if (cmd === "biome") return "/usr/bin/biome";
      if (cmd === "tsc") return "/usr/bin/tsc";
      return null;
    });
    const fileExists = vi.fn().mockImplementation((p: string) => {
      if (p.endsWith("tsconfig.json")) return true;
      if (p.endsWith("biome.json")) return true;
      if (p.endsWith("coverage/coverage-final.json")) return true;
      if (p.includes("node_modules/.bin/")) return false;
      return false;
    });
    const readFile = vi.fn().mockImplementation((p: string) => {
      if (p.endsWith("coverage-final.json")) {
        return JSON.stringify({
          "/cwd/a.ts": {
            path: "/cwd/a.ts",
            statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } },
            s: { "0": 1 },
          },
        });
      }
      return null;
    });
    const gh = vi.fn().mockResolvedValue({
      stdout: makeUnifiedDiff([
        { path: "a.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
      ]),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    const { deps, outs } = makeMockDeps({
      now: () => Date.now(),
      spawn,
      gh,
      which,
      fileExists,
      readFile,
    });
    const runPromise = run(["7"], deps);
    // Poll until all three concurrent spawns have been issued, rather than
    // relying on a single event-loop tick — robust to any async lens-setup step.
    await vi.waitFor(
      () => {
        expect(resolverRegistry.has("semgrep")).toBe(true);
        expect(resolverRegistry.has("tsc")).toBe(true);
        expect(resolverRegistry.has("biome")).toBe(true);
      },
      { timeout: 1000 },
    );
    const expectedKeys = ["semgrep", "tsc", "biome"];
    for (const key of expectedKeys) {
      expect(
        resolverRegistry.has(key),
        `${key} was not spawned before any resolved — serialised regression`,
      ).toBe(true);
      expect(
        resolverRegistry.get(key)!.resolved,
        `${key} resolved before all spawns were issued`,
      ).toBe(false);
    }
    for (const key of expectedKeys) {
      resolverRegistry.get(key)!.resolve(
        key === "semgrep"
          ? { stdout: '{"results":[]}', stderr: "", exitCode: 0, timedOut: false }
          : key === "tsc"
            ? { stdout: "", stderr: "", exitCode: 0, timedOut: false }
            : { stdout: '{"diagnostics":[]}', stderr: "", exitCode: 0, timedOut: false },
      );
    }
    await runPromise;
    const result = JSON.parse(outs.join(""));
    expect(result.meta.types.ran).toBe(true);
  });
});

describe(spawnAsync, () => {
  it("resolves with exitCode from a real subprocess close", async () => {
    const result = await spawnAsync(process.execPath, ["-e", "process.exit(7)"], {});
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("resolves (not rejects) with exitCode -1 and error message on ENOENT", async () => {
    const result = await spawnAsync("/nonexistent/binary", [], {});
    expect(result.exitCode).toBe(-1);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toMatch(/ENOENT|no such file|spawn .* ENOENT|nonexistent\/binary/);
  });

  it("escalates SIGTERM to SIGKILL after the 2s grace window", { timeout: 5000 }, async () => {
    const start = Date.now();
    const result = await spawnAsync(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { timeoutMs: 200 },
    );
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    // Lower bound proves SIGKILL did the killing (SIGTERM alone would have
    // killed a non-trapping process within ms). Upper bound proves the grace
    // window didn't get extended.
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThanOrEqual(2800);
  });

  it(
    "caps captured stdout at MAX_STREAM_BYTES (32MB) when a subprocess floods the pipe",
    { timeout: 20000 },
    async () => {
      const MAX_STREAM_BYTES = 32 * 1024 * 1024;
      // Emit 1MB past the cap so the truncate-rather-than-kill branch fires:
      // the parent stops appending at the cap but the child still runs to a
      // clean exit (close, not error/kill).
      const result = await spawnAsync(
        process.execPath,
        ["-e", `process.stdout.write("x".repeat(${MAX_STREAM_BYTES} + 1024 * 1024))`],
        {},
      );
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      // Capture truncated at exactly the cap — proves the overflow chunks were
      // dropped, not buffered, and the process was not killed on overflow.
      expect(result.stdout.length).toBe(MAX_STREAM_BYTES);
    },
  );

  it(
    "does not arm a timeout when opts.timeoutMs is undefined (process runs to completion)",
    { timeout: 5000 },
    async () => {
      const start = Date.now();
      // ~300ms-lived process with no timeoutMs: the timer branch is skipped
      // entirely, so the process exits on its own and timedOut stays false.
      const result = await spawnAsync(
        process.execPath,
        ["-e", "setTimeout(() => process.exit(5), 300)"],
        {},
      );
      const elapsed = Date.now() - start;
      expect(result.exitCode).toBe(5);
      expect(result.timedOut).toBe(false);
      // Lived its full delay — proves nothing cut it short (no armed timer).
      expect(elapsed).toBeGreaterThanOrEqual(250);
    },
  );

  it("runs npm audit and surfaces dependency findings on changed package.json lines", async () => {
    const packageJsonContent = '{\n  "dependencies": {\n    "lodash": "4.17.20"\n  }\n}';
    const auditStdout = makeNpmAuditJson([
      { pkg: "lodash", severity: "high", ghsaId: "GHSA-jf85-cpcp-j695", title: "Prototype Pollution" },
    ]);
    const fileExists = vi.fn().mockImplementation((p: string) => p.endsWith("package.json"));
    const which = vi.fn().mockImplementation((cmd: string) => (cmd === "npm" ? "/usr/bin/npm" : null));
    const readFile = vi.fn().mockImplementation((p: string) =>
      p.endsWith("package.json") ? packageJsonContent : null,
    );
    const spawn = vi.fn().mockResolvedValue({
      stdout: auditStdout,
      stderr: "",
      exitCode: 1, // npm audit exits 1 when vulnerabilities are found
      timedOut: false,
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        stdout: makeUnifiedDiff([
          { path: "package.json", hunks: [{ oldStart: 1, newStart: 1, lines: ["+l1", "+l2", "+l3", "+l4", "+l5"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which,
      spawn,
      fileExists,
      readFile,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.dependencies.ran).toBe(true);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]).toMatchObject({
      file: "package.json",
      rule_id: "GHSA-jf85-cpcp-j695",
      source: "npm-audit",
      confidence: 90,
    });
    expect(spawn).toHaveBeenCalledWith(
      "npm",
      ["audit", "--json"],
      expect.any(Object),
    );
  });

  it("skips the dependencies lens with no-package-json when package.json is absent", async () => {
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        stdout: makeUnifiedDiff([
          { path: "a.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      fileExists: vi.fn().mockReturnValue(false),
      which: vi.fn().mockReturnValue(null),
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.dependencies.ran).toBe(false);
    expect(result.meta.dependencies.skipped_reason).toBe("no-package-json");
  });

  it("skips the dependencies lens with npm-not-on-path when npm is missing", async () => {
    const fileExists = vi.fn().mockImplementation((p: string) => p.endsWith("package.json"));
    const which = vi.fn().mockReturnValue(null); // npm missing
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        stdout: makeUnifiedDiff([
          { path: "a.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      fileExists,
      which,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.dependencies.ran).toBe(false);
    expect(result.meta.dependencies.skipped_reason).toBe("npm-not-on-path");
  });

  it("skips the dependencies lens with timeout when npm audit times out", async () => {
    const fileExists = vi.fn().mockImplementation((p: string) => p.endsWith("package.json"));
    const which = vi.fn().mockImplementation((cmd: string) => (cmd === "npm" ? "/usr/bin/npm" : null));
    const spawn = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: -1, timedOut: true });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        stdout: makeUnifiedDiff([
          { path: "a.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      fileExists,
      which,
      spawn,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.dependencies.ran).toBe(false);
    expect(result.meta.dependencies.skipped_reason).toBe("timeout");
  });

  it("skips the dependencies lens with npm-exit-<n> when npm audit exits with a non-{0,1} code", async () => {
    const fileExists = vi.fn().mockImplementation((p: string) => p.endsWith("package.json"));
    const which = vi.fn().mockImplementation((cmd: string) => (cmd === "npm" ? "/usr/bin/npm" : null));
    const spawn = vi.fn().mockResolvedValue({ stdout: "", stderr: "boom", exitCode: 2, timedOut: false });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        stdout: makeUnifiedDiff([
          { path: "a.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      fileExists,
      which,
      spawn,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.dependencies.ran).toBe(false);
    expect(result.meta.dependencies.skipped_reason).toBe("npm-exit-2");
  });

  it("drops dependency findings whose package.json line is outside the diff scope", async () => {
    // lodash sits on line 3 of the package.json, but the diff only touches
    // lines 5-6 (the axios bump). applyDiffScope must drop the lodash
    // finding — otherwise a pre-existing CVE on an unchanged line would
    // resurface on every PR that touches package.json.
    const packageJsonContent =
      '{\n  "dependencies": {\n    "lodash": "4.17.20",\n    "axios": "0.21.0",\n    "react": "18.0.0"\n  }\n}';
    const auditStdout = makeNpmAuditJson([
      { pkg: "lodash", severity: "high", ghsaId: "GHSA-jf85-cpcp-j695" },
    ]);
    const fileExists = vi.fn().mockImplementation((p: string) => p.endsWith("package.json"));
    const which = vi.fn().mockImplementation((cmd: string) => (cmd === "npm" ? "/usr/bin/npm" : null));
    const readFile = vi.fn().mockImplementation((p: string) =>
      p.endsWith("package.json") ? packageJsonContent : null,
    );
    const spawn = vi.fn().mockResolvedValue({
      stdout: auditStdout,
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        // Diff only touches lines 5-6 (the axios bump). lodash is on line 3.
        stdout: makeUnifiedDiff([
          { path: "package.json", hunks: [{ oldStart: 5, newStart: 5, lines: ["+    \"axios\": \"1.0.0\"", "+    \"react\": \"18.0.0\""] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      which,
      spawn,
      fileExists,
      readFile,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.dependencies.ran).toBe(true);
    // The lens runs and parses the lodash CVE on line 3, but applyDiffScope
    // drops it because the diff only covers lines 5-6.
    expect(result.dependencies).toHaveLength(0);
  });

  it("skips with npm-audit-no-vulnerabilities-key when npm audit emits an error envelope (ENOLOCK)", async () => {
    // npm audit exits 1 both for 'found vulnerabilities' and for 'couldn't
    // run'. The error envelope shape is `{error: {code: 'ENOLOCK', ...}}`
    // with no vulnerabilities key — treating that as ran=true masks a real
    // failure. The lens must detect the missing key and skip.
    const fileExists = vi.fn().mockImplementation((p: string) => p.endsWith("package.json"));
    const which = vi.fn().mockImplementation((cmd: string) => (cmd === "npm" ? "/usr/bin/npm" : null));
    const spawn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ error: { code: "ENOLOCK", summary: "No package-lock.json" } }),
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        stdout: makeUnifiedDiff([
          { path: "package.json", hunks: [{ oldStart: 1, newStart: 1, lines: ["+l1"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      fileExists,
      which,
      spawn,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.dependencies.ran).toBe(false);
    expect(result.meta.dependencies.skipped_reason).toBe("npm-audit-no-vulnerabilities-key");
    expect(result.dependencies).toEqual([]);
  });

  it("treats npm audit exit 1 as the 'found vulnerabilities' path, not a catastrophic skip", async () => {
    const packageJsonContent = '{\n  "dependencies": {\n    "lodash": "4.17.20"\n  }\n}';
    const auditStdout = makeNpmAuditJson([
      { pkg: "lodash", severity: "moderate", ghsaId: "GHSA-aaaa-aaaa-aaaa" },
    ]);
    const fileExists = vi.fn().mockImplementation((p: string) => p.endsWith("package.json"));
    const which = vi.fn().mockImplementation((cmd: string) => (cmd === "npm" ? "/usr/bin/npm" : null));
    const readFile = vi.fn().mockImplementation((p: string) =>
      p.endsWith("package.json") ? packageJsonContent : null,
    );
    const spawn = vi.fn().mockResolvedValue({ stdout: auditStdout, stderr: "", exitCode: 1, timedOut: false });
    const { deps, outs } = makeMockDeps({
      gh: vi.fn().mockResolvedValue({
        stdout: makeUnifiedDiff([
          { path: "package.json", hunks: [{ oldStart: 1, newStart: 1, lines: ["+l1", "+l2", "+l3"] }] },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      fileExists,
      which,
      readFile,
      spawn,
    });
    await run(["7"], deps);
    const result = JSON.parse(outs.join(""));
    expect(result.meta.dependencies.ran).toBe(true);
    expect(result.meta.dependencies.skipped_reason).toBeUndefined();
    expect(result.dependencies).toHaveLength(1);
  });
});
