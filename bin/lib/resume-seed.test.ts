import { describe, expect, it } from "vitest";
import { resumeSeedFor } from "./resume-seed";

describe("resumeSeedFor", () => {
  it("should seed the manager window with the slug-free manage resume line", () => {
    expect(resumeSeedFor("manager", "manager")).toBe("/flow-manage --resume");
  });
});
