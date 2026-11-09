import { expect, it, vi } from "vitest";
import { report } from "./subject";

vi.mock("./dep", () => ({ value: "mocked" }));

it("sees the mocked dep even after an earlier file loaded the real one", () => {
  expect(report()).toBe("mocked");
});
