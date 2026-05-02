#!/usr/bin/env bun
/**
 * Inject test-step evidence into a PR body.
 *
 * `/pr-review` step 8c runs each runnable `- [ ]` item in the PR's
 * `## Test Steps` section and ticks the box on success. This helper
 * also records the captured stdout/stderr + exit code as a `<details>`
 * block immediately under the matched item, so a reader of the merged
 * PR sees what was tested without diving into tmux scrollback.
 *
 * The block is anchored on a deterministic `<!-- flow:evidence -->`
 * marker on the open tag, so re-runs replace the prior block instead
 * of stacking. Output is head/tail-trimmed when over the line cap to
 * keep PR bodies under GitHub's 65,536-char limit.
 *
 * Usage:
 *   flow-inject-evidence --body-file <path> --item <regex> \
 *     --output-file <path> --exit-code <N> [--timestamp <iso>]
 */
import { readFileSync, writeFileSync } from "node:fs";

export type InjectArgs = {
  bodyFile: string;
  item: string;
  outputFile: string;
  exitCode: number;
  timestamp?: string;
};

export type InjectResult =
  | { ok: true; body: string; replaced: boolean; ticked: boolean }
  | { ok: false; error: string };

const HEAD_LINES = 100;
const TAIL_LINES = 50;
const TRIM_THRESHOLD = HEAD_LINES + TAIL_LINES;
const MARKER_OPEN = "<!-- flow:evidence -->";

export function parseArgs(argv: string[]): InjectArgs | { error: string } {
  const out: Partial<InjectArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === "--body-file") out.bodyFile = val;
    else if (flag === "--item") out.item = val;
    else if (flag === "--output-file") out.outputFile = val;
    else if (flag === "--exit-code") out.exitCode = Number.parseInt(val, 10);
    else if (flag === "--timestamp") out.timestamp = val;
    else return { error: `unknown flag: ${flag}` };
    i++;
  }
  if (!out.bodyFile) return { error: "--body-file is required" };
  if (!out.item) return { error: "--item is required" };
  if (!out.outputFile) return { error: "--output-file is required" };
  if (typeof out.exitCode !== "number" || Number.isNaN(out.exitCode)) {
    return { error: "--exit-code must be an integer" };
  }
  return out as InjectArgs;
}

export function trimOutput(raw: string): string {
  const lines = raw.split("\n");
  if (lines.length <= TRIM_THRESHOLD) return raw;
  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(-TAIL_LINES);
  const omitted = lines.length - HEAD_LINES - TAIL_LINES;
  return [
    ...head,
    "",
    `... [truncated; ${omitted} more lines, see tmux scrollback for full output]`,
    "",
    ...tail,
  ].join("\n");
}

export function buildEvidenceBlock(
  output: string,
  exitCode: number,
  timestamp: string,
): string {
  const status = exitCode === 0 ? "pass" : `FAILED exit ${exitCode}`;
  const summary = `Output (auto-captured ${timestamp}; ${status})`;
  const trimmed = trimOutput(output);
  return [
    `<details>${MARKER_OPEN}<summary>${summary}</summary>`,
    "",
    "```text",
    trimmed,
    "```",
    "",
    "</details>",
  ].join("\n");
}

function findExistingBlockEnd(lines: string[], matchIdx: number): number | null {
  let i = matchIdx + 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || !lines[i].includes(MARKER_OPEN)) return null;
  while (i < lines.length) {
    if (lines[i].includes("</details>")) return i;
    i++;
  }
  return matchIdx;
}

/**
 * Find the first line matching `args.item` (interpreted as a JS regex,
 * tested against each line). On match: tick `- [ ]` → `- [x]` if the
 * exit code is 0; replace any existing evidence block immediately
 * below; insert a fresh evidence block on the next line.
 */
export function rewriteBody(
  body: string,
  args: InjectArgs,
  output: string,
): InjectResult {
  const lines = body.split("\n");
  const itemRe = new RegExp(args.item);
  const matchIdx = lines.findIndex((line) => itemRe.test(line));
  if (matchIdx < 0) {
    return { ok: false, error: `no line matched item regex: ${args.item}` };
  }

  let ticked = false;
  if (args.exitCode === 0) {
    const next = lines[matchIdx].replace(/^(\s*)- \[ \]/, "$1- [x]");
    if (next !== lines[matchIdx]) {
      lines[matchIdx] = next;
      ticked = true;
    }
  }

  const blockEnd = findExistingBlockEnd(lines, matchIdx);
  const replaced = blockEnd !== null;
  if (replaced) {
    lines.splice(matchIdx + 1, blockEnd - matchIdx);
  }

  const ts = args.timestamp ?? new Date().toISOString();
  const evidence = buildEvidenceBlock(output, args.exitCode, ts);
  lines.splice(matchIdx + 1, 0, ...evidence.split("\n"));

  return { ok: true, body: lines.join("\n"), replaced, ticked };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(`flow-inject-evidence: ${parsed.error}\n`);
    process.exit(2);
  }
  const body = readFileSync(parsed.bodyFile, "utf8");
  const output = readFileSync(parsed.outputFile, "utf8");
  const result = rewriteBody(body, parsed, output);
  if (!result.ok) {
    process.stderr.write(`flow-inject-evidence: ${result.error}\n`);
    process.exit(1);
  }
  writeFileSync(parsed.bodyFile, result.body);
  process.stdout.write(
    `evidence ${result.replaced ? "replaced" : "inserted"}; box ${result.ticked ? "ticked" : "left"}\n`,
  );
}

if (import.meta.main) {
  void main();
}
