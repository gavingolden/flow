import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analyzeTranscripts,
  estimateFrontmatterCost,
  estimateStaticCost,
  estimateTokens,
  resolveSessionJsonls,
} from "./lib/transcript-audit";
import { encodeProjectSegment } from "./lib/cost";
import { parseArgs, run } from "./flow-transcript-audit";

const SAMPLE_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "transcript-audit-sample.jsonl",
);
const SCHEMA_BREAK_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "transcript-audit-schema-break.jsonl",
);

/**
 * The expected aggregates pinned below (phaseTotals, carryForwardTotals,
 * toolClassStats, subAgentSpend, editSizeDistribution) were derived by
 * running the real `analyzeTranscripts()` against
 * `bin/fixtures/transcript-audit-sample.jsonl` and reading off its output
 * — not hand-counted. If the fixture is ever hand-edited (e.g. to add a
 * new tool-class or attributionSkill scenario), regenerate the pinned
 * numbers the same way: write a throwaway script that imports
 * `analyzeTranscripts` from `./lib/transcript-audit`, runs it against the
 * updated fixture, and prints the result — then paste the printed values
 * into the `toEqual(...)` blocks below. This keeps the pin honest without
 * committing a permanent generator script for a one-off task.
 */
describe("analyzeTranscripts — synthetic fixture", () => {
  it("returns no-data when zero JSONL paths are given", async () => {
    const result = await analyzeTranscripts([]);
    expect(result).toEqual({ status: "no-data" });
  });

  it("pins per-phase totals — strict headline never carries a null/unrecognized attribution forward", async () => {
    const result = await analyzeTranscripts([SAMPLE_FIXTURE]);
    if (result.status !== "ok")
      throw new Error(`expected ok, got ${result.status}`);
    expect(result.phaseTotals).toEqual({
      supervisor: { input: 108, output: 53, cacheCreation: 10, cacheRead: 5 },
      plan: { input: 200, output: 80, cacheCreation: 0, cacheRead: 0 },
      implement: { input: 94, output: 42, cacheCreation: 0, cacheRead: 0 },
      verify: { input: 15, output: 8, cacheCreation: 0, cacheRead: 0 },
      review: { input: 20, output: 10, cacheCreation: 0, cacheRead: 0 },
      unattributed: { input: 27, output: 13, cacheCreation: 0, cacheRead: 0 },
    });
  });

  it("pins the carry-forward secondary view — null/unrecognized attribution inherits the prior attributed phase", async () => {
    const result = await analyzeTranscripts([SAMPLE_FIXTURE]);
    if (result.status !== "ok")
      throw new Error(`expected ok, got ${result.status}`);
    // Record 2 (null) carries onto supervisor (record 1). Record 21
    // ("unknown-skill-xyz", unrecognized — not null, but still unattributed)
    // carries onto supervisor too, since record 19 (the last attributed
    // record before it) was flow-pipeline.
    expect(result.carryForwardTotals).toEqual({
      supervisor: { input: 135, output: 66, cacheCreation: 10, cacheRead: 5 },
      plan: { input: 200, output: 80, cacheCreation: 0, cacheRead: 0 },
      implement: { input: 94, output: 42, cacheCreation: 0, cacheRead: 0 },
      verify: { input: 15, output: 8, cacheCreation: 0, cacheRead: 0 },
      review: { input: 20, output: 10, cacheCreation: 0, cacheRead: 0 },
      unattributed: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    });
  });

  it("pins per-tool-class counts and payload-char sizes across all six classes", async () => {
    const result = await analyzeTranscripts([SAMPLE_FIXTURE]);
    if (result.status !== "ok")
      throw new Error(`expected ok, got ${result.status}`);
    expect(result.toolClassStats).toEqual({
      edit: { count: 2, payloadChars: 77 },
      diff: { count: 1, payloadChars: 50 },
      "verify-log": { count: 1, payloadChars: 31 },
      "skill-body": { count: 2, payloadChars: 137 },
      "sub-agent-return": { count: 2, payloadChars: 60 },
      other: { count: 1, payloadChars: 13 },
    });
  });

  it("classifies the Skill tool's own tool_result as a stub, not skill-body — the real body is the adjacent text-only record", async () => {
    const result = await analyzeTranscripts([SAMPLE_FIXTURE]);
    if (result.status !== "ok")
      throw new Error(`expected ok, got ${result.status}`);
    // Two skill-body hits: the adjacent post-Skill-launch text record, and
    // the direct Read of a SKILL.md path. If the classifier mis-attributed
    // the Skill tool's ~26-char launch stub as skill-body, count would be 3
    // and payloadChars would be far smaller than 137.
    expect(result.toolClassStats["skill-body"].count).toBe(2);
  });

  it("branches sub-agent spend on toolUseResult.status — completed contributes totalTokens, async_launched does not", async () => {
    const result = await analyzeTranscripts([SAMPLE_FIXTURE]);
    if (result.status !== "ok")
      throw new Error(`expected ok, got ${result.status}`);
    expect(result.subAgentSpend).toEqual({
      completedCount: 1,
      pendingAsyncCount: 1,
      totalTokens: 5000,
    });
  });

  it("pins the edit-size distribution — a create-type Write falls back to counting content lines, not an empty structuredPatch", async () => {
    const result = await analyzeTranscripts([SAMPLE_FIXTURE]);
    if (result.status !== "ok")
      throw new Error(`expected ok, got ${result.status}`);
    // Edit: 2 added + 1 removed = 3. Write (create, structuredPatch: []):
    // 4 content lines, 0 removed = 4. Without the create-type fallback this
    // would wrongly register as a zero-line edit.
    expect(result.editSizeDistribution).toEqual({
      count: 2,
      min: 3,
      median: 3,
      max: 4,
      p50: 3,
      p90: 4,
      p99: 4,
    });
  });

  it("merges aggregates across multiple JSONL paths (the resume-session case)", async () => {
    const result = await analyzeTranscripts([SAMPLE_FIXTURE, SAMPLE_FIXTURE]);
    if (result.status !== "ok")
      throw new Error(`expected ok, got ${result.status}`);
    expect(result.phaseTotals.plan.input).toBe(400);
    expect(result.toolClassStats.edit.count).toBe(4);
    expect(result.subAgentSpend.totalTokens).toBe(10000);
  });
});

