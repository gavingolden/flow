import { describe, expect, it, vi } from "vitest";
import { capDiff, parseArgs, run, splitIntoBlocks, type GhRunner } from "./flow-pr-diff";

// --- Fixtures ---

function makeFileBlock(path: string, lineCount: number): string {
  const header = [
    `diff --git a/${path} b/${path}`,
    `index abc..def 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${lineCount} +1,${lineCount} @@`,
  ];
  const body = Array.from({ length: lineCount }, (_, i) => ` line ${i + 1}`);
  return [...header, ...body].join("\n");
}

const SMALL_BLOCK = makeFileBlock("src/small.ts", 10);
const LARGE_BLOCK = makeFileBlock("src/large.ts", 2000);

// --- splitIntoBlocks ---

describe(splitIntoBlocks, () => {
  it("returns no blocks when input has no diff --git markers", () => {
    expect(splitIntoBlocks("")).toEqual({ preamble: [], blocks: [] });
    expect(splitIntoBlocks("just some text\nno diff here")).toEqual({
      preamble: ["just some text", "no diff here"],
      blocks: [],
    });
  });

  it("splits a single-file diff into one block", () => {
    const { preamble, blocks } = splitIntoBlocks(SMALL_BLOCK + "\n");
    expect(preamble).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0][0]).toBe("diff --git a/src/small.ts b/src/small.ts");
  });

  it("splits a multi-file diff at each diff --git marker", () => {
    const a = makeFileBlock("a.ts", 5);
    const b = makeFileBlock("b.ts", 5);
    const c = makeFileBlock("c.ts", 5);
    const { blocks } = splitIntoBlocks([a, b, c].join("\n") + "\n");
    expect(blocks).toHaveLength(3);
    expect(blocks[0][0]).toBe("diff --git a/a.ts b/a.ts");
    expect(blocks[1][0]).toBe("diff --git a/b.ts b/b.ts");
    expect(blocks[2][0]).toBe("diff --git a/c.ts b/c.ts");
  });

  it("captures preamble lines that precede the first diff --git", () => {
    const input = "preamble line\nanother preamble\n" + SMALL_BLOCK + "\n";
    const { preamble, blocks } = splitIntoBlocks(input);
    expect(preamble).toEqual(["preamble line", "another preamble"]);
    expect(blocks).toHaveLength(1);
  });
});

// --- capDiff ---

describe(capDiff, () => {
  it("returns empty string for empty input", () => {
    expect(capDiff("", 300, 5000, 100)).toBe("");
  });

  it("returns input verbatim when no diff --git markers are present", () => {
    expect(capDiff("not a diff", 300, 5000, 100)).toBe("not a diff");
  });

  it("returns small files unchanged with a trailing newline preserved", () => {
    const input = SMALL_BLOCK + "\n";
    expect(capDiff(input, 300, 5000, 100)).toBe(input);
  });

  it("caps a large file with head + marker + tail", () => {
    const input = LARGE_BLOCK + "\n";
    const output = capDiff(input, 300, 5000, 42);
    const lines = output.split("\n");
    // Drop final empty (from trailing newline).
    if (lines[lines.length - 1] === "") lines.pop();

    // First line is still the diff --git header.
    expect(lines[0]).toBe("diff --git a/src/large.ts b/src/large.ts");
    // Marker is on its own line and references the full-diff escape hatch.
    const markerIdx = lines.findIndex((l) => l.startsWith("... [truncated"));
    expect(markerIdx).toBeGreaterThan(0);
    expect(lines[markerIdx]).toContain("gh pr diff 42");
    // Truncated count = original 2005 lines (5 header + 2000 body) - 200 head - 100 tail.
    expect(lines[markerIdx]).toContain("truncated 1705 lines");
    // Total kept is 200 head + 1 marker + 100 tail = 301.
    expect(lines.length).toBe(301);
  });

  it("preserves small files when a sibling large file is truncated", () => {
    const input = SMALL_BLOCK + "\n" + LARGE_BLOCK + "\n";
    const output = capDiff(input, 300, 5000, 99);
    const blocks = output.split(/(?=^diff --git )/m);
    expect(blocks).toHaveLength(2);
    // Small block round-trips byte-for-byte (modulo trailing newline).
    expect(blocks[0].trimEnd()).toBe(SMALL_BLOCK);
    // Large block has the marker.
    expect(blocks[1]).toContain("... [truncated");
  });

  it("disables per-file capping when maxLines is 0", () => {
    const input = LARGE_BLOCK + "\n";
    const output = capDiff(input, 0, 0, 1);
    expect(output).toBe(input);
  });

  it("enforces maxTotal by dropping trailing files with a footer", () => {
    // Three files, each ~10 lines (~30 lines total). maxTotal=15 forces truncation
    // after the first file (which is ~10 lines), since adding the second would exceed 15.
    const a = makeFileBlock("a.ts", 5);
    const b = makeFileBlock("b.ts", 5);
    const c = makeFileBlock("c.ts", 5);
    const input = [a, b, c].join("\n") + "\n";
    const output = capDiff(input, 0, 15, 7);

    expect(output).toContain("a/a.ts");
    expect(output).not.toContain("a/b.ts");
    expect(output).not.toContain("a/c.ts");
    expect(output).toContain("[2 additional file(s) omitted; full diff: gh pr diff 7]");
  });

  it("always keeps at least one file even when its size exceeds maxTotal", () => {
    // A single 50-line block with maxTotal=10 — we still include the file (capped per
    // maxLines), otherwise the output would be just a footer and useless.
    const input = makeFileBlock("solo.ts", 50) + "\n";
    const output = capDiff(input, 0, 10, 1);
    expect(output).toContain("a/solo.ts");
    expect(output).not.toContain("additional file(s) omitted");
  });

  it("places the truncation marker outside @@ ... @@ hunk headers", () => {
    const input = LARGE_BLOCK + "\n";
    const output = capDiff(input, 300, 5000, 1);
    const markerLine = output
      .split("\n")
      .find((l) => l.startsWith("... [truncated"));
    expect(markerLine).toBeDefined();
    // The marker should not be inside a hunk header (no @@ prefix on its own line).
    expect(markerLine!.startsWith("@@")).toBe(false);
  });

  it("produces a valid round-trip when nothing needs capping", () => {
    const input = SMALL_BLOCK + "\n";
    expect(capDiff(input, 300, 5000, 1)).toBe(input);
  });
});

