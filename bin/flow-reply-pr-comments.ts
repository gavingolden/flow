#!/usr/bin/env bun
/**
 * Batch-posts replies to GitHub PR review comments.
 *
 * Reads a JSON array of {comment_id, body} from stdin or a file and posts each
 * reply via `gh api`. Continues on individual failures and reports a summary.
 *
 * Usage:
 *   echo '<json>' | flow-reply-pr-comments <pr-number-or-url>
 *   flow-reply-pr-comments <pr-number-or-url> --file replies.json
 *
 * Examples:
 *   echo '[{"comment_id": 123, "body": "✅ Done"}]' | flow-reply-pr-comments 100
 *   flow-reply-pr-comments https://github.com/owner/repo/pull/100 --file replies.json
 */

import { parsePrNumber } from "./flow-fetch-pr-review";

// --- Types ---

export type CommentReply = {
  comment_id: number;
  body: string;
};

export type ReplyResult = {
  comment_id: number;
  success: boolean;
  error?: string;
};

export type ReplySummary = {
  total: number;
  succeeded: number;
  failed: number;
  results: ReplyResult[];
};

// --- Helpers ---

function gh(args: string[]): string {
  const result = Bun.spawnSync(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(stderr || `gh ${args.join(" ")} failed with exit code ${result.exitCode}`);
  }

  return result.stdout.toString().trim();
}

// --- Parsing ---

/** Parses and validates a JSON string as an array of CommentReply. */
export function parseReplies(input: string): CommentReply[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Invalid JSON input");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Input must be a JSON array");
  }

  if (parsed.length === 0) {
    return [];
  }

  const replies: CommentReply[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Entry ${i}: must be an object`);
    }

    const obj = entry as Record<string, unknown>;
    if (typeof obj.comment_id !== "number") {
      throw new Error(`Entry ${i}: "comment_id" must be a number`);
    }
    if (typeof obj.body !== "string") {
      throw new Error(`Entry ${i}: "body" must be a string`);
    }

    replies.push({ comment_id: obj.comment_id, body: obj.body });
  }

  return replies;
}

// --- Reply Logic ---

function postReply(prNumber: number, reply: CommentReply): ReplyResult {
  try {
    gh([
      "api",
      `repos/{owner}/{repo}/pulls/${prNumber}/comments/${reply.comment_id}/replies`,
      "-f",
      `body=${reply.body}`,
    ]);
    return { comment_id: reply.comment_id, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { comment_id: reply.comment_id, success: false, error: message };
  }
}

function postAllReplies(prNumber: number, replies: CommentReply[]): ReplySummary {
  const results: ReplyResult[] = [];

  for (const reply of replies) {
    const result = postReply(prNumber, reply);
    results.push(result);
  }

  const succeeded = results.filter((r) => r.success).length;
  return {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

// --- Output ---

/** Formats a ReplySummary as human-readable output. */
export function formatSummary(summary: ReplySummary): string {
  const lines: string[] = [];

  lines.push(`Replies: ${summary.succeeded}/${summary.total} posted successfully`);
  lines.push("");

  for (const result of summary.results) {
    if (result.success) {
      lines.push(`  OK    comment #${result.comment_id}`);
    } else {
      lines.push(`  FAIL  comment #${result.comment_id}: ${result.error}`);
    }
  }

  return lines.join("\n");
}

// --- CLI ---

function printHelp(): void {
  console.log(`
Usage: flow-reply-pr-comments <pr-number-or-url> [options]

Batch-posts replies to GitHub PR review comments. Reads a JSON array of
{comment_id, body} objects from stdin or a file.

Arguments:
  pr-number-or-url   PR number (e.g. 100) or full URL

Options:
  --file <path>      Read replies JSON from a file instead of stdin
  --help, -h         Show this help message

Input format:
  [
    {"comment_id": 123, "body": "✅ Addressed — updated the type."},
    {"comment_id": 456, "body": "⏭️ Skipped — already handled by the linter."}
  ]

Examples:
  echo '[{"comment_id": 123, "body": "Done"}]' | flow-reply-pr-comments 100
  flow-reply-pr-comments 100 --file replies.json
  `);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  // First positional argument is the PR number/URL.
  // Walk args by index, skipping --flag and its value.
  let prArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file") {
      i++; // skip the --file value
      continue;
    }
    if (args[i].startsWith("--")) continue;
    prArg = args[i];
    break;
  }
  if (!prArg) {
    console.error("Error: PR number or URL is required as the first argument.");
    console.error("Run with --help for usage.");
    process.exit(1);
  }

  const prNumber = parsePrNumber(prArg);

  // Read input
  let input: string;
  const fileIdx = args.indexOf("--file");
  if (fileIdx !== -1) {
    const filePath = args[fileIdx + 1];
    if (!filePath) {
      console.error("Error: --file requires a file path");
      process.exit(1);
    }
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      console.error(`Error: File not found: ${filePath}`);
      process.exit(1);
    }
    input = await file.text();
  } else {
    input = await Bun.stdin.text();
    if (!input.trim()) {
      console.error("Error: No input received on stdin. Pipe JSON or use --file.");
      console.error("Run with --help for usage.");
      process.exit(1);
    }
  }

  const replies = parseReplies(input);

  if (replies.length === 0) {
    console.log("No replies to post.");
    process.exit(0);
  }

  console.log(`Posting ${replies.length} replies to PR #${prNumber}...\n`);

  const summary = postAllReplies(prNumber, replies);
  console.log(formatSummary(summary));

  process.exit(summary.failed > 0 ? 1 : 0);
}

if (import.meta.main) {
  main();
}