describe("analyzeTranscripts — graceful schema-break degradation", () => {
  it("returns status:schema-break (not a throw, not a silently-zeroed aggregate) when message.usage has none of the expected fields", async () => {
    const result = await analyzeTranscripts([SCHEMA_BREAK_FIXTURE]);
    expect(result.status).toBe("schema-break");
    if (result.status !== "schema-break") throw new Error("unreachable");
    expect(result.reason).toContain("message.usage");
    expect(result.reason).toContain("schema may have changed");
  });

  it("detects an attributionSkill field whose type is not string|null as a schema break", async () => {
    const tmpFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "flow-ta-test-")),
      "bad.jsonl",
    );
    const record = {
      type: "assistant",
      attributionSkill: 42,
      message: {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    fs.writeFileSync(tmpFile, JSON.stringify(record) + "\n");
    const result = await analyzeTranscripts([tmpFile]);
    expect(result.status).toBe("schema-break");
    if (result.status !== "schema-break") throw new Error("unreachable");
    expect(result.reason).toContain("attributionSkill");
  });

  it("does not schema-break on absent optional structure (no Agent calls, no attributionSkill key at all)", async () => {
    const tmpFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "flow-ta-test-")),
      "ok.jsonl",
    );
    const record = {
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    };
    fs.writeFileSync(tmpFile, JSON.stringify(record) + "\n");
    const result = await analyzeTranscripts([tmpFile]);
    expect(result.status).toBe("ok");
  });

  it("skips a lone malformed JSON line without treating it as a schema break", async () => {
    const tmpFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "flow-ta-test-")),
      "malformed.jsonl",
    );
    const good = {
      type: "assistant",
      attributionSkill: "flow-pipeline",
      message: {
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    };
    fs.writeFileSync(
      tmpFile,
      ["{not valid json", JSON.stringify(good)].join("\n"),
    );
    const result = await analyzeTranscripts([tmpFile]);
    expect(result.status).toBe("ok");
  });
});

describe(estimateTokens, () => {
  it("estimates tokens as chars / 4, rounded up (a documented floor, not a point estimate)", () => {
    expect(estimateTokens(400)).toBe(100);
    expect(estimateTokens(401)).toBe(101);
    expect(estimateTokens(0)).toBe(0);
  });
});

