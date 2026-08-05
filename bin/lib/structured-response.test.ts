import { describe, expect, it } from "vitest";
import { parseStructured } from "./structured-response";

describe("parseStructured — extraction", () => {
  it("returns the parsed object when the text is a bare JSON object", () => {
    const result = parseStructured('{"foo":"bar"}', undefined);
    expect(result).toEqual({ ok: true, value: { foo: "bar" } });
  });

  it("extracts the object when wrapped in a ```json fence", () => {
    const text = 'Here is the result:\n```json\n{"foo":"bar"}\n```\nThanks.';
    const result = parseStructured(text, undefined);
    expect(result).toEqual({ ok: true, value: { foo: "bar" } });
  });

  it("extracts the object when prose precedes AND follows it", () => {
    const text =
      'Sure, here is my answer: {"foo":"bar"} — let me know if you need more.';
    const result = parseStructured(text, undefined);
    expect(result).toEqual({ ok: true, value: { foo: "bar" } });
  });

  it("fails closed with a reason when no JSON object can be extracted", () => {
    const result = parseStructured("no json anywhere in this text", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no JSON object could be extracted/i);
    }
  });
});

describe("parseStructured — fail-closed validation", () => {
  const schema = {
    required: ["reasoning", "count"],
    properties: {
      reasoning: { type: "string" },
      count: { type: "number" },
    },
  };

  it("fails closed with a reason when a schema-required key is absent", () => {
    const result = parseStructured('{"reasoning":"because"}', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/"count"/);
      expect(result.reason).toMatch(/missing/i);
    }
  });

  it("fails closed with a reason when a required key has the wrong type", () => {
    const result = parseStructured(
      '{"reasoning":"because","count":"three"}',
      schema,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/"count"/);
      expect(result.reason).toMatch(/number/i);
    }
  });

  it("passes when every required key is present with the right type", () => {
    const result = parseStructured('{"reasoning":"because","count":3}', schema);
    expect(result).toEqual({
      ok: true,
      value: { reasoning: "because", count: 3 },
    });
  });

  it("validates shape-only when the schema has no required list", () => {
    const result = parseStructured('{"anything":true}', { properties: {} });
    expect(result).toEqual({ ok: true, value: { anything: true } });
  });

  it("validates shape-only when the schema is not an object", () => {
    const result = parseStructured('{"anything":true}', null);
    expect(result).toEqual({ ok: true, value: { anything: true } });
  });
});
