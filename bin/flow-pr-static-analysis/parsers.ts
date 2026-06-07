import * as path from "node:path";
import type { Finding, Severity } from "./types";

// --- Confidence mapping ----------------------------------------------------
// Single source of truth. The default `--min-confidence 80` filters soft
// signals automatically; agents see only what's likely to be a real finding.

export const SEMGREP_CONFIDENCE: Record<string, number> = {
  ERROR: 95,
  WARNING: 80,
  INFO: 60,
};

export const BIOME_CONFIDENCE: Record<string, number> = {
  error: 90,
  warning: 75,
  information: 60,
  info: 60,
};

export const ESLINT_CONFIDENCE: Record<number, number> = {
  2: 90, // error
  1: 75, // warning
};

export const TSC_CONFIDENCE = 100; // deterministic compiler output

export const SVELTE_CHECK_CONFIDENCE = 100; // svelte-check is deterministic compiler-equivalent output

export const COVERAGE_UNCOVERED_CONFIDENCE = 85;

export const NPM_AUDIT_CONFIDENCE: Record<string, number> = {
  low: 60,
  moderate: 80,
  high: 90,
  critical: 95,
};

// --- Pure parsers ----------------------------------------------------------

/**
 * Parse `semgrep --json` output. The shape is `{results: [...]}` with each
 * result carrying `path`, `start.line`, `end.line`, `check_id`, `extra.severity`,
 * and `extra.message`. Extras vary by version; we read defensively.
 */
export function parseSemgrepJson(stdout: string): Finding[] {
  if (!stdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { results?: unknown }).results)
  ) {
    return [];
  }
  const results = (parsed as { results: unknown[] }).results;
  const out: Finding[] = [];
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const raw = r as {
      path?: string;
      start?: { line?: number };
      end?: { line?: number };
      check_id?: string;
      extra?: { severity?: string; message?: string };
    };
    if (
      typeof raw.path !== "string" ||
      typeof raw.start?.line !== "number" ||
      typeof raw.check_id !== "string"
    ) {
      continue;
    }
    const sev = raw.extra?.severity ?? "INFO";
    const confidence = SEMGREP_CONFIDENCE[sev] ?? 60;
    const finding: Finding = {
      file: raw.path,
      line: raw.start.line,
      rule_id: raw.check_id,
      message: raw.extra?.message ?? raw.check_id,
      confidence,
      severity: mapSemgrepSeverity(sev),
      source: "semgrep",
    };
    if (typeof raw.end?.line === "number" && raw.end.line > raw.start.line) {
      finding.end_line = raw.end.line;
    }
    out.push(finding);
  }
  return out;
}

function mapSemgrepSeverity(s: string): Severity {
  if (s === "ERROR") return "error";
  if (s === "WARNING") return "warning";
  return "info";
}

/**
 * Parse `biome check --reporter=json` output. Biome's JSON report has a
 * `diagnostics: [{location, severity, category, message}]` shape. The
 * location's file path may be absolute; the caller normalises against the
 * worktree.
 */
export function parseBiomeJson(stdout: string, worktree: string): Finding[] {
  if (!stdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { diagnostics?: unknown }).diagnostics)
  ) {
    return [];
  }
  const diags = (parsed as { diagnostics: unknown[] }).diagnostics;
  const out: Finding[] = [];
  for (const d of diags) {
    if (!d || typeof d !== "object") continue;
    const raw = d as {
      location?: {
        path?: { file?: string } | string;
        span?: [number, number] | { start?: { line?: number } };
        sourceCode?: string;
      };
      severity?: string;
      category?: string;
      message?: string | { content?: string };
      description?: string;
    };
    const file = extractBiomeFile(raw.location?.path);
    if (!file) continue;
    const line = extractBiomeLine(raw.location);
    if (line === null) continue;
    const sev = (raw.severity ?? "info").toLowerCase();
    const confidence = BIOME_CONFIDENCE[sev] ?? 60;
    const message =
      typeof raw.message === "string"
        ? raw.message
        : raw.message?.content ?? raw.description ?? raw.category ?? "biome diagnostic";
    out.push({
      file: relativise(file, worktree),
      line,
      rule_id: raw.category ?? "biome/unknown",
      message,
      confidence,
      severity: mapBiomeSeverity(sev),
      source: "biome",
    });
  }
  return out;
}

