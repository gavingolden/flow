import { describe, expect, it } from "vitest";
import { priceFor, statsFromJsonl } from "./review-lens-cost";

const prices = {
  "claude-opus-4-7": {
    friendlyName: "Opus",
    input: 10,
    cacheCreation: 0,
    cacheRead: 0,
    output: 0,
  },
};

const line = (content: unknown[], id = "m1", model = "claude-opus-4-7") =>
  JSON.stringify({
    type: "assistant",
    message: {
      id,
      model,
      content,
      usage: { input_tokens: 1_000_000, output_tokens: 5 },
    },
  });

describe("statsFromJsonl", () => {
  it("counts tool calls on every line but usage once per message.id", () => {
    const raw = [
      line([{ type: "tool_use", name: "Read", input: { file_path: "a" } }]),
      line([{ type: "tool_use", name: "Grep", input: {} }]),
      line([{ type: "tool_use", name: "Read", input: { file_path: "b" } }]),
    ].join("\n");
    const s = statsFromJsonl(raw, prices);
    expect(s.turns).toBe(1);
    expect(s.reads).toBe(2);
    expect(s.greps).toBe(1);
    expect(s.files.size).toBe(2);
    expect(s.output).toBe(5);
    expect(s.dollars).toBeCloseTo(10, 6);
  });

  it("counts distinct message ids separately", () => {
    const raw = [line([], "m1"), line([], "m2")].join("\n");
    expect(statsFromJsonl(raw, prices).turns).toBe(2);
  });
});

describe("statsFromJsonl last-occurrence rule", () => {
  const withOutput = (output: number, id = "m1") =>
    JSON.stringify({
      type: "assistant",
      message: {
        id,
        model: "claude-opus-4-7",
        content: [],
        usage: { input_tokens: 1_000_000, output_tokens: output },
      },
    });
  const outPrices = {
    "claude-opus-4-7": {
      friendlyName: "Opus",
      input: 10,
      cacheCreation: 0,
      cacheRead: 0,
      output: 1_000_000,
    },
  };

  it("uses the last line's output (3 then 333 => 333, counted once)", () => {
    const s = statsFromJsonl(
      [withOutput(3), withOutput(333)].join("\n"),
      outPrices,
    );
    expect(s.turns).toBe(1);
    expect(s.output).toBe(333);
    expect(s.dollars).toBeCloseTo(10 + 333, 6);
  });
});

describe("priceFor", () => {
  it("falls back to the model family's priced entry", () => {
    expect(priceFor("claude-opus-5", prices)).toBe(prices["claude-opus-4-7"]);
  });
  it("returns null for an unknown family", () => {
    expect(priceFor("mystery-model", prices)).toBeNull();
  });
});
