#!/usr/bin/env bun
/**
 * Attaches an issue owner's own verbatim notes to the GitHub issue(s) they
 * belong to, as a marker-tagged comment separate from the triage findings.
 *
 * Why: `/flow-backlog-triage` captures an owner's original notes text
 * byte-for-byte into a scratch file (see methodology.md "Verbatim
 * capture"), and a per-issue map decides which captured ref attaches to
 * which issue. Having a model re-type that text into a comment payload
 * would put a language model back in the copy path — exactly the failure
 * this feature exists to remove. This helper is the deterministic,
 * model-free last mile: parse the capture file, cross-check every block
 * against the raw notes source, and upsert one marker-tagged comment per
 * issue via `gh`.
 *
 * Bodies travel to `gh api` as JSON on stdin (`--input -`), never
 * interpolated into argv — an owner's verbatim note can be arbitrarily
 * long and can contain characters (quotes, backticks, `$(...)`) that are
 * unsafe to fold into a `-f body=<value>` argv entry.
 *
 * Usage:
 *   flow-verbatim-notes attach --verbatim-file <path> --map-file <path> [--dry-run]
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export const MARKER = "<!-- owner-verbatim-notes-v1 -->";
export const MAX_COMMENT_CHARS = 65536;

export type GhRunner = (
  argv: string[],
  stdin?: string,
) => { stdout: string; stderr: string; exitCode: number };

export type Args = { verbatimFile: string; mapFile: string; dryRun: boolean };

export type MapFile = {
  version: 1;
  sourceOfTruth: string;
  preamble: { triageDates: string };
  attachments: { issue: number; refs: { ref: string; label: string }[] }[];
  unattached: { ref: string; reason: string }[];
};

export type Envelope = {
  version: 1;
  sourceOfTruth: string;
  attachments: {
    issue: number;
    refs: string[];
    action:
      | "created"
      | "updated"
      | "unchanged"
      | "skipped"
      | "would-create"
      | "would-update";
    reason: string | null;
    commentUrl: string | null;
  }[];
  unattached: { ref: string; reason: string }[];
  duplicateMarkers: number[];
};

const defaultGh: GhRunner = (argv, stdin) => {
  const r = Bun.spawnSync(["gh", ...argv], {
    stdin: stdin !== undefined ? Buffer.from(stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
    exitCode: r.exitCode ?? -1,
  };
};

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Args = { verbatimFile: "", mapFile: "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (flag === "--verbatim-file" || flag === "--map-file") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: `${flag} requires a value` };
      }
      if (flag === "--verbatim-file") out.verbatimFile = value;
      else out.mapFile = value;
      i++;
      continue;
    }
    return { error: `unknown flag: ${flag}` };
  }
  if (!out.verbatimFile) return { error: "--verbatim-file is required" };
  if (!out.mapFile) return { error: "--map-file is required" };
  return out;
}

const REF_INDEX_RE = /^<!-- flow-verbatim-refs:\s*(.+?)\s*-->$/m;
const SOURCE_RE = /^<!-- flow-verbatim-source:\s*(.+?)\s*-->$/m;
const BLOCK_HEADING_RE = /^\*\*([A-Za-z][A-Za-z0-9]*)\*\*/;

/**
 * Reads the `<!-- flow-verbatim-refs: ... -->` index line. A capture file
 * without one is a hard error — the index is the only reliable way to
 * disambiguate a real block boundary from a `**word**`-shaped line inside
 * an owner's note body, so there is no pattern-only fallback.
 */
export function parseRefIndex(text: string): Set<string> {
  const m = text.match(REF_INDEX_RE);
  if (!m) {
    throw new Error(
      "capture file is missing the required `<!-- flow-verbatim-refs: ... -->` index line",
    );
  }
  const refs = m[1]
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  return new Set(refs);
}

/** Reads the `<!-- flow-verbatim-source: ... -->` provenance line. */
export function parseSourcePath(text: string): string {
  const m = text.match(SOURCE_RE);
  if (!m) {
    throw new Error(
      "capture file is missing the required `<!-- flow-verbatim-source: ... -->` provenance line",
    );
  }
  return m[1].trim();
}

/**
 * Splits the capture file into ref -> body. A block starts ONLY at a line
 * matching `**<ref>**` whose captured ref is present in `refIndex`, and
 * runs to the next such line or EOF — a bare `---`, an ATX heading, or a
 * `**word**`-shaped line naming an unknown ref are all body text, never
 * boundaries. Bodies are returned byte-for-byte (no re-quoting — the
 * source lines are already `> `-prefixed), with leading and trailing
 * blank lines trimmed (the heading line and the blockquote conventionally
 * sit on either side of one blank separator line, which is formatting,
 * not captured content).
 */
