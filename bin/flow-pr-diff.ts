#!/usr/bin/env bun
/**
 * Wraps `gh pr diff <number>` and per-file caps each block at a line budget,
 * so the multi-agent review fan-out in `/pr-review` step 3 (which substitutes
 * `{{DIFF}}` into six parallel agent prompts) doesn't replicate 10–100 KB of
 * raw diff context six times over. Agents are already instructed to Read the
 * changed files in full for surrounding context — the diff is a "what changed
 * at a glance" hint, not the source of truth.
 *
 * The cap is mechanical (head + tail truncation), not semantic. The truncation
 * marker is emitted between hunks so the unified-diff format stays parseable
 * by naive consumers (`patch`, `git apply`, etc.).
 *
 * Usage:
 *   flow-pr-diff <pr-number>
 *   flow-pr-diff <pr-number> --max-lines 0     # disable per-file cap
 *   flow-pr-diff <pr-number> --max-lines 500   # raise per-file cap
 *   flow-pr-diff <pr-number> --max-total 10000 # raise total cap
 *   flow-pr-diff --help
 *
 * Exit 0 on success, 1 on `gh` failure or invalid input, 2 on argument-parse error.
 */

const HELP_TEXT = `flow-pr-diff — capped wrapper around \`gh pr diff <number>\`

Usage:
  flow-pr-diff <pr-number> [options]

Options:
  --max-lines <n>   Per-file source-line budget (default: 300). When a file's
                    diff exceeds this, it's truncated to head 200 + tail 100
                    plus one marker line (so a truncated block emits at most
                    n + 1 lines). Set to 0 to disable per-file capping.
  --max-total <n>   Total output line cap across all files (default: 5000).
                    Set to 0 to disable. Files past the cap are dropped with a footer.
  --help, -h        Show this help message.

The output is a valid unified diff with truncation markers emitted outside
\`@@ ... @@\` hunk headers — it round-trips through 'patch' / 'git apply' for
non-truncated files but is not meant to be re-applied as a whole. For an
uncapped diff, use \`gh pr diff <number>\`.`;

const DEFAULT_MAX_LINES = 300;
const DEFAULT_MAX_TOTAL = 5000;
const HEAD_RATIO = 2 / 3;

type ParseOk = {
  prNumber: number;
  maxLines: number;
  maxTotal: number;
};
type ParseHelp = { kind: "help" };
type ParseErr = { error: string };

export function parseArgs(argv: string[]): ParseOk | ParseHelp | ParseErr {
  let prNumber: number | undefined;
  let maxLines = DEFAULT_MAX_LINES;
  let maxTotal = DEFAULT_MAX_TOTAL;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--max-lines") {
      const value = argv[++i];
      if (value === undefined) return { error: "--max-lines requires a value" };
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 0)
        return { error: `invalid --max-lines value: ${value}` };
      maxLines = n;
      continue;
    }
    if (arg === "--max-total") {
      const value = argv[++i];
      if (value === undefined) return { error: "--max-total requires a value" };
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 0)
        return { error: `invalid --max-total value: ${value}` };
      maxTotal = n;
      continue;
    }
    if (arg.startsWith("--")) {
      return { error: `unknown flag: ${arg}` };
    }
    if (prNumber !== undefined) {
      return { error: `unexpected extra argument: ${arg}` };
    }
    const n = parseInt(arg, 10);
    if (isNaN(n) || n <= 0) return { error: `invalid PR number: ${arg}` };
    prNumber = n;
  }

  if (prNumber === undefined) return { error: "<pr-number> is required" };
  return { prNumber, maxLines, maxTotal };
}

/** Splits a unified diff into per-file blocks plus any preamble. */
export function splitIntoBlocks(diff: string): {
  preamble: string[];
  blocks: string[][];
} {
  const lines = diff.split("\n");
  // `gh pr diff` always ends with a trailing newline → a final empty element.
  // Drop it so `lines.length` reflects content lines and rejoining round-trips.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const blockStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) blockStarts.push(i);
  }
  if (blockStarts.length === 0) {
    return { preamble: lines, blocks: [] };
  }
  const preamble = blockStarts[0] > 0 ? lines.slice(0, blockStarts[0]) : [];
  const blocks: string[][] = [];
  for (let i = 0; i < blockStarts.length; i++) {
    const start = blockStarts[i];
    const end = i + 1 < blockStarts.length ? blockStarts[i + 1] : lines.length;
    blocks.push(lines.slice(start, end));
  }
  return { preamble, blocks };
}

