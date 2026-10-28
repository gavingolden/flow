import { fencedLineMask } from "./md-block-structure";

export type CodeRange = { start: number; end: number };

function isBlankAt(text: string, from: number, end: number): boolean {
  for (let i = from; i < end && text[i] !== "\n"; i++) {
    if (!/\s/.test(text[i])) return false;
  }
  return true;
}

function runLength(text: string, at: number, end: number): number {
  let n = 0;
  while (at + n < end && text[at + n] === "`") n++;
  return n;
}

// Find the end of a span opened by a run of `len` backticks, or -1. A span
// may cross single newlines but never a blank line or the segment end.
function spanEnd(text: string, from: number, end: number, len: number): number {
  let i = from;
  while (i < end) {
    if (text[i] === "`") {
      const n = runLength(text, i, end);
      if (n === len) return i + n;
      i += n;
    } else if (text[i] === "\n" && isBlankAt(text, i + 1, end)) {
      return -1;
    } else {
      i++;
    }
  }
  return -1;
}

function inlineSpans(
  text: string,
  start: number,
  end: number,
  out: CodeRange[],
): void {
  let i = start;
  while (i < end) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
    } else if (c === "`") {
      const n = runLength(text, i, end);
      const close = spanEnd(text, i + n, end, n);
      if (close === -1) {
        i += n;
      } else {
        out.push({ start: i, end: close });
        i = close;
      }
    } else {
      i++;
    }
  }
}

/** Sorted, non-overlapping character ranges (end exclusive) of `body` that are
 * markdown code: fenced blocks (fence lines included, an unclosed fence runs
 * to EOF) and CommonMark inline code spans. */
export function codeRanges(body: string): CodeRange[] {
  const lines = body.split("\n");
  const mask = fencedLineMask(lines, { unclosedIsCode: true });
  const out: CodeRange[] = [];
  let offset = 0;
  let segStart = 0;
  let fenceStart = -1;
  const flushSegment = (segEnd: number) => {
    if (segEnd > segStart) inlineSpans(body, segStart, segEnd, out);
  };
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = offset + lines[i].length;
    if (mask[i]) {
      if (fenceStart === -1) {
        flushSegment(offset);
        fenceStart = offset;
      }
    } else if (fenceStart !== -1) {
      out.push({ start: fenceStart, end: offset - 1 });
      fenceStart = -1;
      segStart = offset;
    }
    offset = lineEnd + 1;
  }
  if (fenceStart !== -1) {
    out.push({ start: fenceStart, end: body.length });
  } else {
    flushSegment(body.length);
  }
  return out;
}

export function inCode(ranges: CodeRange[], index: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index < ranges[mid].start) hi = mid - 1;
    else if (index >= ranges[mid].end) lo = mid + 1;
    else return true;
  }
  return false;
}
