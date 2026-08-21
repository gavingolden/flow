import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  initInfo,
  metricSource,
  parseStream,
  transcriptMetrics,
  type StreamEvent,
} from "./eval-transcript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(
  HERE,
  "..",
  "fixtures",
  "eval",
  "stream-sample.jsonl",
);

describe("parseStream", () => {
  it("parses every line of the committed fixture with no parse errors", () => {
    const text = fs.readFileSync(FIXTURE_PATH, "utf8");
    const { events, result, parseErrors } = parseStream(text);
    expect(parseErrors).toBe(0);
    expect(events.length).toBeGreaterThan(0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("result");
  });

  it("tolerates rate_limit_event, system/thinking_tokens, and unknown types", () => {
    const text = [
      JSON.stringify({ type: "rate_limit_event", foo: 1 }),
      JSON.stringify({
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 5,
      }),
      JSON.stringify({ type: "some_future_event", bar: true }),
    ].join("\n");
    const { events, parseErrors } = parseStream(text);
    expect(parseErrors).toBe(0);
    expect(events).toHaveLength(3);
  });

  it("counts an unparseable line as a parse error without throwing", () => {
    const text = [
      '{"type":"assistant"}',
      "not json at all",
      '{"type":"result","is_error":false}',
    ].join("\n");
    const { events, parseErrors, result } = parseStream(text);
    expect(parseErrors).toBe(1);
    expect(events).toHaveLength(2);
    expect(result?.type).toBe("result");
  });

  it("ignores blank lines", () => {
    const { events, parseErrors } = parseStream('\n{"type":"system"}\n\n');
    expect(parseErrors).toBe(0);
    expect(events).toHaveLength(1);
  });
});

describe("transcriptMetrics", () => {
  it("derives correct metrics from the committed fixture", () => {
    const text = fs.readFileSync(FIXTURE_PATH, "utf8");
    const { events, result } = parseStream(text);
    const metrics = transcriptMetrics(events, result);
    expect(metrics.assistantMessages).toBe(2);
    expect(metrics.toolCalls.StructuredOutput).toBe(1);
    expect(metrics.finalContextTokens).toBeGreaterThan(0);
    expect(metrics.costUsd).toBeGreaterThan(0);
    expect(metrics.numTurns).toBe(2);
    expect(metrics.subagentsSpawned).toBe(0);
    expect(metrics.modelShare["claude-haiku-4-5-20251001"]).toBeCloseTo(1, 5);
    expect(metrics.modelShare.haiku).toBeCloseTo(1, 5);
  });

  it("finalContextTokens uses only the last top-level assistant event (parent_tool_use_id === null)", () => {
    const events: StreamEvent[] = [
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      // A subagent turn (non-null parent_tool_use_id) with a much bigger
      // context — must NOT win finalContextTokens.
      {
        type: "assistant",
        parent_tool_use_id: "toolu_subagent",
        message: {
          usage: {
            input_tokens: 90000,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          usage: {
            input_tokens: 200,
            output_tokens: 5,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 25,
          },
        },
      },
    ];
    const metrics = transcriptMetrics(events, null);
    expect(metrics.finalContextTokens).toBe(200 + 50 + 25);
  });

  it("counts tool_use content blocks by name across all assistant events", () => {
    const events: StreamEvent[] = [
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", name: "Bash" }] },
      },
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "tool_use", name: "Bash" },
            { type: "tool_use", name: "Read" },
          ],
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "x",
        message: { content: [{ type: "tool_use", name: "Bash" }] },
      },
    ];
    const metrics = transcriptMetrics(events, null);
    expect(metrics.toolCalls).toEqual({ Bash: 3, Read: 1 });
  });

  it("computes modelShare including alias buckets by substring match", () => {
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 3,
      total_cost_usd: 1,
      duration_ms: 1,
      session_id: "s",
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {
        "claude-sonnet-4-5-20250929": {
          inputTokens: 300,
          outputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 1,
        },
        "claude-haiku-4-5-20251001": {
          inputTokens: 90,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.1,
        },
      },
      permission_denials: [],
    } as const;
    const metrics = transcriptMetrics([], result as never);
    expect(metrics.modelShare.sonnet).toBeCloseTo(400 / 500, 5);
    expect(metrics.modelShare.haiku).toBeCloseTo(100 / 500, 5);
  });

  it("reports subagentsSpawned from result.subagent_stats", () => {
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0,
      duration_ms: 0,
      session_id: "s",
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      subagent_stats: { spawned: 3, max_depth: 2 },
      permission_denials: [],
    } as const;
    const metrics = transcriptMetrics([], result as never);
    expect(metrics.subagentsSpawned).toBe(3);
    expect(metrics.maxSubagentDepth).toBe(2);
  });
});

describe("metricSource", () => {
  it("resolves dotted result.* and transcript.* paths", () => {
    const text = fs.readFileSync(FIXTURE_PATH, "utf8");
    const { events, result } = parseStream(text);
    const transcript = transcriptMetrics(events, result);
    expect(metricSource("result.total_cost_usd", { result, transcript })).toBe(
      result?.total_cost_usd,
    );
    expect(
      metricSource("transcript.finalContextTokens", { result, transcript }),
    ).toBe(transcript.finalContextTokens);
    expect(
      metricSource("transcript.toolCalls.StructuredOutput", {
        result,
        transcript,
      }),
    ).toBe(1);
  });

  it("returns undefined for an unrecognised source prefix or a non-numeric leaf", () => {
    const transcript = transcriptMetrics([], null);
    expect(
      metricSource("bogus.total_cost_usd", { result: null, transcript }),
    ).toBeUndefined();
    expect(
      metricSource("result.session_id", { result: null, transcript }),
    ).toBeUndefined();
  });
});

describe("initInfo", () => {
  it("extracts claudeVersion/model/plugins/agents from the system/init event", () => {
    const text = fs.readFileSync(FIXTURE_PATH, "utf8");
    const { events } = parseStream(text);
    const info = initInfo(events);
    expect(info.claudeVersion).toBe("2.1.239");
    expect(info.model).toBe("claude-haiku-4-5-20251001");
    expect(Array.isArray(info.plugins)).toBe(true);
    expect(Array.isArray(info.agents)).toBe(true);
    expect(info.agents).toContain("general-purpose");
  });

  it("returns empty plugins/agents arrays when there is no init event", () => {
    const info = initInfo([{ type: "assistant" }]);
    expect(info.plugins).toEqual([]);
    expect(info.agents).toEqual([]);
    expect(info.claudeVersion).toBeUndefined();
  });
});