function extractBiomeFile(p: unknown): string | null {
  if (typeof p === "string") return p;
  if (p && typeof p === "object" && typeof (p as { file?: string }).file === "string") {
    return (p as { file: string }).file;
  }
  return null;
}

function extractBiomeLine(loc: unknown): number | null {
  if (!loc || typeof loc !== "object") return null;
  const l = loc as {
    span?: [number, number] | { start?: { line?: number } };
    sourceCode?: string;
  };
  // Modern biome: span is [byteStart, byteEnd] — derive line from sourceCode.
  if (Array.isArray(l.span) && typeof l.span[0] === "number" && typeof l.sourceCode === "string") {
    const prefix = l.sourceCode.slice(0, l.span[0]);
    return prefix.split("\n").length;
  }
  // Older biome: span.start.line.
  if (
    l.span &&
    !Array.isArray(l.span) &&
    typeof (l.span as { start?: { line?: number } }).start?.line === "number"
  ) {
    return (l.span as { start: { line: number } }).start.line;
  }
  return null;
}

function mapBiomeSeverity(s: string): Severity {
  if (s === "error") return "error";
  if (s === "warning") return "warning";
  return "info";
}

/**
 * Parse `eslint --format json` output. The shape is an array of file
 * results: `[{filePath, messages: [{line, ruleId, message, severity}]}]`.
 */
export function parseEslintJson(stdout: string, worktree: string): Finding[] {
  if (!stdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Finding[] = [];
  for (const f of parsed) {
    if (!f || typeof f !== "object") continue;
    const raw = f as {
      filePath?: string;
      messages?: Array<{
        line?: number;
        endLine?: number;
        ruleId?: string | null;
        message?: string;
        severity?: number;
      }>;
    };
    if (typeof raw.filePath !== "string" || !Array.isArray(raw.messages)) continue;
    for (const m of raw.messages) {
      if (typeof m.line !== "number") continue;
      const confidence = ESLINT_CONFIDENCE[m.severity ?? 0] ?? 60;
      const finding: Finding = {
        file: relativise(raw.filePath, worktree),
        line: m.line,
        rule_id: m.ruleId ?? "eslint/unknown",
        message: m.message ?? "eslint diagnostic",
        confidence,
        severity: m.severity === 2 ? "error" : "warning",
        source: "eslint",
      };
      if (typeof m.endLine === "number" && m.endLine > m.line) {
        finding.end_line = m.endLine;
      }
      out.push(finding);
    }
  }
  return out;
}

/**
 * Parse `tsc --noEmit --pretty false` stdout. Each diagnostic is a single
 * line: `path/to/file.ts(line,col): error TSnnnn: message`. Multi-line
 * diagnostics (rare; usually wrapped messages) are collapsed onto the
 * first line — we drop continuation lines because they don't carry their
 * own file:line.
 */
export function parseTscOutput(stdout: string, worktree: string): Finding[] {
  if (!stdout.trim()) return [];
  const out: Finding[] = [];
  const re = /^(.+?)\((\d+),\d+\): (error|warning) (TS\d+): (.+)$/;
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    const m = line.match(re);
    if (!m) continue;
    const [, file, lineNum, severityStr, code, message] = m;
    out.push({
      file: relativise(file, worktree),
      line: parseInt(lineNum, 10),
      rule_id: code,
      message,
      confidence: TSC_CONFIDENCE,
      severity: severityStr === "error" ? "error" : "warning",
      source: "tsc",
    });
  }
  return out;
}

