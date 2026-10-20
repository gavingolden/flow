import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
      skipped: 0,
      skippedAt: [],
      repeatedAt: [],
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
      skipped: 0,
      skippedAt: [],
      repeatedAt: [],
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

  it("parses dedupe only as the first token with a lone PR", () => {
    expect(parseArgs(["dedupe", "100"])).toEqual({
      kind: "dedupe",
      prArg: "100",
    });
    for (const argv of [
      ["dedupe", "100", "--file", "f.json"],
      ["dedupe", "100", "--head-sha", SHA],
      ["dedupe"],
      ["100", "dedupe"],
    ]) {
      expect(parseArgs(argv).kind).toBe("error");
    }
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
      env: {},
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
      if (argv.includes("--paginate")) {
        return { stdout: "", stderr: "", exitCode: 0 };
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
      env: {},
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
      env: {},
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

type GhArgs = Array<[string[]]>;
const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
const ndjson = (...rows: object[]) =>
  rows.map((r) => JSON.stringify(r)).join("\n");
const comment = (over: object) => ({
  id: 1,
  path: "a.ts",
  line: 1,
  original_line: 1,
  start_line: null,
  original_start_line: null,
  side: "RIGHT",
  body: "x",
  user: "me",
  in_reply_to_id: null,
  ...over,
});

function silent<T>(fn: () => Promise<T>): Promise<{ out: string[]; v: T }> {
  const out: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((m) => {
    out.push(String(m));
  });
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  return fn().then((v) => {
    log.mockRestore();
    err.mockRestore();
    return { out, v };
  });
}

describe("run() idempotent posting", () => {
  const findingsFile = (...f: object[]) => vi.fn(async () => JSON.stringify(f));

  it("skips a finding already on the PR and counts it", async () => {
    const gh = vi.fn((argv: string[]) =>
      argv.includes("--paginate") ? ok(ndjson(comment({}))) : ok(),
    );
    const { out, v } = await silent(() =>
      run(["100", "--file", "f.json", "--head-sha", SHA], {
        gh,
        env: {},
        readFile: findingsFile({ file: "a.ts", line: 1, body: "x\n" }),
      }),
    );
    expect(v).toBe(0);
    expect(out.join("\n")).toContain("SKIP  a.ts:1 (already on PR)");
    const posts = (gh.mock.calls as unknown as GhArgs).filter((c) =>
      c[0].includes("-f"),
    );
    expect(posts).toHaveLength(0);
  });

  it("posts an in-batch duplicate once", async () => {
    const gh = vi.fn(() => ok());
    const f = { file: "a.ts", line: 3, body: "dup" };
    const { v, out } = await silent(() =>
      run(["100", "--file", "f.json", "--head-sha", SHA], {
        gh,
        env: {},
        readFile: findingsFile(f, f),
      }),
    );
    expect(v).toBe(0);
    const posts = (gh.mock.calls as unknown as GhArgs).filter((c) =>
      c[0].includes("-f"),
    );
    expect(posts).toHaveLength(1);
    const text = out.join("\n");
    expect(text).toContain("SKIP  a.ts:3 (repeated in this batch)");
    expect(text).not.toContain("already on PR");
  });

  it("posts nothing and exits 1 when the existing-comment read fails", async () => {
    const gh = vi.fn((argv: string[]) =>
      argv.includes("--paginate")
        ? { stdout: "", stderr: "HTTP 502", exitCode: 1 }
        : ok(),
    );
    const { v } = await silent(() =>
      run(["100", "--file", "f.json", "--head-sha", SHA], {
        gh,
        env: {},
        readFile: findingsFile({ file: "a.ts", line: 1, body: "x" }),
      }),
    );
    expect(v).toBe(1);
    const posts = (gh.mock.calls as unknown as GhArgs).filter((c) =>
      c[0].includes("-f"),
    );
    expect(posts).toHaveLength(0);
  });

  it("matches a multi-line finding against GitHub's start_line/line response", async () => {
    const gh = vi.fn((argv: string[]) =>
      argv.includes("--paginate")
        ? ok(ndjson(comment({ line: 8, start_line: 5, body: "range" })))
        : ok(),
    );
    const { out } = await silent(() =>
      run(["100", "--file", "f.json", "--head-sha", SHA], {
        gh,
        env: {},
        readFile: findingsFile({
          file: "a.ts",
          line: 5,
          end_line: 8,
          body: "range",
        }),
      }),
    );
    expect(out.join("\n")).toContain("SKIP  a.ts:5");
  });

  it("parses a two-page NDJSON response and matches an outdated comment", async () => {
    const page1 = Array.from({ length: 30 }, (_, i) =>
      comment({
        id: i + 1,
        line: i + 10,
        original_line: i + 10,
        body: `b${i}`,
      }),
    );
    const page2 = [
      comment({ id: 99, line: null, original_line: 2, body: "old" }),
    ];
    const gh = vi.fn((argv: string[]) =>
      argv.includes("--paginate") ? ok(ndjson(...page1, ...page2)) : ok(),
    );
    const { out } = await silent(() =>
      run(["100", "--file", "f.json", "--head-sha", SHA], {
        gh,
        env: {},
        readFile: findingsFile({ file: "a.ts", line: 2, body: "old" }),
      }),
    );
    expect(out.join("\n")).toContain("SKIP  a.ts:2");
  });
});

describe("run() dedupe", () => {
  const FLOW = "**issue (non-blocking):** dup";
  it("keeps the oldest, deletes newer same-author dupes, leaves others alone", async () => {
    const rows = [
      comment({ id: 1, body: FLOW }),
      comment({ id: 2, body: FLOW }),
      comment({ id: 3, body: FLOW }),
      comment({ id: 4, body: FLOW, user: "someone-else" }),
      comment({ id: 5, body: "hand written", user: "me" }),
      comment({ id: 6, body: "hand written", user: "me" }),
    ];
    const gh = vi.fn((argv: string[]) => {
      if (argv[1] === "user") return ok("me\n");
      if (argv.includes("--paginate")) return ok(ndjson(...rows));
      return ok();
    });
    const { out, v } = await silent(() =>
      run(["dedupe", "100"], { gh, env: {} }),
    );
    expect(v).toBe(0);
    const deletes = (gh.mock.calls as unknown as GhArgs)
      .filter((c) => c[0].includes("DELETE"))
      .map((c) => c[0][c[0].length - 1]);
    expect(deletes).toEqual([
      "repos/{owner}/{repo}/pulls/comments/2",
      "repos/{owner}/{repo}/pulls/comments/3",
    ]);
    expect(JSON.parse(out[0])).toEqual({
      pr: 100,
      kept: 1,
      deleted: [2, 3],
      skippedWithReplies: [],
      failed: [],
    });
  });

  it("keeps a duplicate that has a reply, reporting it", async () => {
    const rows = [
      comment({ id: 1, body: FLOW }),
      comment({ id: 2, body: FLOW }),
      comment({ id: 3, body: "reply", in_reply_to_id: 2, user: "other" }),
    ];
    const gh = vi.fn((argv: string[]) => {
      if (argv[1] === "user") return ok("me");
      if (argv.includes("--paginate")) return ok(ndjson(...rows));
      return ok();
    });
    const { out, v } = await silent(() =>
      run(["dedupe", "100"], { gh, env: {} }),
    );
    expect(v).toBe(0);
    expect(JSON.parse(out[0]).skippedWithReplies).toEqual([2]);
    expect(
      (gh.mock.calls as unknown as GhArgs).some((c) => c[0].includes("DELETE")),
    ).toBe(false);
  });

  it("recognises the intent annotation shape", async () => {
    const body = "**why:** because\n\n<!-- flow-intent-v1 -->";
    const gh = vi.fn((argv: string[]) => {
      if (argv[1] === "user") return ok("me");
      if (argv.includes("--paginate"))
        return ok(ndjson(comment({ id: 1, body }), comment({ id: 2, body })));
      return ok();
    });
    const { out } = await silent(() => run(["dedupe", "100"], { gh, env: {} }));
    expect(JSON.parse(out[0]).deleted).toEqual([2]);
  });

  it("exits 1 and deletes nothing when the gh user lookup fails", async () => {
    const gh = vi.fn((argv: string[]) =>
      argv[1] === "user"
        ? { stdout: "", stderr: "HTTP 401", exitCode: 1 }
        : ok(
            ndjson(
              comment({ id: 1, body: FLOW }),
              comment({ id: 2, body: FLOW }),
            ),
          ),
    );
    const { v } = await silent(() => run(["dedupe", "100"], { gh, env: {} }));
    expect(v).toBe(1);
    expect(
      (gh.mock.calls as unknown as GhArgs).some((c) => c[0].includes("DELETE")),
    ).toBe(false);
  });

  it("reports a failed DELETE in failed[] and exits 1", async () => {
    const gh = vi.fn((argv: string[]) => {
      if (argv[1] === "user") return ok("me");
      if (argv.includes("--paginate"))
        return ok(
          ndjson(
            comment({ id: 1, body: FLOW }),
            comment({ id: 2, body: FLOW }),
            comment({ id: 3, body: FLOW }),
          ),
        );
      if (argv.includes("DELETE") && argv[argv.length - 1].endsWith("/2"))
        return { stdout: "", stderr: "HTTP 403", exitCode: 1 };
      return ok();
    });
    const { out, v } = await silent(() =>
      run(["dedupe", "100"], { gh, env: {} }),
    );
    expect(v).toBe(1);
    const report = JSON.parse(out[0]);
    expect(report.deleted).toEqual([3]);
    expect(report.failed).toEqual([{ id: 2, error: "HTTP 403" }]);
  });

  it("exits 2 on --file, --head-sha or dedupe not first", async () => {
    for (const argv of [
      ["dedupe", "100", "--file", "f.json"],
      ["dedupe", "100", "--head-sha", SHA],
      ["100", "dedupe"],
    ]) {
      const { v } = await silent(() => run(argv, { gh: vi.fn(), env: {} }));
      expect(v).toBe(2);
    }
  });
});

describe("run() own-PR check", () => {
  it("refuses a PR that is not the pipeline's own, posting nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fpf-own-"));
    fs.writeFileSync(
      path.join(dir, "slug-a.json"),
      JSON.stringify({
        slug: "slug-a",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-22T11:00:00Z",
        pr: 5,
      }),
    );
    const gh = vi.fn(() => ok());
    const deps = { gh, env: { FLOW_SLUG: "slug-a" }, stateDir: dir };
    const refused = await silent(() =>
      run(["6", "--file", "f.json"], {
        ...deps,
        readFile: async () => "[]",
      }),
    );
    const refusedDedupe = await silent(() => run(["dedupe", "6"], deps));
    fs.rmSync(dir, { recursive: true, force: true });
    expect(refused.v).toBe(2);
    expect(refusedDedupe.v).toBe(2);
    expect(gh).not.toHaveBeenCalled();
  });
});
