import { describe, expect, it, vi } from "vitest";
import {
  buildPostArgv,
  fetchHeadSha,
  formatSummary,
  parseArgs,
  parseFindings,
  postAll,
  run,
  type Finding,
  type PostSummary,
} from "./flow-post-findings";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe(parseFindings, () => {
  it("parses a single-line finding", () => {
    const input = JSON.stringify([
      { file: "src/a.ts", line: 10, body: "issue" },
    ]);
    expect(parseFindings(input)).toEqual([
      { file: "src/a.ts", line: 10, body: "issue" },
    ]);
  });

  it("parses a multi-line range", () => {
    const input = JSON.stringify([
      { file: "a.ts", line: 5, end_line: 12, body: "x" },
    ]);
    expect(parseFindings(input)).toEqual([
      { file: "a.ts", line: 5, end_line: 12, body: "x" },
    ]);
  });

  it("collapses end_line == line into a single-line finding", () => {
    const input = JSON.stringify([
      { file: "a.ts", line: 5, end_line: 5, body: "x" },
    ]);
    expect(parseFindings(input)).toEqual([
      { file: "a.ts", line: 5, body: "x" },
    ]);
  });

  it("accepts side=LEFT/RIGHT", () => {
    const input = JSON.stringify([
      { file: "a.ts", line: 1, side: "LEFT", body: "x" },
    ]);
    expect(parseFindings(input)).toEqual([
      { file: "a.ts", line: 1, side: "LEFT", body: "x" },
    ]);
  });

  it("accepts `path` as an alias for `file`", () => {
    const input = JSON.stringify([{ path: "src/a.ts", line: 1, body: "x" }]);
    expect(parseFindings(input)).toEqual([
      { file: "src/a.ts", line: 1, body: "x" },
    ]);
  });

  it("throws on non-array input", () => {
    expect(() => parseFindings('{"file":"a.ts"}')).toThrow(
      "must be a JSON array",
    );
  });

  it("throws on invalid JSON", () => {
    expect(() => parseFindings("not json")).toThrow("Invalid JSON input");
  });

  it("throws when file is missing", () => {
    expect(() =>
      parseFindings(JSON.stringify([{ line: 1, body: "x" }])),
    ).toThrow('Entry 0: "file" must be a non-empty string');
  });

  it("throws when line is not a positive integer", () => {
    expect(() =>
      parseFindings(JSON.stringify([{ file: "a.ts", line: 0, body: "x" }])),
    ).toThrow('Entry 0: "line" must be a positive integer');
    expect(() =>
      parseFindings(JSON.stringify([{ file: "a.ts", line: 1.5, body: "x" }])),
    ).toThrow("positive integer");
  });

  it("throws when body is empty", () => {
    expect(() =>
      parseFindings(JSON.stringify([{ file: "a.ts", line: 1, body: "" }])),
    ).toThrow('Entry 0: "body" must be a non-empty string');
  });

  it("throws when end_line < line", () => {
    expect(() =>
      parseFindings(
        JSON.stringify([{ file: "a.ts", line: 10, end_line: 5, body: "x" }]),
      ),
    ).toThrow('Entry 0: "end_line" must be >= "line"');
  });

  it("throws when side is invalid", () => {
    expect(() =>
      parseFindings(
        JSON.stringify([{ file: "a.ts", line: 1, side: "MIDDLE", body: "x" }]),
      ),
    ).toThrow('"side" must be "LEFT" or "RIGHT"');
  });
});

describe(buildPostArgv, () => {
  it("builds a single-line argv with default RIGHT side", () => {
    const argv = buildPostArgv(100, SHA, {
      file: "src/a.ts",
      line: 42,
      body: "issue",
    });
    expect(argv).toEqual([
      "api",
      "repos/{owner}/{repo}/pulls/100/comments",
      "-f",
      `commit_id=${SHA}`,
      "-f",
      "path=src/a.ts",
      "-F",
      "line=42",
      "-f",
      "side=RIGHT",
      "-f",
      "body=issue",
    ]);
  });

  it("respects an explicit LEFT side", () => {
    const argv = buildPostArgv(100, SHA, {
      file: "a.ts",
      line: 1,
      side: "LEFT",
      body: "removed",
    });
    expect(argv).toContain("side=LEFT");
  });

  it("emits start_line, start_side and shifts line for multi-line ranges", () => {
    // gh's API: line is the *bottom* of the range; start_line is the top.
    const argv = buildPostArgv(100, SHA, {
      file: "a.ts",
      line: 5,
      end_line: 12,
      body: "x",
    });
    expect(argv).toContain("line=12"); // bottom of range
    expect(argv).toContain("start_line=5"); // top
    expect(argv).toContain("start_side=RIGHT");
  });

  it("matches start_side to the explicit side", () => {
    const argv = buildPostArgv(100, SHA, {
      file: "a.ts",
      line: 5,
      end_line: 12,
      side: "LEFT",
      body: "x",
    });
    expect(argv).toContain("start_side=LEFT");
  });
});

describe(fetchHeadSha, () => {
  it("returns the SHA on success", () => {
    const gh = vi.fn(() => ({ stdout: SHA + "\n", stderr: "", exitCode: 0 }));
    expect(fetchHeadSha(100, gh)).toBe(SHA);
    expect(gh).toHaveBeenCalledWith([
      "pr",
      "view",
      "100",
      "--json",
      "headRefOid",
      "-q",
      ".headRefOid",
    ]);
  });

  it("throws on gh failure with stderr", () => {
    const gh = vi.fn(() => ({
      stdout: "",
      stderr: "auth required",
      exitCode: 4,
    }));
    expect(() => fetchHeadSha(100, gh)).toThrow("auth required");
  });

  it("throws on non-SHA stdout", () => {
    const gh = vi.fn(() => ({ stdout: "not-a-sha", stderr: "", exitCode: 0 }));
    expect(() => fetchHeadSha(100, gh)).toThrow("unexpected headRefOid");
  });
});

