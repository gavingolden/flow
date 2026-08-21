import { expect, test } from "bun:test";
import { slugify } from "./slug";

test("lowercases and dashes", () => {
  expect(slugify("Hello World")).toBe("hello-world");
});

test("truncates at the max length", () => {
  const long = "a".repeat(30);
  const result = slugify(long);
  expect(result).toBe("a".repeat(20));
  expect(result.length).toBe(20);
});

test("trims leading/trailing punctuation before truncation", () => {
  expect(slugify("  --hi--  ")).toBe("hi");
});
