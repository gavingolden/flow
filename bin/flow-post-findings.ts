#!/usr/bin/env bun
/**
 * Posts pr-review findings as individual inline review comments on a PR.
 *
 * Why: pr-review step 10 documents the exact `gh api .../pulls/<n>/comments`
 * shape that anchors a finding to a specific file + line on the PR diff —
 * including the multi-line `start_line` / `start_side` quirk and the
 * `commit_id` requirement. The agent rebuilds that call by hand for every
 * finding today; one wrong flag (`-f` vs `-F`, missing `commit_id`,
 * forgetting `start_side`) silently posts the comment in the wrong place
 * or to the wrong endpoint. This helper makes the shape deterministic.
 *
 * Sibling helper to `flow-reply-pr-comments` (which posts replies to
 * existing comments). The two are deliberately split: replies go to the
 * `/comments/<id>/replies` endpoint and only need a body; new findings go
 * to the `/comments` endpoint and need file + line + commit_id.
 *
 * Usage:
 *   echo '<json>' | flow-post-findings <pr-number-or-url>
 *   flow-post-findings <pr-number-or-url> --file findings.json
 *   flow-post-findings <pr> --head-sha <sha>     # skip the gh pr view lookup
 *
 * Input format (each entry):
 *   {
 *     "file": "src/foo.ts",   // gh api `path` field
 *     "line": 42,              // post-fix line number
 *     "end_line": 48,          // optional; multi-line range end
 *     "side": "RIGHT",         // optional, default "RIGHT"; "LEFT" only for removed lines
 *     "body": "**suggestion (non-blocking):** ..."
 *   }
 */

import { parsePrNumber } from "./flow-fetch-pr-review";

export type Finding = {
  file: string;
  line: number;
  end_line?: number;
  side?: "LEFT" | "RIGHT";
  body: string;
};

export type PostResult = {
  file: string;
  line: number;
  success: boolean;
  error?: string;
};

export type PostSummary = {
  total: number;
  succeeded: number;
  failed: number;
  results: PostResult[];
};

type GhResult = { stdout: string; stderr: string; exitCode: number };
export type GhRunner = (argv: string[]) => GhResult;

const defaultGh: GhRunner = (argv) => {
  const r = Bun.spawnSync(["gh", ...argv], { stdout: "pipe", stderr: "pipe" });
  return {
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
    exitCode: r.exitCode ?? -1,
  };
};

export function parseFindings(input: string): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Invalid JSON input");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Input must be a JSON array");
  }
  const findings: Finding[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Entry ${i}: must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    // Accept either `file` or `path` for ergonomics — gh's wire field is `path`,
    // but pr-review's agent JSON consistently uses `file`. Normalize to `file`.
    const filePath = obj.file ?? obj.path;
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error(`Entry ${i}: "file" must be a non-empty string`);
    }
    if (typeof obj.line !== "number" || !Number.isInteger(obj.line) || obj.line <= 0) {
      throw new Error(`Entry ${i}: "line" must be a positive integer`);
    }
    if (typeof obj.body !== "string" || obj.body.length === 0) {
      throw new Error(`Entry ${i}: "body" must be a non-empty string`);
    }
    const f: Finding = { file: filePath, line: obj.line, body: obj.body };
    if (obj.end_line !== undefined) {
      if (typeof obj.end_line !== "number" || !Number.isInteger(obj.end_line) || obj.end_line <= 0) {
        throw new Error(`Entry ${i}: "end_line" must be a positive integer`);
      }
      if (obj.end_line < obj.line) {
        throw new Error(`Entry ${i}: "end_line" must be >= "line"`);
      }
      // gh's API treats start_line == line as a single-line range; skip in that case.
      if (obj.end_line > obj.line) f.end_line = obj.end_line;
    }
    if (obj.side !== undefined) {
      if (obj.side !== "LEFT" && obj.side !== "RIGHT") {
        throw new Error(`Entry ${i}: "side" must be "LEFT" or "RIGHT"`);
      }
      f.side = obj.side;
    }
    findings.push(f);
  }
  return findings;
}

export function fetchHeadSha(prNumber: number, gh: GhRunner): string {
  const r = gh(["pr", "view", String(prNumber), "--json", "headRefOid", "-q", ".headRefOid"]);
  if (r.exitCode !== 0) {
    throw new Error(r.stderr.trim() || `gh pr view failed (${r.exitCode})`);
  }
  const sha = r.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`gh pr view returned unexpected headRefOid: ${sha}`);
  }
  return sha;
}

/**
 * Builds the `gh api` argv for posting one finding. The shape is taken
 * verbatim from pr-review SKILL.md step 10 — `-f` for strings (path,
 * side, body), `-F` for numbers (line, start_line). Multi-line ranges
 * also need `start_side` per GitHub's API; default it to the same side
 * as `side`.
 */
