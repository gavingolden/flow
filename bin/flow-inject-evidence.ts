#!/usr/bin/env bun
/**
 * Inject test-step evidence into a PR body.
 *
 * `/flow-pr-review` step 8c runs each runnable `- [ ]` item in the PR's
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
 *
 * `--item` is interpreted as a JS regex via `new RegExp(args.item)`,
 * tested per body line. Pass a discriminating substring (` `npm run
 * verify` `) rather than the entire item text — characters like `()`,
 * `[]`, `{}`, `?`, `+`, `*`, `|`, `\` carry regex meaning and must be
 * escaped (or scoped out of the pattern) by the caller. Backticks,
 * spaces, dashes, slashes, equals signs are all literal.
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

/**
 * Pick a code-fence length safe for the captured output. Per
 * CommonMark/GFM, a fence of N backticks closes only on a run of
 * >= N backticks. We pick `max(3, longest_run + 1)` so any run in
 * the output is shorter than the surrounding fence and cannot break
 * out — `npm test` printing a markdown ``` block is a real case.
 */
function pickFenceLength(output: string): number {
  let longest = 0;
  for (const match of output.matchAll(/`+/g)) {
    if (match[0].length > longest) longest = match[0].length;
  }
  return Math.max(3, longest + 1);
}

export function buildEvidenceBlock(
  output: string,
  exitCode: number,
  timestamp: string,
): string {
  const status = exitCode === 0 ? "pass" : `FAILED exit ${exitCode}`;
  const summary = `Output (auto-captured ${timestamp}; ${status})`;
  const trimmed = trimOutput(output);
  const fence = "`".repeat(pickFenceLength(trimmed));
  // The trailing empty string yields a blank line after `</details>`
  // when these are joined with `\n`. GitHub's GFM type 6/7 HTML blocks
  // only end at a blank line — without one, the next bullet (or the
  // next `<details>`'s `</details>`) gets absorbed into a chained
  // raw-HTML block, killing checkbox rendering for everything that
  // follows. Same pattern as the leading blank between `<summary>` and
  // the code fence: GFM only re-enters markdown mode after a blank.
  return [
    `<details>${MARKER_OPEN}<summary>${summary}</summary>`,
    "",
    `${fence}text`,
    trimmed,
    fence,
    "",
    "</details>",
    "",
  ].join("\n");
}

/**
 * Scan from a list-item head line forward to the index of its last
 * continuation line. CommonMark/GFM rule: continuations are blank
 * lines or lines indented past the bullet marker. We treat any
 * non-blank line indented to `bulletIndent + 2` or deeper as part of
 * the same item; a blank line is tolerated only if a later indented
 * line follows. Anything else (another bullet at the same indent, an
 * unindented paragraph, the next `## ` heading, EOF) terminates.
 *
 * If `headIdx` is not a `- ` bullet, returns `headIdx` unchanged.
 */
function findListItemEnd(lines: string[], headIdx: number): number {
  const head = lines[headIdx];
  const headMatch = head.match(/^(\s*)-\s/);
  if (!headMatch) return headIdx;
  const continuationMin = headMatch[1].length + 2;

  let lastContent = headIdx;
  let i = headIdx + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent >= continuationMin) {
      lastContent = i;
      i++;
      continue;
    }
    break;
  }
  return lastContent;
}

/**
 * Locate a prior evidence block attached to the bullet at `matchIdx`.
 * The marker can appear directly under the bullet head (single-line
 * item, legacy layout) or after the bullet's continuation lines
 * (multi-line item, current layout). Search runs from the line after
 * the list item's end through any blanks until the first non-blank
 * line, which must carry MARKER_OPEN. Returns the line index of the
 * block's `</details>` close, or `null` if no clean block exists.
 *
 * If MARKER_OPEN is present but the closing `</details>` is missing,
 * the body was hand-edited or a prior write was interrupted —
 * treated as "no existing block" so the caller inserts a fresh one
 * and the orphan stays visible for the human to clean up.
 */
function findExistingBlockEnd(
  lines: string[],
  matchIdx: number,
): number | null {
  const itemEnd = findListItemEnd(lines, matchIdx);
  let i = itemEnd + 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || !lines[i].includes(MARKER_OPEN)) return null;
  while (i < lines.length) {
    if (lines[i].includes("</details>")) return i;
    i++;
  }
  return null;
}

/**
 * Find the first line matching `args.item` (interpreted as a JS regex,
 * tested against each line). On match: tick `- [ ]` → `- [x]` if the
 * exit code is 0; replace any existing evidence block attached to the
 * matched bullet; insert a fresh evidence block after the bullet's
 * last continuation line. Multi-line bullets keep their continuation
 * intact — evidence never splits a list item.
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

  const itemEnd = findListItemEnd(lines, matchIdx);
  const blockEnd = findExistingBlockEnd(lines, matchIdx);
  const replaced = blockEnd !== null;
  if (replaced) {
    // Drop the prior block: lines from the bullet's end through
    // </details>, plus a trailing blank line if one was emitted by
    // a previous run. Without trimming that blank, the freshly
    // emitted evidence (which carries its own trailing blank) would
    // stack a second one each time replace runs.
    let removeEnd = blockEnd;
    if (lines[removeEnd + 1] === "") removeEnd++;
    lines.splice(itemEnd + 1, removeEnd - itemEnd);
  }

  const ts = args.timestamp ?? new Date().toISOString();
  const evidence = buildEvidenceBlock(output, args.exitCode, ts);
  lines.splice(itemEnd + 1, 0, ...evidence.split("\n"));

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