export function parseVerbatimFile(
  text: string,
  refIndex: Set<string>,
): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const blocks = new Map<string, string>();
  let currentRef: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentRef === null) return;
    while (
      currentLines.length > 0 &&
      currentLines[currentLines.length - 1].trim() === ""
    ) {
      currentLines.pop();
    }
    while (currentLines.length > 0 && currentLines[0].trim() === "") {
      currentLines.shift();
    }
    blocks.set(currentRef, currentLines.join("\n"));
  };

  for (const line of lines) {
    const m = line.match(BLOCK_HEADING_RE);
    if (m && refIndex.has(m[1])) {
      flush();
      currentRef = m[1];
      currentLines = [];
      continue;
    }
    if (currentRef !== null) currentLines.push(line);
  }
  flush();
  return blocks;
}

function stripQuotePrefix(body: string): string {
  return body
    .split("\n")
    .map((line) => {
      if (line.startsWith("> ")) return line.slice(2);
      if (line === ">") return "";
      return line;
    })
    .join("\n");
}

/**
 * For each captured block, strips the `> ` blockquote prefix the capture
 * added and asserts the remaining text appears in `notesText` as a
 * contiguous byte sequence. A non-empty return is fatal — it means the
 * capture silently diverged from the owner's original text (a fixed typo,
 * collapsed whitespace, or a missing prefix all fail the plain substring
 * check on their own).
 *
 * A dropped TRAILING character (e.g. a stripped `?`) is different: any
 * prefix of a matched substring is trivially still a substring, so a
 * plain `.includes()` can't see it. Guard that case separately — after
 * locating the match, the source byte immediately following it must be
 * whitespace or end-of-file; a non-whitespace byte there means the block
 * stopped short of the source's actual boundary.
 */
export function crossCheckAgainstSource(
  blocks: Map<string, string>,
  notesText: string,
): { ref: string; reason: string }[] {
  const failures: { ref: string; reason: string }[] = [];
  for (const [ref, body] of blocks) {
    const stripped = stripQuotePrefix(body);
    if (stripped.trim() === "") {
      failures.push({
        ref,
        reason: `captured block is empty — nothing was copied from the notes source`,
      });
      continue;
    }
    // The block text can legitimately occur more than once in a notes
    // dump (short lines like "?" or "revisit this" repeat). Judging the
    // boundary from only the first `indexOf` hit is wrong in both
    // directions — an unrelated earlier occurrence can fail a
    // byte-perfect capture, and a truncated form that happens to appear
    // earlier can pass. Evaluate every occurrence; accept the block if
    // ANY occurrence has clean boundaries on both ends.
    let from = 0;
    let idx = -1;
    let found = false;
    let cleanMatch = false;
    let anyTrailingOk = false;
    let anyLeadingOk = false;
    while ((idx = notesText.indexOf(stripped, from)) !== -1) {
      found = true;
      const nextChar = notesText[idx + stripped.length];
      const prevChar = idx === 0 ? undefined : notesText[idx - 1];
      const thisTrailingOk = nextChar === undefined || /\s/.test(nextChar);
      const thisLeadingOk = prevChar === undefined || /\s/.test(prevChar);
      anyTrailingOk = anyTrailingOk || thisTrailingOk;
      anyLeadingOk = anyLeadingOk || thisLeadingOk;
      if (thisTrailingOk && thisLeadingOk) {
        cleanMatch = true;
        break;
      }
      from = idx + 1;
    }
    if (!found) {
      failures.push({
        ref,
        reason: `captured block does not appear byte-for-byte in the recorded notes source`,
      });
    } else if (!cleanMatch) {
      if (!anyTrailingOk) {
        failures.push({
          ref,
          reason: `captured block appears truncated relative to the recorded notes source (non-whitespace content follows with no boundary)`,
        });
      } else {
        failures.push({
          ref,
          reason: `captured block appears to drop leading content relative to the recorded notes source (non-whitespace content precedes with no boundary)`,
        });
      }
    }
  }
  return failures;
}

