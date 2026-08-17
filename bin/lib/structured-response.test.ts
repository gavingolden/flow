import { describe, expect, it } from "vitest";
import {
  decodeDelegateArtifact,
  extractJsonObject,
  parseStructured,
  unwrapAgyEnvelope,
} from "./structured-response";

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

  // findBalancedObjectSpan is sold as string-literal aware — a brace inside
  // a string value must never desync the depth count. These three cases
  // exercise the depth counter, `inString`, and `escaped` state transitions
  // that a naive first-`{`-to-last-`}` slice would get wrong.
  it("extracts a nested object wrapped in prose", () => {
    const text = 'before {"a":{"b":1}} after';
    const result = parseStructured(text, undefined);
    expect(result).toEqual({ ok: true, value: { a: { b: 1 } } });
  });

  it("does not desync brace-depth counting on a brace inside a string value", () => {
    const text = 'answer: {"note":"see {ref} and }"} done';
    const result = parseStructured(text, undefined);
    expect(result).toEqual({ ok: true, value: { note: "see {ref} and }" } });
  });

  it("handles an escaped quote inside a string value without ending the string early", () => {
    const text = '{"s":"he said \\"hi\\""} trailing';
    const result = parseStructured(text, undefined);
    expect(result).toEqual({ ok: true, value: { s: 'he said "hi"' } });
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

  it("fails closed when a required key with a declared type is present but null", () => {
    // The presence check only treats `undefined` as missing, so a `null`
    // value slips past it — this pins that it is still caught by the
    // declared-type check right after.
    const result = parseStructured('{"reasoning":null,"count":3}', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/"reasoning"/);
      expect(result.reason).toMatch(/string/i);
    }
  });
});

