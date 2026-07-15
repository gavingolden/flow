#!/usr/bin/env bun
/**
 * Hunk-level intent-annotation trigger for /flow-new-feature Step 5b.
 *
 * Reads `git diff -U0 <merge-base>...HEAD` against the resolved default
 * branch, parses hunks per file, evaluates three trigger rules, ranks the
 * resulting candidates by priority, caps the result via a floor/ratio/ceiling
 * formula (operator-overridable machine-wide), and emits
 * a single JSON envelope on stdout:
 *
 *   {
 *     "candidates": [
 *       { "file": "...", "line": 42, "end_line": 50, "side": "RIGHT",
 *         "hunk_excerpt": "..." },
 *       ...
 *     ],
 *     "overflowBullet": "- N additional hunks ..."
 *   }
 *
 * The candidates carry NO `body` field — the calling /flow-new-feature agent
 * fills 1-2-sentence rationale bodies and pipes the constructed Finding[]
 * to flow-post-findings.
 *
 * Usage:
 *   flow-annotate-pr <pr-number>
 *   flow-annotate-pr --help
 */

import * as fs from "node:fs";
import { flowConfigPath } from "./lib/paths";

// --- Constants (exported for tests) ---

export const HUNK_LOC_THRESHOLD = 10;
export const FILE_LOC_THRESHOLD = 30;
export const RESTRUCTURE_PLUS_MIN = 4;
export const RESTRUCTURE_MINUS_MIN = 4;
export const RULE_C_MIN_HUNK_LOC = 5;

export const ANNOTATION_FLOOR = 8;
export const ANNOTATION_CAP_RATIO = 0.5;
export const ANNOTATION_CEILING = 24;

export type CapConfig = { ratio: number; ceiling: number };
export const DEFAULT_CAP_CONFIG: CapConfig = {
  ratio: ANNOTATION_CAP_RATIO,
  ceiling: ANNOTATION_CEILING,
};

/**
 * Config-read seam, mirroring `bin/lib/models-config.ts`'s
 * `defaultReadConfigFile` pattern. Tests inject a fake reader so the real
 * `~/.flow/config.json` is never touched.
 */
export type ReadConfigFile = () => unknown;

export const defaultReadConfigFile: ReadConfigFile = () => {
  try {
    return JSON.parse(fs.readFileSync(flowConfigPath(), "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * Resolves the operator-overridable cap formula from an optional
 * `flowAnnotatePr` key in `~/.flow/config.json`. Any missing/malformed field
 * falls back to its default independently — a present-but-invalid `ratio`
 * doesn't invalidate a valid `ceiling` alongside it, and vice versa.
 */
export function readCapConfig(
  read: ReadConfigFile = defaultReadConfigFile,
): CapConfig {
  const raw = read();
  let ratio = DEFAULT_CAP_CONFIG.ratio;
  let ceiling = DEFAULT_CAP_CONFIG.ceiling;
  if (typeof raw === "object" && raw !== null) {
    const section = (raw as Record<string, unknown>).flowAnnotatePr;
    if (typeof section === "object" && section !== null) {
      const r = (section as Record<string, unknown>).ratio;
      const c = (section as Record<string, unknown>).ceiling;
      if (typeof r === "number" && r > 0 && r <= 1) ratio = r;
      if (typeof c === "number" && Number.isInteger(c) && c >= ANNOTATION_FLOOR)
        ceiling = c;
    }
  }
  return { ratio, ceiling };
}

/**
 * Floor/ratio/ceiling cap formula: `ceiling` when the ratio-scaled count
 * exceeds it, else the ratio-scaled count, but never below `ANNOTATION_FLOOR`.
 * Small/typical PRs (candidateCount <= 2 * ANNOTATION_FLOOR under the default
 * 0.5 ratio) land exactly on the floor — identical behavior to the previous
 * fixed cap of 8.
 */
export function computeCap(
  candidateCount: number,
  capConfig: CapConfig = DEFAULT_CAP_CONFIG,
): number {
  return Math.min(
    capConfig.ceiling,
    Math.max(ANNOTATION_FLOOR, Math.ceil(candidateCount * capConfig.ratio)),
  );
}

// --- Types ---

export type DiffLine = { kind: "+" | "-" | " "; text: string };

export type Hunk = {
  /** Pre-image starting line (from header `-OLD,N`). */
  oldStart: number;
  /** Post-image starting line (from header `+NEW,N`). */
  newStart: number;
  /** Number of pre-image lines. */
  oldCount: number;
  /** Number of post-image lines. */
  newCount: number;
  /** Lines belonging to this hunk (excluding the header). */
  lines: DiffLine[];
  /** The raw header line (`@@ ... @@`). */
  headerRaw: string;
};

export type FileDiff = {
  file: string;
  hunks: Hunk[];
};

export type Candidate = {
  file: string;
  line: number;
  /** Set only when the candidate spans multiple lines. */
  end_line?: number;
  side: "RIGHT" | "LEFT";
  hunk_excerpt: string;
  /** Internal — used for ranking; stripped before emit. */
  _matchedRule: "a" | "b" | "c";
  /** Internal — hunk LOC for ranking. */
  _hunkLoc: number;
  /** Internal — restructure intensity (min(+,-)) for tie-breaks. */
  _restructure: number;
};

export type Envelope = {
  candidates: Array<
    Omit<Candidate, "_matchedRule" | "_hunkLoc" | "_restructure">
  >;
  overflowBullet?: string;
};

// --- Diff parsing ---

const FILE_HEADER_RE = /^diff --git a\/(.+?) b\/(.+?)$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let currentHunk: Hunk | null = null;

  const flushHunk = () => {
    if (current && currentHunk) {
      current.hunks.push(currentHunk);
    }
    currentHunk = null;
  };

  const flushFile = () => {
    flushHunk();
    if (current) files.push(current);
    current = null;
  };

  for (const line of diff.split("\n")) {
    const fileMatch = line.match(FILE_HEADER_RE);
    if (fileMatch) {
      flushFile();
      // Prefer the post-image path (b/...); falls back to a/... if rename or delete.
      current = { file: fileMatch[2], hunks: [] };
      continue;
    }
    if (!current) continue;

    const hunkMatch = line.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      flushHunk();
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount =
        hunkMatch[2] === undefined ? 1 : parseInt(hunkMatch[2], 10);
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount =
        hunkMatch[4] === undefined ? 1 : parseInt(hunkMatch[4], 10);
      currentHunk = {
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [],
        headerRaw: line,
      };
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ kind: "+", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ kind: "-", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ kind: " ", text: line.slice(1) });
    }
    // Drop everything else (no-newline markers, blank lines between hunks).
  }

  flushFile();
  return files;
}

