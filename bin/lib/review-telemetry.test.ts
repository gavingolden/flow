import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateCounts,
  attributeTranscripts,
  findSubagentsDir,
  mergeTelemetry,
  parseLensModels,
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
      status: "complete",
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

  it("keeps the last figure per lens (widen re-pass)", () => {
    const out = parseLensTokens(["bug-detection=100", "bug-detection=50"]);
    expect(out).toEqual({ "bug-detection": 50 });
  });
});

describe("parseLensModels", () => {
  it("parses `bug-detection=opus` pairs", () => {
    const out = parseLensModels(["bug-detection=opus", "security=sonnet"]);
    expect(out).toEqual({ "bug-detection": "opus", security: "sonnet" });
  });

  it("ignores malformed entries (no '=', empty lens, empty value)", () => {
    const out = parseLensModels(["malformed", "=opus", "security="]);
    expect(out).toEqual({});
  });

  it("returns an empty map for an empty flag list", () => {
    expect(parseLensModels([])).toEqual({});
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

  it("sums every in-window transcript of a lens (a widen re-pass or respawn), excluding ones before since, with model/file from the newest", async () => {
    const dir = makeSubagentsDir();
    const since = new Date(Date.now() - 60_000);
    const now = Date.now() / 1000;

    const addTranscript = (
      name: string,
      model: string,
      input: number,
      output: number,
      mtime: number,
    ): string => {
      fs.writeFileSync(
        path.join(dir, `${name}.meta.json`),
        JSON.stringify({ agentType: "flow-review-bug-detection" }),
      );
      const file = path.join(dir, `${name}.jsonl`);
      fs.writeFileSync(
        file,
        JSON.stringify({
          type: "assistant",
          message: {
            model,
            usage: { input_tokens: input, output_tokens: output },
          },
        }),
      );
      fs.utimesSync(file, mtime, mtime);
      return file;
    };

    addTranscript("agent-before", "claude-before", 1000, 1000, now - 3600);
    addTranscript("agent-old", "claude-old", 10, 5, now - 30);
    const newJsonl = addTranscript("agent-new", "claude-new", 200, 100, now);

    const out = await attributeTranscripts(dir, since);
    expect(out["bug-detection"].usage).toEqual({
      total: 315,
      input: 210,
      cache_creation: 0,
      cache_read: 0,
      output: 105,
    });
    expect(out["bug-detection"].model).toBe("claude-new");
    expect(out["bug-detection"].file).toBe(newJsonl);
  });

  it("excludes a transcript newer than the until bound", async () => {
    const dir = makeSubagentsDir();
    const now = Date.now() / 1000;
    for (const [name, mtime] of [
      ["agent-in", now - 30],
      ["agent-late", now],
    ] as const) {
      fs.writeFileSync(
        path.join(dir, `${name}.meta.json`),
        JSON.stringify({ agentType: "flow-review-security" }),
      );
      const file = path.join(dir, `${name}.jsonl`);
      writeUsageJsonl(file, "claude-x");
      fs.utimesSync(file, mtime, mtime);
    }
    const out = await attributeTranscripts(
      dir,
      new Date((now - 60) * 1000),
      new Date((now - 10) * 1000),
    );
    expect(out.security.usage.total).toBe(50);
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

  it("takes tokens from the transcript and records the notification figure separately as context_tokens", () => {
    const t = mergeTelemetry({
      ...baseArgs,
      counts: {},
      lensTokens: { "bug-detection": 12345 },
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
    expect(t.lenses["bug-detection"].context_tokens).toBe(12345);
  });

  it("never writes the notification figure into tokens: notification only yields tokens null + 'unavailable' with context_tokens set", () => {
    const t = mergeTelemetry({
      ...baseArgs,
      counts: {},
      lensTokens: { "bug-detection": 12345 },
      transcripts: {},
    });
    expect(t.lenses["bug-detection"].tokens).toBeNull();
    expect(t.lenses["bug-detection"].tokens_source).toBe("unavailable");
    expect(t.lenses["bug-detection"].context_tokens).toBe(12345);
  });

  it("transcript only keeps the per-class split with context_tokens null", () => {
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
    expect(t.lenses["bug-detection"].context_tokens).toBeNull();
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
    expect(t.lenses["bug-detection"].context_tokens).toBeNull();
  });

  it("populates model from --lens-model even with no transcript", () => {
    const t = mergeTelemetry({
      ...baseArgs,
      counts: {},
      lensTokens: {},
      lensModels: { "bug-detection": "opus" },
      transcripts: {},
    });
    expect(t.lenses["bug-detection"].model).toBe("opus");
  });

  it("prefers the transcript's concrete model over a --lens-model alias, and falls back to the alias without a transcript", () => {
    const transcripts = {
      "bug-detection": { usage: { total: 999 }, model: "claude-x" },
    };
    const withFlag = mergeTelemetry({
      ...baseArgs,
      counts: {},
      lensTokens: {},
      lensModels: { "bug-detection": "opus" },
      transcripts,
    });
    expect(withFlag.lenses["bug-detection"].model).toBe("claude-x");
    const without = mergeTelemetry({
      ...baseArgs,
      counts: {},
      lensTokens: {},
      lensModels: {},
      transcripts,
    });
    expect(without.lenses["bug-detection"].model).toBe("claude-x");
    const aliasOnly = mergeTelemetry({
      ...baseArgs,
      counts: {},
      lensTokens: {},
      lensModels: { "bug-detection": "opus" },
      transcripts: {},
    });
    expect(aliasOnly.lenses["bug-detection"].model).toBe("opus");
  });

  it("tags rows version 3", () => {
    const t = mergeTelemetry({
      ...baseArgs,
      counts: {},
      lensTokens: {},
      transcripts: {},
    });
    expect(t.version).toBe(3);
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
