#!/usr/bin/env bun
/**
 * Builds the clean squash-merge commit body for /flow-pipeline step 10.
 *
 * Why: PR #210 appended the Claude-Code-Session-Id trailer to the squash
 * body by passing the *entire verbatim PR body* to `gh pr merge --body`.
 * That dragged gate/CI scaffolding into `git log` — the `## Test Steps`
 * section, `<details>` evidence dumps, and HTML-comment markers. This
 * helper produces the clean body: the narrative before the first
 * `## Test Steps` heading, HTML comments stripped, with the trailer as
 * the final line.
 *
 * Usage:
 *   flow-merge-body --session-id <id> [body]
 *
 * The raw PR body is the positional `body` argument when given, else
 * read from stdin. The clean body is written to stdout.
 *
 * Exit codes:
 *   0 — body emitted
 *   2 — bad CLI args
 */

// Same column-0 heading anchor flow-gate-decide.ts uses, so a literal
// "## Test Steps" mid-line or indented inside a fenced block is not a
// false cut point.
const HEADING_RE = /^## Test Steps[ \t]*$/m;

/**
 * Pure transform: strip HTML comments first, then keep the narrative
 * before the first `## Test Steps` heading on the stripped text (whole
 * body when the heading is absent), trim trailing whitespace, then
 * append the `Claude-Code-Session-Id:` trailer as the final line after
 * one blank-line separator (Git trailer convention).
 *
 * Stripping before truncation matters: a column-0 `## Test Steps` line
 * inside an HTML comment must not become a false cut point, and slicing
 * before stripping would leave a dangling `<!--` opener in the output.
 */
export function buildMergeBody(rawBody: string, sessionId: string): string {
  const stripped = rawBody.replace(/<!--[\s\S]*?-->/g, "");
  const m = HEADING_RE.exec(stripped);
  const narrative = m ? stripped.slice(0, m.index) : stripped;
  return `${narrative.trimEnd()}\n\nClaude-Code-Session-Id: ${sessionId}`;
}

export type Args = { sessionId: string; body?: string };

export function parseArgs(argv: string[]): Args | { error: string } {
  let sessionId: string | undefined;
  let body: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session-id") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) return { error: "--session-id requires a value" };
      sessionId = v;
      i++;
      continue;
    }
    if (a.startsWith("--")) return { error: `unknown flag: ${a}` };
    if (body !== undefined) return { error: "unexpected extra positional argument" };
    body = a;
  }
  if (!sessionId) return { error: "--session-id is required" };
  return { sessionId, body };
}

export async function run(
  argv: string[],
  readStdin: () => Promise<string> = () => Bun.stdin.text(),
): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-merge-body: ${parsed.error}`);
    console.error("usage: flow-merge-body --session-id <id> [body]");
    return 2;
  }
  const rawBody = parsed.body ?? (await readStdin());
  process.stdout.write(buildMergeBody(rawBody, parsed.sessionId) + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
