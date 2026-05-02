import { describe, expect, it } from "vitest";
import { computeUsd, formatUsd, parseStreamJsonText, PRICE_MAP } from "./eval-cost";

const sonnetAssistant = (usage: Record<string, number>) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", model: "claude-sonnet-4-6", usage },
  });

const opusAssistant = (usage: Record<string, number>) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", model: "claude-opus-4-7", usage },
  });

const resultEvent = (totalCostUsd: number) =>
  JSON.stringify({ type: "result", subtype: "success", total_cost_usd: totalCostUsd });

describe("parseStreamJsonText", () => {
  it("uses result.total_cost_usd as authoritative when present", () => {
    const text = [
      sonnetAssistant({ input_tokens: 100, output_tokens: 50 }),
      resultEvent(0.0042),
    ].join("\n");

    const r = parseStreamJsonText(text);

    expect(r.usd).toBe(0.0042);
    expect(r.authoritative).toBe(true);
  });

  it("falls back to price-map computation when result event is absent", () => {
    const text = sonnetAssistant({
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });

    const r = parseStreamJsonText(text);

    expect(r.authoritative).toBe(false);
    expect(r.usd).toBeCloseTo(
      PRICE_MAP["claude-sonnet-4-6"].inputPerM + PRICE_MAP["claude-sonnet-4-6"].outputPerM,
    );
  });

  it("aggregates token counts across multiple assistant events", () => {
    const text = [
      sonnetAssistant({ input_tokens: 10, output_tokens: 5 }),
      sonnetAssistant({ input_tokens: 20, output_tokens: 7 }),
    ].join("\n");

    const r = parseStreamJsonText(text);

    expect(r.tokens.input).toBe(30);
    expect(r.tokens.output).toBe(12);
  });

  it("splits tokens by model into perModel", () => {
    const text = [
      sonnetAssistant({ input_tokens: 100, output_tokens: 0 }),
      opusAssistant({ input_tokens: 200, output_tokens: 0 }),
    ].join("\n");

    const r = parseStreamJsonText(text);

    expect(r.perModel["claude-sonnet-4-6"].input).toBe(100);
    expect(r.perModel["claude-opus-4-7"].input).toBe(200);
  });

  it("tolerates malformed JSON lines without throwing", () => {
    const text = [
      sonnetAssistant({ input_tokens: 1, output_tokens: 1 }),
      "{not json",
      "",
      resultEvent(0.001),
    ].join("\n");

    const r = parseStreamJsonText(text);
    expect(r.usd).toBe(0.001);
    expect(r.authoritative).toBe(true);
  });

  it("ignores assistant events with missing usage", () => {
    const text = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", model: "claude-sonnet-4-6" },
    });
    const r = parseStreamJsonText(text);
    expect(r.tokens.input).toBe(0);
  });

  it("buckets unknown models without crashing", () => {
    const text = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-future-9",
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    });
    const r = parseStreamJsonText(text);
    expect(r.perModel["claude-future-9"]?.input).toBe(5);
    expect(r.usd).toBe(0);
  });
});

describe("computeUsd", () => {
  it("computes from input/output tokens at the documented rates", () => {
    const usd = computeUsd({
      "claude-haiku-4-5": { input: 1_000_000, output: 0, cacheCreation: 0, cacheRead: 0 },
    });
    expect(usd).toBeCloseTo(PRICE_MAP["claude-haiku-4-5"].inputPerM);
  });

  it("returns 0 for unpriced models", () => {
    const usd = computeUsd({
      mystery: { input: 1_000_000, output: 1_000_000, cacheCreation: 0, cacheRead: 0 },
    });
    expect(usd).toBe(0);
  });
});

describe("formatUsd", () => {
  it("formats with $ prefix and 4 decimals", () => {
    expect(formatUsd(0.001234)).toBe("$0.0012");
    expect(formatUsd(1)).toBe("$1.0000");
  });
});