// --- Trigger evaluation ---

/** Counts only changed lines (+ and -), excluding context. */
export function countHunkLoc(hunk: Hunk): number {
  let n = 0;
  for (const l of hunk.lines) {
    if (l.kind === "+" || l.kind === "-") n++;
  }
  return n;
}

export function countPlus(hunk: Hunk): number {
  return hunk.lines.filter((l) => l.kind === "+").length;
}

export function countMinus(hunk: Hunk): number {
  return hunk.lines.filter((l) => l.kind === "-").length;
}

/** Rule (a): hunk has ≥10 changed lines. */
export function matchesRuleA(hunk: Hunk): boolean {
  return countHunkLoc(hunk) >= HUNK_LOC_THRESHOLD;
}

/** Rule (b): mixed-add-delete restructure (≥4 + AND ≥4 -). */
export function matchesRuleB(hunk: Hunk): boolean {
  return (
    countPlus(hunk) >= RESTRUCTURE_PLUS_MIN &&
    countMinus(hunk) >= RESTRUCTURE_MINUS_MIN
  );
}

/**
 * Composite: does this hunk match rules a OR b (file-independent rules)?
 * Used by callers; rule (c) is applied separately because it requires
 * file-level state.
 */
export function evaluateTrigger(hunk: Hunk, fileLoc: number): boolean {
  void fileLoc;
  return matchesRuleA(hunk) || matchesRuleB(hunk);
}

/** Sum of all hunks' changed LOC for a file. */
export function fileChangedLoc(file: FileDiff): number {
  let n = 0;
  for (const h of file.hunks) n += countHunkLoc(h);
  return n;
}

// --- Candidate construction ---

/**
 * Anchor rule:
 * - mixed-add-delete hunks anchor on the first `+` line with side: RIGHT;
 * - pure-deletion hunks anchor on the first `-` line with side: LEFT.
 * Returns line/end_line in post-image coordinates for RIGHT, pre-image
 * for LEFT.
 */
