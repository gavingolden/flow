import { codeRanges } from "./md-code-ranges";

const SECTION_HEADING = /^##\s+(User-facing changes|System changes)\s*$/i;
const ANY_TOP_HEADING = /^#{1,2}\s/;
const BULLET = /^(\s*)[-*]\s+(.*)$/;
const ARROW_PAIR_PREFIX = /^\s*[-*]\s+(?:\*\*)?Before\s*(?:→|->)\s*After\b/i;
const PAIR_LABEL = /^\*\*(?:Before|After):\*\*/;
const PROSE_ARROW = /\s(?:→|->)\s/;

function blankOut(text: string, from: number, to: number): string {
  return (
    text.slice(0, from) +
    text.slice(from, to).replace(/[^\n]/g, " ") +
    text.slice(to)
  );
}

// Same-length copy of `body` with HTML comments, fenced blocks, and inline
// code replaced by spaces, so line indices and offsets still line up.
function maskCode(body: string): string {
  let text = body;
  for (const m of body.matchAll(/<!--[\s\S]*?-->/g)) {
    text = blankOut(text, m.index, m.index + m[0].length);
  }
  for (const r of codeRanges(text)) text = blankOut(text, r.start, r.end);
  return text;
}

function isPairChild(line: string | undefined, parentIndent: number): boolean {
  if (line === undefined) return false;
  const m = BULLET.exec(line);
  return m !== null && m[1].length > parentIndent && PAIR_LABEL.test(m[2]);
}

function flaggedInSection(
  lines: string[],
  rawLines: string[],
): { count: number; first: string } {
  let count = 0;
  let first = "";
  for (let i = 0; i < lines.length; i++) {
    const m = BULLET.exec(lines[i]);
    if (!m) continue;
    const [, indent, text] = m;
    const isPairLabel = PAIR_LABEL.test(text);
    const isPairSubBullet = indent.length > 0 && isPairLabel;
    const next = lines.slice(i + 1).find((l) => l.trim() !== "");
    const flagged =
      ARROW_PAIR_PREFIX.test(lines[i]) ||
      (!isPairSubBullet &&
        text.includes("**Before:**") &&
        text.includes("**After:**")) ||
      (indent.length === 0 && isPairLabel) ||
      (!isPairLabel &&
        !isPairChild(next, indent.length) &&
        PROSE_ARROW.test(text));
    if (flagged) {
      if (count === 0)
        first = rawLines[i]
          .trim()
          .replace(/^[-*]\s+/, "")
          .slice(0, 40);
      count++;
    }
  }
  return { count, first };
}

export function findArrowDeltaBullets(body: string): string[] {
  const lines = maskCode(body).split(/\r?\n/);
  const rawLines = body.split(/\r?\n/);
  const warnings: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = SECTION_HEADING.exec(lines[i]);
    if (!heading) continue;
    let end = i + 1;
    while (end < lines.length && !ANY_TOP_HEADING.test(lines[end])) end++;
    const { count: n, first } = flaggedInSection(
      lines.slice(i + 1, end),
      rawLines.slice(i + 1, end),
    );
    if (n > 0) {
      warnings.push(
        `warn: PR '## ${heading[1]}' has ${n} change bullet(s) not in the nested Before/After shape (first: "${first}") — use an outcome parent bullet with nested **Before:** / **After:** sub-bullets`,
      );
    }
  }
  return warnings;
}
