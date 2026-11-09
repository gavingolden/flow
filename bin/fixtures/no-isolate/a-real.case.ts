import { expect, it } from "vitest";
import { report } from "./subject";

it("sees the real dep", () => {
  expect(report()).toBe("real");
});
