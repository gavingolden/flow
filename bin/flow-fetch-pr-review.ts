#!/usr/bin/env bun
/**
 * Fetches GitHub PR review comments and formats them as structured markdown.
 *
 * Usage:
 *   flow-fetch-pr-review <pr-number-or-url>
 *
 * Examples:
 *   flow-fetch-pr-review 100
 *   flow-fetch-pr-review https://github.com/owner/repo/pull/100
 *
 * Side effect: advances the owning pipeline's `state.phase` to `reviewing`
 * once the PR payload is fetched — `/flow-pr-review` Step 2's mandatory
 * fetch is what makes Step 8's phase write unskippable (plan.md Task 4).
 * A silent no-op when `state.pr` doesn't match (standalone review, or a
 * leaked `FLOW_SLUG` from an unrelated flow window) or no state file
 * exists at all — this helper is also invoked outside any pipeline.
 */

import { resolveSlugAmbient } from "./lib/session-identity";
import { advancePhase } from "./lib/phase-advance";
import { FLOW_STATE_DIR } from "./lib/paths";

// --- Types ---

export type ReviewComment = {
  path: string;
  line: number | null;
  start_line: number | null;
  body: string;
  diff_hunk: string;
  html_url: string;
  user: { login: string };
  in_reply_to_id: number | null;
  id: number;
};

type Review = {
  body: string;
  state: string;
  user: { login: string };
  html_url: string;
};

type PullRequest = {
  title: string;
  html_url: string;
  number: number;
  state: string;
  body: string;
  additions: number;
  deletions: number;
  changed_files: number;
  head: { ref: string };
};

type GroupedComments = Map<string, ReviewComment[]>;

// --- Helpers ---

/** Test seam: a `gh` runner mirroring every other helper's `GhRunner` shape,
 * narrowed to this file's string-in/string-out contract (throws on
 * non-zero exit, mirroring `defaultGh` below). */
export type GhRunner = (args: string[]) => string;

/** Runs `gh` CLI with the given args. Throws on non-zero exit. */
function defaultGh(args: string[]): string {
  const result = Bun.spawnSync(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(
      stderr || `gh ${args.join(" ")} failed with exit code ${result.exitCode}`,
    );
  }

  return result.stdout.toString().trim();
}

/** Extracts a PR number from a number string or full GitHub URL. */
export function parsePrNumber(input: string): number {
  // Full URL: https://github.com/owner/repo/pull/123
  const urlMatch = input.match(/\/pull\/(\d+)/);
  if (urlMatch) return parseInt(urlMatch[1], 10);

  // Plain number
  const num = parseInt(input, 10);
  if (!isNaN(num) && num > 0) return num;

  throw new Error(`Invalid PR number or URL: ${input}`);
}

// --- API ---

function fetchPr(prNumber: number, gh: GhRunner = defaultGh): PullRequest {
  const json = gh([
    "api",
    `repos/{owner}/{repo}/pulls/${prNumber}`,
    "--jq",
    '{title, html_url, number, state, body: (.body // ""), additions, deletions, changed_files, head: {ref: .head.ref}}',
  ]);
  return JSON.parse(json) as PullRequest;
}

function fetchChangedFiles(
  prNumber: number,
  gh: GhRunner = defaultGh,
): string[] {
  const output = gh(["pr", "diff", String(prNumber), "--name-only"]);
  return output.split("\n").filter(Boolean);
}