function anchorHunk(hunk: Hunk): {
  line: number;
  end_line?: number;
  side: "RIGHT" | "LEFT";
} {
  const hasPlus = hunk.lines.some((l) => l.kind === "+");
  const hasMinus = hunk.lines.some((l) => l.kind === "-");

  if (hasPlus) {
    // RIGHT side — first + line in the post-image. Walk hunk.lines tracking
    // the post-image line cursor.
    let cursor = hunk.newStart;
    let firstPlus: number | null = null;
    let lastPlus = cursor;
    for (const l of hunk.lines) {
      if (l.kind === "+") {
        if (firstPlus === null) firstPlus = cursor;
        lastPlus = cursor;
        cursor++;
      } else if (l.kind === " ") {
        cursor++;
      }
      // '-' doesn't advance post-image cursor.
    }
    if (firstPlus === null) firstPlus = hunk.newStart;
    return firstPlus === lastPlus
      ? { line: firstPlus, side: "RIGHT" }
      : { line: firstPlus, end_line: lastPlus, side: "RIGHT" };
  }

  // Pure deletion — LEFT side, first - line in the pre-image.
  if (hasMinus) {
    let cursor = hunk.oldStart;
    let firstMinus: number | null = null;
    let lastMinus = cursor;
    for (const l of hunk.lines) {
      if (l.kind === "-") {
        if (firstMinus === null) firstMinus = cursor;
        lastMinus = cursor;
        cursor++;
      } else if (l.kind === " ") {
        cursor++;
      }
    }
    if (firstMinus === null) firstMinus = hunk.oldStart;
    return firstMinus === lastMinus
      ? { line: firstMinus, side: "LEFT" }
      : { line: firstMinus, end_line: lastMinus, side: "LEFT" };
  }

  // Should not happen with a non-empty diff, but degrade gracefully.
  return { line: hunk.newStart, side: "RIGHT" };
}

/** Renders the hunk as a short excerpt (header + lines, joined). */
function hunkExcerpt(hunk: Hunk): string {
  const parts: string[] = [hunk.headerRaw];
  for (const l of hunk.lines) {
    parts.push(`${l.kind}${l.text}`);
  }
  return parts.join("\n");
}

function makeCandidate(
  file: string,
  hunk: Hunk,
  rule: "a" | "b" | "c",
): Candidate {
  const anchor = anchorHunk(hunk);
  return {
    file,
    line: anchor.line,
    ...(anchor.end_line !== undefined ? { end_line: anchor.end_line } : {}),
    side: anchor.side,
    hunk_excerpt: hunkExcerpt(hunk),
    _matchedRule: rule,
    _hunkLoc: countHunkLoc(hunk),
    _restructure: Math.min(countPlus(hunk), countMinus(hunk)),
  };
}

/**
 * Collect candidates across all files, applying per-file dedup for rule (c).
 *
 * - Rules (a) and (b) fire on every matching hunk in every file.
 * - Rule (c) fires ONLY on the first non-trivial hunk (LOC ≥
 *   RULE_C_MIN_HUNK_LOC) in each file whose total changed LOC ≥
 *   FILE_LOC_THRESHOLD, and only when that hunk did not already match (a)
 *   or (b).
 */
export function dedupPerFile(files: FileDiff[]): Candidate[] {
  const out: Candidate[] = [];
  for (const file of files) {
    const fileLoc = fileChangedLoc(file);
    const ruleCEligible = fileLoc >= FILE_LOC_THRESHOLD;
    let ruleCFired = false;
    for (const hunk of file.hunks) {
      const a = matchesRuleA(hunk);
      const b = matchesRuleB(hunk);
      if (a || b) {
        out.push(makeCandidate(file.file, hunk, a ? "a" : "b"));
        continue;
      }
      if (
        ruleCEligible &&
        !ruleCFired &&
        countHunkLoc(hunk) >= RULE_C_MIN_HUNK_LOC
      ) {
        out.push(makeCandidate(file.file, hunk, "c"));
        ruleCFired = true;
      }
    }
  }
  return out;
}

/**
 * Rank candidates by (hunk LOC desc → restructure intensity desc → path
 * alphabetical → line ascending) and cap via the floor/ratio/ceiling formula
 * (see `computeCap`). Returns {kept, surplus} so the caller can format the
 * overflow bullet.
 */
export function rankAndCap(
  candidates: Candidate[],
  capConfig: CapConfig = DEFAULT_CAP_CONFIG,
): {
  kept: Candidate[];
  surplus: number;
} {
  const sorted = [...candidates].sort((x, y) => {
    if (y._hunkLoc !== x._hunkLoc) return y._hunkLoc - x._hunkLoc;
    if (y._restructure !== x._restructure)
      return y._restructure - x._restructure;
    if (x.file !== y.file) return x.file < y.file ? -1 : 1;
    return x.line - y.line;
  });
  const cap = computeCap(sorted.length, capConfig);
  if (sorted.length <= cap) {
    return { kept: sorted, surplus: 0 };
  }
  return {
    kept: sorted.slice(0, cap),
    surplus: sorted.length - cap,
  };
}

