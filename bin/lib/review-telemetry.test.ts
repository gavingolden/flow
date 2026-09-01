import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateCounts,
  attributeTranscripts,
  findSubagentsDir,
  mergeTelemetry,
  parseLensTokens,
} from "./review-telemetry";
import type { ConsolidatorResult } from "./agent-finding-schema";
import type { FixApplierResult } from "./fix-applier-schema";

describe("aggregateCounts", () => {
  it("counts emitted findings per lens from agent outputs", () => {
    const counts = aggregateCounts({
      agentOutputs: {
        "bug-detection": { findings: [{}, {}] },
      },
      consolidator: null,
      fixApplier: null,
    });
    expect(counts["bug-detection"].findings_emitted).toBe(2);
    expect(counts["bug-detection"].ran).toBe(true);
  });

  it("marks a lens ran:false with the gated reason when the artifact carries a gated key", () => {
    const counts = aggregateCounts({
      agentOutputs: {
        performance: {
          findings: [],
          gated: { reason: "docs-only diff (1 files)" },
        },
      },
      consolidator: null,
      fixApplier: null,
    });
    expect(counts.performance.ran).toBe(false);
    expect(counts.performance.skip_reason).toBe("docs-only diff (1 files)");
  });

  it("attributes survived findings by agent_source and dropped/acted/deferred by the `<lens>:` finding_id prefix", () => {
    const consolidator: ConsolidatorResult = {
      consolidated_findings: [
        {
          finding_id: "bug-detection:a.ts:1:issue",
          agent_source: "bug-detection",
        },
      ],
      dropped_by_validation: [
        {
          finding_id: "bug-detection:b.ts:2:nitpick",
          original_finding: {},
          reason: "dup",
        },
      ],
      rejected_alternatives: [],
      anti_patterns_found: [],
      summary: "ok",
    };
    const fixApplier: FixApplierResult = {
      commits: [
        {
          sha: "abc",
          files: ["a.ts"],
          finding_id: "bug-detection:a.ts:1:issue",
          reasoning: "fix",
          verify_status: "pass",
        },
      ],
      deferred: [
        {
          finding_id: "bug-detection:c.ts:3:issue",
          tracker_entry_url: "",
          reason: "deferred",
        },
      ],
      rejected_alternatives: [],
      anti_patterns_found: [],
      summary: "ok",
    };
    const counts = aggregateCounts({
      agentOutputs: { "bug-detection": { findings: [{}] } },
      consolidator,
      fixApplier,
    });
    expect(counts["bug-detection"].findings_survived).toBe(1);
    expect(counts["bug-detection"].findings_dropped).toBe(1);
    expect(counts["bug-detection"].findings_acted).toBe(1);
    expect(counts["bug-detection"].findings_deferred).toBe(1);
  });

  it("returns zero counts (not throw) when consolidator or fixApplier is null", () => {
    const counts = aggregateCounts({
      agentOutputs: { "bug-detection": { findings: [] } },
      consolidator: null,
      fixApplier: null,
    });
    expect(counts["bug-detection"]).toEqual({
      ran: true,
      skip_reason: null,
      findings_emitted: 0,
      findings_survived: 0,
      findings_dropped: 0,
      findings_acted: 0,
      findings_deferred: 0,
    });
  });
});

describe("parseLensTokens", () => {
  it("parses `bug-detection=123` pairs and ignores malformed entries", () => {
    const out = parseLensTokens([
      "bug-detection=123",
      "malformed",
      "security=abc",
      "=99",
    ]);
    expect(out).toEqual({ "bug-detection": 123 });
  });

  it("sums duplicate flags for the same lens (widen re-pass)", () => {
    const out = parseLensTokens(["bug-detection=100", "bug-detection=50"]);
    expect(out).toEqual({ "bug-detection": 150 });
  });
});

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeSubagentsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-review-telemetry-"));
  scratchDirs.push(dir);
  return dir;
}

function writeUsageJsonl(filePath: string, model: string): void {
  const lines = [
    JSON.stringify({
      type: "assistant",
      message: { model, usage: { input_tokens: 10, output_tokens: 5 } },
    }),
    JSON.stringify({
      type: "assistant",
      message: { model, usage: { input_tokens: 20, output_tokens: 15 } },
    }),
  ];
  fs.writeFileSync(filePath, lines.join("\n"));
}

