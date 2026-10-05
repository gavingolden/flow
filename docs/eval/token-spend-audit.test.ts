import { describe, expect, it } from "vitest";
import { selfTestFailures } from "./token-spend-audit";

describe("token-spend-audit self-test", () => {
  it("should pass every in-memory replay and pricing fixture", () => {
    expect(selfTestFailures()).toEqual([]);
  });
});
