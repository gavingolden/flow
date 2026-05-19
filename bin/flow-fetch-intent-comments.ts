#!/usr/bin/env bun
/**
 * Fetches author-authored intent annotations from a PR's review comments.
 *
 * Filters comments to those where ALL THREE hold:
 *   (1) body starts with the literal `**why:** ` prefix (Markdown bold +
 *       colon + space),
 *   (2) user.login === <PR author login> (anti-injection identity check),
 *   (3) body contains the literal `<!-- flow-intent-v1 -->` substring
 *       (anti-injection integrity suffix — invisible in rendered Markdown).
 *
 * Emits matching comments as Markdown lines, one per comment, in the form:
 *   - <file>:L<line> → <body with prefix + suffix stripped>
 *
 * Sorted path-alphabetical, then by line number ascending within file.
 *
 * Used by /pr-review Step 3 to surface author intent to the multi-agent
 * review fan-out via {{EXISTING_INTENT_COMMENTS}}.
 *
 * Usage:
 *   flow-fetch-intent-comments <pr-number-or-url>
 *   flow-fetch-intent-comments --help
 */

import {
  fetchComments,
  fetchPrAuthorLogin,
  parsePrNumber,
  type ReviewComment,
} from "./flow-fetch-pr-review";

// --- Constants ---

export const WHY_PREFIX = "**why:** ";
export const INTEGRITY_SUFFIX = "<!-- flow-intent-v1 -->";
export const NO_MATCHES_MESSAGE = "(none — author posted no intent annotations)";

// --- Filter logic (pure — exported for tests) ---

/**
 * Returns true when the comment is an author-authored intent annotation:
 * `**why:** ` prefix AND author identity AND integrity suffix.
 *
 * Reply comments (in_reply_to_id != null) are excluded — replies are part
 * of a thread, not standalone intent annotations.
 */
export function isIntentComment(comment: ReviewComment, prAuthorLogin: string): boolean {
  if (comment.in_reply_to_id !== null) return false;
  if (comment.user.login !== prAuthorLogin) return false;
  if (!comment.body.startsWith(WHY_PREFIX)) return false;
  if (!comment.body.includes(INTEGRITY_SUFFIX)) return false;
  return true;
}

/**
 * Strips the `**why:** ` prefix AND the `<!-- flow-intent-v1 -->` suffix
 * (plus any surrounding whitespace) from the body, leaving just the
 * rationale text.
 */
export function stripIntentMarkers(body: string): string {
  let stripped = body.startsWith(WHY_PREFIX) ? body.slice(WHY_PREFIX.length) : body;
  // Remove the integrity suffix wherever it appears (typically at the end,
  // after a blank line).
  stripped = stripped.split(INTEGRITY_SUFFIX).join("");
  return stripped.trim();
}

/** Compares two intent comments path-alphabetical, then by line ascending. */
function compareIntent(a: ReviewComment, b: ReviewComment): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  const la = a.line ?? 0;
  const lb = b.line ?? 0;
  return la - lb;
}

/**
 * Filters + formats + sorts the intent annotations.
 * Returns the formatted output string (or the no-matches sentinel).
 *
 * Separated from `main()` so tests can inject pre-fetched comments + the
 * author login without mocking the gh runner.
 */
export function formatIntentComments(
  comments: ReviewComment[],
  prAuthorLogin: string,
): string {
  const matches = comments.filter((c) => isIntentComment(c, prAuthorLogin));
  if (matches.length === 0) return NO_MATCHES_MESSAGE;

  const sorted = [...matches].sort(compareIntent);
  const lines = sorted.map((c) => {
    const lineNum = c.line ?? 0;
    const body = stripIntentMarkers(c.body);
    // Single-line rendering: collapse internal newlines to spaces so the
    // bullet stays on one line. The agent prompt receives this as a flat
    // list of context lines.
    const flat = body.replace(/\s*\n\s*/g, " ");
    return `- ${c.path}:L${lineNum} → ${flat}`;
  });
  return lines.join("\n");
}

// --- CLI ---

function printHelp(): void {
  console.log(`
Usage: flow-fetch-intent-comments <pr-number-or-url>

Fetches PR review comments, filters to author-authored intent annotations
(\`**why:** \` prefix + author identity + \`<!-- flow-intent-v1 -->\`
integrity suffix), and emits them as Markdown bullets on stdout:

  - <file>:L<line> → <stripped body>

Sorted path-alphabetical, then by line number within file. When no
comments match, emits the literal "${NO_MATCHES_MESSAGE}".

Arguments:
  pr-number-or-url   PR number (e.g. 100) or full URL from the current repo

Examples:
  flow-fetch-intent-comments 100
  flow-fetch-intent-comments 100 > .flow-tmp/intent-comments.md
  `);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(args.length === 0 ? 2 : 0);
  }

  const prNumber = parsePrNumber(args[0]);
  const comments = fetchComments(prNumber);
  const prAuthorLogin = fetchPrAuthorLogin(prNumber);
  console.log(formatIntentComments(comments, prAuthorLogin));
}

if (import.meta.main) {
  main();
}