// --- parseArgs ---

describe(parseArgs, () => {
  it("returns a help marker for --help / -h", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
  });

  it("parses a bare PR number with defaults", () => {
    expect(parseArgs(["42"])).toEqual({
      prNumber: 42,
      maxLines: 300,
      maxTotal: 5000,
    });
  });

  it("parses --max-lines and --max-total overrides", () => {
    expect(parseArgs(["7", "--max-lines", "500", "--max-total", "10000"])).toEqual({
      prNumber: 7,
      maxLines: 500,
      maxTotal: 10000,
    });
  });

  it("accepts 0 to disable the per-file cap", () => {
    const r = parseArgs(["7", "--max-lines", "0"]);
    expect("error" in r).toBe(false);
    expect((r as { maxLines: number }).maxLines).toBe(0);
  });

  it("rejects a missing PR number", () => {
    const r = parseArgs([]);
    expect("error" in r && r.error).toBe("<pr-number> is required");
  });

  it("rejects a non-numeric PR argument", () => {
    const r = parseArgs(["foo"]);
    expect("error" in r && r.error?.includes("invalid PR number")).toBe(true);
  });

  it("rejects unknown flags", () => {
    const r = parseArgs(["7", "--unknown"]);
    expect("error" in r && r.error?.includes("unknown flag")).toBe(true);
  });

  it("rejects extra positional arguments", () => {
    const r = parseArgs(["7", "8"]);
    expect("error" in r && r.error?.includes("unexpected extra argument")).toBe(true);
  });
});

// --- run integration ---

describe(run, () => {
  it("exits 0 and writes capped diff on success", () => {
    const gh: GhRunner = vi.fn().mockReturnValue({
      stdout: SMALL_BLOCK + "\n",
      stderr: "",
      exitCode: 0,
    });
    const writes: string[] = [];
    const errs: string[] = [];
    const exit = run(["7"], {
      gh,
      writeOut: (s) => writes.push(s),
      writeErr: (s) => errs.push(s),
    });
    expect(exit).toBe(0);
    expect(writes.join("")).toBe(SMALL_BLOCK + "\n");
    expect(errs).toEqual([]);
    expect(gh).toHaveBeenCalledWith(["pr", "diff", "7"]);
  });

  it("exits 1 with stderr message when gh fails", () => {
    const gh: GhRunner = vi.fn().mockReturnValue({
      stdout: "",
      stderr: "GraphQL: Could not resolve to a PullRequest",
      exitCode: 1,
    });
    const errs: string[] = [];
    const exit = run(["7"], { gh, writeOut: () => {}, writeErr: (s) => errs.push(s) });
    expect(exit).toBe(1);
    expect(errs.join("")).toContain("GraphQL: Could not resolve");
  });

  it("exits 2 on argument-parse errors", () => {
    const errs: string[] = [];
    const exit = run([], { writeOut: () => {}, writeErr: (s) => errs.push(s) });
    expect(exit).toBe(2);
    expect(errs.join("")).toContain("<pr-number> is required");
  });
});
