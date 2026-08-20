/**
 * Shared GFM `<details>`-block structure rules.
 *
 * Lifted from `bin/flow-inject-evidence.ts`'s `buildEvidenceBlock`, which
 * already encoded the two rules correctly for the one block it builds:
 * a blank line after every line ending in `</summary>` and after every
 * line ending in `</details>`. GitHub's GFM type 6/7 HTML blocks only end
 * at a blank line — without one, the next bullet (or the next
 * `<details>`'s `</details>`) gets absorbed into a chained raw-HTML
 * block, killing checkbox rendering for everything that follows. Same
 * pattern as the leading blank between `<summary>` and a code fence:
 * GFM only re-enters markdown mode after a blank.
 *
 * DEPTH-INDEPENDENT BY DECISION: no open/close nesting model, no depth
 * counter. Captured program output spliced into a PR body (evidence
 * blocks, agent findings) can contain unbalanced `</details>` text, on
 * which any depth counter desynchronizes. Insert a blank line after
 * EVERY qualifying line, full stop.
 */

export type Defect = {
  line: number;
  kind: "missing-blank-after-summary" | "missing-blank-after-details-close";
};

const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/;
const SUMMARY_END_RE = /<\/summary>\s*$/;
const DETAILS_END_RE = /<\/details>\s*$/;
const DETAILS_OPEN_RE = /<details\b/i;

/**
 * Split `body` into its real content lines plus a `trailingNewline`
 * flag. `body.split("\n")` on a `\n`-terminated string yields a
 * trailing empty-string artifact that isn't a real line (there is no
 * content after the final newline) — dropping it here means "the last
 * element of `lines`" always means the true last line of content,
 * whether or not the body ends in a newline. CRLF lines keep their
 * trailing `\r` attached to the line text (GFM/CommonMark line-ending
 * neutral: a trailing `\r` never changes where a line "ends" for our
 * regexes, which anchor with `\s*$`).
 */
function splitBody(body: string): {
  lines: string[];
  trailingNewline: boolean;
} {
  const trailingNewline = body.endsWith("\n");
  const raw = body.split("\n");
  const lines = trailingNewline ? raw.slice(0, -1) : raw;
  return { lines, trailingNewline };
}

function joinBody(lines: string[], trailingNewline: boolean): string {
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/**
 * Fence-aware tracker: opens on a fence line (three-or-more backticks or
 * tildes), closes only on a fence of the SAME character and
 * equal-or-greater length. A fixed three-backtick tracker is foreclosed —
 * `flow-inject-evidence.ts`'s `pickFenceLength` already widens fences
 * past three backticks to safely wrap captured output that itself
 * contains backtick runs, so a naive tracker would misfire on those
 * widened fences (and on deliberately-broken markdown documentation
 * examples).
 */
class FenceTracker {
  private openChar: "`" | "~" | null = null;
  private openLen = 0;

  /** Feed one line's text and return whether it is fenced content
   * (i.e. inside an open fence, INCLUDING the fence line that opened
   * or closed it — fence delimiters are never eligible for
   * insertion or block-open/close detection). */
  feed(text: string): boolean {
    const m = text.match(FENCE_OPEN_RE);
    if (this.openChar === null) {
      if (m) {
        this.openChar = m[1][0] as "`" | "~";
        this.openLen = m[1].length;
        return true;
      }
      return false;
    }
    if (m && m[1][0] === this.openChar && m[1].length >= this.openLen) {
      this.openChar = null;
      this.openLen = 0;
      return true;
    }
    return true;
  }
}

/**
 * Detect-only scan: report every line ending in `</summary>` or
 * `</details>` that is not followed by a blank line, outside fenced
 * content. The document's true last line is never reported — there is
 * no following content for an unterminated block to swallow. Never
 * mutates `body`.
 */
export function findDetailsBlockDefects(body: string): Defect[] {
  const { lines } = splitBody(body);
  const fence = new FenceTracker();
  const defects: Defect[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const fenced = fence.feed(text);
    if (fenced) continue;
    const isLast = i === lines.length - 1;
    if (isLast) continue;
    const nextBlank = lines[i + 1].trim() === "";
    if (nextBlank) continue;
    if (SUMMARY_END_RE.test(text)) {
      defects.push({ line: i, kind: "missing-blank-after-summary" });
    } else if (DETAILS_END_RE.test(text)) {
      defects.push({ line: i, kind: "missing-blank-after-details-close" });
    }
  }
  return defects;
}

/**
 * Insert-only, idempotent normalization: insert a blank line after every
 * line ending in `</summary>` or `</details>` (outside fenced content)
 * that isn't already followed by one and isn't the document's last
 * line. Never removes, reorders, or rewraps anything. Preserves
 * whatever line terminators (CRLF-aware) and trailing-newline state the
 * input carries.
 */
export function normalizeDetailsBlocks(body: string): {
  body: string;
  insertions: number;
} {
  const { lines, trailingNewline } = splitBody(body);
  const fence = new FenceTracker();
  const out: string[] = [];
  let insertions = 0;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    out.push(text);
    const fenced = fence.feed(text);
    if (fenced) continue;
    const isLast = i === lines.length - 1;
    if (isLast) continue;
    const nextBlank = lines[i + 1].trim() === "";
    if (nextBlank) continue;
    if (SUMMARY_END_RE.test(text) || DETAILS_END_RE.test(text)) {
      out.push(text.endsWith("\r") ? "\r" : "");
      insertions++;
    }
  }
  return { body: joinBody(out, trailingNewline), insertions };
}

/**
 * Query used by `flow-gate-decide.ts` to exclude `- [ ]` items GFM has
 * already swallowed into raw HTML: line indices that fall inside an
 * OPEN `<details>` block with no blank line ever closing it (outside
 * fenced content). A `<details>` block that IS closed by a later blank
 * line is not reported — content between the open tag and that blank
 * line is the block's intended nested content, not stray markdown.
 * Returns a Set of 0-indexed line numbers into the body's real content
 * lines (i.e. `body.split("\n")` minus the trailing empty artifact a
 * `\n`-terminated body produces — see `splitBody`).
 */
export function findUnterminatedHtmlBlockLines(body: string): Set<number> {
  const { lines } = splitBody(body);
  const fence = new FenceTracker();
  const trapped = new Set<number>();
  let openStart: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const fenced = fence.feed(text);
    if (fenced) continue;
    if (openStart === null) {
      if (DETAILS_OPEN_RE.test(text)) openStart = i;
      continue;
    }
    if (text.trim() === "") {
      openStart = null;
    }
    // A nested/repeated `<details>` line while already inside an open
    // block is a no-op — the outer open still governs.
  }
  if (openStart !== null) {
    for (let i = openStart; i < lines.length; i++) trapped.add(i);
  }
  return trapped;
}
