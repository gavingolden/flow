/**
 * Pure conflict-marker scan module: owns the marker pattern, the `git grep`
 * output parse (including the committed-tree rev-prefix strip), the
 * touched-file parse, and the blocking/pre-existing partition. No
 * subprocesses, no I/O — both consumers (`bin/flow-conflict-marker-check.ts`'s
 * CLI, for the merge-resolver's post-commit Layer 2, and
 * `bin/flow-pre-commit.ts`'s in-process diff-scoped gate) supply their own
 * `git` invocations and call these pure functions.
 *
 * Deliberately NOT registered in `bin/lib/sources.ts`'s `VALIDATOR_MODULES`
 * allowlist, and carries no bun shebang / `import.meta.main` guard:
 * `isExecutableLibModule` (`bin/flow-pre-commit.ts`) content-gates on exactly
 * those two signals to decide what must be tracked executable, and this
 * module must stay a plain library, never a PATH-bound helper.
 */

/**
 * ERE form (for `git grep -E`) matching a leftover `<<<<<<<` or `>>>>>>>`
 * conflict-marker line at the START of a line, followed by a space (the ref
 * suffix, e.g. `<<<<<<< HEAD`) or end-of-line. Deliberately EXCLUDES
 * `=======` (legitimate content elsewhere — markdown setext headings, ASCII
 * rules — so broadening the pattern would false-positive there) and
 * `|||||||` (only appears under the opt-in `merge.conflictStyle=diff3`,
 * which flow never sets).
 */
export const MARKER_PATTERN = "^(<{7}|>{7})( |$)";

/** JS-regex equivalent of {@link MARKER_PATTERN}, for parsing already-fetched text. */
export const MARKER_LINE_REGEX = /^(<{7}|>{7})( |$)/;

export type MarkerHit = {
  path: string;
  line: number;
  text: string;
};

export type PartitionedHits = {
  blocking: MarkerHit[];
  preExisting: MarkerHit[];
};

// Non-greedy on the path segment so a `:` inside the matched marker text
// (rare, but possible with a custom conflict-style label) doesn't get eaten
// into the path.
const GIT_GREP_LINE_REGEX = /^(.+?):(\d+):([\s\S]*)$/;

/**
 * Parses `git grep --full-name -nE MARKER_PATTERN [rev] -- ...` stdout into
 * structured hits.
 *
 * When `rev` is supplied (the committed-tree CLI form, `git grep ... HEAD --
 * ...`), each line is prefixed `HEAD:<path>:<line>:<text>` — that prefix is
 * stripped BEFORE the path/line/text split, or the parsed "path" would be
 * `HEAD:<real path>` and would never match a touched-file set (this exact
 * failure mode was reproduced live: a prose reimplementation of this strip
 * matches nothing and dismisses every real hit as pre-existing).
 *
 * A line that doesn't match the expected shape at all — which should never
 * happen against real `git grep -n` output — is FAIL-CLOSED: it's classified
 * with the `"(unparsed)"` sentinel path so `partitionHits` always treats it
 * as blocking rather than silently dropping it.
 */
export function parseGitGrepOutput(
  stdout: string,
  rev?: string,
): MarkerHit[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((raw) => {
      const line =
        rev !== undefined && raw.startsWith(`${rev}:`)
          ? raw.slice(rev.length + 1)
          : raw;
      const match = GIT_GREP_LINE_REGEX.exec(line);
      if (!match) return { path: "(unparsed)", line: 0, text: raw };
      return { path: match[1], line: Number(match[2]), text: match[3] };
    });
}

/**
 * Parses `git show --name-only --format="" -m HEAD` output: one path per
 * line, blank lines dropped. The `-m` form prints one diff per parent, so a
 * two-parent merge commit repeats every path either parent touched —
 * DEDUPE, so `partitionHits`'s `Set` lookup and any caller iterating the
 * result don't double-count a path touched on both sides.
 */
export function parseTouchedFiles(stdout: string): string[] {
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Splits scan hits into `blocking` (the hit's path is in `scope` — this
 * merge/diff touched it — OR the hit was unparsable, fail-closed) and
 * `preExisting` (a marker that predates this change and is out of scope).
 */
export function partitionHits(
  hits: MarkerHit[],
  scope: ReadonlySet<string>,
): PartitionedHits {
  const blocking: MarkerHit[] = [];
  const preExisting: MarkerHit[] = [];
  for (const hit of hits) {
    if (hit.path === "(unparsed)" || scope.has(hit.path)) {
      blocking.push(hit);
    } else {
      preExisting.push(hit);
    }
  }
  return { blocking, preExisting };
}

/** Formats one `<label> <path>:<line>: <text>` line per hit, in input order. */
export function formatHits(hits: MarkerHit[], label: string): string[] {
  return hits.map((h) => `${label} ${h.path}:${h.line}: ${h.text}`);
}