export function overflowPointer(surplus: number): string {
  return `- ${surplus} additional hunks exceeded the inline cap — see commit messages for details.`;
}

/** Strips the internal `_*` fields before emitting on stdout. */
function stripInternal(c: Candidate): Envelope["candidates"][number] {
  const result: Envelope["candidates"][number] = {
    file: c.file,
    line: c.line,
    side: c.side,
    hunk_excerpt: c.hunk_excerpt,
  };
  if (c.end_line !== undefined) result.end_line = c.end_line;
  return result;
}

export function buildEnvelope(
  files: FileDiff[],
  capConfig: CapConfig = DEFAULT_CAP_CONFIG,
): Envelope {
  const all = dedupPerFile(files);
  const { kept, surplus } = rankAndCap(all, capConfig);
  const envelope: Envelope = { candidates: kept.map(stripInternal) };
  if (surplus > 0) envelope.overflowBullet = overflowPointer(surplus);
  return envelope;
}

// --- Git invocation (CLI only — not exercised by unit tests) ---

function runGit(args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    const stderr = r.stderr.toString().trim();
    throw new Error(
      stderr || `git ${args.join(" ")} failed with exit code ${r.exitCode}`,
    );
  }
  return r.stdout.toString();
}

/**
 * Resolves the default branch from `git symbolic-ref refs/remotes/origin/HEAD`.
 * Falls back to `main` if the symbolic-ref is missing (fresh clone without
 * HEAD pointer set).
 */
function resolveDefaultBranch(): string {
  try {
    const out = runGit(["symbolic-ref", "refs/remotes/origin/HEAD"]).trim();
    // Format: refs/remotes/origin/main
    const m = out.match(/refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  } catch {
    // Fall through
  }
  return "main";
}

function fetchDiff(): string {
  const defaultBranch = resolveDefaultBranch();
  const mergeBase = runGit([
    "merge-base",
    "HEAD",
    `origin/${defaultBranch}`,
  ]).trim();
  return runGit(["diff", "-U0", `${mergeBase}...HEAD`]);
}

// --- CLI ---

function printHelp(): void {
  const capConfig = readCapConfig();
  console.log(`
Usage: flow-annotate-pr <pr-number>

Reads \`git diff -U0 <merge-base>...HEAD\` against origin/<default-branch>,
evaluates the hunk-level intent-annotation trigger rules, and emits a JSON
envelope on stdout:

  {
    "candidates": [
      { "file": "...", "line": N, "end_line": M?, "side": "RIGHT"|"LEFT",
        "hunk_excerpt": "..." }
    ],
    "overflowBullet": "- N additional hunks ..."  // present when capped
  }

Trigger rules:
  (a) hunk has >= ${HUNK_LOC_THRESHOLD} changed lines (+ AND - combined)
  (b) hunk is a mixed restructure (>= ${RESTRUCTURE_PLUS_MIN} +, >= ${RESTRUCTURE_MINUS_MIN} -)
  (c) file has >= ${FILE_LOC_THRESHOLD} changed LOC — first non-trivial hunk
      (>= ${RULE_C_MIN_HUNK_LOC} LOC) only, per file

Cap: floor ${ANNOTATION_FLOOR}, scaling to ~${Math.round(capConfig.ratio * 100)}% of matched hunks above
the floor, ceiling ${capConfig.ceiling}; surplus rolls into overflowBullet for the calling
agent to append under \`## Why\` in the PR body. Override ratio/ceiling
machine-wide via a \`flowAnnotatePr\` object in ~/.flow/config.json.

The helper does NOT call gh — its only job is local diff + trigger eval +
JSON emit. The PR number arg is accepted for symmetry with other helpers
but is otherwise unused.

Examples:
  flow-annotate-pr 100
  flow-annotate-pr 100 | jq .
  `);
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (args.length === 0) {
    console.error("flow-annotate-pr: PR number is required");
    console.error("run with --help for usage");
    process.exit(2);
  }

  // PR number is accepted for symmetry but not used by the helper.
  void args[0];

  const diff = fetchDiff();
  const files = parseDiff(diff);
  const capConfig = readCapConfig();
  const envelope = buildEnvelope(files, capConfig);
  console.log(JSON.stringify(envelope, null, 2));
}

if (import.meta.main) {
  main();
}