function capBlock(
  block: string[],
  maxLines: number,
  prNumber: number,
): string[] {
  if (maxLines === 0 || block.length <= maxLines) return block;
  const headCount = Math.ceil(maxLines * HEAD_RATIO);
  const tailCount = maxLines - headCount;
  const truncatedCount = block.length - headCount - tailCount;
  const marker = `... [truncated ${truncatedCount} lines; full diff: gh pr diff ${prNumber}] ...`;
  return [
    ...block.slice(0, headCount),
    marker,
    ...block.slice(block.length - tailCount),
  ];
}

/**
 * Pure capping function. Splits the diff into per-file blocks, caps each
 * file at `maxLines` *source* lines (head 2/3 + tail 1/3) plus one extra
 * marker line between them — so a truncated block emits at most
 * `maxLines + 1` lines. Then enforces `maxTotal` by dropping trailing files
 * with a footer. `maxLines = 0` disables per-file capping; `maxTotal = 0`
 * disables the total cap.
 */
export function capDiff(
  diff: string,
  maxLines: number,
  maxTotal: number,
  prNumber: number,
): string {
  if (!diff) return "";
  const { preamble, blocks } = splitIntoBlocks(diff);
  if (blocks.length === 0) return diff;

  const cappedBlocks = blocks.map((b) => capBlock(b, maxLines, prNumber));

  const out: string[] = [...preamble];
  if (maxTotal > 0) {
    let runningTotal = preamble.length;
    let cutAt = cappedBlocks.length;
    for (let i = 0; i < cappedBlocks.length; i++) {
      const next = runningTotal + cappedBlocks[i].length;
      if (next > maxTotal && i > 0) {
        cutAt = i;
        break;
      }
      runningTotal = next;
    }
    for (let i = 0; i < cutAt; i++) out.push(...cappedBlocks[i]);
    if (cutAt < cappedBlocks.length) {
      const omitted = cappedBlocks.length - cutAt;
      out.push(
        `... [${omitted} additional file(s) omitted; full diff: gh pr diff ${prNumber}] ...`,
      );
    }
  } else {
    for (const b of cappedBlocks) out.push(...b);
  }

  // Preserve the trailing newline that `gh pr diff` always emits.
  return out.join("\n") + "\n";
}

// --- gh wrapper ---

export type GhRunner = (args: string[]) => {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const defaultGhRunner: GhRunner = (args) => {
  const r = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString().trim(),
    exitCode: r.exitCode ?? 1,
  };
};

export type RunDeps = {
  gh?: GhRunner;
  writeOut?: (s: string) => void;
  writeErr?: (s: string) => void;
};

export function run(argv: string[], deps: RunDeps = {}): number {
  const writeOut = deps.writeOut ?? ((s) => process.stdout.write(s));
  const writeErr = deps.writeErr ?? ((s) => process.stderr.write(s));
  const gh = deps.gh ?? defaultGhRunner;

  const parsed = parseArgs(argv);
  if ("kind" in parsed) {
    writeOut(`${HELP_TEXT}\n`);
    return 0;
  }
  if ("error" in parsed) {
    writeErr(`flow-pr-diff: ${parsed.error}\n`);
    writeErr(
      "usage: flow-pr-diff <pr-number> [--max-lines N] [--max-total N]\n",
    );
    return 2;
  }

  const result = gh(["pr", "diff", String(parsed.prNumber)]);
  if (result.exitCode !== 0) {
    writeErr(
      `flow-pr-diff: gh pr diff ${parsed.prNumber} failed: ${result.stderr || "no stderr"}\n`,
    );
    return 1;
  }
  writeOut(
    capDiff(result.stdout, parsed.maxLines, parsed.maxTotal, parsed.prNumber),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