/**
 * Parse `svelte-check --output machine` stdout. Each diagnostic is a single
 * line of the shape `ROW COLUMN SEVERITY "FILE" MESSAGE`, e.g.
 * `12 5 ERROR "src/foo.svelte" Cannot find name 'document'.`. Framing lines
 * (`START`, `COMPLETED ...`) and blank lines have no quoted file and are
 * skipped. Machine lines carry no per-line TS code, so `rule_id` is the stable
 * label `"svelte-check"`.
 */
export function parseSvelteCheckOutput(stdout: string, worktree: string): Finding[] {
  if (!stdout.trim()) return [];
  const out: Finding[] = [];
  const re = /^(\d+) (\d+) (ERROR|WARNING) "([^"]+)" (.+)$/;
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    const m = line.match(re);
    if (!m) continue;
    const [, lineNum, , severityStr, file, message] = m;
    out.push({
      file: relativise(file, worktree),
      line: parseInt(lineNum, 10),
      rule_id: "svelte-check",
      message,
      confidence: SVELTE_CHECK_CONFIDENCE,
      severity: severityStr === "ERROR" ? "error" : "warning",
      source: "svelte-check",
    });
  }
  return out;
}

/**
 * Parse a `coverage-final.json` (Istanbul/c8/vitest format). Each file is
 * keyed by absolute path with a `statementMap` and `s` (statement-hit
 * counts). We emit one finding per uncovered statement, dropping
 * out-of-bounds entries defensively.
 */
