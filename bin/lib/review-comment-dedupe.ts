import type { Finding, GhRunner } from "../flow-post-findings";

export type ExistingComment = {
  id: number;
  path: string;
  line: number | null;
  original_line: number | null;
  start_line: number | null;
  original_start_line: number | null;
  side: string | null;
  body: string;
  user: string;
  in_reply_to_id: number | null;
};

const COMMENT_PROJECTION =
  ".[] | {id, path, line, original_line, start_line, original_start_line, side, body, user: .user.login, in_reply_to_id}";

function key(
  path: string,
  side: string,
  start: number | null,
  end: number | null,
  body: string,
): string {
  return JSON.stringify([path, side, start, end, body.trimEnd()]);
}

/** Key in GitHub's wire form: a range posts `line=end_line`, `start_line=line`. */
export function findingKey(f: Finding): string {
  const end = f.end_line ?? f.line;
  const start = f.end_line !== undefined ? f.line : end;
  return key(f.file, f.side ?? "RIGHT", start, end, f.body);
}

export function commentKey(c: ExistingComment): string {
  const end = c.line ?? c.original_line;
  const start = c.start_line ?? c.original_start_line ?? end;
  return key(c.path, c.side ?? "RIGHT", start, end, c.body);
}

/** Throws on any gh or parse failure so the caller can post nothing. */
export function fetchExistingComments(
  prNumber: number,
  gh: GhRunner,
): ExistingComment[] {
  const r = gh([
    "api",
    "--paginate",
    `repos/{owner}/{repo}/pulls/${prNumber}/comments`,
    "--jq",
    COMMENT_PROJECTION,
  ]);
  if (r.exitCode !== 0) {
    throw new Error(
      `existing-comment read failed: ${r.stderr.trim() || `gh exited ${r.exitCode}`}`,
    );
  }
  const out: ExistingComment[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ExistingComment);
    } catch {
      throw new Error("existing-comment read failed: unparseable gh output");
    }
  }
  return out;
}

export function filterNewFindings(
  findings: Finding[],
  existing: ExistingComment[],
): { toPost: Finding[]; skipped: Finding[]; repeated: Finding[] } {
  const onPr = new Set(existing.map(commentKey));
  const inBatch = new Set<string>();
  const toPost: Finding[] = [];
  const skipped: Finding[] = [];
  const repeated: Finding[] = [];
  for (const f of findings) {
    const k = findingKey(f);
    if (onPr.has(k)) skipped.push(f);
    else if (inBatch.has(k)) repeated.push(f);
    else {
      inBatch.add(k);
      toPost.push(f);
    }
  }
  return { toPost, skipped, repeated };
}

const CC_LABELS =
  "issue|suggestion|nitpick|praise|question|todo|thought|chore|note";
const CONVENTIONAL = new RegExp(
  `^\\*\\*(?:${CC_LABELS})(?: \\([^)]*\\))?:\\*\\*`,
);
const INTENT_MARKER = "<!-- flow-intent-v1 -->";

/** Both caller shapes: Conventional Comments prefix, or the intent annotation. */
export function isFlowFindingBody(body: string): boolean {
  if (CONVENTIONAL.test(body)) return true;
  return body.startsWith("**why:**") && body.trimEnd().endsWith(INTENT_MARKER);
}

export function planDedupe(
  existing: ExistingComment[],
  login: string,
): { keep: number[]; remove: number[]; skippedWithReplies: number[] } {
  const replied = new Set(
    existing.flatMap((c) =>
      c.in_reply_to_id === null ? [] : [c.in_reply_to_id],
    ),
  );
  const groups = new Map<string, ExistingComment[]>();
  for (const c of existing) {
    if (c.in_reply_to_id !== null || c.user !== login) continue;
    if (!isFlowFindingBody(c.body)) continue;
    const k = commentKey(c);
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const keep: number[] = [];
  const remove: number[] = [];
  const skippedWithReplies: number[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.id - b.id);
    keep.push(sorted[0].id);
    for (const c of sorted.slice(1)) {
      (replied.has(c.id) ? skippedWithReplies : remove).push(c.id);
    }
  }
  return { keep, remove, skippedWithReplies };
}

export function runDedupe(prNumber: number, gh: GhRunner): number {
  let existing: ExistingComment[];
  let login: string;
  try {
    const who = gh(["api", "user", "--jq", ".login"]);
    if (who.exitCode !== 0 || !who.stdout.trim()) {
      throw new Error(
        `gh user lookup failed: ${who.stderr.trim() || `gh exited ${who.exitCode}`}`,
      );
    }
    login = who.stdout.trim();
    existing = fetchExistingComments(prNumber, gh);
  } catch (e) {
    console.error(`flow-post-findings: ${(e as Error).message}`);
    return 1;
  }
  const plan = planDedupe(existing, login);
  const deleted: number[] = [];
  const failed: { id: number; error: string }[] = [];
  for (const id of plan.remove) {
    const r = gh([
      "api",
      "-X",
      "DELETE",
      `repos/{owner}/{repo}/pulls/comments/${id}`,
    ]);
    if (r.exitCode === 0) deleted.push(id);
    else
      failed.push({ id, error: r.stderr.trim() || `gh exited ${r.exitCode}` });
  }
  console.log(
    JSON.stringify({
      pr: prNumber,
      kept: plan.keep.length,
      deleted,
      skippedWithReplies: plan.skippedWithReplies,
      failed,
    }),
  );
  return failed.length > 0 ? 1 : 0;
}