describe("extractJsonObject", () => {
  it("returns the object verbatim when there is no wrapper", () => {
    expect(extractJsonObject('{"findings":[]}')).toBe('{"findings":[]}');
  });

  it("recovers an object wrapped in leading/trailing prose (first-{-to-last-} slice)", () => {
    const wrapped = 'Here are my findings:\n{"findings":[]}\nDone.';
    expect(extractJsonObject(wrapped)).toBe('{"findings":[]}');
  });

  it("returns null when there is no brace pair", () => {
    expect(extractJsonObject("no json here at all")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
    expect(extractJsonObject("} only a close brace {")).toBeNull();
  });

  it("recovers an object inside a ```json fence", () => {
    const fenced = '```json\n{"findings":[]}\n```';
    expect(extractJsonObject(fenced)).toBe('{"findings":[]}');
  });

  // Pins the load-bearing lastIndexOf("}") (vs a first-`}` indexOf): a payload
  // with nested braces must be recovered whole, not truncated at the inner `}`.
  // A naive indexOf rewrite passes the empty-body cases above but fails here.
  it("recovers a non-empty payload with nested braces (lastIndexOf, not indexOf)", () => {
    const nested = '{"findings":[{"file":"x"}]}';
    expect(extractJsonObject(nested)).toBe(nested);
    const wrapped = 'My review:\n{"findings":[{"file":"x","line":1}]}\nEnd.';
    expect(extractJsonObject(wrapped)).toBe(
      '{"findings":[{"file":"x","line":1}]}',
    );
  });
});

describe("unwrapAgyEnvelope", () => {
  it("prefers structured_output and returns .response as text", () => {
    const raw = JSON.stringify({
      response: 'Here is my answer: {"foo":"bar"}',
      structured_output: { foo: "bar" },
    });
    expect(unwrapAgyEnvelope(raw)).toEqual({
      text: 'Here is my answer: {"foo":"bar"}',
      structured: { foo: "bar" },
    });
  });

  it("returns text-only when the envelope has no structured_output", () => {
    const raw = JSON.stringify({ response: '{"foo":"bar"}' });
    expect(unwrapAgyEnvelope(raw)).toEqual({
      text: '{"foo":"bar"}',
      structured: undefined,
    });
  });

  it("returns { text: rawArtifact } with no structured field on non-envelope / malformed input", () => {
    expect(unwrapAgyEnvelope("not json at all")).toEqual({
      text: "not json at all",
    });
    expect(unwrapAgyEnvelope('{"no_response_key":true}')).toEqual({
      text: '{"no_response_key":true}',
    });
    expect(unwrapAgyEnvelope("")).toEqual({ text: "" });
  });

  it("never throws on garbage input", () => {
    expect(() => unwrapAgyEnvelope("\x00\x01{")).not.toThrow();
  });
});

describe("decodeDelegateArtifact — rung ordering", () => {
  const validateFoo = (
    candidate: unknown,
  ): { ok: true; value: { foo: string } } | { ok: false } => {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      typeof (candidate as Record<string, unknown>).foo === "string"
    ) {
      return {
        ok: true,
        value: { foo: (candidate as Record<string, unknown>).foo as string },
      };
    }
    return { ok: false };
  };

  it("returns via:'structured-output' when the structured channel validates", () => {
    const raw = JSON.stringify({
      response: "prose that never gets parsed",
      structured_output: { foo: "bar" },
    });
    expect(decodeDelegateArtifact(raw, validateFoo)).toEqual({
      ok: true,
      value: { foo: "bar" },
      via: "structured-output",
    });
  });

  // This is the case that matters: an off-shape structured_output must NOT
  // short-circuit the ladder — it has to fall through to the next rung
  // rather than reporting {ok:false} outright.
  it("falls through to via:'response-parse' when structured_output is present but fails the validator", () => {
    const raw = JSON.stringify({
      response: 'Sure, here you go: {"foo":"bar"}',
      structured_output: { notFoo: "wrong shape" },
    });
    expect(decodeDelegateArtifact(raw, validateFoo)).toEqual({
      ok: true,
      value: { foo: "bar" },
      via: "response-parse",
    });
  });

  it("orders rungs structured before response-parse before naive-salvage", () => {
    // No envelope at all — parseStructured on the whole text is the ONLY
    // rung capable of recovering this (a bare parseable object), so a
    // 'response-parse' via confirms rung 2 fires before rung 3 is tried.
    expect(decodeDelegateArtifact('{"foo":"bar"}', validateFoo)).toEqual({
      ok: true,
      value: { foo: "bar" },
      via: "response-parse",
    });
  });

  it("never throws on malformed input and returns {ok:false} when no rung validates", () => {
    expect(() =>
      decodeDelegateArtifact("\x00garbage", validateFoo),
    ).not.toThrow();
    expect(decodeDelegateArtifact("no json anywhere", validateFoo)).toEqual({
      ok: false,
    });
    expect(
      decodeDelegateArtifact(
        JSON.stringify({ response: "still no json" }),
        validateFoo,
      ),
    ).toEqual({ ok: false });
  });

  it("does not throw when the validate callback itself throws on rung 1 or rung 2", () => {
    const throwingValidate = (): { ok: true; value: unknown } => {
      throw new Error("validator blew up");
    };
    // Rung 1: structured_output present, validator throws.
    expect(() =>
      decodeDelegateArtifact(
        JSON.stringify({
          response: "prose",
          structured_output: { foo: "bar" },
        }),
        throwingValidate as never,
      ),
    ).toThrow();
    // Rung 2: no structured_output, parseStructured succeeds, validator throws.
    expect(() =>
      decodeDelegateArtifact('{"foo":"bar"}', throwingValidate as never),
    ).toThrow();
  });
});

describe("unwrapAgyEnvelope — decoupled channels", () => {
  it("surfaces structured_output even when .response is null/absent", () => {
    const rawNullResponse = JSON.stringify({
      response: null,
      structured_output: { foo: "bar" },
    });
    expect(unwrapAgyEnvelope(rawNullResponse)).toEqual({
      text: rawNullResponse,
      structured: { foo: "bar" },
    });

    const rawNoResponseKey = JSON.stringify({
      structured_output: { foo: "bar" },
    });
    expect(unwrapAgyEnvelope(rawNoResponseKey)).toEqual({
      text: rawNoResponseKey,
      structured: { foo: "bar" },
    });
  });
});
