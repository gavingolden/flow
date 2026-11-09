import { describe, expect, it } from "vitest";
import {
  EXPECTED_PNG,
  checkTreeFrame,
  lastTreeFrame,
  pngSize,
  svgShell,
} from "../docs/demo/tmux-tree-check";

const SEP = "─".repeat(80);
const ROWS = [
  "(0) - flow: 6 windows (attached)",
  "(1) ├─> + 0:   feat web-app    new-logo               —              #11    merged   New logo",
  "(2) ├─> + 1: ! feat web-app    fix-typo               —              #12    gated    Typo fix",
  "(3) ├─> + 2: ! feat api        add-csv-export         —              —      plan?    CSV export",
  "(4) ├─> + 3:   feat web-app    add-search             —              —      impl     Search",
  "(5) ├─> + 4:   feat web-app    add-dark-mode          —              —      start    add-dark-mode",
  "(6) └─> + 5:   feat api        fix-login-bug          —              —      start    fix-login-bug",
];
const STATUS =
  "[flow] 0:New logo  1:Typo fix  2:CSV export  3:Search  4:add-dark-mode  5:fix-login-bug*";
const logOf = (rows: string[]) =>
  [
    "$ tmux attach -t flow",
    SEP,
    ...rows,
    "",
    "",
    "",
    "",
    "",
    STATUS,
    SEP,
    "$ ",
  ].join("\n");

describe("checkTreeFrame", () => {
  it("should pass a real six-row frame", () => {
    expect(checkTreeFrame(logOf(ROWS))).toEqual([]);
  });

  it("should fail when a row is dropped", () => {
    const rows = ROWS.filter((_, i) => i !== 4);
    rows[0] = rows[0].replace("6 windows", "5 windows");
    expect(checkTreeFrame(logOf(rows)).join("\n")).toContain(
      "expected 6 window rows, found 5",
    );
  });

  it("should fail when the flag is removed from fix-typo", () => {
    const rows = [...ROWS];
    rows[2] = rows[2].replace("1: !", "1:  ");
    expect(checkTreeFrame(logOf(rows)).join("\n")).toContain("fix-typo: flag");
  });

  it("should fail when the PR column shifts on fix-typo", () => {
    const rows = [...ROWS];
    rows[2] = rows[2].replace("—              #12", "—                #12");
    expect(checkTreeFrame(logOf(rows)).join("\n")).toContain("fix-typo: pr");
  });

  it("should fail when only a no-PR row shifts", () => {
    const rows = [...ROWS];
    rows[4] = rows[4].replace("—      impl", "—        impl");
    expect(checkTreeFrame(logOf(rows)).join("\n")).toContain("add-search");
  });

  it("should still pass with ANSI colour escapes around the flag", () => {
    const rows = [...ROWS];
    rows[2] = rows[2].replace("!", "\x1b[33m!\x1b[39m");
    expect(checkTreeFrame(logOf(rows))).toEqual([]);
  });

  it("should fail when the log has no tree frame", () => {
    expect(checkTreeFrame(`$ ls\n${SEP}\n$ `).join("\n")).toContain(
      "no tree frame",
    );
  });

  it("should name the four places to update on drift", () => {
    const rows = ROWS.filter((_, i) => i !== 4);
    expect(checkTreeFrame(logOf(rows)).join("\n")).toContain(
      "docs/demo/tmux-tree-check.ts",
    );
  });
});

describe("lastTreeFrame", () => {
  it("should pick the last tree frame", () => {
    const first = logOf(ROWS.map((r) => r.replace("Search", "Old   ")));
    const log = `${first}\n${SEP}\n${logOf(ROWS)}\n${SEP}\n$ done`;
    expect(lastTreeFrame(log)).toContain(ROWS[4]);
    expect(lastTreeFrame(log)).not.toContain(
      ROWS[4].replace("Search", "Old   "),
    );
  });

  it("should return nothing when no frame has a tree", () => {
    expect(lastTreeFrame("$ ls")).toEqual([]);
  });
});

describe("pngSize", () => {
  const header = (w: number, h: number) => {
    const b = new Uint8Array(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const v = new DataView(b.buffer);
    v.setUint32(16, w);
    v.setUint32(20, h);
    return b;
  };

  it("should read width and height from the IHDR", () => {
    expect(pngSize(header(1100, 300))).toEqual(EXPECTED_PNG);
  });

  it("should read a view with a non-zero byteOffset", () => {
    const big = new Uint8Array(40);
    big.set(header(1100, 300), 7);
    expect(pngSize(big.subarray(7))).toEqual(EXPECTED_PNG);
  });

  it("should throw on a non-PNG buffer", () => {
    expect(() => pngSize(new Uint8Array(24))).toThrow(/PNG/);
  });
});

describe("svgShell", () => {
  const svg = (payload: string, cx: number) =>
    `<image href="data:image/png;base64,${payload}"/><circle cx="${cx}"/>`;

  it("should mask only the base64 payload", () => {
    expect(svgShell(svg("AAAA", 5))).toBe(svgShell(svg("BBBB", 5)));
    expect(svgShell(svg("AAAA", 5))).not.toBe(svgShell(svg("AAAA", 6)));
  });
});