/** Parses newline-delimited JSON objects emitted by `gh api --paginate --jq`. */
export function parseNdjson<T>(output: string): T[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function fetchReviews(prNumber: number, gh: GhRunner = defaultGh): Review[] {
  const output = gh([
    "api",
    "--paginate",
    `repos/{owner}/{repo}/pulls/${prNumber}/reviews`,
    "--jq",
    ".[] | {body, state, user: {login: .user.login}, html_url}",
  ]);
  return parseNdjson<Review>(output);
}

export function fetchComments(
  prNumber: number,
  gh: GhRunner = defaultGh,
): ReviewComment[] {
  const output = gh([
    "api",
    "--paginate",
    `repos/{owner}/{repo}/pulls/${prNumber}/comments`,
    "--jq",
    ".[] | {path, line, start_line, body, diff_hunk, html_url, user: {login: .user.login}, in_reply_to_id, id}",
  ]);
  return parseNdjson<ReviewComment>(output);
}

/**
 * Returns the PR author's login. Used by the intent-comment filter to
 * enforce identity (only the author's `**why:** ` comments count as
 * intent annotations — defends against reviewer-injected lookalikes).
 */
export function fetchPrAuthorLogin(
  prNumber: number,
  gh: GhRunner = defaultGh,
): string {
  return gh([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "author",
    "--jq",
    ".author.login",
  ]);
}

// --- Formatting ---

/** Groups comments by file path, filtering out reply threads (keeps top-level only). */
export function groupByFile(comments: ReviewComment[]): GroupedComments {
  const grouped: GroupedComments = new Map();

  for (const comment of comments) {
    // Skip replies — they're threaded under the parent
    if (comment.in_reply_to_id) continue;

    const existing = grouped.get(comment.path) ?? [];
    existing.push(comment);
    grouped.set(comment.path, existing);
  }

  return grouped;
}

/** Indexes replies by parent comment ID for O(1) lookups. */
export function buildReplyIndex(
  comments: ReviewComment[],
): Map<number, ReviewComment[]> {
  const index = new Map<number, ReviewComment[]>();
  for (const c of comments) {
    if (!c.in_reply_to_id) continue;
    const replies = index.get(c.in_reply_to_id) ?? [];
    replies.push(c);
    index.set(c.in_reply_to_id, replies);
  }
  return index;
}

export function formatLineRef(comment: ReviewComment): string {
  if (comment.start_line && comment.line) {
    return `L${comment.start_line}-L${comment.line}`;
  }
  if (comment.line) {
    return `L${comment.line}`;
  }
  return "file-level";
}

export function formatComment(
  comment: ReviewComment,
  replyIndex: Map<number, ReviewComment[]>,
): string {
  const lines: string[] = [];
  const lineRef = formatLineRef(comment);

  lines.push(`#### ${lineRef} — @${comment.user.login}`);
  // Surface the numeric GitHub comment id only for top-level comments —
  // Step 9 of /flow-pr-review matches replies against top-level comment_ids,
  // so the id on quoted reply sub-blocks below is intentionally omitted.
  lines.push(`**Comment ID:** ${comment.id}`);
  lines.push("");
  lines.push(comment.body);

  // Include replies inline
  const replies = replyIndex.get(comment.id) ?? [];
  for (const reply of replies) {
    lines.push("");
    const replyLines = reply.body.split("\n");
    const quoted = replyLines
      .map((line, i) =>
        i === 0 ? `> **@${reply.user.login}:** ${line}` : `> ${line}`,
      )
      .join("\n");
    lines.push(quoted);
  }

  return lines.join("\n");
}

function formatOutput(
  pr: PullRequest,
  reviews: Review[],
  comments: ReviewComment[],
  changedFiles: string[],
): string {
  const lines: string[] = [];

  lines.push(`# PR #${pr.number}: ${pr.title}`);
  lines.push("");
  lines.push(`**URL:** ${pr.html_url}`);
  lines.push(`**Branch:** \`${pr.head.ref}\``);
  lines.push(`**State:** ${pr.state}`);
  lines.push(
    `**Stats:** +${pr.additions} −${pr.deletions} across ${pr.changed_files} files`,
  );

  // PR description
  if (pr.body.trim()) {
    lines.push("");
    lines.push("## Description");
    lines.push("");
    lines.push(pr.body);
  }

  // Changed files
  if (changedFiles.length > 0) {
    lines.push("");
    lines.push("## Changed Files");
    lines.push("");
    for (const file of changedFiles) {
      lines.push(`- \`${file}\``);
    }
  }

  // Top-level review summaries (skip empty ones)
  const substantiveReviews = reviews.filter((r) => r.body.trim().length > 0);
  if (substantiveReviews.length > 0) {
    lines.push("");
    lines.push("## Review Summaries");
    for (const review of substantiveReviews) {
      lines.push("");
      lines.push(`### @${review.user.login} — ${review.state}`);
      lines.push("");
      lines.push(review.body);
    }
  }

  // Inline comments grouped by file
  const grouped = groupByFile(comments);
  if (grouped.size > 0) {
    const replyIndex = buildReplyIndex(comments);
    lines.push("");
    lines.push(
      `## Inline Comments (${comments.filter((c) => !c.in_reply_to_id).length})`,
    );

    for (const [filePath, fileComments] of grouped) {
      lines.push("");
      lines.push(`### \`${filePath}\``);

      for (const comment of fileComments) {
        lines.push("");
        lines.push(formatComment(comment, replyIndex));
      }
    }
  }

  if (grouped.size === 0 && substantiveReviews.length === 0) {
    lines.push("");
    lines.push("No review comments found on this PR.");
  }

  return lines.join("\n");
}

// --- CLI ---

function printHelp(): void {
  console.log(`
Usage: flow-fetch-pr-review <pr-number-or-url>

Fetches GitHub PR review comments and formats them as structured markdown
for agent consumption. Uses the gh CLI (must be installed and authenticated).

The PR must belong to the current repository (owner/repo is inferred from git remote).

Arguments:
  pr-number-or-url   PR number (e.g. 100) or full URL from the current repo

Examples:
  flow-fetch-pr-review 100
  flow-fetch-pr-review https://github.com/owner/repo/pull/100
  `);
}

export type Deps = {
  gh?: GhRunner;
  resolveSlug?: () => string | null;
  stateDir?: string;
};

/**
 * Runs the fetch-and-format CLI. Extracted from the former bare `main()` so
 * the phase-advance side effect has a seam to inject `gh` / `resolveSlug` /
 * `stateDir` through in tests (plan.md Contract adjustment #4 — this file
 * exported only pure formatters before; there was no runner to attach a
 * dep to).
 */
export function run(argv: string[], deps: Deps = {}): number {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }

  const gh = deps.gh ?? defaultGh;
  const resolveSlug = deps.resolveSlug ?? (() => resolveSlugAmbient());
  const stateDir = deps.stateDir ?? FLOW_STATE_DIR;

  const prNumber = parsePrNumber(argv[0]);

  const pr = fetchPr(prNumber, gh);
  const reviews = fetchReviews(prNumber, gh);
  const comments = fetchComments(prNumber, gh);
  const changedFiles = fetchChangedFiles(prNumber, gh);

  // Never fail the fetch on an advance no-op — the return value is
  // discarded except for the stderr NOTICE `advancePhase` emits itself on
  // a pr-mismatch. Called before the fetch output reaches stdout so the
  // phase write happens as part of the mandatory fetch, not after it.
  advancePhase("reviewing", {
    slug: resolveSlug(),
    expectPr: prNumber,
    dir: stateDir,
  });

  console.log(formatOutput(pr, reviews, comments, changedFiles));

  return 0;
}

// Only run when executed directly (not when imported for testing)
if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