export function parseMapFile(text: string): MapFile | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: `map file is not valid JSON: ${(e as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "map file must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) return { error: "map file must have version: 1" };
  if (typeof obj.sourceOfTruth !== "string" || obj.sourceOfTruth.length === 0) {
    return { error: "map file must have a non-empty sourceOfTruth" };
  }
  const preamble = obj.preamble;
  if (preamble === null || typeof preamble !== "object") {
    return { error: "map file must have preamble.triageDates as a string" };
  }
  const triageDates = (preamble as Record<string, unknown>).triageDates;
  if (typeof triageDates !== "string" || triageDates.trim().length === 0) {
    return {
      error: "map file must have a non-empty preamble.triageDates string",
    };
  }
  if (!Array.isArray(obj.attachments)) {
    return { error: "map file must have an attachments array" };
  }
  const attachments: MapFile["attachments"] = [];
  for (const entry of obj.attachments) {
    if (entry === null || typeof entry !== "object") {
      return { error: "each attachments entry must be an object" };
    }
    const e = entry as Record<string, unknown>;
    if (
      typeof e.issue !== "number" ||
      !Number.isInteger(e.issue) ||
      e.issue <= 0
    ) {
      return {
        error: `attachments entry has a non-positive/non-integer issue: ${e.issue}`,
      };
    }
    if (!Array.isArray(e.refs)) {
      return {
        error: `attachments entry for issue ${e.issue} must have a refs array`,
      };
    }
    const refs: { ref: string; label: string }[] = [];
    for (const r of e.refs) {
      const ro = r as Record<string, unknown>;
      if (
        r === null ||
        typeof r !== "object" ||
        typeof ro.ref !== "string" ||
        typeof ro.label !== "string" ||
        ro.label.trim().length === 0
      ) {
        return {
          error: `attachments entry for issue ${e.issue} has a malformed ref`,
        };
      }
      refs.push({ ref: ro.ref as string, label: ro.label as string });
    }
    attachments.push({ issue: e.issue, refs });
  }
  if (!Array.isArray(obj.unattached)) {
    return { error: "map file must have an unattached array" };
  }
  const unattached: MapFile["unattached"] = [];
  for (const entry of obj.unattached) {
    if (entry === null || typeof entry !== "object") {
      return { error: "each unattached entry must be an object" };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.ref !== "string" || e.ref.length === 0) {
      return { error: "each unattached entry must have a non-empty ref" };
    }
    if (typeof e.reason !== "string" || e.reason.trim().length === 0) {
      return {
        error: `unattached entry for ref ${e.ref} is missing a reason`,
      };
    }
    unattached.push({ ref: e.ref, reason: e.reason });
  }
  return {
    version: 1,
    sourceOfTruth: obj.sourceOfTruth,
    preamble: {
      triageDates: (preamble as Record<string, unknown>).triageDates as string,
    },
    attachments,
    unattached,
  };
}

/**
 * Renders the marker-tagged comment body for one map attachment entry.
 * The preamble is owner-neutral (this skill is distributed across repos
 * with different owners) and names the byte-for-byte guarantee; the
 * never-reconcile rule (see methodology.md "Attach the owner's verbatim
 * notes") is why this comment stands alone rather than editing another.
 */
export function renderComment(
  entry: MapFile["attachments"][number],
  blocks: Map<string, string>,
  map: MapFile,
): string {
  const lines: string[] = [MARKER, "", "## Owner original note (verbatim)", ""];
  lines.push(
    `The text below is copied byte-for-byte from the owner's exact notes ` +
      `(${map.preamble.triageDates}) — unedited, including any typos or ` +
      `informal phrasing.`,
  );
  lines.push("");
  lines.push(
    "It is posted as a second, separately authored voice alongside the " +
      "triage findings on this issue. Where the two disagree, the " +
      "disagreement is preserved here rather than reconciled into one " +
      "comment.",
  );
  lines.push("");
  for (const ref of entry.refs) {
    const body = blocks.get(ref.ref) ?? "";
    lines.push(`**${ref.ref}** — ${ref.label}`, "", body, "");
  }
  // `sourceOfTruth` commonly lives outside the worktree (an owner's dump
  // file) and is often an absolute path — publishing it verbatim into a
  // public GitHub comment leaks local filesystem layout (e.g. an OS
  // account name). Only the basename carries provenance value publicly;
  // the full path stays local, in the envelope.
  lines.push(
    "---",
    "",
    `<sub>Source of truth: ${basename(map.sourceOfTruth)}</sub>`,
  );
  return lines.join("\n");
}

type IssueComment = { id: number; body: string; login: string | null };

