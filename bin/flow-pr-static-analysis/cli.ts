import type { Args } from "./types";

// --- CLI -------------------------------------------------------------------

export const HELP_TEXT = `flow-pr-static-analysis — pre-digest static-analysis facts for /pr-review

Usage:
  flow-pr-static-analysis <PR> [options]

Options:
  --min-confidence <n>      Drop findings with confidence below n (0-100, default 80).
                            Set to 0 to disable filtering.
  --max-tool-timeout <sec>  Per-tool wall-clock cap (default 60). A tool that
                            exceeds this is skipped with reason 'timeout'.
  --coverage-file <path>    Path to coverage-final.json (default: auto-detect
                            coverage/coverage-final.json in the worktree).
  --help, -h                Show this help.

Output: a single JSON object on stdout when all lenses settle. Per-tool
progress is on stderr so the JSON is cleanly capturable.

Exit codes:
  0  facts computed (any lens may be skipped)
  2  argument-parse error`;

export function parseArgs(
  argv: string[],
): Args | { error: string } | { help: true } {
  if (argv.length === 0) return { error: "PR number is required" };
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [first, ...rest] = argv;
  if (first.startsWith("--")) {
    return { error: "PR number must be the first positional argument" };
  }
  const pr = Number.parseInt(first, 10);
  if (!Number.isFinite(pr) || pr <= 0 || String(pr) !== first) {
    return { error: `PR must be a positive integer, got '${first}'` };
  }
  const out: Args = { pr, minConfidence: 80, maxToolTimeoutSec: 60 };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    switch (flag) {
      case "--min-confidence": {
        if (!value || value.startsWith("--")) {
          return { error: "--min-confidence requires a value" };
        }
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 0 || n > 100 || String(n) !== value) {
          return {
            error: `--min-confidence must be an integer 0-100, got '${value}'`,
          };
        }
        out.minConfidence = n;
        i++;
        continue;
      }
      case "--max-tool-timeout": {
        if (!value || value.startsWith("--")) {
          return { error: "--max-tool-timeout requires a value" };
        }
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n <= 0 || String(n) !== value) {
          return {
            error: `--max-tool-timeout must be a positive integer, got '${value}'`,
          };
        }
        out.maxToolTimeoutSec = n;
        i++;
        continue;
      }
      case "--coverage-file":
        if (!value || value.startsWith("--")) {
          return { error: "--coverage-file requires a value" };
        }
        out.coverageFile = value;
        i++;
        continue;
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  return out;
}
