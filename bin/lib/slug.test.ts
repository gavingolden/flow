import { describe, expect, it } from "vitest";
import { slugify } from "./slug";

describe(slugify, () => {
  it("lowercases input", () => {
    expect(slugify("CSV Export")).toBe("csv-export");
  });

  it("replaces runs of non-alphanumerics with a single hyphen", () => {
    expect(slugify("add multiple spaces")).toBe("add-multiple-spaces");
    expect(slugify("special!!chars??here")).toBe("special-chars-here");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  add CSV  ")).toBe("add-csv");
    expect(slugify("--abc--")).toBe("abc");
  });

  it("caps the token count and drops trailing hyphens", () => {
    const long = slugify("a-very-long-feature-description-that-exceeds-forty-characters-easily");
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("-")).toBe(false);
  });

  it("preserves digits", () => {
    expect(slugify("PR 142 fixup")).toBe("pr-142-fixup");
  });

  it("drops English stop-words", () => {
    expect(
      slugify("Proceed with Item 7 in the roadmap if the prerequisites are complete"),
    ).toBe("proceed-item-7-roadmap-prerequisites");
  });

  it("caps at 5 tokens after stop-word filtering", () => {
    expect(slugify("alpha beta gamma delta epsilon zeta eta")).toBe(
      "alpha-beta-gamma-delta-epsilon",
    );
  });

  it("falls back to task-<hash8> when stop-words consume the entire input", () => {
    const slug = slugify("the if and");
    expect(slug).toMatch(/^task-[0-9a-f]{8}$/);
  });

  it("falls back to task-<hash8> when input is purely punctuation", () => {
    const slug = slugify("!!!---???");
    expect(slug).toMatch(/^task-[0-9a-f]{8}$/);
  });

  it("fallback is deterministic for the same input", () => {
    expect(slugify("the if and")).toBe(slugify("the if and"));
    expect(slugify("THE IF AND")).toBe(slugify("the if and"));
  });

  it("fallback differs across distinct inputs", () => {
    expect(slugify("the if and")).not.toBe(slugify("a or be"));
  });
});
