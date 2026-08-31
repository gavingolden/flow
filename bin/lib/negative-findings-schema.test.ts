import { describe, expect, it, vi } from "vitest";
import {
  isRejectedAlternativeBase,
  isAntiPatternBase,
  firstMissingStringField,
  normalizeNegativeEntry,
} from "./negative-findings-schema";

describe("isRejectedAlternativeBase", () => {
  it("accepts a happy-path entry", () => {
    expect(
      isRejectedAlternativeBase({
        considered_approach: "used a regex",
        why_rejected: "too brittle across locales",
      }),
    ).toBe(true);
  });

  it("rejects a missing considered_approach", () => {
    expect(isRejectedAlternativeBase({ why_rejected: "too brittle" })).toBe(
      false,
    );
  });

  it("rejects a missing why_rejected", () => {
    expect(
      isRejectedAlternativeBase({ considered_approach: "used a regex" }),
    ).toBe(false);
  });

  it("rejects a non-string considered_approach", () => {
    expect(
      isRejectedAlternativeBase({
        considered_approach: 42,
        why_rejected: "too brittle",
      }),
    ).toBe(false);
  });

  it("rejects a non-string why_rejected", () => {
    expect(
      isRejectedAlternativeBase({
        considered_approach: "used a regex",
        why_rejected: null,
      }),
    ).toBe(false);
  });

  it("rejects an empty-string field", () => {
    expect(
      isRejectedAlternativeBase({
        considered_approach: "",
        why_rejected: "too brittle",
      }),
    ).toBe(false);
  });

  it.each([null, undefined, [], "string", 1, true])(
    "rejects non-object input %p",
    (v) => {
      expect(isRejectedAlternativeBase(v)).toBe(false);
    },
  );
});

describe("isAntiPatternBase", () => {
  it("accepts a happy-path entry", () => {
    expect(
      isAntiPatternBase({
        location: "src/foo.ts:12",
        pattern: "silent catch",
        recommendation: "log or rethrow",
      }),
    ).toBe(true);
  });

  it("rejects a missing location", () => {
    expect(
      isAntiPatternBase({
        pattern: "silent catch",
        recommendation: "log or rethrow",
      }),
    ).toBe(false);
  });

  it("rejects a missing pattern", () => {
    expect(
      isAntiPatternBase({
        location: "src/foo.ts:12",
        recommendation: "log or rethrow",
      }),
    ).toBe(false);
  });

  it("rejects a missing recommendation", () => {
    expect(
      isAntiPatternBase({
        location: "src/foo.ts:12",
        pattern: "silent catch",
      }),
    ).toBe(false);
  });

  it("rejects non-string field values", () => {
    expect(
      isAntiPatternBase({
        location: "src/foo.ts:12",
        pattern: 1,
        recommendation: "log or rethrow",
      }),
    ).toBe(false);
  });

  it.each([null, undefined, [], "string", 1, true])(
    "rejects non-object input %p",
    (v) => {
      expect(isAntiPatternBase(v)).toBe(false);
    },
  );
});

describe("firstMissingStringField", () => {
  it("returns null when every named field is a non-empty string", () => {
    expect(
      firstMissingStringField({ considered_approach: "a", why_rejected: "b" }, [
        "considered_approach",
        "why_rejected",
      ]),
    ).toBeNull();
  });

  it("returns the first missing field name, in field order", () => {
    expect(
      firstMissingStringField({ why_rejected: "b" }, [
        "considered_approach",
        "why_rejected",
      ]),
    ).toBe("considered_approach");
  });

  it("returns the first non-string field name", () => {
    expect(
      firstMissingStringField({ considered_approach: 1, why_rejected: "b" }, [
        "considered_approach",
        "why_rejected",
      ]),
    ).toBe("considered_approach");
  });

  it("returns the field name for a three-field check", () => {
    expect(
      firstMissingStringField({ location: "l", pattern: "p" }, [
        "location",
        "pattern",
        "recommendation",
      ]),
    ).toBe("recommendation");
  });

  it("returns the first field name for non-object input", () => {
    expect(firstMissingStringField(null, ["considered_approach"])).toBe(
      "considered_approach",
    );
  });
});

