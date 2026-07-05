import { describe, expect, it } from "vitest";
import { slugify, isValidSlug } from "./slug";

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
    const long = slugify(
      "a-very-long-feature-description-that-exceeds-forty-characters-easily",
    );
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("-")).toBe(false);
  });

  it("preserves digits", () => {
    expect(slugify("PR 142 fixup")).toBe("pr-142-fixup");
  });

  it("drops English stop-words", () => {
    expect(
      slugify(
        "Proceed with Item 7 in the roadmap if the prerequisites are complete",
      ),
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

describe(isValidSlug, () => {
  it("accepts lowercase kebab slugs", () => {
    expect(isValidSlug("pokedex-page")).toBe(true);
    expect(isValidSlug("csv-export")).toBe(true);
  });

  it("accepts a slug with more than 5 tokens (slugify's cap does not apply)", () => {
    expect(isValidSlug("a-b-c-d-e-f-g")).toBe(true);
  });

  it("accepts digit-only and single-char slugs", () => {
    expect(isValidSlug("123")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
  });

  it("accepts a slug at the 60-char length bound", () => {
    expect(isValidSlug("a".repeat(60))).toBe(true);
  });

  it("rejects uppercase and spaces", () => {
    expect(isValidSlug("Bad Slug")).toBe(false);
    expect(isValidSlug("PascalCase")).toBe(false);
  });

  it("rejects leading, trailing, and double hyphens", () => {
    expect(isValidSlug("-x")).toBe(false);
    expect(isValidSlug("x-")).toBe(false);
    expect(isValidSlug("x--y")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isValidSlug("")).toBe(false);
  });

  it("rejects an over-length (>60 char) slug", () => {
    expect(isValidSlug("a".repeat(61))).toBe(false);
  });
});
