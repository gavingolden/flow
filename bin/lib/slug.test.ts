import { describe, expect, it } from "vitest";
import { slugify } from "./slug";

describe(slugify, () => {
  it("lowercases input", () => {
    expect(slugify("CSV Export")).toBe("csv-export");
  });

  it("replaces runs of non-alphanumerics with a single hyphen", () => {
    expect(slugify("add  multiple   spaces")).toBe("add-multiple-spaces");
    expect(slugify("special!!chars??here")).toBe("special-chars-here");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  add CSV  ")).toBe("add-csv");
    expect(slugify("--abc--")).toBe("abc");
  });

  it("caps at 40 chars and trims trailing hyphens left after truncation", () => {
    const long = slugify("a-very-long-feature-description-that-exceeds-forty-characters-easily");
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("-")).toBe(false);
  });

  it("preserves digits", () => {
    expect(slugify("PR 142 fixup")).toBe("pr-142-fixup");
  });
});
