import { describe, expect, it } from "vitest";
import { selfTest } from "./token-spend-audit";

describe("token-spend-audit self-test", () => {
  it("reports no failures", () => {
    expect(selfTest()).toEqual([]);
  });
});