describe(postAll, () => {
  it("posts each finding and returns a success summary", () => {
    const gh = vi.fn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const findings: Finding[] = [
      { file: "a.ts", line: 1, body: "x" },
      { file: "b.ts", line: 2, body: "y" },
    ];
    const summary = postAll(100, SHA, findings, gh);
    expect(gh).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({
      total: 2,
      succeeded: 2,
      failed: 0,
      results: [
        { file: "a.ts", line: 1, success: true },
        { file: "b.ts", line: 2, success: true },
      ],
    });
  });

  it("continues past individual failures and reports them", () => {
    let call = 0;
    const gh = vi.fn(() => {
      call++;
      if (call === 2)
        return { stdout: "", stderr: "404: not found", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const findings: Finding[] = [
      { file: "a.ts", line: 1, body: "x" },
      { file: "b.ts", line: 2, body: "y" },
      { file: "c.ts", line: 3, body: "z" },
    ];
    const summary = postAll(100, SHA, findings, gh);
    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.results[1]).toEqual({
      file: "b.ts",
      line: 2,
      success: false,
      error: "404: not found",
    });
  });
});

describe(formatSummary, () => {
  it("formats a mixed result", () => {
    const s: PostSummary = {
      total: 2,
      succeeded: 1,
      failed: 1,
      results: [
        { file: "a.ts", line: 1, success: true },
        { file: "b.ts", line: 2, success: false, error: "boom" },
      ],
    };
    const out = formatSummary(s);
    expect(out).toContain("1/2 posted successfully");
    expect(out).toContain("OK    a.ts:1");
    expect(out).toContain("FAIL  b.ts:2: boom");
  });
});

describe(parseArgs, () => {
  it("requires a PR argument", () => {
    expect(parseArgs([])).toEqual({
      kind: "error",
      message: "PR number or URL is required",
    });
  });

  it("rejects an unknown flag", () => {
    expect(parseArgs(["100", "--bogus"])).toEqual({
      kind: "error",
      message: "unknown flag: --bogus",
    });
  });

  it("parses --file and --head-sha", () => {
    expect(parseArgs(["100", "--file", "f.json", "--head-sha", SHA])).toEqual({
      kind: "ok",
      prArg: "100",
      file: "f.json",
      headSha: SHA,
    });
  });

  it("returns help when --help is present", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
  });
});

describe("run() integration", () => {
  it("posts findings from --file and exits 0", async () => {
    const gh = vi.fn((argv: string[]) => {
      if (argv[0] === "pr" && argv[1] === "view") {
        return { stdout: SHA, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const readFile = vi.fn(async () =>
      JSON.stringify([{ file: "a.ts", line: 1, body: "x" }]),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = await run(["100", "--file", "findings.json"], {
      gh,
      readFile,
    });
    logSpy.mockRestore();
    expect(exit).toBe(0);
    expect(readFile).toHaveBeenCalledWith("findings.json");
  });

  it("exits 1 when at least one post fails", async () => {
    let call = 0;
    const gh = vi.fn((argv: string[]) => {
      if (argv[0] === "pr" && argv[1] === "view") {
        return { stdout: SHA, stderr: "", exitCode: 0 };
      }
      call++;
      return call === 1
        ? { stdout: "", stderr: "rate limit", exitCode: 1 }
        : { stdout: "", stderr: "", exitCode: 0 };
    });
    const readFile = vi.fn(async () =>
      JSON.stringify([
        { file: "a.ts", line: 1, body: "x" },
        { file: "b.ts", line: 2, body: "y" },
      ]),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = await run(["100", "--file", "findings.json"], {
      gh,
      readFile,
    });
    logSpy.mockRestore();
    expect(exit).toBe(1);
  });

  it("skips the head-sha lookup when --head-sha is provided", async () => {
    const gh = vi.fn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const readFile = vi.fn(async () =>
      JSON.stringify([{ file: "a.ts", line: 1, body: "x" }]),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = await run(["100", "--file", "f.json", "--head-sha", SHA], {
      gh,
      readFile,
    });
    logSpy.mockRestore();
    expect(exit).toBe(0);
    // No call should be `pr view` — only the comments-post.
    // vi.fn() infers () => Result without arg types, so cast through unknown
    // to recover the (argv: string[]) tuple shape for the assertion.
    const calls = gh.mock.calls as unknown as Array<[string[]]>;
    expect(
      calls.find((c) => c[0][0] === "pr" && c[0][1] === "view"),
    ).toBeUndefined();
  });

  it("returns 0 with 'No findings to post.' on an empty array", async () => {
    const gh = vi.fn();
    const readFile = vi.fn(async () => "[]");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = await run(["100", "--file", "f.json"], { gh, readFile });
    logSpy.mockRestore();
    expect(exit).toBe(0);
    expect(gh).not.toHaveBeenCalled();
  });

  it("returns 2 on a JSON parse error", async () => {
    const readFile = vi.fn(async () => "not-json");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = await run(["100", "--file", "f.json"], {
      gh: vi.fn(),
      readFile,
    });
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });

  it("returns 2 on bad CLI args", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = await run(["--bogus"], { gh: vi.fn(), readFile: vi.fn() });
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });
});