export function buildPostArgv(prNumber: number, headSha: string, f: Finding): string[] {
  const side = f.side ?? "RIGHT";
  const argv = [
    "api",
    `repos/{owner}/{repo}/pulls/${prNumber}/comments`,
    "-f",
    `commit_id=${headSha}`,
    "-f",
    `path=${f.file}`,
    "-F",
    `line=${f.line}`,
    "-f",
    `side=${side}`,
    "-f",
    `body=${f.body}`,
  ];
  if (f.end_line !== undefined) {
    // gh's API uses start_line < line for the "anchor at the bottom of the
    // range" convention. We've already normalized `line` as the end of the
    // range and `end_line` as inclusive, so swap to start_line=line and
    // line=end_line.
    const startIdx = argv.indexOf("line=" + f.line);
    argv[startIdx] = `line=${f.end_line}`;
    argv.push("-F", `start_line=${f.line}`);
    argv.push("-f", `start_side=${side}`);
  }
  return argv;
}

function postOne(prNumber: number, headSha: string, f: Finding, gh: GhRunner): PostResult {
  const argv = buildPostArgv(prNumber, headSha, f);
  const r = gh(argv);
  if (r.exitCode === 0) {
    return { file: f.file, line: f.line, success: true };
  }
  return {
    file: f.file,
    line: f.line,
    success: false,
    error: r.stderr.trim() || `gh exited ${r.exitCode}`,
  };
}

export function postAll(
  prNumber: number,
  headSha: string,
  findings: Finding[],
  gh: GhRunner,
): PostSummary {
  const results: PostResult[] = findings.map((f) => postOne(prNumber, headSha, f, gh));
  const succeeded = results.filter((r) => r.success).length;
  return {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

export function formatSummary(summary: PostSummary): string {
  const lines: string[] = [];
  lines.push(`Findings: ${summary.succeeded}/${summary.total} posted successfully`);
  lines.push("");
  for (const r of summary.results) {
    const where = `${r.file}:${r.line}`;
    if (r.success) lines.push(`  OK    ${where}`);
    else lines.push(`  FAIL  ${where}: ${r.error}`);
  }
  return lines.join("\n");
}

function printHelp(): void {
  console.log(`
Usage: flow-post-findings <pr-number-or-url> [options]

Posts pr-review findings as individual inline review comments. Reads a
JSON array from stdin or a file. Each finding is posted to the GitHub
PR's /comments endpoint (NOT the /reviews endpoint — that creates a
batched formal review with an Approved/Requested-changes banner, which
is overkill for self-review).

Arguments:
  pr-number-or-url   PR number (e.g. 100) or full URL

Options:
  --file <path>      Read findings JSON from a file instead of stdin
  --head-sha <sha>   Use this commit SHA as commit_id (default: gh pr view ... headRefOid)
  --help, -h         Show this help

Input format (each entry):
  {
    "file": "src/foo.ts",
    "line": 42,
    "end_line": 48,         // optional, multi-line range
    "side": "RIGHT",         // optional, default "RIGHT"
    "body": "**issue (non-blocking):** ..."
  }

Examples:
  echo '<findings>' | flow-post-findings 100
  flow-post-findings 100 --file findings.json
  `);
}

type ParsedArgs =
  | { kind: "ok"; prArg: string; file?: string; headSha?: string }
  | { kind: "help" }
  | { kind: "error"; message: string };

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  let prArg: string | undefined;
  let file: string | undefined;
  let headSha: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) return { kind: "error", message: "--file requires a value" };
      file = v;
      i++;
      continue;
    }
    if (a === "--head-sha") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--"))
        return { kind: "error", message: "--head-sha requires a value" };
      headSha = v;
      i++;
      continue;
    }
    if (a.startsWith("--")) return { kind: "error", message: `unknown flag: ${a}` };
    if (prArg) return { kind: "error", message: `unexpected positional argument: ${a}` };
    prArg = a;
  }
  if (!prArg) return { kind: "error", message: "PR number or URL is required" };
  return { kind: "ok", prArg, file, headSha };
}

export type Deps = {
  gh?: GhRunner;
  readStdin?: () => Promise<string>;
  readFile?: (path: string) => Promise<string>;
};

export async function run(argv: string[], deps: Deps = {}): Promise<number> {
  const gh = deps.gh ?? defaultGh;
  const readStdin = deps.readStdin ?? (() => Bun.stdin.text());
  const readFile = deps.readFile ?? ((p: string) => Bun.file(p).text());

  const parsed = parseArgs(argv);
  if (parsed.kind === "help") {
    printHelp();
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(`flow-post-findings: ${parsed.message}`);
    console.error("run with --help for usage");
    return 2;
  }

  const prNumber = parsePrNumber(parsed.prArg);

  let input: string;
  if (parsed.file) {
    input = await readFile(parsed.file);
  } else {
    input = await readStdin();
    if (!input.trim()) {
      console.error("flow-post-findings: no input on stdin (pipe JSON or use --file)");
      return 2;
    }
  }

  let findings: Finding[];
  try {
    findings = parseFindings(input);
  } catch (e) {
    console.error(`flow-post-findings: ${(e as Error).message}`);
    return 2;
  }

  if (findings.length === 0) {
    console.log("No findings to post.");
    return 0;
  }

  let headSha: string;
  try {
    headSha = parsed.headSha ?? fetchHeadSha(prNumber, gh);
  } catch (e) {
    console.error(`flow-post-findings: ${(e as Error).message}`);
    return 1;
  }

  console.log(`Posting ${findings.length} findings to PR #${prNumber} @ ${headSha.slice(0, 7)}...`);
  const summary = postAll(prNumber, headSha, findings, gh);
  console.log(formatSummary(summary));
  return summary.failed > 0 ? 1 : 0;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