describe(estimateFrontmatterCost, () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ta-frontmatter-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts YAML frontmatter from a SKILL.md and estimates its token cost within tolerance", async () => {
    const skillDir = path.join(tmpDir, "my-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    const frontmatter =
      "name: my-skill\ndescription: a test skill for the fixture";
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\n${frontmatter}\n---\n\n# Goal\n\nDo the thing.`,
    );
    const result = await estimateFrontmatterCost(tmpDir);
    expect(result.perSkill["my-skill"]).toBe(Math.ceil(frontmatter.length / 4));
    expect(result.total).toBe(result.perSkill["my-skill"]);
    expect(result.charsPerToken).toBe(4);
  });

  it("sums across multiple nested skills and ignores non-SKILL.md files", async () => {
    for (const name of ["skill-a", "skill-b"]) {
      const dir = path.join(tmpDir, "tier", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\n---\nbody`,
      );
      fs.writeFileSync(
        path.join(dir, "reference.md"),
        "not frontmatter, should be ignored",
      );
    }
    const result = await estimateFrontmatterCost(tmpDir);
    expect(Object.keys(result.perSkill).sort()).toEqual(["skill-a", "skill-b"]);
    expect(result.total).toBe(
      result.perSkill["skill-a"] + result.perSkill["skill-b"],
    );
  });

  it("returns an empty estimate for a directory with no SKILL.md files", async () => {
    const result = await estimateFrontmatterCost(tmpDir);
    expect(result).toEqual({ perSkill: {}, total: 0, charsPerToken: 4 });
  });

  it("accumulates (not overwrites) perSkill when two skills share a folder name across categories, so total stays consistent with the sum of perSkill", async () => {
    for (const category of ["pipeline", "universal"]) {
      const dir = path.join(tmpDir, category, "shared-name");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: shared-name\ncategory: ${category}\n---\nbody`,
      );
    }
    const result = await estimateFrontmatterCost(tmpDir);
    expect(Object.keys(result.perSkill)).toEqual(["shared-name"]);
    expect(result.total).toBe(result.perSkill["shared-name"]);
  });
});

describe(estimateStaticCost, () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ta-static-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("measures per-file lines/chars/estTokens and sums into totals", async () => {
    const fileA = path.join(tmpDir, "a.md");
    const fileB = path.join(tmpDir, "b.md");
    fs.writeFileSync(fileA, "line one\nline two\n"); // 18 chars, 2 lines
    fs.writeFileSync(fileB, "abcd\n"); // 5 chars, 1 line
    const result = await estimateStaticCost([fileA, fileB]);
    expect(result.files).toEqual([
      { path: fileA, lines: 2, chars: 18, estTokens: 5 },
      { path: fileB, lines: 1, chars: 5, estTokens: 2 },
    ]);
    expect(result.totals).toEqual({ lines: 3, chars: 23, estTokens: 7 });
  });

  it("counts a trailing line with no final newline", async () => {
    const file = path.join(tmpDir, "no-trailing-newline.md");
    fs.writeFileSync(file, "one\ntwo\nthree"); // no trailing \n, 3 lines
    const result = await estimateStaticCost([file]);
    expect(result.files[0].lines).toBe(3);
  });

  it("reports zero lines/chars/estTokens for an empty file", async () => {
    const file = path.join(tmpDir, "empty.md");
    fs.writeFileSync(file, "");
    const result = await estimateStaticCost([file]);
    expect(result.files[0]).toEqual({
      path: file,
      lines: 0,
      chars: 0,
      estTokens: 0,
    });
  });

  it("throws on a missing/unreadable path (the CLI maps this to exit 2)", async () => {
    await expect(
      estimateStaticCost([path.join(tmpDir, "does-not-exist.md")]),
    ).rejects.toThrow();
  });
});

