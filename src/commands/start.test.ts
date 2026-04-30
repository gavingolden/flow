import { describe, expect, it } from "vitest";
import { FLOW_START_DEPRECATION_WARNING } from "./start.js";

describe("FLOW_START_DEPRECATION_WARNING", () => {
  it("mentions the command is deprecated", () => {
    expect(FLOW_START_DEPRECATION_WARNING).toMatch(/deprecated/i);
  });

  it("points users at /flow-add (with hyphen, not space)", () => {
    expect(FLOW_START_DEPRECATION_WARNING).toContain("/flow-add");
    expect(FLOW_START_DEPRECATION_WARNING).not.toMatch(/\/flow add/);
  });

  it("is a single line so the user sees it at the top of stderr", () => {
    expect(FLOW_START_DEPRECATION_WARNING).not.toContain("\n");
  });
});