function listComments(
  issue: number,
  gh: GhRunner,
): IssueComment[] | { error: string } {
  // --paginate without --slurp concatenates page bodies as `[{...}][{...}]`,
  // which is not valid JSON on its own. --slurp wraps multi-page output as
  // an array-of-pages (`[[...],[...]]`); a single-page response flattens to
  // itself since its objects aren't arrays. Mirrors
  // flow-pipeline-summary.ts's findMarkedCommentId.
  const r = gh([
    "api",
    `repos/{owner}/{repo}/issues/${issue}/comments`,
    "--paginate",
    "--slurp",
  ]);
  if (r.exitCode !== 0) {
    return {
      error:
        r.stderr.trim() ||
        `gh api issues/${issue}/comments failed (${r.exitCode})`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return {
      error: `gh api issues/${issue}/comments returned non-JSON: ${(e as Error).message}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { error: `gh api issues/${issue}/comments returned non-array` };
  }
  const comments: IssueComment[] = [];
  for (const c of parsed.flat()) {
    const obj = c as Record<string, unknown>;
    if (typeof obj.id === "number" && typeof obj.body === "string") {
      const user = obj.user as Record<string, unknown> | undefined;
      const login = user && typeof user.login === "string" ? user.login : null;
      comments.push({ id: obj.id, body: obj.body, login });
    }
  }
  return comments;
}

/**
 * Resolves the login of the account `gh` is authenticated as. The marker
 * match below trusts only comments this login posted — otherwise, on a
 * public repo, anyone who can comment can pre-post the marker HTML comment
 * (it's visible in this repo's own docs) and either hijack the upsert slot
 * or make every future PATCH 403.
 */
function currentLogin(gh: GhRunner): string | null {
  const r = gh(["api", "user", "--jq", ".login"]);
  if (r.exitCode !== 0) return null;
  const login = r.stdout.trim();
  return login.length > 0 ? login : null;
}

function issueState(
  issue: number,
  gh: GhRunner,
): "OPEN" | "CLOSED" | { error: string } {
  const r = gh(["issue", "view", String(issue), "--json", "state"]);
  if (r.exitCode !== 0) {
    return {
      error: r.stderr.trim() || `gh issue view ${issue} failed (${r.exitCode})`,
    };
  }
  try {
    const parsed = JSON.parse(r.stdout) as { state?: string };
    if (parsed.state === "OPEN" || parsed.state === "CLOSED") {
      return parsed.state;
    }
    return {
      error: `gh issue view ${issue} returned unexpected state: ${r.stdout}`,
    };
  } catch (e) {
    return {
      error: `gh issue view ${issue} returned non-JSON: ${(e as Error).message}`,
    };
  }
}

function parseHtmlUrl(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { html_url?: string };
    return parsed.html_url ?? null;
  } catch {
    return null;
  }
}

function attachOne(
  entry: MapFile["attachments"][number],
  blocks: Map<string, string>,
  map: MapFile,
  args: Args,
  gh: GhRunner,
  envelope: Envelope,
  selfLogin: string | null,
): void {
  const refs = entry.refs.map((r) => r.ref);
  const push = (
    action: Envelope["attachments"][number]["action"],
    reason: string | null,
    commentUrl: string | null,
  ) => {
    envelope.attachments.push({
      issue: entry.issue,
      refs,
      action,
      reason,
      commentUrl,
    });
  };

  const state = issueState(entry.issue, gh);
  if (typeof state === "object") {
    push("skipped", `gh-error: ${state.error.slice(0, 500)}`, null);
    return;
  }
  if (state === "CLOSED") {
    push("skipped", "issue-closed", null);
    return;
  }

  const body = renderComment(entry, blocks, map);
  if (body.length > MAX_COMMENT_CHARS) {
    push("skipped", `body-too-large (refs: ${refs.join(", ")})`, null);
    return;
  }

  const comments = listComments(entry.issue, gh);
  if ("error" in comments) {
    push("skipped", `gh-error: ${comments.error.slice(0, 500)}`, null);
    return;
  }

  // A marker-bearing comment authored by someone other than the account
  // running this helper is never a legitimate upsert target — resolving
  // `selfLogin` as null (gh api user failed) falls back to body-only
  // matching so a run doesn't hard-fail purely on the auth-probe call.
  const markerComments = comments.filter(
    (c) =>
      c.body.startsWith(MARKER) &&
      (selfLogin === null || c.login === null || c.login === selfLogin),
  );
  if (markerComments.length > 1) envelope.duplicateMarkers.push(entry.issue);

  if (markerComments.length === 0) {
    if (args.dryRun) {
      push("would-create", null, null);
      return;
    }
    const r = gh(
      [
        "api",
        "--method",
        "POST",
        `repos/{owner}/{repo}/issues/${entry.issue}/comments`,
        "--input",
        "-",
      ],
      JSON.stringify({ body }),
    );
    if (r.exitCode !== 0) {
      push("skipped", `gh-error: ${r.stderr.trim().slice(0, 500)}`, null);
      return;
    }
    push("created", null, parseHtmlUrl(r.stdout));
    return;
  }

  const target = markerComments[0];
  if (target.body === body) {
    push("unchanged", null, null);
    return;
  }
  if (args.dryRun) {
    push("would-update", null, null);
    return;
  }
  const r = gh(
    [
      "api",
      "--method",
      "PATCH",
      `repos/{owner}/{repo}/issues/comments/${target.id}`,
      "--input",
      "-",
    ],
    JSON.stringify({ body }),
  );
  if (r.exitCode !== 0) {
    push("skipped", `gh-error: ${r.stderr.trim().slice(0, 500)}`, null);
    return;
  }
  push("updated", null, parseHtmlUrl(r.stdout));
}

/**
 * Attaches every map entry's verbatim text to its GitHub issue. Fails
 * fast (throws, posting nothing for ANY issue) on any of: a ref named in
 * the map but absent from the capture file, a capture file with no refs
 * index line, a recorded notes-source path that no longer exists, or a
 * captured block that fails the byte-for-byte cross-check. Per-issue
 * failures after that point (closed issue, oversized body, a single gh
 * call failing) are recorded as `skipped` and do not abort the run.
 */
export function attach(args: Args, gh: GhRunner = defaultGh): Envelope {
  const verbatimText = readFileSync(args.verbatimFile, "utf8");
  const refIndex = parseRefIndex(verbatimText);
  const sourcePath = parseSourcePath(verbatimText);
  const blocks = parseVerbatimFile(verbatimText, refIndex);

  const mapText = readFileSync(args.mapFile, "utf8");
  const parsedMap = parseMapFile(mapText);
  if ("error" in parsedMap) throw new Error(parsedMap.error);
  const map = parsedMap;

  const missingRefs: string[] = [];
  for (const a of map.attachments) {
    for (const r of a.refs) {
      if (!blocks.has(r.ref)) missingRefs.push(r.ref);
    }
  }
  if (missingRefs.length > 0) {
    throw new Error(
      `ref(s) named in the map are absent from the capture file: ${missingRefs.join(", ")}`,
    );
  }

  if (!existsSync(sourcePath)) {
    throw new Error(`recorded notes source no longer exists: ${sourcePath}`);
  }
  // Normalize CRLF to LF for the comparison only — `parseVerbatimFile`
  // always rejoins block bodies with `\n` (line 169), so an owner's notes
  // file with CRLF endings (a Windows export, a Notion/email paste) would
  // otherwise fail `indexOf` on every multi-line block. Line endings carry
  // no owner-authored content, so normalizing them here doesn't weaken the
  // byte-for-byte guarantee; the posted bytes (from `blocks`) are untouched.
  const notesText = readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");

  const crossCheckFailures = crossCheckAgainstSource(blocks, notesText);
  if (crossCheckFailures.length > 0) {
    const refs = crossCheckFailures.map((f) => f.ref).join(", ");
    throw new Error(
      `verbatim capture failed the byte-for-byte cross-check against the source for ref(s): ${refs}`,
    );
  }

  const envelope: Envelope = {
    version: 1,
    sourceOfTruth: map.sourceOfTruth,
    attachments: [],
    unattached: map.unattached,
    duplicateMarkers: [],
  };

  const selfLogin = currentLogin(gh);
  for (const entry of map.attachments) {
    attachOne(entry, blocks, map, args, gh, envelope, selfLogin);
  }

  return envelope;
}

export function run(argv: string[], gh: GhRunner = defaultGh): number {
  if (argv[0] !== "attach") {
    console.error(
      "usage: flow-verbatim-notes attach --verbatim-file <path> --map-file <path> [--dry-run]",
    );
    return 2;
  }
  const parsed = parseArgs(argv.slice(1));
  if ("error" in parsed) {
    console.error(`flow-verbatim-notes: ${parsed.error}`);
    return 2;
  }
  try {
    const envelope = attach(parsed, gh);
    process.stdout.write(JSON.stringify(envelope) + "\n");
    return 0;
  } catch (e) {
    console.error(`flow-verbatim-notes: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
