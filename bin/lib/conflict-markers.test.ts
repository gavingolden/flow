/**
 * Tests for `bin/lib/conflict-markers.ts` — the pure marker-scan module.
 *
 * Pure functions only: no subprocesses, no fixture repos. The rev-prefix
 * strip and the fail-closed unparsed-line rule are the two properties this
 * module exists to get right, so they get dedicated cases.
 *
 * FIXTURE HAZARD: marker text is built via array-join / `\n`-escaped
 * single-line strings, never a column-0 multi-line template literal — a
 * literal `<<<<<<< HEAD` at the start of a line in this TRACKED .ts file
 * would make flow's own `checkConflictMarkers` gate fail on this file.
 */

import { describe, expect, it } from "vitest";
import {
  MARKER_PATTERN,
  MARKER_LINE_REGEX,
  formatHits,
  parseGitGrepOutput,
  parseTouchedFiles,
  partitionHits,
  type MarkerHit,
} from "./conflict-markers";

const HEAD_MARKER = ["<", "<", "<", "<", "<", "<", "<"].join("");
const TAIL_MARKER = [">", ">", ">", ">", ">", ">", ">"].join("");

describe("MARKER_PATTERN / MARKER_LINE_REGEX", () => {
  it("matches a leading marker followed by a ref name or end-of-line", () => {
    expect(MARKER_LINE_REGEX.test(`${HEAD_MARKER} HEAD`)).toBe(true);
    expect(MARKER_LINE_REGEX.test(TAIL_MARKER)).toBe(true);
    expect(MARKER_LINE_REGEX.test(`${TAIL_MARKER} origin/main`)).toBe(true);
  });

  it("does not match a bare ======= line (excluded on purpose)", () => {
    const equalsLine = "=".repeat(7);
    expect(MARKER_LINE_REGEX.test(equalsLine)).toBe(false);
  });

  it("does not match a marker mid-line", () => {
    expect(MARKER_LINE_REGEX.test(`x ${HEAD_MARKER} HEAD`)).toBe(false);
  });

  it("MARKER_PATTERN is the ERE-string twin of MARKER_LINE_REGEX", () => {
    expect(MARKER_PATTERN).toBe("^(<{7}|>{7})( |$)");
  });
});

describe(parseGitGrepOutput, () => {
  it("parses a no-rev line, leaving the path as git printed it", () => {
    const stdout = ["sub/deep/m.txt:2:" + HEAD_MARKER + " HEAD"].join("\n");
    const hits = parseGitGrepOutput(stdout);
    expect(hits).toEqual([
      { path: "sub/deep/m.txt", line: 2, text: `${HEAD_MARKER} HEAD` },
    ]);
  });

  it("strips the leading `HEAD:` rev prefix before splitting path/line/text", () => {
    const stdout = ["HEAD:g.txt:1:" + HEAD_MARKER + " HEAD"].join("\n");
    const hits = parseGitGrepOutput(stdout, "HEAD");
    expect(hits).toEqual([
      { path: "g.txt", line: 1, text: `${HEAD_MARKER} HEAD` },
    ]);
  });

  it("does not strip a rev prefix when none was supplied", () => {
    // Without `rev`, a literal `HEAD:` in the path (however unlikely) is
    // left alone rather than guessed at.
    const stdout = ["HEAD:g.txt:1:" + HEAD_MARKER].join("\n");
    const hits = parseGitGrepOutput(stdout);
    expect(hits[0].path).toBe("HEAD:g.txt");
  });

  it("classifies an unparsable line as blocking via the (unparsed) sentinel", () => {
    // No `:<digits>:` field at all — cannot be split into path/line/text.
    const bogus = "not-a-grep-line-without-a-numeric-field";
    const hits = parseGitGrepOutput(bogus);
    expect(hits).toEqual([{ path: "(unparsed)", line: 0, text: bogus }]);
  });

  it("drops blank lines and ignores empty stdout", () => {
    expect(parseGitGrepOutput("")).toEqual([]);
    const stdout = ["", "f.txt:1:" + HEAD_MARKER, ""].join("\n");
    expect(parseGitGrepOutput(stdout)).toEqual([
      { path: "f.txt", line: 1, text: HEAD_MARKER },
    ]);
  });

  it("splits non-greedily on the path so a colon in the text is preserved", () => {
    const stdout = ["f.txt:3:" + HEAD_MARKER + " label: extra"].join("\n");
    const hits = parseGitGrepOutput(stdout);
    expect(hits).toEqual([
      { path: "f.txt", line: 3, text: `${HEAD_MARKER} label: extra` },
    ]);
  });
});

describe(parseTouchedFiles, () => {
  it("dedupes repeated paths across both -m parents", () => {
    const stdout = ["a.txt", "b.txt", "a.txt"].join("\n");
    expect(parseTouchedFiles(stdout)).toEqual(["a.txt", "b.txt"]);
  });

  it("drops blank lines", () => {
    const stdout = ["", "a.txt", "", "", "b.txt", ""].join("\n");
    expect(parseTouchedFiles(stdout)).toEqual(["a.txt", "b.txt"]);
  });

  it("returns an empty array for empty stdout", () => {
    expect(parseTouchedFiles("")).toEqual([]);
  });
});

describe(partitionHits, () => {
  it("splits in-scope hits into blocking and out-of-scope hits into preExisting", () => {
    const hits: MarkerHit[] = [
      { path: "touched.txt", line: 1, text: HEAD_MARKER },
      { path: "untouched.txt", line: 5, text: TAIL_MARKER },
    ];
    const { blocking, preExisting } = partitionHits(
      hits,
      new Set(["touched.txt"]),
    );
    expect(blocking).toEqual([hits[0]]);
    expect(preExisting).toEqual([hits[1]]);
  });

  it("always treats an unparsed hit as blocking regardless of scope", () => {
    const hits: MarkerHit[] = [{ path: "(unparsed)", line: 0, text: "???" }];
    const { blocking, preExisting } = partitionHits(hits, new Set());
    expect(blocking).toEqual(hits);
    expect(preExisting).toEqual([]);
  });
});

describe(formatHits, () => {
  it("formats one <label> <path>:<line>: <text> line per hit, in order", () => {
    const hits: MarkerHit[] = [
      { path: "a.txt", line: 1, text: HEAD_MARKER },
      { path: "b.txt", line: 9, text: TAIL_MARKER },
    ];
    expect(formatHits(hits, "BLOCKING")).toEqual([
      `BLOCKING a.txt:1: ${HEAD_MARKER}`,
      `BLOCKING b.txt:9: ${TAIL_MARKER}`,
    ]);
  });

  it("returns an empty array for no hits", () => {
    expect(formatHits([], "BLOCKING")).toEqual([]);
  });
});