describe(parseArgs, () => {
  it("requires either a JSONL path or --slug", () => {
    const parsed = parseArgs([]);
    expect(parsed).toEqual({
      error: "provide at least one JSONL path or --slug <slug>",
    });
  });

  it("parses a bare JSONL path as analyze mode with default json format", () => {
    const parsed = parseArgs(["foo.jsonl"]);
    expect(parsed).toEqual({
      mode: "analyze",
      jsonlPaths: ["foo.jsonl"],
      slug: undefined,
      repo: undefined,
      format: "json",
    });
  });

  it("tolerates the optional literal 'analyze' token", () => {
    const parsed = parseArgs(["analyze", "foo.jsonl", "--format", "md"]);
    expect(parsed).toEqual({
      mode: "analyze",
      jsonlPaths: ["foo.jsonl"],
      slug: undefined,
      repo: undefined,
      format: "md",
    });
  });

  it("parses --slug and --repo", () => {
    const parsed = parseArgs(["--slug", "my-slug", "--repo", "/some/repo"]);
    expect(parsed).toEqual({
      mode: "analyze",
      jsonlPaths: [],
      slug: "my-slug",
      repo: "/some/repo",
      format: "json",
    });
  });

  it("parses --frontmatter mode and rejects stray positional args alongside it", () => {
    expect(parseArgs(["--frontmatter", "skills"])).toEqual({
      mode: "frontmatter",
      dir: "skills",
      format: "json",
    });
    expect(parseArgs(["--frontmatter", "skills", "extra.jsonl"])).toEqual({
      error: "unexpected argument(s) with --frontmatter: extra.jsonl",
    });
  });

  it("rejects an unknown --format value", () => {
    expect(parseArgs(["foo.jsonl", "--format", "yaml"])).toEqual({
      error: "--format must be 'json' or 'md', got 'yaml'",
    });
  });

  it("parses --static mode with one or more paths", () => {
    expect(parseArgs(["--static", "a.md", "b.md"])).toEqual({
      mode: "static",
      paths: ["a.md", "b.md"],
      format: "json",
    });
  });

  it("rejects --static with no path arguments", () => {
    expect(parseArgs(["--static"])).toEqual({
      error: "--static requires at least one path argument",
    });
  });

  it("rejects --static combined with --frontmatter", () => {
    expect(parseArgs(["--static", "a.md", "--frontmatter", "skills"])).toEqual({
      error: "--static cannot be combined with --frontmatter",
    });
  });

  it("rejects --static combined with --slug/--repo", () => {
    expect(parseArgs(["--static", "a.md", "--slug", "my-slug"])).toEqual({
      error: "--static cannot be combined with --slug/--repo",
    });
  });
});

describe("run — CLI exit codes", () => {
  it("exits 2 on bad args", async () => {
    expect(await run([])).toBe(2);
  });

  it("exits 0 and prints ok data for the sample fixture", async () => {
    expect(await run([SAMPLE_FIXTURE, "--format", "json"])).toBe(0);
  });

  it("exits 3 on no-data", async () => {
    const tmpFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "flow-ta-test-")),
      "empty.jsonl",
    );
    fs.writeFileSync(tmpFile, "");
    expect(await run([tmpFile])).toBe(3);
  });

  it("exits 4 on schema-break, distinct from the no-data exit code", async () => {
    const exitCode = await run([SCHEMA_BREAK_FIXTURE]);
    expect(exitCode).toBe(4);
    expect(exitCode).not.toBe(3);
  });

  it("exits 0 for --frontmatter mode over the repo's own skills directory", async () => {
    expect(await run(["--frontmatter", "skills", "--format", "md"])).toBe(0);
  });

  it("exits 0 for --static mode over the repo's own AGENTS.md, in both formats", async () => {
    expect(await run(["--static", "AGENTS.md"])).toBe(0);
    expect(await run(["--static", "AGENTS.md", "--format", "md"])).toBe(0);
  });

  it("exits 2 for --static mode on a missing path", async () => {
    expect(
      await run(["--static", "/tmp/does-not-exist-flow-transcript-audit.md"]),
    ).toBe(2);
  });

  it("exits 2 with a clean message instead of a raw ENOENT stack trace for a nonexistent path", async () => {
    expect(await run(["/tmp/does-not-exist-flow-transcript-audit.jsonl"])).toBe(
      2,
    );
  });

  it("resolves --slug (+ relative --repo) end to end via a seeded projects-root fixture", async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-ta-slug-test-"),
    );
    const repoAbsPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-ta-slug-repo-"),
    );
    try {
      const projectDir = path.join(tmpRoot, encodeProjectSegment(repoAbsPath));
      fs.mkdirSync(projectDir, { recursive: true });
      const jsonlPath = path.join(projectDir, "session.jsonl");
      fs.writeFileSync(
        jsonlPath,
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: "Use the /flow-pipeline skill for: my slug",
          },
        }) + "\n",
      );

      const paths = await resolveSessionJsonls("my-slug", repoAbsPath, tmpRoot);
      expect(paths).toEqual([jsonlPath]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(repoAbsPath, { recursive: true, force: true });
    }
  });
});
