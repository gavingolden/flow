import { expect, it } from "vitest";
import { report } from "./subject";

it("sees the real dep again after a mocking file", () => {
  expect(report()).toBe("real");
});
