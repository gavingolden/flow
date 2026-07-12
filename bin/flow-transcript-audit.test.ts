import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analyzeTranscripts,
  estimateFrontmatterCost,
  estimateTokens,
} from "./lib/transcript-audit";
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
      "skill-body": { count: 2, payloadChars: 132 },
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
    // and payloadChars would be far smaller than 132.
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
});