describe("normalizeNegativeEntry", () => {
  it("maps the shape alias to considered_approach", () => {
    expect(
      normalizeNegativeEntry(
        { shape: "used a regex", why_rejected: "too brittle" },
        "rejected",
      ),
    ).toEqual({
      shape: "used a regex",
      considered_approach: "used a regex",
      why_rejected: "too brittle",
    });
  });

  it("maps the candidate alias to considered_approach", () => {
    expect(
      normalizeNegativeEntry(
        { candidate: "used a regex", why_rejected: "too brittle" },
        "rejected",
      ),
    ).toMatchObject({ considered_approach: "used a regex" });
  });

  it("maps the reason alias to why_rejected", () => {
    expect(
      normalizeNegativeEntry(
        { considered_approach: "used a regex", reason: "too brittle" },
        "rejected",
      ),
    ).toMatchObject({ why_rejected: "too brittle" });
  });

  it("maps the reason_rejected alias to why_rejected", () => {
    expect(
      normalizeNegativeEntry(
        {
          considered_approach: "used a regex",
          reason_rejected: "too brittle",
        },
        "rejected",
      ),
    ).toMatchObject({ why_rejected: "too brittle" });
  });

  it("maps the checked alias to considered_approach only when candidate is absent", () => {
    expect(
      normalizeNegativeEntry(
        { checked: "used a regex", why_rejected: "too brittle" },
        "rejected",
      ),
    ).toMatchObject({ considered_approach: "used a regex" });
  });

  it("does not apply the checked alias when candidate is also present", () => {
    const result = normalizeNegativeEntry(
      {
        checked: "used a regex",
        candidate: "used a lookup table",
        why_rejected: "too brittle",
      },
      "rejected",
    ) as Record<string, unknown>;
    expect(result.considered_approach).toBe("used a lookup table");
  });

  it("maps the observation alias to pattern", () => {
    expect(
      normalizeNegativeEntry(
        {
          location: "a.ts:1",
          observation: "silent catch",
          recommendation: "log it",
        },
        "anti-pattern",
      ),
    ).toMatchObject({ pattern: "silent catch" });
  });

  it("maps the note alias to recommendation", () => {
    expect(
      normalizeNegativeEntry(
        { location: "a.ts:1", pattern: "silent catch", note: "log it" },
        "anti-pattern",
      ),
    ).toMatchObject({ recommendation: "log it" });
  });

  it("recovers a bare-string rejected entry with a stated placeholder", () => {
    expect(normalizeNegativeEntry("used a regex", "rejected")).toEqual({
      considered_approach: "used a regex",
      why_rejected: "(not stated by the lens)",
    });
  });

  it("leaves a bare-string anti-pattern entry unmappable", () => {
    expect(normalizeNegativeEntry("silent catch", "anti-pattern")).toBe(
      "silent catch",
    );
  });

  it("maps an unnamed two-property rejected object positionally", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      expect(
        normalizeNegativeEntry(
          { foo: "used a regex", bar: "too brittle" },
          "rejected",
        ),
      ).toEqual({
        foo: "used a regex",
        bar: "too brittle",
        considered_approach: "used a regex",
        why_rejected: "too brittle",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain(
        "negative-findings: positional map rejected foo,bar -> considered_approach,why_rejected",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("maps an unnamed three-property anti-pattern object positionally", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      expect(
        normalizeNegativeEntry(
          { a: "a.ts:1", b: "silent catch", c: "log it" },
          "anti-pattern",
        ),
      ).toEqual({
        a: "a.ts:1",
        b: "silent catch",
        c: "log it",
        location: "a.ts:1",
        pattern: "silent catch",
        recommendation: "log it",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain(
        "negative-findings: positional map anti-pattern a,b,c -> location,pattern,recommendation",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("leaves a four-property unnamed object unmappable", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const input = { a: "1", b: "2", c: "3", d: "4" };
      expect(normalizeNegativeEntry(input, "rejected")).toEqual(input);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("is idempotent — normalizing twice equals normalizing once", () => {
    const once = normalizeNegativeEntry(
      { shape: "used a regex", why_rejected: "too brittle" },
      "rejected",
    );
    const twice = normalizeNegativeEntry(once, "rejected");
    expect(twice).toEqual(once);
  });

  it("never mutates its input", () => {
    const input = Object.freeze({
      shape: "used a regex",
      why_rejected: "too brittle",
    });
    expect(() => normalizeNegativeEntry(input, "rejected")).not.toThrow();
    expect(input).toEqual({
      shape: "used a regex",
      why_rejected: "too brittle",
    });
  });

  it("never clobbers a present canonical field", () => {
    expect(
      normalizeNegativeEntry(
        {
          considered_approach: "the real one",
          shape: "a decoy",
          why_rejected: "too brittle",
        },
        "rejected",
      ),
    ).toMatchObject({ considered_approach: "the real one" });
  });

  it("does not log for a nominal alias match", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      normalizeNegativeEntry(
        { shape: "used a regex", why_rejected: "too brittle" },
        "rejected",
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