describe("attributeTranscripts", () => {
  it("keys transcripts by agentType suffix and by `review lens: <lens>` description, ignores files older than since, and sums usage across assistant events", async () => {
    const dir = makeSubagentsDir();
    const since = new Date(Date.now() - 60_000);

    fs.writeFileSync(
      path.join(dir, "agent-x.meta.json"),
      JSON.stringify({ agentType: "flow-review-bug-detection" }),
    );
    writeUsageJsonl(path.join(dir, "agent-x.jsonl"), "claude-x");

    fs.writeFileSync(
      path.join(dir, "agent-y.meta.json"),
      JSON.stringify({ description: "review lens: security" }),
    );
    writeUsageJsonl(path.join(dir, "agent-y.jsonl"), "claude-y");

    const out = await attributeTranscripts(dir, since);
    expect(out["bug-detection"].usage.total).toBe(50);
    expect(out.security.usage.total).toBe(50);
    expect(out["bug-detection"].model).toBe("claude-x");
  });

  it("ignores files older than since", async () => {
    const dir = makeSubagentsDir();
    fs.writeFileSync(
      path.join(dir, "agent-old.meta.json"),
      JSON.stringify({ agentType: "flow-review-performance" }),
    );
    writeUsageJsonl(path.join(dir, "agent-old.jsonl"), "claude-old");
    const future = new Date(Date.now() + 60_000);
    const out = await attributeTranscripts(dir, future);
    expect(out.performance).toBeUndefined();
  });

  it("picks the newest transcript's usage/file when a widen re-pass produces two transcripts for the same lens", async () => {
    const dir = makeSubagentsDir();
    const since = new Date(Date.now() - 60_000);

    fs.writeFileSync(
      path.join(dir, "agent-old.meta.json"),
      JSON.stringify({ agentType: "flow-review-bug-detection" }),
    );
    const oldJsonl = path.join(dir, "agent-old.jsonl");
    writeUsageJsonl(oldJsonl, "claude-old");

    fs.writeFileSync(
      path.join(dir, "agent-new.meta.json"),
      JSON.stringify({ agentType: "flow-review-bug-detection" }),
    );
    const newJsonl = path.join(dir, "agent-new.jsonl");
    fs.writeFileSync(
      newJsonl,
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-new",
          usage: { input_tokens: 200, output_tokens: 100 },
        },
      }),
    );

    const now = Date.now() / 1000;
    fs.utimesSync(oldJsonl, now - 120, now - 120);
    fs.utimesSync(newJsonl, now, now);

    const out = await attributeTranscripts(dir, since);
    expect(out["bug-detection"].usage.total).toBe(300);
    expect(out["bug-detection"].model).toBe("claude-new");
    expect(out["bug-detection"].file).toBe(newJsonl);
  });
});

describe("findSubagentsDir", () => {
  it("returns null when no session dir matches", () => {
    const root = makeSubagentsDir();
    expect(findSubagentsDir("nonexistent-session", root)).toBeNull();
  });

  it("finds the matching session's subagents dir", () => {
    const root = makeSubagentsDir();
    const target = path.join(root, "encoded-project", "session-1", "subagents");
    fs.mkdirSync(target, { recursive: true });
    expect(findSubagentsDir("session-1", root)).toBe(target);
  });
});

describe("mergeTelemetry", () => {
  const baseArgs = {
    pr: 42,
    repo: "flow",
    slug: "my-slug",
    sessionId: "sess-1",
    scope: {
      scope: "delta" as const,
      base_sha: "abc",
      head_sha: "def",
      delta_files: ["a.ts"],
      delta_ratio: 0.1,
    },
    widened: { value: false, reason: null },
    startedAt: "2026-01-01T00:00:00.000Z",
  };

  it("should prefer --lens-tokens over transcript usage (tokens_source 'task-notification', tokens.total only)", () => {
    const t = mergeTelemetry({
      ...baseArgs,
      counts: {
        "bug-detection": {
          ran: true,
          skip_reason: null,
          findings_emitted: 1,
          findings_survived: 1,
          findings_dropped: 0,
          findings_acted: 0,
          findings_deferred: 0,
        },
      },
      lensTokens: { "bug-detection": 12345 },
      transcripts: {
        "bug-detection": { usage: { total: 999, input: 1 }, model: "claude-x" },
      },
    });
    expect(t.lenses["bug-detection"].tokens).toEqual({ total: 12345 });
    expect(t.lenses["bug-detection"].tokens_source).toBe("task-notification");
  });

  it("falls back to the transcript split when no --lens-tokens figure exists", () => {
    const t = mergeTelemetry({
      ...baseArgs,
      counts: {},
      lensTokens: {},
      transcripts: {
        "bug-detection": {
          usage: { total: 50, input: 30, output: 20 },
          model: "claude-x",
        },
      },
    });
    expect(t.lenses["bug-detection"].tokens).toEqual({
      total: 50,
      input: 30,
      output: 20,
    });
    expect(t.lenses["bug-detection"].tokens_source).toBe("subagent-transcript");
  });

  it("yields tokens null + 'unavailable' when neither exists", () => {
    const t = mergeTelemetry({
      ...baseArgs,
      counts: {},
      lensTokens: {},
      transcripts: {},
    });
    expect(t.lenses["bug-detection"].tokens).toBeNull();
    expect(t.lenses["bug-detection"].tokens_source).toBe("unavailable");
  });

  it("builds run_id as `<pr>:<head_sha>:<started_at>`", () => {
    const t = mergeTelemetry({
      ...baseArgs,
      counts: {},
      lensTokens: {},
      transcripts: {},
    });
    expect(t.run_id).toBe("42:def:2026-01-01T00:00:00.000Z");
  });
});