export function parseCoverageJson(content: string, worktree: string): Finding[] {
  if (!content.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const out: Finding[] = [];
  for (const [absFile, fileDataRaw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!fileDataRaw || typeof fileDataRaw !== "object") continue;
    const fd = fileDataRaw as {
      path?: string;
      statementMap?: Record<string, { start?: { line?: number }; end?: { line?: number } }>;
      s?: Record<string, number>;
    };
    const file = relativise(fd.path ?? absFile, worktree);
    const stmtMap = fd.statementMap ?? {};
    const hits = fd.s ?? {};
    for (const [stmtId, count] of Object.entries(hits)) {
      if (count > 0) continue;
      const stmt = stmtMap[stmtId];
      const startLine = stmt?.start?.line;
      if (typeof startLine !== "number") continue;
      const finding: Finding = {
        file,
        line: startLine,
        rule_id: "coverage/uncovered-statement",
        message: `Statement on line ${startLine} is not covered by any test.`,
        confidence: COVERAGE_UNCOVERED_CONFIDENCE,
        severity: "warning",
        source: "coverage",
      };
      const endLine = stmt?.end?.line;
      if (typeof endLine === "number" && endLine > startLine) {
        finding.end_line = endLine;
      }
      out.push(finding);
    }
  }
  return out;
}

/**
 * Parse `npm audit --json` output (v7+ shape:
 * `{auditReportVersion: 2, vulnerabilities: {<pkg>: {name, severity, isDirect,
 * via, effects, range, nodes, fixAvailable}}}`). The `via` array is mixed:
 * string entries point back into the same vulnerabilities map (sibling-package
 * references, skipped to avoid double-counting) and object entries carry the
 * actual advisory metadata. Transitive (`isDirect=false`) findings are
 * filtered out — v1 scope is direct deps only.
 */
export function parseNpmAuditJson(
  stdout: string,
  packageJsonContent: string | null,
): Finding[] {
  if (!stdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !(parsed as { vulnerabilities?: unknown }).vulnerabilities ||
    typeof (parsed as { vulnerabilities?: unknown }).vulnerabilities !== "object"
  ) {
    return [];
  }
  const vulns = (parsed as { vulnerabilities: Record<string, unknown> }).vulnerabilities;
  const out: Finding[] = [];
  for (const [pkgName, vulnRaw] of Object.entries(vulns)) {
    if (!vulnRaw || typeof vulnRaw !== "object") continue;
    const vuln = vulnRaw as {
      name?: string;
      severity?: string;
      isDirect?: boolean;
      via?: unknown[];
    };
    if (vuln.isDirect === false) continue;
    if (!Array.isArray(vuln.via)) continue;
    const line = resolveNpmAuditLine(pkgName, packageJsonContent);
    for (const via of vuln.via) {
      // Skip string entries — they're sibling-package references that point
      // back into the same vulnerabilities map; emitting them double-counts
      // the same CVE across the dependency chain.
      if (typeof via !== "object" || via === null) continue;
      const v = via as {
        source?: number;
        title?: string;
        url?: string;
        severity?: string;
      };
      const severity = (v.severity ?? vuln.severity ?? "low").toLowerCase();
      const confidence = NPM_AUDIT_CONFIDENCE[severity] ?? 60;
      const ruleId = extractGhsaId(v.url) ?? (v.source !== undefined ? String(v.source) : "npm-audit/unknown");
      out.push({
        file: "package.json",
        line,
        rule_id: ruleId,
        message: v.title ?? `Vulnerability in ${pkgName}`,
        confidence,
        severity: mapNpmAuditSeverity(severity),
        source: "npm-audit",
      });
    }
  }
  return out;
}

function extractGhsaId(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/GHSA-[a-z0-9-]+/i);
  return m ? m[0] : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveNpmAuditLine(pkgName: string, packageJsonContent: string | null): number {
  if (packageJsonContent === null) return 1;
  const re = new RegExp(`"${escapeRegex(pkgName)}"\\s*:`);
  const lines = packageJsonContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return 1;
}

function mapNpmAuditSeverity(s: string): Severity {
  if (s === "critical" || s === "high") return "error";
  if (s === "moderate") return "warning";
  return "info";
}

// --- Diff scoping ----------------------------------------------------------

/**
 * Compute `{file -> Set<line>}` from a unified diff, tracking only NEW-file
 * line numbers from `+` markers (and incrementing past unchanged context).
 *
 * Why not include `-` lines: a finding on a removed line is a finding on
 * code that no longer exists — it cannot be "introduced by this PR". The
 * `/pr-review` "review only changes introduced by this PR" anti-pattern
 * is enforced here at the helper level, not in each agent's prompt.
 */
export function computeChangedLines(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let currentFile: string | null = null;
  let newLineNum = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      if (!result.has(currentFile)) result.set(currentFile, new Set());
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        newLineNum = parseInt(m[1], 10);
        inHunk = true;
      }
      continue;
    }
    if (!inHunk || currentFile === null) continue;
    if (line.startsWith("+")) {
      result.get(currentFile)!.add(newLineNum);
      newLineNum++;
    } else if (line.startsWith("-")) {
      // removed; don't increment new-file counter
    } else if (line.startsWith(" ") || line === "") {
      newLineNum++;
    }
    // "\ No newline at end of file" and other markers fall through.
  }

  // Drop files that ended up with no `+` lines (rename-only, mode-only).
  for (const [file, set] of result) {
    if (set.size === 0) result.delete(file);
  }
  return result;
}

/**
 * Filter a finding list to those falling on lines actually touched by the
 * PR. A finding's primary line must intersect the changed-lines set for
 * its file; if `end_line` is set the range overlap is checked.
 *
 * Pre-existing issues on untouched lines of touched files are dropped —
 * they're out of scope for "review only changes introduced by this PR".
 */
export function applyDiffScope(
  findings: Finding[],
  changedLines: Map<string, Set<number>>,
): Finding[] {
  if (changedLines.size === 0) return [];
  return findings.filter((f) => {
    const lines = changedLines.get(f.file);
    if (!lines) return false;
    if (f.end_line === undefined) return lines.has(f.line);
    for (let l = f.line; l <= f.end_line; l++) {
      if (lines.has(l)) return true;
    }
    return false;
  });
}

/**
 * Filter a finding list to those at or above the confidence threshold.
 */
export function applyConfidenceThreshold(findings: Finding[], min: number): Finding[] {
  if (min <= 0) return findings;
  return findings.filter((f) => f.confidence >= min);
}

// --- Helpers ---------------------------------------------------------------

export function relativise(p: string, worktree: string): string {
  if (!path.isAbsolute(p)) return p;
  const rel = path.relative(worktree, p);
  return rel.startsWith("..") ? p : rel;
}
