/**
 * Tests for flow-fetch-pr-review.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildReplyIndex,
  formatComment,
  formatLineRef,
  groupByFile,
  parseNdjson,
  parsePrNumber,
  run,
  type GhRunner,
  type ReviewComment,
} from "./flow-fetch-pr-review";
import { readState, writeState } from "./lib/state";

// --- Factories ---

function createComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 1,
    path: "src/index.ts",
    line: 10,
    start_line: null,
    body: "Looks good",
    diff_hunk: "@@ -1,3 +1,3 @@",
    html_url: "https://github.com/owner/repo/pull/1#comment-1",
    user: { login: "reviewer" },
    in_reply_to_id: null,
    ...overrides,
  };
}

// --- Tests ---

describe(parsePrNumber, () => {
  it("should parse a plain number", () => {
    expect(parsePrNumber("42")).toBe(42);
  });

  it("should parse a full GitHub PR URL", () => {
    expect(parsePrNumber("https://github.com/owner/repo/pull/123")).toBe(123);
  });

  it("should throw on invalid input", () => {
    expect(() => parsePrNumber("abc")).toThrow("Invalid PR number or URL");
  });

  it("should throw on zero", () => {
    expect(() => parsePrNumber("0")).toThrow("Invalid PR number or URL");
  });

  it("should throw on negative number", () => {
    expect(() => parsePrNumber("-5")).toThrow("Invalid PR number or URL");
  });
});

describe(parseNdjson, () => {
  it("should parse single JSON object per line", () => {
    const input = '{"a":1}\n{"a":2}\n{"a":3}';
    expect(parseNdjson<{ a: number }>(input)).toEqual([
      { a: 1 },
      { a: 2 },
      { a: 3 },
    ]);
  });

  it("should handle empty string", () => {
    expect(parseNdjson("")).toEqual([]);
  });

  it("should skip blank lines", () => {
    const input = '{"a":1}\n\n{"a":2}\n';
    expect(parseNdjson<{ a: number }>(input)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("should handle single line", () => {
    expect(parseNdjson<{ x: string }>('{"x":"hello"}')).toEqual([
      { x: "hello" },
    ]);
  });
});

describe(groupByFile, () => {
  it("should group top-level comments by file path", () => {
    const comments = [
      createComment({ id: 1, path: "a.ts", line: 1 }),
      createComment({ id: 2, path: "b.ts", line: 5 }),
      createComment({ id: 3, path: "a.ts", line: 10 }),
    ];

    const grouped = groupByFile(comments);

    expect(grouped.size).toBe(2);
    expect(grouped.get("a.ts")).toHaveLength(2);
    expect(grouped.get("b.ts")).toHaveLength(1);
  });

  it("should exclude reply comments", () => {
    const comments = [
      createComment({ id: 1, path: "a.ts" }),
      createComment({ id: 2, path: "a.ts", in_reply_to_id: 1 }),
    ];

    const grouped = groupByFile(comments);

    expect(grouped.get("a.ts")).toHaveLength(1);
    expect(grouped.get("a.ts")![0].id).toBe(1);
  });

  it("should return empty map for no comments", () => {
    expect(groupByFile([]).size).toBe(0);
  });
});

describe(buildReplyIndex, () => {
  it("should index replies by parent comment ID", () => {
    const comments = [
      createComment({ id: 1 }),
      createComment({ id: 2, in_reply_to_id: 1 }),
      createComment({ id: 3, in_reply_to_id: 1 }),
    ];

    const index = buildReplyIndex(comments);

    expect(index.get(1)).toHaveLength(2);
    expect(index.get(1)!.map((c) => c.id)).toEqual([2, 3]);
  });

  it("should skip top-level comments", () => {
    const comments = [createComment({ id: 1 }), createComment({ id: 2 })];

    const index = buildReplyIndex(comments);

    expect(index.size).toBe(0);
  });

  it("should return empty map for no comments", () => {
    expect(buildReplyIndex([]).size).toBe(0);
  });
});

describe(formatLineRef, () => {
  it("should format single line reference", () => {
    expect(formatLineRef(createComment({ line: 42 }))).toBe("L42");
  });

  it("should format line range", () => {
    expect(formatLineRef(createComment({ start_line: 10, line: 20 }))).toBe(
      "L10-L20",
    );
  });

  it("should return file-level when no line info", () => {
    expect(formatLineRef(createComment({ line: null, start_line: null }))).toBe(
      "file-level",
    );
  });
});

describe(formatComment, () => {
  it("should format a comment without replies", () => {
    const comment = createComment({ id: 1, line: 42, body: "Fix this" });
    const result = formatComment(comment, new Map());

    expect(result).toContain("#### L42 — @reviewer");
    expect(result).toContain("Fix this");
  });

  it("should surface the numeric comment id on a labelled line", () => {
    const comment = createComment({ id: 123456789, line: 42 });
    const result = formatComment(comment, new Map());

    expect(result).toContain("**Comment ID:** 123456789");
  });

  it("should include replies as blockquotes", () => {
    const comment = createComment({ id: 1, body: "Fix this" });
    const reply = createComment({
      id: 2,
      in_reply_to_id: 1,
      body: "Done",
      user: { login: "author" },
    });
    const index = buildReplyIndex([comment, reply]);

    const result = formatComment(comment, index);

    expect(result).toContain("> **@author:** Done");
  });

  it("should NOT surface a Comment ID line for reply sub-blocks", () => {
    // The code comment at flow-fetch-pr-review.ts L191-192 claims the
    // `**Comment ID:**` line is emitted only for top-level comments —
    // the reply's own id is intentionally omitted. Pin that claim so a
    // regression that hoisted the push inside the reply loop is caught.
    const comment = createComment({ id: 1, body: "Fix this" });
    const reply = createComment({
      id: 99,
      in_reply_to_id: 1,
      body: "Done",
      user: { login: "author" },
    });
    const index = buildReplyIndex([comment, reply]);

    const result = formatComment(comment, index);

    expect(result).toContain("**Comment ID:** 1");
    expect(result).not.toContain("**Comment ID:** 99");
  });

  it("should handle multiline reply bodies", () => {
    const comment = createComment({ id: 1 });
    const reply = createComment({
      id: 2,
      in_reply_to_id: 1,
      body: "Line one\nLine two\nLine three",
      user: { login: "bob" },
    });
    const index = buildReplyIndex([comment, reply]);

    const result = formatComment(comment, index);

    expect(result).toContain("> **@bob:** Line one");
    expect(result).toContain("> Line two");
    expect(result).toContain("> Line three");
  });
});

describe("run()", () => {
  let stateDir!: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-fetch-pr-review-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    logSpy.mockRestore();
  });

  function seedState(slug: string, phase: string, pr?: number): void {
    writeState(
      {
        slug,
        phase,
        repo: "/tmp/repo",
        ...(pr !== undefined ? { pr } : {}),
        updatedAt: "2026-01-01T00:00:00Z",
      },
      stateDir,
    );
  }

  /** A minimal hermetic `gh` runner satisfying every call `run()` makes:
   * `fetchPr`, `fetchReviews`, `fetchComments`, `fetchChangedFiles`. */
  function makeGh(prNumber: number): GhRunner {
    const prJson = JSON.stringify({
      title: "Fix bug",
      html_url: `https://github.com/o/r/pull/${prNumber}`,
      number: prNumber,
      state: "OPEN",
      body: "",
      additions: 1,
      deletions: 0,
      changed_files: 1,
      head: { ref: "feature" },
    });
    return (args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return "";
      if (args[0] === "api" && args.includes("--paginate")) return "";
      if (args[0] === "api") return prJson;
      throw new Error(`unexpected gh call in test: gh ${args.join(" ")}`);
    };
  }

  it("prints help and returns 0 without touching gh when no args are given", () => {
    const gh = vi.fn(() => {
      throw new Error("gh should not be called");
    });
    const exit = run([], { gh });
    expect(exit).toBe(0);
    expect(gh).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "Usage: flow-fetch-pr-review",
    );
  });

  it("advances a matching pipeline's phase to reviewing after a successful fetch", () => {
    seedState("s1", "ci-wait", 100);
    const exit = run(["100"], {
      gh: makeGh(100),
      resolveSlug: () => "s1",
      stateDir,
    });
    expect(exit).toBe(0);
    const state = readState("s1", stateDir);
    expect(state?.phase).toBe("reviewing");
    expect(state?.phaseLog).toHaveLength(1);
  });

  it("does not write when state.pr differs (the FLOW_SLUG-leak case)", () => {
    seedState("s2", "ci-wait", 999);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["100"], {
      gh: makeGh(100),
      resolveSlug: () => "s2",
      stateDir,
    });
    expect(exit).toBe(0);
    expect(readState("s2", stateDir)?.phase).toBe("ci-wait");
    expect(errSpy.mock.calls.flat().join("\n")).toContain(
      "NOTICE — phase-advance",
    );
    errSpy.mockRestore();
  });

  it("does not write and does not crash when no state file exists (standalone invocation)", () => {
    const exit = run(["100"], {
      gh: makeGh(100),
      resolveSlug: () => "ghost-slug",
      stateDir,
    });
    expect(exit).toBe(0);
    expect(fs.readdirSync(stateDir)).toHaveLength(0);
  });
});
